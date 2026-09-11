/**
 * Milestone 5 — playback of Gemini Live's native audio.
 *
 * Knows nothing about Gemini's protocol: it takes raw PCM bytes plus the sample
 * rate the server declared, and schedules them gaplessly. main.ts connects the
 * two.
 *
 * The scheduling model is a playback cursor rather than a source-per-packet
 * `start()`, because calling start() with no explicit time for every packet
 * leaves audible gaps and clicks between chunks.
 */

export type AudioOutputState = 'uninitialized' | 'locked' | 'ready' | 'playing' | 'error'

export interface AudioOutputStats {
  state: AudioOutputState
  contextSampleRate: number
  chunksQueued: number
  chunksPlayed: number
  chunksDropped: number
  bytesQueued: number
  queuedMs: number
  scheduledSources: number
  cancellations: number
  lastError: string
}

/**
 * A small lead keeps the very first chunk of a turn from being scheduled in the
 * past when the context clock has already moved past our cursor.
 */
const SCHEDULE_LEAD_SECONDS = 0.04

/** Warn once the scheduled-but-unplayed backlog passes this. */
const QUEUE_WARN_MS = 4000

/** Hard ceiling. Beyond this the queue is no longer "behind", it is leaking. */
const QUEUE_LIMIT_MS = 15000

type StateListener = (stats: AudioOutputStats, reason: string) => void

export class GeminiAudioOutput {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private state: AudioOutputState = 'uninitialized'
  private nextPlaybackTime = 0
  private scheduled = new Set<AudioBufferSourceNode>()
  private listener: StateListener | null = null
  private warnedAboutBacklog = false
  private unlockHandlerAttached = false

  private chunksQueued = 0
  private chunksPlayed = 0
  private chunksDropped = 0
  private bytesQueued = 0
  private cancellations = 0
  private lastError = ''

  setListener(listener: StateListener | null): void {
    this.listener = listener
  }

  getState(): AudioOutputState {
    return this.state
  }

  getStats(): AudioOutputStats {
    return {
      state: this.state,
      contextSampleRate: this.context?.sampleRate ?? 0,
      chunksQueued: this.chunksQueued,
      chunksPlayed: this.chunksPlayed,
      chunksDropped: this.chunksDropped,
      bytesQueued: this.bytesQueued,
      queuedMs: Math.round(this.queuedSeconds() * 1000),
      scheduledSources: this.scheduled.size,
      cancellations: this.cancellations,
      lastError: this.lastError,
    }
  }

  /**
   * Creates the AudioContext and tries to start it. Returns true when audio is
   * usable. A false return is never fatal: the caller carries on text-only.
   */
  async initialize(): Promise<boolean> {
    if (this.context) return this.resumeIfNeeded()

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!Ctor) {
      this.fail('Web Audio API is unavailable in this WebView')
      return false
    }

    try {
      // Deliberately no explicit sampleRate: iOS may refuse or silently ignore
      // a forced rate. We let the context run at its hardware rate and hand
      // Web Audio 24 kHz AudioBuffers, which it resamples natively.
      const context = new Ctor()
      const gain = context.createGain()
      gain.gain.value = 1
      gain.connect(context.destination)

      this.context = context
      this.gain = gain
      this.nextPlaybackTime = context.currentTime

      console.log(`[Audio] AudioContext initialised sampleRate=${context.sampleRate}`)
    } catch (error) {
      this.fail(`AudioContext creation failed: ${describe(error)}`)
      return false
    }

    return this.resumeIfNeeded()
  }

  /**
   * Must be called from a real DOM user-gesture handler on the phone.
   *
   * A G2 tap does NOT count: it reaches us as an Even Hub bridge event, not a
   * DOM UI event, so it carries no user activation and iOS will leave the
   * context suspended. Hence the phone-side "Enable Audio" button.
   */
  async unlock(): Promise<boolean> {
    if (!this.context) {
      const ready = await this.initialize()
      if (!ready && this.state === 'error') return false
    }

    const context = this.context
    if (!context) return false

    try {
      await context.resume()
      // The classic iOS nudge: a zero-length silent buffer inside the gesture
      // makes some WebKit builds treat the context as genuinely started.
      const silent = context.createBuffer(1, 1, 22050)
      const source = context.createBufferSource()
      source.buffer = silent
      source.connect(context.destination)
      source.start(0)
    } catch (error) {
      this.fail(`AudioContext resume failed: ${describe(error)}`)
      return false
    }

    if (isRunning(context)) {
      this.nextPlaybackTime = context.currentTime
      this.setState('ready', 'unlocked')
      console.log('[Audio] playback unlocked')
      return true
    }

    this.setState('locked', 'resume did not start context')
    return false
  }

  /**
   * Attaches a one-shot listener so the next touch anywhere on the phone UI
   * unlocks audio, in case the user never presses the button.
   */
  attachGestureUnlock(target: EventTarget = window): void {
    if (this.unlockHandlerAttached) return
    this.unlockHandlerAttached = true

    const handler = () => {
      void this.unlock().then(unlocked => {
        if (!unlocked) return
        target.removeEventListener('touchend', handler)
        target.removeEventListener('mousedown', handler)
      })
    }

    target.addEventListener('touchend', handler)
    target.addEventListener('mousedown', handler)
  }

  /**
   * Queues one PCM chunk. `sampleRate` comes from the server's declared
   * mimeType rather than a hardcoded constant.
   */
  enqueue(pcm: Uint8Array, sampleRate: number): boolean {
    const context = this.context
    const gain = this.gain

    if (!context || !gain || this.state === 'error') {
      this.chunksDropped += 1
      return false
    }

    if (!isRunning(context)) {
      // Still locked. Dropping is correct: queueing minutes of stale answers to
      // play when the user finally taps would be worse than silence.
      this.chunksDropped += 1
      this.setState('locked', 'chunk arrived while context suspended')
      return false
    }

    if (pcm.byteLength < 2) {
      this.chunksDropped += 1
      console.warn(`[Audio] malformed chunk bytes=${pcm.byteLength}`)
      return false
    }

    const queuedMs = this.queuedSeconds() * 1000

    if (queuedMs > QUEUE_LIMIT_MS) {
      this.chunksDropped += 1
      console.warn(`[Audio] queue over limit ${Math.round(queuedMs)}ms — dropping chunk`)
      return false
    }

    if (queuedMs > QUEUE_WARN_MS && !this.warnedAboutBacklog) {
      this.warnedAboutBacklog = true
      console.warn(`[Audio] playback queue=${Math.round(queuedMs)}ms — falling behind`)
    }

    let buffer: AudioBuffer
    try {
      buffer = this.toAudioBuffer(context, pcm, sampleRate)
    } catch (error) {
      this.chunksDropped += 1
      console.warn(`[Audio] failed to decode chunk: ${describe(error)}`)
      return false
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)

    const startAt = Math.max(context.currentTime + SCHEDULE_LEAD_SECONDS, this.nextPlaybackTime)
    source.start(startAt)
    this.nextPlaybackTime = startAt + buffer.duration

    this.scheduled.add(source)
    source.onended = () => {
      this.scheduled.delete(source)
      this.chunksPlayed += 1
      if (this.scheduled.size === 0) {
        this.warnedAboutBacklog = false
        this.setState('ready', 'queue drained')
      }
    }

    this.chunksQueued += 1
    this.bytesQueued += pcm.byteLength
    this.setState('playing', 'chunk queued')

    return true
  }

  /**
   * Barge-in. Everything already scheduled is discarded and the cursor is reset
   * to now, so the next turn starts immediately instead of behind the old
   * answer. Stopping generation server-side is not enough on its own — audio
   * already handed to Web Audio would keep playing.
   */
  clear(reason = 'interrupted'): void {
    const context = this.context
    const cancelled = this.scheduled.size

    for (const source of this.scheduled) {
      try {
        source.onended = null
        source.stop()
      } catch {
        // Already finished; nothing to cancel.
      }
    }

    this.scheduled.clear()
    this.warnedAboutBacklog = false

    if (context) {
      this.nextPlaybackTime = context.currentTime
    }

    if (cancelled > 0) {
      this.cancellations += 1
      console.log(`[Audio] playback cancelled sources=${cancelled} reason=${reason}`)
    }

    if (this.state === 'playing') {
      this.setState('ready', reason)
    }
  }

  stop(): void {
    this.clear('stopped')
  }

  async dispose(): Promise<void> {
    this.clear('disposed')
    const context = this.context
    this.context = null
    this.gain = null

    if (!context) return

    try {
      await context.close()
      console.log('[Audio] AudioContext closed')
    } catch (error) {
      console.warn('[Audio] AudioContext close failed:', describe(error))
    }

    this.setState('uninitialized', 'disposed')
  }

  private async resumeIfNeeded(): Promise<boolean> {
    const context = this.context
    if (!context) return false

    if (isRunning(context)) {
      this.setState('ready', 'context running')
      return true
    }

    try {
      // Works when the call still sits inside a user gesture; harmless if not.
      await context.resume()
    } catch {
      // Expected on iOS without activation.
    }

    if (isRunning(context)) {
      this.setState('ready', 'context resumed')
      return true
    }

    this.setState('locked', 'context suspended, awaiting phone gesture')
    console.log('[Audio] context suspended — needs a phone tap to unlock')
    return false
  }

  private queuedSeconds(): number {
    const context = this.context
    if (!context) return 0
    return Math.max(0, this.nextPlaybackTime - context.currentTime)
  }

  /**
   * PCM signed 16-bit little-endian -> Float32 in [-1, 1].
   *
   * DataView with the explicit littleEndian flag rather than Int16Array, which
   * would inherit the platform's byte order. Dividing by 32768 keeps the full
   * negative range (-32768 maps to exactly -1).
   *
   * The buffer is created at the SERVER's sample rate (24 kHz), not the
   * context's. Web Audio resamples it natively on playback, which is both
   * correct and faster than anything we would write.
   */
  private toAudioBuffer(context: AudioContext, pcm: Uint8Array, sampleRate: number): AudioBuffer {
    const frames = Math.floor(pcm.byteLength / 2)
    const buffer = context.createBuffer(1, frames, sampleRate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2)

    for (let index = 0; index < frames; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768
    }

    return buffer
  }

  private fail(message: string): void {
    this.lastError = message
    console.error(`[Audio] ${message}`)
    this.setState('error', message)
  }

  private setState(next: AudioOutputState, reason: string): void {
    if (this.state === next) return
    this.state = next
    this.listener?.(this.getStats(), reason)
  }
}

/** Kept as a function so TypeScript does not narrow `state` across an await. */
function isRunning(context: AudioContext): boolean {
  return context.state === 'running'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
