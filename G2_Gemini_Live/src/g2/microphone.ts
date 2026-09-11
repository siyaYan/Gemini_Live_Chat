import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk'

export const G2_MIC_FORMAT = 'PCM signed 16-bit little-endian, mono, 16 kHz'
export const G2_MIC_FIELD = 'event.audioEvent.audioPcm'

export interface MicrophoneStats {
  chunks: number
  totalBytes: number
  latestChunkBytes: number
  audioEvents: number
  missingPcmEvents: number
  invalidPcmEvents: number
  startedAtMs: number
  stoppedAtMs: number | null
  durationSeconds: number
}

type StatsListener = (stats: MicrophoneStats, label: string) => void

export class G2MicrophoneProbe {
  private recording = false
  private logTimer: number | null = null
  private statsListener: StatsListener | null = null
  private stats: MicrophoneStats = this.createStats()

  constructor(private bridge: EvenAppBridge) {}

  get isRecording(): boolean {
    return this.recording
  }

  getStats(): MicrophoneStats {
    return this.snapshot()
  }

  setStatsListener(listener: StatsListener | null): void {
    this.statsListener = listener
  }

  async start(): Promise<MicrophoneStats> {
    if (this.recording) return this.snapshot()

    this.stats = this.createStats()
    let opened = await this.bridge.audioControl(true)

    if (!opened) {
      console.warn('[G2 Mic] audioControl(true) returned false; resetting audio and retrying once.')
      await this.closeAudioControl('start retry', false)
      await wait(150)
      this.stats = this.createStats()
      opened = await this.bridge.audioControl(true)
    }

    if (!opened) {
      throw new Error('audioControl(true) returned false')
    }

    this.recording = true
    this.logTimer = window.setInterval(() => this.logStats(), 1000)
    console.log(`[G2 Mic] started; field=${G2_MIC_FIELD}; format=${G2_MIC_FORMAT}`)
    this.statsListener?.(this.snapshot(), 'started')

    return this.snapshot()
  }

  async resetControl(): Promise<void> {
    this.recording = false
    this.clearLogTimer()
    await this.closeAudioControl('recovery reset', false)
  }

  async stop(): Promise<MicrophoneStats> {
    if (!this.recording) return this.snapshot()

    this.recording = false
    this.stats.stoppedAtMs = performance.now()
    this.clearLogTimer()

    await this.closeAudioControl('stop')

    const stats = this.snapshot()
    this.logStats(stats, 'stopped')
    return stats
  }

  handleEvent(event: EvenHubEvent): void {
    if (!this.recording || !event.audioEvent) return

    this.stats.audioEvents += 1
    const pcm = event.audioEvent.audioPcm

    if (!pcm) {
      this.stats.missingPcmEvents += 1
      return
    }

    if (!(pcm instanceof Uint8Array)) {
      this.stats.invalidPcmEvents += 1
      return
    }

    this.stats.chunks += 1
    this.stats.latestChunkBytes = pcm.byteLength
    this.stats.totalBytes += pcm.byteLength
  }

  private createStats(): MicrophoneStats {
    return {
      chunks: 0,
      totalBytes: 0,
      latestChunkBytes: 0,
      audioEvents: 0,
      missingPcmEvents: 0,
      invalidPcmEvents: 0,
      startedAtMs: performance.now(),
      stoppedAtMs: null,
      durationSeconds: 0,
    }
  }

  private snapshot(): MicrophoneStats {
    const endMs = this.stats.stoppedAtMs ?? performance.now()
    return {
      ...this.stats,
      durationSeconds: Math.max(0, (endMs - this.stats.startedAtMs) / 1000),
    }
  }

  private clearLogTimer() {
    if (this.logTimer === null) return
    window.clearInterval(this.logTimer)
    this.logTimer = null
  }

  private async closeAudioControl(context: string, warnOnFalse = true): Promise<boolean> {
    try {
      const closed = await this.bridge.audioControl(false)
      if (!closed && warnOnFalse) {
        console.warn(`[G2 Mic] audioControl(false) returned false during ${context}`)
      }
      return closed
    } catch (error) {
      console.warn(`[G2 Mic] audioControl(false) failed during ${context}:`, error)
      return false
    }
  }

  private logStats(stats = this.snapshot(), label = 'recording') {
    console.log(
      `[G2 Mic] ${label} ` +
        `chunks=${stats.chunks} ` +
        `bytes=${stats.totalBytes} ` +
        `latestChunk=${stats.latestChunkBytes} ` +
        `duration≈${stats.durationSeconds.toFixed(1)}s ` +
        `audioEvents=${stats.audioEvents} ` +
        `missingPcm=${stats.missingPcmEvents} ` +
        `invalidPcm=${stats.invalidPcmEvents} ` +
        `field=${G2_MIC_FIELD} ` +
        `format="${G2_MIC_FORMAT}"`,
    )
    this.statsListener?.(stats, label)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
