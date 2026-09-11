export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview'
export const GEMINI_AUDIO_MIME_TYPE = 'audio/pcm;rate=16000'
/** Live API output is always 24 kHz, 16-bit, mono, little-endian PCM. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000

const LIVE_WS_HOST = 'wss://generativelanguage.googleapis.com/ws'
const LIVE_WS_CONSTRAINED = `${LIVE_WS_HOST}/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained`
const STATS_LOG_INTERVAL_MS = 1000
const OPEN_TIMEOUT_MS = 8000
const MAX_LOGGED_FRAMES = 6
const MAX_LOGGED_FRAME_CHARS = 400

export interface GeminiLiveStats {
  audioChunksSent: number
  audioBytesSent: number
  audioChunksDropped: number
  interimInputFrames: number
  inputTranscriptFrames: number
  outputTranscriptFrames: number
  outputAudioMessages: number
  outputAudioBytes: number
  turnsCompleted: number
  interruptions: number
  connectedAtMs: number
  closedAtMs: number | null
  durationSeconds: number
  socketOpened: boolean
  setupComplete: boolean
  serverFrames: number
  lastCloseCode: number | null
  lastCloseReason: string
  lastServerError: string
}

export interface GeminiSetupResult {
  ok: boolean
  reason: string | null
}

export interface GeminiLiveCallbacks {
  onStatus?: (message: string) => void
  /** A finalized fragment of the user's speech. Fragments must be accumulated. */
  onInputTranscript?: (delta: string) => void
  /** Low-latency partial of the user's speech; replaces the previous partial. */
  onInterimInputTranscript?: (text: string) => void
  /** A fragment of Gemini's answer as text. Fragments must be accumulated. */
  onOutputTranscript?: (delta: string) => void
  /** Native model audio: raw PCM bytes plus the sample rate the server declared. */
  onOutputAudio?: (pcm: Uint8Array, sampleRate: number) => void
  onGenerationComplete?: () => void
  onTurnComplete?: () => void
  onInterrupted?: () => void
  onStats?: (stats: GeminiLiveStats, label: string) => void
  onError?: (error: Error) => void
  onClose?: (event: CloseEvent) => void
}

type GeminiServerMessage = {
  setupComplete?: unknown
  error?: { code?: number; message?: string; status?: string }
  serverContent?: {
    // BidiGenerateContentTranscription: { text, languageCode }
    inputTranscription?: { text?: string; languageCode?: string }
    interimInputTranscription?: { text?: string; languageCode?: string }
    outputTranscription?: { text?: string; languageCode?: string }
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

/**
 * Why this file changed (Milestone 3 debugging):
 *
 * The previous version only resolved the "setup complete" waiters when
 * setupComplete actually arrived, or when WE closed the socket. If Gemini
 * rejected the setup and closed the socket itself (bad model, bad field,
 * expired/consumed token, wrong API version), nothing resolved the waiter, so
 * every possible server-side rejection surfaced on the glasses as the generic
 * "Gemini setupComplete timeout" and the real close code/reason was lost.
 *
 * Now: the close handler resolves the setup waiters with the close code and
 * reason, server `error` frames are parsed, the first few raw frames are
 * logged, and all of it is exposed through the stats object so the phone panel
 * can show the real cause without a dev console.
 */
export class GeminiLiveSession {
  private websocket: WebSocket | null = null
  private connected = false
  private closing = false
  private setupComplete = false
  private statsTimer: number | null = null
  private audioStreamEnded = false
  private loggedFrames = 0
  private setupWaiters: Array<(result: GeminiSetupResult) => void> = []
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
    this.setupComplete = false
    this.loggedFrames = 0

    // Do NOT percent-encode: the token name is `auth_tokens/<id>` and the
    // official SDK passes it through unescaped. Encoding the slash has been a
    // source of 4xx handshake failures.
    const url = `${LIVE_WS_CONSTRAINED}?access_token=${token}`
    console.log('[Gemini Live] connecting to BidiGenerateContentConstrained (v1beta)')

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url)
      // Gemini Live delivers its JSON messages as BINARY frames, not text
      // frames. Forcing 'arraybuffer' keeps decoding synchronous and in order;
      // the default 'blob' needs an async read, which can reorder frames.
      websocket.binaryType = 'arraybuffer'
      let settled = false

      const openTimeout = window.setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(`Gemini WebSocket open timeout after ${OPEN_TIMEOUT_MS}ms`)
        this.stats.lastServerError = error.message
        try {
          websocket.close()
        } catch {
          /* ignore */
        }
        reject(error)
      }, OPEN_TIMEOUT_MS)

      websocket.onopen = () => {
        window.clearTimeout(openTimeout)
        this.websocket = websocket
        this.connected = true
        this.stats.socketOpened = true
        this.sendSetup()
        this.startStatsTimer()
        console.log('[Gemini Live] connected')
        this.callbacks.onStatus?.('Gemini Live connected')
        settled = true
        resolve()
      }

      websocket.onmessage = event => this.handleMessage(event)

      websocket.onerror = () => {
        const error = new Error('Gemini WebSocket error (handshake or transport)')
        this.stats.lastServerError = error.message
        console.error('[Gemini Live] websocket error')
        this.callbacks.onError?.(error)
        if (!settled) {
          window.clearTimeout(openTimeout)
          settled = true
          reject(error)
        }
      }

      websocket.onclose = event => {
        window.clearTimeout(openTimeout)
        this.connected = false
        this.stats.closedAtMs = performance.now()
        this.stats.lastCloseCode = event.code
        this.stats.lastCloseReason = (event.reason || '').slice(0, 300)
        this.clearStatsTimer()
        this.resolveFinalTranscriptWaiters(false)
        // The important fix: a server-side rejection must unblock the setup
        // wait with the actual reason instead of timing out generically.
        this.resolveSetupWaiters({ ok: false, reason: this.describeClose(event) })

        console.log(`[Gemini Live] session closed code=${event.code} reason="${event.reason}"`)
        this.callbacks.onClose?.(event)

        if (!settled) {
          settled = true
          reject(new Error(`Gemini WebSocket closed during handshake: ${this.describeClose(event)}`))
          return
        }

        if (!this.closing && event.code !== 1000) {
          this.callbacks.onError?.(new Error(`Gemini WebSocket closed unexpectedly: ${this.describeClose(event)}`))
        }
      }
    })
  }

  waitForSetupComplete(timeoutMs: number): Promise<GeminiSetupResult> {
    if (this.setupComplete) return Promise.resolve({ ok: true, reason: null })

    const websocket = this.websocket
    if (!websocket || websocket.readyState === WebSocket.CLOSED) {
      return Promise.resolve({
        ok: false,
        reason: this.stats.lastCloseCode === null ? 'Gemini socket not open' : this.describeStoredClose(),
      })
    }

    return new Promise(resolve => {
      const waiter = (result: GeminiSetupResult) => {
        window.clearTimeout(timeout)
        resolve(result)
      }

      const timeout = window.setTimeout(() => {
        this.setupWaiters = this.setupWaiters.filter(entry => entry !== waiter)
        resolve({
          ok: false,
          reason: `Gemini setupComplete timeout after ${timeoutMs}ms (socket still open, frames=${this.stats.serverFrames}${
            this.stats.lastServerError ? `, lastError=${this.stats.lastServerError}` : ''
          })`,
        })
      }, timeoutMs)

      this.setupWaiters.push(waiter)
    })
  }

  sendPcm(pcm: Uint8Array): boolean {
    const websocket = this.websocket

    if (!websocket || websocket.readyState !== WebSocket.OPEN || !this.setupComplete) {
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
    if (this.stats.inputTranscriptFrames > 0) return Promise.resolve(true)

    return new Promise(resolve => {
      const waiter = (received: boolean) => {
        window.clearTimeout(timeout)
        resolve(received)
      }

      const timeout = window.setTimeout(() => {
        this.finalTranscriptWaiters = this.finalTranscriptWaiters.filter(entry => entry !== waiter)
        resolve(false)
      }, timeoutMs)

      this.finalTranscriptWaiters.push(waiter)
    })
  }

  close(reason = 'client close'): void {
    this.closing = true
    this.clearStatsTimer()
    this.resolveSetupWaiters({ ok: false, reason: `closed by client (${reason})` })
    this.resolveFinalTranscriptWaiters(false)

    const websocket = this.websocket
    this.websocket = null
    this.connected = false

    if (!websocket || websocket.readyState === WebSocket.CLOSED) return
    if (websocket.readyState === WebSocket.OPEN && this.setupComplete && !this.audioStreamEnded) {
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
    const setup = {
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
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }

    this.websocket?.send(JSON.stringify(setup))
    // Safe to log: contains no key and no token.
    console.log('[Gemini Live] setup sent', JSON.stringify(setup))
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data

    if (typeof data !== 'string') {
      // Gemini can deliver JSON as a Blob/ArrayBuffer in some WebView engines.
      if (data instanceof Blob) {
        data
          .text()
          .then(text => this.handleTextFrame(text))
          .catch(error => console.warn('[Gemini Live] failed to read blob frame:', error))
        return
      }
      if (data instanceof ArrayBuffer) {
        this.handleTextFrame(new TextDecoder().decode(data))
        return
      }
      console.warn('[Gemini Live] unsupported frame type:', typeof data)
      return
    }

    this.handleTextFrame(data)
  }

  private handleTextFrame(raw: string): void {
    this.stats.serverFrames += 1

    if (this.loggedFrames < MAX_LOGGED_FRAMES) {
      this.loggedFrames += 1
      console.log(`[Gemini Live] frame#${this.stats.serverFrames} ${raw.slice(0, MAX_LOGGED_FRAME_CHARS)}`)
    }

    let message: GeminiServerMessage
    try {
      message = JSON.parse(raw) as GeminiServerMessage
    } catch (error) {
      console.warn('[Gemini Live] failed to parse server message:', error)
      return
    }

    if (message.error) {
      const detail = `${message.error.status ?? message.error.code ?? 'error'}: ${message.error.message ?? 'unknown'}`
      this.stats.lastServerError = detail.slice(0, 300)
      console.error(`[Gemini Live] server error ${detail}`)
      this.callbacks.onError?.(new Error(`Gemini server error ${detail}`))
      this.resolveSetupWaiters({ ok: false, reason: `Gemini server error ${detail}` })
      this.emitStats('server error')
      return
    }

    if (message.setupComplete) {
      this.setupComplete = true
      console.log('[Gemini Live] setup complete')
      this.callbacks.onStatus?.('Gemini Live setup complete')
      this.resolveSetupWaiters({ ok: true, reason: null })
    }

    if (message.goAway?.timeLeft) {
      console.warn(`[Gemini Live] goAway timeLeft=${message.goAway.timeLeft}`)
    }

    const content = message.serverContent
    if (!content) {
      this.emitStats('message')
      return
    }

    const interimText = content.interimInputTranscription?.text
    if (interimText) {
      this.stats.interimInputFrames += 1
      this.callbacks.onInterimInputTranscript?.(interimText)
    }

    const inputText = content.inputTranscription?.text
    if (inputText) {
      this.stats.inputTranscriptFrames += 1
      console.log(`[Gemini Live] input transcript delta="${inputText}"`)
      this.callbacks.onInputTranscript?.(inputText)
      this.resolveFinalTranscriptWaiters(true)
    }

    const outputText = content.outputTranscription?.text
    if (outputText) {
      this.stats.outputTranscriptFrames += 1
      console.log(`[Gemini Live] output transcript delta="${outputText}"`)
      this.callbacks.onOutputTranscript?.(outputText)
    }

    // Native model audio. Forwarded as raw bytes only — this class must not
    // know how playback works, and playback must not know the Live protocol.
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (!data) continue

      const mimeType = part.inlineData?.mimeType ?? ''
      if (mimeType && !mimeType.startsWith('audio/')) continue

      let pcm: Uint8Array
      try {
        pcm = base64ToBytes(data)
      } catch (error) {
        console.warn('[Gemini Live] failed to decode audio chunk:', error)
        continue
      }

      this.stats.outputAudioMessages += 1
      this.stats.outputAudioBytes += pcm.byteLength
      this.callbacks.onOutputAudio?.(pcm, parseSampleRate(mimeType))
    }

    if (content.interrupted) {
      this.stats.interruptions += 1
      console.log('[Gemini Live] interrupted')
      this.callbacks.onInterrupted?.()
    }

    if (content.generationComplete) {
      this.callbacks.onGenerationComplete?.()
    }

    if (content.turnComplete) {
      this.stats.turnsCompleted += 1
      console.log(`[Gemini Live] turn complete turns=${this.stats.turnsCompleted}`)
      this.callbacks.onStatus?.('Gemini turn complete')
      this.callbacks.onTurnComplete?.()
    }

    this.emitStats(content.turnComplete ? 'turn complete' : 'message')
  }

  private describeClose(event: CloseEvent): string {
    const hint = closeCodeHint(event.code, event.reason)
    return `close code=${event.code}${event.reason ? ` reason="${event.reason}"` : ''}${hint ? ` — ${hint}` : ''}`
  }

  private describeStoredClose(): string {
    const code = this.stats.lastCloseCode ?? 0
    const reason = this.stats.lastCloseReason
    const hint = closeCodeHint(code, reason)
    return `close code=${code}${reason ? ` reason="${reason}"` : ''}${hint ? ` — ${hint}` : ''}`
  }

  private createStats(): GeminiLiveStats {
    return {
      audioChunksSent: 0,
      audioBytesSent: 0,
      audioChunksDropped: 0,
      interimInputFrames: 0,
      inputTranscriptFrames: 0,
      outputTranscriptFrames: 0,
      outputAudioMessages: 0,
      outputAudioBytes: 0,
      turnsCompleted: 0,
      interruptions: 0,
      connectedAtMs: performance.now(),
      closedAtMs: null,
      durationSeconds: 0,
      socketOpened: false,
      setupComplete: false,
      serverFrames: 0,
      lastCloseCode: null,
      lastCloseReason: '',
      lastServerError: '',
    }
  }

  private snapshot(): GeminiLiveStats {
    const endMs = this.stats.closedAtMs ?? performance.now()
    return {
      ...this.stats,
      setupComplete: this.setupComplete,
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
          `frames=${stats.serverFrames} ` +
          `audioOut=${stats.outputAudioMessages}/${stats.outputAudioBytes}B ` +
          `setup=${stats.setupComplete} ` +
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

  private resolveSetupWaiters(result: GeminiSetupResult): void {
    const waiters = this.setupWaiters
    this.setupWaiters = []
    for (const waiter of waiters) {
      waiter(result)
    }
  }
}

function closeCodeHint(code: number, reason: string): string {
  const text = (reason || '').toLowerCase()

  if (text.includes('expired') || text.includes('invalid') && text.includes('token')) {
    return 'ephemeral token rejected: mint a fresh one (uses=1 tokens are consumed by the first connect)'
  }

  switch (code) {
    case 1002:
      return 'protocol error: the setup frame was malformed'
    case 1007:
      return 'invalid setup payload: bad model name or unsupported setup field'
    case 1008:
      return 'policy/auth failure: ephemeral token invalid, expired, already used, or minted on a different API version'
    case 1011:
      return 'server-side error'
    case 1006:
      return 'abnormal close with no handshake: the WebView could not complete the TLS/WS upgrade'
    default:
      return ''
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

function parseSampleRate(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType)
  const parsed = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GEMINI_OUTPUT_SAMPLE_RATE
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
