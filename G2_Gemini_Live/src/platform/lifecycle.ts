import { log, warn } from '../log'

/**
 * Lifecycle and background-audio diagnostics.
 *
 * Built to MEASURE what the Even Hub WebView + iOS actually do, rather than to
 * guess. Every lifecycle transition logs one structured line with the full
 * state of audio, socket and packet flow, so the four background scenarios can
 * be compared from a real device:
 *
 *   A. screen on, Even app foreground
 *   B. screen on, Even app backgrounded
 *   C. screen locked while Gemini is already speaking
 *   D. phone already locked, speak to G2, Gemini starts a NEW response
 *
 * `visibilitychange` alone is not enough on iOS. `pagehide`/`pageshow` fire for
 * WebKit page-cache transitions where visibilitychange may not, and `pageshow`
 * with `persisted === true` is the only signal that the page was restored from
 * the back/forward cache rather than merely revealed.
 */

export type LifecycleEventName =
  | 'visible'
  | 'hidden'
  | 'pagehide'
  | 'pageshow'
  | 'pageshow-restored'
  | 'freeze'
  | 'resume'

export interface LifecycleSources {
  audioState: () => string
  audioQueuedMs: () => number
  audioContextTime: () => number
  audioChunksPlayed: () => number
  socketState: () => string
  micChunks: () => number
  outputChunks: () => number
}

export interface LifecycleSample {
  event: LifecycleEventName
  atMs: number
  visibility: DocumentVisibilityState
  audioState: string
  audioQueuedMs: number
  audioContextTime: number
  socketState: string
  /** Packets per second since the previous sample. */
  micRate: number
  outputRate: number
  playedRate: number
  /** Seconds since the previous sample; large values mean the page was frozen. */
  sinceLastSeconds: number
}

type TransitionHandler = (sample: LifecycleSample) => void

export class LifecycleMonitor {
  private attached = false
  private lastSampleAtMs = performance.now()
  private lastMicChunks = 0
  private lastOutputChunks = 0
  private lastPlayedChunks = 0
  private timer: number | null = null

  private readonly onVisibility = () => {
    this.record(document.visibilityState === 'visible' ? 'visible' : 'hidden')
  }

  private readonly onPageHide = (event: PageTransitionEvent) => {
    const sample = this.record('pagehide')
    if (event.persisted) {
      warn('Session', 'pagehide persisted=true — page entered the WebKit page cache; timers and audio stop here')
    }
    return sample
  }

  private readonly onPageShow = (event: PageTransitionEvent) => {
    this.record(event.persisted ? 'pageshow-restored' : 'pageshow')
  }

  private readonly onFreeze = () => {
    this.record('freeze')
  }

  private readonly onResume = () => {
    this.record('resume')
  }

  constructor(
    private sources: LifecycleSources,
    private handler: TransitionHandler,
    /** Periodic sampling interval while a session runs; 0 disables it. */
    private sampleIntervalMs = 0,
  ) {}

  attach(): void {
    if (this.attached) return
    this.attached = true

    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPageHide)
    window.addEventListener('pageshow', this.onPageShow)
    // Page Lifecycle API; present on some WebKit builds, harmless when absent.
    document.addEventListener('freeze', this.onFreeze)
    document.addEventListener('resume', this.onResume)

    if (this.sampleIntervalMs > 0) {
      this.timer = window.setInterval(() => {
        this.record(document.visibilityState === 'visible' ? 'visible' : 'hidden')
      }, this.sampleIntervalMs)
    }

    log('Session', 'lifecycle monitor attached')
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false

    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('pagehide', this.onPageHide)
    window.removeEventListener('pageshow', this.onPageShow)
    document.removeEventListener('freeze', this.onFreeze)
    document.removeEventListener('resume', this.onResume)

    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Take a sample now, outside a transition. */
  sample(event: LifecycleEventName = 'visible'): LifecycleSample {
    return this.record(event)
  }

  private record(event: LifecycleEventName): LifecycleSample {
    const now = performance.now()
    const elapsedSeconds = Math.max(0.001, (now - this.lastSampleAtMs) / 1000)

    const micChunks = this.sources.micChunks()
    const outputChunks = this.sources.outputChunks()
    const playedChunks = this.sources.audioChunksPlayed()

    const sample: LifecycleSample = {
      event,
      atMs: now,
      visibility: document.visibilityState,
      audioState: this.sources.audioState(),
      audioQueuedMs: this.sources.audioQueuedMs(),
      audioContextTime: Number(this.sources.audioContextTime().toFixed(2)),
      socketState: this.sources.socketState(),
      micRate: rate(micChunks - this.lastMicChunks, elapsedSeconds),
      outputRate: rate(outputChunks - this.lastOutputChunks, elapsedSeconds),
      playedRate: rate(playedChunks - this.lastPlayedChunks, elapsedSeconds),
      sinceLastSeconds: Number(elapsedSeconds.toFixed(2)),
    }

    this.lastSampleAtMs = now
    this.lastMicChunks = micChunks
    this.lastOutputChunks = outputChunks
    this.lastPlayedChunks = playedChunks

    log(
      'Session',
      `lifecycle ${event} visibility=${sample.visibility} audio=${sample.audioState} ` +
        `queued=${sample.audioQueuedMs}ms ctxTime=${sample.audioContextTime}s socket=${sample.socketState} ` +
        `mic=${sample.micRate}/s out=${sample.outputRate}/s played=${sample.playedRate}/s ` +
        `since=${sample.sinceLastSeconds}s`,
    )

    this.handler(sample)
    return sample
  }
}

function rate(delta: number, seconds: number): number {
  if (delta <= 0) return 0
  return Math.round(delta / seconds)
}
