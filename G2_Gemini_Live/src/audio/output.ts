import { AUDIO } from '../config'
import { log, warn, error } from '../log'

/**
 * Playback of Gemini Live's native audio.
 *
 * Knows nothing about Gemini's protocol: it takes raw PCM bytes plus the
 * sample rate the server declared, and schedules them gaplessly against a
 * playback cursor. Calling start() with no explicit time per packet leaves
 * audible gaps and clicks between chunks.
 */

/** How long a scheduled-but-silent queue must sit before we call it dead. */
const STALL_TIMEOUT_MS = 3000

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
  /** Times the cursor fell behind the clock mid-answer. */
  underruns: number
  /** Times iOS suspended the context (screen lock, a call, a route change). */
  interruptions: number
  /** True only after the context has been unusable long enough to be real. */
  needsGesture: boolean
  /** Context claims to be running but nothing is actually rendering. */
  stalled: boolean
  contextGeneration: number
  lastError: string
}

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
  private unlockHandler: (() => void) | null = null
  private unlockTarget: EventTarget | null = null
  /** When the context first became unusable, for the gesture-hint debounce. */
  private notRunningSince: number | null = null
  /**
   * Silent-context detection. On iOS an AudioContext can report `running`
   * after an audio-session interruption while its underlying audio unit is
   * dead: sources schedule, the cursor advances, `onended` never fires and
   * nothing is audible. Resuming such a context never revives it — only
   * building a new one does.
   */
  private stalled = false
  private needsRebuildAfterInterruption = false
  private lastPlayedCount = 0
  private lastProgressAtMs = performance.now()
  private contextGeneration = 0

  private chunksQueued = 0
  private chunksPlayed = 0
  private chunksDropped = 0
  private bytesQueued = 0
  private cancellations = 0
  private underruns = 0
  private interruptions = 0
  private lastError = ''

  setListener(listener: StateListener | null): void {
    this.listener = listener
  }

  getState(): AudioOutputState {
    return this.state
  }

  /**
   * Once-a-second health check. Detects the running-but-silent context: audio
   * scheduled, queue not draining, `chunksPlayed` frozen. Returns fresh stats.
   */
  poll(): AudioOutputStats {
    if (this.chunksPlayed !== this.lastPlayedCount) {
      this.lastPlayedCount = this.chunksPlayed
      this.lastProgressAtMs = performance.now()
      if (this.stalled) {
        this.stalled = false
        this.needsRebuildAfterInterruption = false
        log('Audio', 'playback progressing again')
      }
      return this.getStats()
    }

    const idleMs = performance.now() - this.lastProgressAtMs
    const shouldBePlaying = this.scheduled.size > 0 && this.queuedSeconds() > 0.5

    if (!this.stalled && shouldBePlaying && idleMs > STALL_TIMEOUT_MS) {
      this.stalled = true
      warn(
        'Audio',
        `context reports running but nothing has played for ${Math.round(idleMs)}ms ` +
          `(${this.scheduled.size} sources, ${Math.round(this.queuedSeconds() * 1000)}ms queued) — ` +
          'the audio unit is dead and the context must be rebuilt',
      )
      this.setState('locked', 'context running but silent')
      this.refresh('stalled')
    }

    return this.getStats()
  }

  /** AudioContext clock, for lifecycle sampling. A frozen clock means iOS stopped it. */
  getContextTime(): number {
    return this.context?.currentTime ?? 0
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
      underruns: this.underruns,
      interruptions: this.interruptions,
      needsGesture: this.computeNeedsGesture() || this.stalled,
      stalled: this.stalled,
      contextGeneration: this.contextGeneration,
      lastError: this.lastError,
    }
  }

  /**
   * Creates the AudioContext and tries to start it. A false return is never
   * fatal: the caller carries on text-only.
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
      // a forced rate. The context runs at hardware rate and Web Audio
      // resamples our 24 kHz buffers natively.
      const context = new Ctor()
      const gain = context.createGain()
      gain.gain.value = 1
      gain.connect(context.destination)

      this.context = context
      this.gain = gain
      this.nextPlaybackTime = context.currentTime

      context.addEventListener('statechange', () => {
        if (isRunning(context)) {
          this.notRunningSince = null
          return
        }
        this.interruptions += 1
        warn('Audio', `context state -> ${context.state} (interruption ${this.interruptions})`)
        this.needsRebuildAfterInterruption = true
        this.setState('locked', `context ${context.state}`)
      })

      log('Audio', `AudioContext initialised sampleRate=${context.sampleRate}`)
    } catch (failure) {
      this.fail(`AudioContext creation failed: ${describe(failure)}`)
      return false
    }

    return this.resumeIfNeeded()
  }

  /**
   * Must be called from a real DOM user-gesture handler on the phone.
   *
   * A G2 tap does NOT count: it arrives as an Even Hub bridge event, not a DOM
   * UI event, so it carries no user activation and iOS leaves the context
   * suspended.
   */
  async unlock(): Promise<boolean> {
    // A context that has been interrupted, or that is running-but-silent,
    // cannot be revived by resume(). Rebuild it — we are inside a real user
    // gesture here, which is the only place iOS allows a fresh context to
    // start cleanly.
    if (this.context && (this.stalled || this.needsRebuildAfterInterruption)) {
      log(
        'Audio',
        `rebuilding AudioContext (stalled=${this.stalled}, ` +
          `needsRebuild=${this.needsRebuildAfterInterruption}, interruptions=${this.interruptions})`,
      )
      await this.recreateContext()
    }

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
    } catch (failure) {
      this.fail(`AudioContext resume failed: ${describe(failure)}`)
      return false
    }

    if (isRunning(context)) {
      this.nextPlaybackTime = context.currentTime
      this.notRunningSince = null
      this.stalled = false
      this.needsRebuildAfterInterruption = false
      this.lastProgressAtMs = performance.now()
      this.setState('ready', 'unlocked')
      log('Audio', 'playback unlocked')
      return true
    }

    this.setState('locked', 'resume did not start context')
    return false
  }

  /**
   * Called when iOS brings the WebView back to the foreground.
   *
   * This is intentionally best-effort. If iOS still requires a DOM gesture,
   * resume() will fail or the context will remain suspended and the phone UI
   * will surface Enable Audio. If WebKit reports `running` after an
   * interruption, we keep the conservative "needs gesture" state until the
   * next real phone tap can rebuild the context.
   */
  async recoverAfterForeground(reason: string): Promise<boolean> {
    const context = this.context

    if (!context) {
      return this.initialize()
    }

    if (this.stalled) {
      this.setState('locked', `${reason}: stalled context needs phone gesture`)
      this.refresh('foreground stalled')
      return false
    }

    if (this.needsRebuildAfterInterruption && isRunning(context)) {
      // WebKit can claim "running" while the underlying audio unit is still
      // unrecoverable after screen lock. Do not report this as healthy; wait
      // for a real phone tap so unlock() can rebuild.
      this.setState('locked', `${reason}: interrupted context needs phone gesture`)
      this.refresh('foreground interrupted')
      return false
    }

    return this.resume()
  }

  /**
   * Re-arm after an iOS interruption. Safe to call repeatedly. Unlike unlock()
   * this needs no gesture in principle — but iOS often ignores it anyway after
   * a media interruption, which is why the touch listeners stay attached.
   */
  async resume(): Promise<boolean> {
    const context = this.context
    if (!context || this.state === 'error') return false

    // A stalled context looks healthy to resume(); say so rather than
    // reporting success and leaving the user with silence.
    if (this.stalled) {
      log('Audio', 'resume skipped: context is running but silent, needs a gesture to rebuild')
      return false
    }

    if (isRunning(context)) return true

    try {
      await context.resume()
    } catch (failure) {
      warn('Audio', `resume after interruption failed: ${describe(failure)}`)
      return false
    }

    if (!isRunning(context)) {
      this.setState('locked', 'resume needs a phone gesture')
      return false
    }

    // The clock kept advancing while suspended, so the old cursor is far in the
    // past. Reset it or every queued chunk fires at once.
    this.nextPlaybackTime = context.currentTime
    this.notRunningSince = null
    this.setState('ready', 'resumed after interruption')
    log('Audio', 'resumed after interruption')
    return true
  }

  /**
   * Any touch on the phone UI restores audio. These listeners stay attached for
   * the life of the app: iOS revokes activation on every media interruption, so
   * a one-shot listener would be long gone by the time it is needed.
   */
  attachGestureUnlock(target: EventTarget = window): void {
    if (this.unlockHandlerAttached) return
    this.unlockHandlerAttached = true

    const handler = () => {
      const context = this.context
      if (context && isRunning(context) && !this.stalled && !this.needsRebuildAfterInterruption) return
      void this.unlock()
    }

    this.unlockHandler = handler
    this.unlockTarget = target
    target.addEventListener('touchend', handler)
    target.addEventListener('mousedown', handler)
    target.addEventListener('click', handler)
  }

  private detachGestureUnlock(): void {
    const target = this.unlockTarget
    const handler = this.unlockHandler
    this.unlockTarget = null
    this.unlockHandler = null
    this.unlockHandlerAttached = false

    if (!target || !handler) return
    target.removeEventListener('touchend', handler)
    target.removeEventListener('mousedown', handler)
    target.removeEventListener('click', handler)
  }

  /** Forces a listener notification even when the state label is unchanged. */
  refresh(reason: string): void {
    this.listener?.(this.getStats(), reason)
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
      // Still locked. Banking minutes of stale answers to play when the user
      // finally taps would be worse than silence.
      this.chunksDropped += 1
      this.setState('locked', 'chunk arrived while context suspended')
      return false
    }

    if (pcm.byteLength < 2) {
      this.chunksDropped += 1
      warn('Audio', `malformed chunk bytes=${pcm.byteLength}`)
      return false
    }

    const queuedMs = this.queuedSeconds() * 1000

    if (queuedMs > AUDIO.queueLimitMs) {
      this.chunksDropped += 1
      warn('Audio', `queue over limit ${Math.round(queuedMs)}ms — dropping chunk`)
      return false
    }

    if (queuedMs > AUDIO.queueWarnMs && !this.warnedAboutBacklog) {
      this.warnedAboutBacklog = true
      warn('Audio', `playback queue=${Math.round(queuedMs)}ms — falling behind`)
    }

    let buffer: AudioBuffer
    try {
      buffer = this.toAudioBuffer(context, pcm, sampleRate)
    } catch (failure) {
      this.chunksDropped += 1
      warn('Audio', `failed to decode chunk: ${describe(failure)}`)
      return false
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)

    const earliest = context.currentTime + AUDIO.scheduleLeadSeconds
    // The cursor falling behind the clock mid-answer means audio arrived too
    // late to be gapless — a real underrun, not just the start of a turn.
    if (this.scheduled.size > 0 && this.nextPlaybackTime < context.currentTime) {
      this.underruns += 1
      warn('Audio', `underrun (${this.underruns}); cursor fell behind the clock`)
    }

    const startAt = Math.max(earliest, this.nextPlaybackTime)
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
   * Barge-in. Everything already scheduled is discarded and the cursor reset to
   * now. Stopping generation server-side is not enough on its own: audio
   * already handed to Web Audio would keep playing over the user.
   *
   * `detectedAtMs` is the moment the interruption frame was parsed, so the log
   * shows the real local cancellation latency.
   */
  clear(reason = 'interrupted', detectedAtMs?: number): void {
    const context = this.context
    const cancelled = this.scheduled.size

    for (const source of this.scheduled) {
      try {
        source.onended = null
        source.stop()
        source.disconnect()
      } catch {
        // Already finished; nothing to cancel.
      }
    }

    this.scheduled.clear()
    this.warnedAboutBacklog = false

    if (context) this.nextPlaybackTime = context.currentTime

    if (cancelled > 0) {
      this.cancellations += 1
      const latency = detectedAtMs === undefined ? '' : ` in ${Math.round(performance.now() - detectedAtMs)}ms`
      log('Audio', `playback cancelled${latency} sources=${cancelled} reason=${reason}`)
    }

    if (this.state === 'playing') this.setState('ready', reason)
  }

  stop(): void {
    this.clear('stopped')
  }

  async dispose(): Promise<void> {
    this.clear('disposed')
    this.detachGestureUnlock()

    const context = this.context
    this.context = null
    this.gain = null

    if (!context) return

    try {
      await context.close()
      log('Audio', 'AudioContext closed')
    } catch (failure) {
      warn('Audio', `AudioContext close failed: ${describe(failure)}`)
    }

    this.setState('uninitialized', 'disposed')
  }

  /**
   * Tear the context down and build a fresh one. The only reliable recovery
   * from an iOS audio-session interruption; must be called from a gesture.
   */
  private async recreateContext(): Promise<boolean> {
    const previous = this.context

    this.clear('rebuilding context')
    this.context = null
    this.gain = null
    this.stalled = false
    this.needsRebuildAfterInterruption = false
    this.notRunningSince = null
    this.lastProgressAtMs = performance.now()

    if (previous) {
      try {
        await previous.close()
      } catch (failure) {
        warn('Audio', `closing the old context failed: ${describe(failure)}`)
      }
    }

    this.contextGeneration += 1
    const ok = await this.initialize()
    log('Audio', `AudioContext rebuilt (generation ${this.contextGeneration}, ok=${ok})`)
    return ok
  }

  private async resumeIfNeeded(): Promise<boolean> {
    const context = this.context
    if (!context) return false

    if (isRunning(context)) {
      this.notRunningSince = null
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
      this.notRunningSince = null
      this.setState('ready', 'context resumed')
      return true
    }

    this.setState('locked', 'context suspended, awaiting phone gesture')
    log('Audio', 'context suspended — needs a phone tap to unlock')
    return false
  }

  /**
   * Debounced, because iOS flaps the context state while it settles after a
   * screen wake. Reading it instantaneously made the Enable Audio button appear
   * and disappear repeatedly; requiring the context to be continuously unusable
   * for gestureHintDelayMs makes the button stable.
   */
  private computeNeedsGesture(): boolean {
    const context = this.context
    if (!context || this.state === 'error') return false

    if (this.stalled) return true

    if (isRunning(context)) {
      if (!this.needsRebuildAfterInterruption) {
        this.notRunningSince = null
        return false
      }

      const now = performance.now()
      if (this.notRunningSince === null) {
        this.notRunningSince = now
        return false
      }

      return now - this.notRunningSince >= AUDIO.gestureHintDelayMs
    }

    const now = performance.now()
    if (this.notRunningSince === null) {
      this.notRunningSince = now
      return false
    }

    return now - this.notRunningSince >= AUDIO.gestureHintDelayMs
  }

  private queuedSeconds(): number {
    const context = this.context
    if (!context) return 0
    return Math.max(0, this.nextPlaybackTime - context.currentTime)
  }

  /**
   * PCM signed 16-bit little-endian -> Float32 in [-1, 1].
   *
   * DataView with an explicit littleEndian flag, not Int16Array, which would
   * inherit the platform byte order. byteOffset is honoured because the bytes
   * may be a view into a larger buffer. Dividing by 32768 maps -32768 to
   * exactly -1 and cannot overflow.
   *
   * The buffer is created at the SERVER's rate; Web Audio resamples natively.
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
    error('Audio', message)
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

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
