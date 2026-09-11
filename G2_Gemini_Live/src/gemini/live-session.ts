import { DIAGNOSTICS, GEMINI, SYSTEM_INSTRUCTION, VAD } from '../config'
import { log, warn, error } from '../log'

export const GEMINI_LIVE_MODEL = GEMINI.model
export const GEMINI_AUDIO_MIME_TYPE = GEMINI.inputMimeType
export const GEMINI_OUTPUT_SAMPLE_RATE = GEMINI.outputSampleRate

const LIVE_WS_CONSTRAINED =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'
const STATS_LOG_INTERVAL_MS = 1000
const MAX_LOGGED_FRAME_CHARS = 400

/** What a socket close means for the reconnect decision. */
export type CloseKind = 'normal' | 'auth' | 'retryable' | 'fatal'

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
  lastCloseKind: CloseKind | null
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
  /** `detectedAtMs` is when the frame was parsed, for interruption latency. */
  onInterrupted?: (detectedAtMs: number) => void
  onStats?: (stats: GeminiLiveStats, label: string) => void
  onError?: (failure: Error) => void
  onClose?: (event: CloseEvent, kind: CloseKind) => void
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
      parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }>
    }
    turnComplete?: boolean
    generationComplete?: boolean
    interrupted?: boolean
  }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: unknown
}

/**
 * The Live API WebSocket.
 *
 * Protocol only: it decodes frames and reports events. It never decides UI
 * state, never touches the display, and never plays audio.
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

  get isReady(): boolean {
    return this.connected && this.setupComplete
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
    // official SDK passes it through unescaped.
    const url = `${LIVE_WS_CONSTRAINED}?access_token=${token}`
    log('Gemini', 'connecting to BidiGenerateContentConstrained (v1beta)')

    await new Promise<void>((resolve, reject) => {
      const websocket = new WebSocket(url)
      // Gemini sends its JSON as BINARY frames. arraybuffer keeps decoding
      // synchronous and ordered; the default 'blob' needs an async read.
      websocket.binaryType = 'arraybuffer'
      let settled = false

      const openTimeout = window.setTimeout(() => {
        if (settled) return
        settled = true
        const failure = new Error(`Gemini WebSocket open timeout after ${GEMINI.openTimeoutMs}ms`)
        this.stats.lastServerError = failure.message
        try {
          websocket.close()
        } catch {
          /* already closing */
        }
        reject(failure)
      }, GEMINI.openTimeoutMs)

      websocket.onopen = () => {
        window.clearTimeout(openTimeout)
        this.websocket = websocket
        this.connected = true
        this.stats.socketOpened = true
        this.sendSetup()
        this.startStatsTimer()
        log('Gemini', 'connected')
        this.callbacks.onStatus?.('Gemini Live connected')
        settled = true
        resolve()
      }

      websocket.onmessage = event => this.handleMessage(event)

      websocket.onerror = () => {
        const failure = new Error('Gemini WebSocket error (handshake or transport)')
        this.stats.lastServerError = failure.message
        error('Gemini', 'websocket error')
        this.callbacks.onError?.(failure)
        if (!settled) {
          window.clearTimeout(openTimeout)
          settled = true
          reject(failure)
        }
      }

      websocket.onclose = event => {
        window.clearTimeout(openTimeout)
        const kind = classifyClose(event.code, event.reason, this.closing)

        this.connected = false
        this.stats.closedAtMs = performance.now()
        this.stats.lastCloseCode = event.code
        this.stats.lastCloseReason = (event.reason || '').slice(0, 300)
        this.stats.lastCloseKind = kind
        this.clearStatsTimer()
        this.resolveFinalTranscriptWaiters(false)
        // A server-side rejection must unblock the setup wait with the real
        // reason rather than timing out generically.
        this.resolveSetupWaiters({ ok: false, reason: this.describeClose(event) })

        log('Gemini', `session closed code=${event.code} kind=${kind} reason="${event.reason}"`)
        this.callbacks.onClose?.(event, kind)

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

  waitForSetupComplete(timeoutMs: number = GEMINI.setupTimeoutMs): Promise<GeminiSetupResult> {
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
          reason: `Gemini setupComplete timeout after ${timeoutMs}ms (frames=${this.stats.serverFrames}${
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
      return false
    }

    this.audioStreamEnded = false
    websocket.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: bytesToBase64(pcm), mimeType: GEMINI_AUDIO_MIME_TYPE },
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

    websocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    this.audioStreamEnded = true
    log('Gemini', 'audio stream end sent')
  }

  waitForFinalTranscript(timeoutMs: number = GEMINI.finalTranscriptTimeoutMs): Promise<boolean> {
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

  /** Idempotent: safe to call repeatedly from any cleanup path. */
  close(reason = 'client close'): void {
    this.closing = true
    this.clearStatsTimer()
    this.resolveSetupWaiters({ ok: false, reason: `closed by client (${reason})` })
    this.resolveFinalTranscriptWaiters(false)

    const websocket = this.websocket
    this.websocket = null
    this.connected = false

    if (!websocket) return

    // Drop the handlers before closing so a late frame cannot reach a session
    // the orchestrator has already forgotten about.
    websocket.onmessage = null
    websocket.onerror = null

    if (websocket.readyState === WebSocket.CLOSED || websocket.readyState === WebSocket.CLOSING) return

    if (websocket.readyState === WebSocket.OPEN && this.setupComplete && !this.audioStreamEnded) {
      websocket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
      this.audioStreamEnded = true
    }

    try {
      websocket.close(1000, reason.slice(0, 120))
    } catch (failure) {
      warn('Gemini', 'close failed', failure)
    }
  }

  private sendSetup(): void {
    const setup = {
      setup: {
        model: `models/${GEMINI.model}`,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: VAD.disabled },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }

    this.websocket?.send(JSON.stringify(setup))
    // Safe to log: no key, no token. The instruction is long, so log its size.
    log('Gemini', `setup sent (systemInstruction ${SYSTEM_INSTRUCTION.length} chars)`)
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data

    if (typeof data === 'string') {
      this.handleTextFrame(data)
      return
    }

    if (data instanceof ArrayBuffer) {
      this.handleTextFrame(new TextDecoder().decode(data))
      return
    }

    if (data instanceof Blob) {
      data
        .text()
        .then(text => this.handleTextFrame(text))
        .catch(failure => warn('Gemini', 'failed to read blob frame', failure))
      return
    }

    warn('Gemini', `unsupported frame type: ${typeof data}`)
  }

  private handleTextFrame(raw: string): void {
    this.stats.serverFrames += 1

    if (this.loggedFrames < DIAGNOSTICS.maxLoggedFrames) {
      this.loggedFrames += 1
      log('Gemini', `frame#${this.stats.serverFrames} ${raw.slice(0, MAX_LOGGED_FRAME_CHARS)}`)
    }

    let message: GeminiServerMessage
    try {
      message = JSON.parse(raw) as GeminiServerMessage
    } catch (failure) {
      warn('Gemini', 'failed to parse server message', failure)
      return
    }

    if (message.error) {
      const detail = `${message.error.status ?? message.error.code ?? 'error'}: ${message.error.message ?? 'unknown'}`
      this.stats.lastServerError = detail.slice(0, 300)
      error('Gemini', `server error ${detail}`)
      this.callbacks.onError?.(new Error(`Gemini server error ${detail}`))
      this.resolveSetupWaiters({ ok: false, reason: `Gemini server error ${detail}` })
      return
    }

    if (message.setupComplete) {
      this.setupComplete = true
      log('Gemini', 'setup complete')
      this.callbacks.onStatus?.('Gemini Live setup complete')
      this.resolveSetupWaiters({ ok: true, reason: null })
    }

    if (message.goAway?.timeLeft) {
      // The server is about to close this session; the orchestrator treats the
      // subsequent close as retryable and reconnects with a fresh token.
      warn('Gemini', `goAway timeLeft=${message.goAway.timeLeft}`)
      this.callbacks.onStatus?.('Gemini session expiring')
    }

    const content = message.serverContent
    if (!content) {
      this.emitStats('message')
      return
    }

    // Interruption first: everything after it belongs to an abandoned turn.
    if (content.interrupted) {
      this.stats.interruptions += 1
      log('Gemini', 'interrupted')
      this.callbacks.onInterrupted?.(performance.now())
    }

    const interimText = content.interimInputTranscription?.text
    if (interimText) {
      this.stats.interimInputFrames += 1
      this.callbacks.onInterimInputTranscript?.(interimText)
    }

    const inputText = content.inputTranscription?.text
    if (inputText) {
      this.stats.inputTranscriptFrames += 1
      this.callbacks.onInputTranscript?.(inputText)
      this.resolveFinalTranscriptWaiters(true)
    }

    const outputText = content.outputTranscription?.text
    if (outputText) {
      this.stats.outputTranscriptFrames += 1
      this.callbacks.onOutputTranscript?.(outputText)
    }

    // Native model audio, forwarded as raw bytes only.
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (!data) continue

      const mimeType = part.inlineData?.mimeType ?? ''
      if (mimeType && !mimeType.startsWith('audio/')) continue

      let pcm: Uint8Array
      try {
        pcm = base64ToBytes(data)
      } catch (failure) {
        warn('Gemini', 'failed to decode audio chunk', failure)
        continue
      }

      this.stats.outputAudioMessages += 1
      this.stats.outputAudioBytes += pcm.byteLength
      this.callbacks.onOutputAudio?.(pcm, parseSampleRate(mimeType))
    }

    if (content.generationComplete) {
      this.callbacks.onGenerationComplete?.()
    }

    if (content.turnComplete) {
      this.stats.turnsCompleted += 1
      log('Gemini', `turn complete turns=${this.stats.turnsCompleted}`)
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
      lastCloseKind: null,
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
      log(
        'Gemini',
        `sent=${stats.audioChunksSent}/${stats.audioBytesSent}B ` +
          `dropped=${stats.audioChunksDropped} frames=${stats.serverFrames} ` +
          `audioOut=${stats.outputAudioMessages}/${stats.outputAudioBytes}B ` +
          `turns=${stats.turnsCompleted} duration≈${stats.durationSeconds.toFixed(1)}s`,
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
    for (const waiter of waiters) waiter(received)
  }

  private resolveSetupWaiters(result: GeminiSetupResult): void {
    const waiters = this.setupWaiters
    this.setupWaiters = []
    for (const waiter of waiters) waiter(result)
  }
}

/**
 * Decides whether a close is worth retrying.
 *
 * An expired or already-used ephemeral token reports as an auth failure, which
 * is still retryable — the reconnect mints a fresh one — but is worth naming
 * separately so the logs do not suggest a network fault.
 */
function classifyClose(code: number, reason: string, closingByClient: boolean): CloseKind {
  if (closingByClient || code === 1000) return 'normal'

  const text = (reason || '').toLowerCase()
  if (text.includes('token') || text.includes('expired') || text.includes('unauthenticated') || code === 1008) {
    return 'auth'
  }

  // 1006 abnormal, 1001 going away, 1011 server error, 1012/1013 restart/overload.
  if (code === 1006 || code === 1001 || code === 1011 || code === 1012 || code === 1013) return 'retryable'

  // 1002 protocol / 1007 invalid payload mean our setup is wrong; retrying it
  // unchanged would just fail again.
  if (code === 1002 || code === 1007) return 'fatal'

  return 'retryable'
}

function closeCodeHint(code: number, reason: string): string {
  const text = (reason || '').toLowerCase()

  if (text.includes('expired') || (text.includes('invalid') && text.includes('token'))) {
    return 'ephemeral token rejected: mint a fresh one (uses=1 tokens are consumed by the first connect)'
  }

  switch (code) {
    case 1002:
      return 'protocol error: the setup frame was malformed'
    case 1007:
      return 'invalid setup payload: bad model name or unsupported setup field'
    case 1008:
      return 'policy/auth failure: token invalid, expired, already used, or minted on a different API version'
    case 1011:
      return 'server-side error'
    case 1006:
      return 'abnormal close with no handshake: network dropped or the WebView could not keep the socket'
    default:
      return ''
  }
}

function parseSampleRate(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType)
  const parsed = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GEMINI_OUTPUT_SAMPLE_RATE
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
