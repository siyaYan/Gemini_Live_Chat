export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview'
export const GEMINI_AUDIO_MIME_TYPE = 'audio/pcm;rate=16000'

const LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
const STATS_LOG_INTERVAL_MS = 1000

export interface GeminiLiveStats {
  audioChunksSent: number
  audioBytesSent: number
  audioChunksDropped: number
  interimTranscripts: number
  finalTranscripts: number
  outputAudioMessages: number
  connectedAtMs: number
  closedAtMs: number | null
  durationSeconds: number
}

export interface GeminiTranscriptEvent {
  text: string
  final: boolean
}

export interface GeminiLiveCallbacks {
  onStatus?: (message: string) => void
  onTranscript?: (transcript: GeminiTranscriptEvent) => void
  onStats?: (stats: GeminiLiveStats, label: string) => void
  onError?: (error: Error) => void
  onClose?: (event: CloseEvent) => void
}

type GeminiServerMessage = {
  setupComplete?: unknown
  serverContent?: {
    inputTranscription?: { text?: string }
    interimInputTranscription?: { text?: string }
    outputTranscription?: { text?: string }
    modelTurn?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string }
      }>
    }
    turnComplete?: boolean
    generationComplete?: boolean
    interrupted?: boolean
  }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: unknown
}

export class GeminiLiveSession {
  private websocket: WebSocket | null = null
  private connected = false
  private closing = false
  private statsTimer: number | null = null
  private audioStreamEnded = false
  private finalTranscriptWaiters: Array<(received: boolean) => void> = []
  private stats: GeminiLiveStats = this.createStats()

  constructor(private callbacks: GeminiLiveCallbacks = {}) {}

  get isConnected(): boolean {
    return this.connected
  }

  getStats(): GeminiLiveStats {
    return this.snapshot()
  }

  async connect(token: string): Promise<void> {
    if (this.websocket) {
      throw new Error('Gemini Live session already exists')
    }

    this.stats = this.createStats()
    const url = `${LIVE_WS_URL}?access_token=${encodeURIComponent(token)}`

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url)
      let settled = false

      websocket.onopen = () => {
        this.websocket = websocket
        this.connected = true
        this.sendSetup()
        this.startStatsTimer()
        console.log('[Gemini Live] connected')
        this.callbacks.onStatus?.('Gemini Live connected')
        settled = true
        resolve()
      }

      websocket.onmessage = event => this.handleMessage(event)

      websocket.onerror = () => {
        const error = new Error('Gemini WebSocket error')
        console.error('[Gemini Live] websocket error')
        this.callbacks.onError?.(error)
        if (!settled) {
          settled = true
          reject(error)
        }
      }

      websocket.onclose = event => {
        this.connected = false
        this.stats.closedAtMs = performance.now()
        this.clearStatsTimer()
        this.resolveFinalTranscriptWaiters(false)
        console.log(`[Gemini Live] session closed code=${event.code} reason="${event.reason}"`)
        this.callbacks.onClose?.(event)

        if (!settled) {
          settled = true
          reject(new Error(`Gemini WebSocket closed before connect: ${event.code}`))
          return
        }

        if (!this.closing && event.code !== 1000) {
          this.callbacks.onError?.(new Error(`Gemini WebSocket closed unexpectedly: ${event.code}`))
        }
      }
    })
  }

  sendPcm(pcm: Uint8Array): boolean {
    const websocket = this.websocket

    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      this.stats.audioChunksDropped += 1
      this.emitStats('audio dropped')
      return false
    }

    this.audioStreamEnded = false
    websocket.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: GEMINI_AUDIO_MIME_TYPE,
          },
        },
      }),
    )

    this.stats.audioChunksSent += 1
    this.stats.audioBytesSent += pcm.byteLength
    return true
  }

  sendAudioStreamEnd(): void {
    const websocket = this.websocket
    if (!websocket || websocket.readyState !== WebSocket.OPEN || this.audioStreamEnded) return

    websocket.send(
      JSON.stringify({
        realtimeInput: {
          audioStreamEnd: true,
        },
      }),
    )
    this.audioStreamEnded = true
    console.log('[Gemini Live] audio stream end sent')
  }

  waitForFinalTranscript(timeoutMs: number): Promise<boolean> {
    if (this.stats.finalTranscripts > 0) return Promise.resolve(true)

    return new Promise(resolve => {
      const timeout = window.setTimeout(() => {
        this.finalTranscriptWaiters = this.finalTranscriptWaiters.filter(waiter => waiter !== resolve)
        resolve(false)
      }, timeoutMs)

      this.finalTranscriptWaiters.push(received => {
        window.clearTimeout(timeout)
        resolve(received)
      })
    })
  }

  close(reason = 'client close'): void {
    this.closing = true
    this.clearStatsTimer()
    this.resolveFinalTranscriptWaiters(false)

    const websocket = this.websocket
    this.websocket = null
    this.connected = false

    if (!websocket || websocket.readyState === WebSocket.CLOSED) return
    if (websocket.readyState === WebSocket.OPEN && !this.audioStreamEnded) {
      websocket.send(
        JSON.stringify({
          realtimeInput: {
            audioStreamEnd: true,
          },
        }),
      )
      this.audioStreamEnded = true
    }

    websocket.close(1000, reason.slice(0, 120))
  }

  private sendSetup(): void {
    this.websocket?.send(
      JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
            },
          },
          inputAudioTranscription: {
            languageCodes: [],
          },
          outputAudioTranscription: {},
        },
      }),
    )
    console.log('[Gemini Live] setup sent')
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return

    let message: GeminiServerMessage
    try {
      message = JSON.parse(event.data) as GeminiServerMessage
    } catch (error) {
      console.warn('[Gemini Live] failed to parse server message:', error)
      return
    }

    if (message.setupComplete) {
      console.log('[Gemini Live] setup complete')
      this.callbacks.onStatus?.('Gemini Live setup complete')
    }

    if (message.goAway?.timeLeft) {
      console.warn(`[Gemini Live] goAway timeLeft=${message.goAway.timeLeft}`)
    }

    const content = message.serverContent
    if (!content) return

    const interimText = content.interimInputTranscription?.text
    if (interimText) {
      this.stats.interimTranscripts += 1
      console.log(`[Gemini Live] transcript interim="${interimText}"`)
      this.callbacks.onTranscript?.({ text: interimText, final: false })
    }

    const finalText = content.inputTranscription?.text
    if (finalText) {
      this.stats.finalTranscripts += 1
      console.log(`[Gemini Live] transcript final="${finalText}"`)
      this.callbacks.onTranscript?.({ text: finalText, final: true })
      this.resolveFinalTranscriptWaiters(true)
    }

    const outputText = content.outputTranscription?.text
    if (outputText) {
      console.log(`[Gemini Live] output transcript="${outputText}"`)
    }

    const outputAudioMessages = content.modelTurn?.parts?.filter(part => part.inlineData?.data).length ?? 0
    if (outputAudioMessages > 0) {
      this.stats.outputAudioMessages += outputAudioMessages
    }

    if (content.turnComplete) {
      this.callbacks.onStatus?.('Gemini turn complete')
    }

    this.emitStats(content.turnComplete ? 'turn complete' : 'message')
  }

  private createStats(): GeminiLiveStats {
    return {
      audioChunksSent: 0,
      audioBytesSent: 0,
      audioChunksDropped: 0,
      interimTranscripts: 0,
      finalTranscripts: 0,
      outputAudioMessages: 0,
      connectedAtMs: performance.now(),
      closedAtMs: null,
      durationSeconds: 0,
    }
  }

  private snapshot(): GeminiLiveStats {
    const endMs = this.stats.closedAtMs ?? performance.now()
    return {
      ...this.stats,
      durationSeconds: Math.max(0, (endMs - this.stats.connectedAtMs) / 1000),
    }
  }

  private startStatsTimer(): void {
    this.clearStatsTimer()
    this.statsTimer = window.setInterval(() => {
      const stats = this.snapshot()
      console.log(
        `[Gemini Live] audio chunks sent=${stats.audioChunksSent} ` +
          `bytes=${stats.audioBytesSent} ` +
          `dropped=${stats.audioChunksDropped} ` +
          `duration≈${stats.durationSeconds.toFixed(1)}s`,
      )
      this.callbacks.onStats?.(stats, 'streaming')
    }, STATS_LOG_INTERVAL_MS)
  }

  private clearStatsTimer(): void {
    if (this.statsTimer === null) return
    window.clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private emitStats(label: string): void {
    this.callbacks.onStats?.(this.snapshot(), label)
  }

  private resolveFinalTranscriptWaiters(received: boolean): void {
    const waiters = this.finalTranscriptWaiters
    this.finalTranscriptWaiters = []
    for (const waiter of waiters) {
      waiter(received)
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
