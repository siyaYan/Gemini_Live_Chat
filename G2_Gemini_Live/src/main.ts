import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { G2Display } from './g2/display'
import { interpretGesture } from './g2/gestures'
import { G2_MIC_FIELD, G2_MIC_FORMAT, G2MicrophoneProbe, type MicrophoneStats } from './g2/microphone'
import { mountUi, setLastEvent, setMicStats, setStatus } from './ui'

const READY_TEXT = 'G2 Gemini Live\nMic Test Ready'

mountUi()
setStatus('connecting', 'Connecting to Even Hub bridge')

const bridge = await waitForEvenAppBridge()
const display = new G2Display(bridge)
const microphone = new G2MicrophoneProbe(bridge)
microphone.setStatsListener((stats, label) => {
  setMicStats(formatStatsPanel(stats, label))
})

await display.mount(READY_TEXT)
setStatus('ready', 'Ready on G2')
setLastEvent('Mic test ready')
setMicStats('Tap once to start G2 microphone diagnostics.')
console.log('[G2 Gemini Live] Milestone 2 mic test ready.')

let cleanedUp = false
let exitRequested = false
let needsPageRestore = false
let recovery: Promise<void> | null = null
let unsubscribe = () => {}

async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  await microphone.stop().catch(error => {
    console.warn('[G2 Gemini Live] Mic stop during cleanup failed:', error)
  })
  unsubscribe()
  setStatus('exiting', 'Cleaned up')
  console.log('[G2 Gemini Live] Cleaned up event listener.')
}

async function handleSingleTap() {
  if (exitRequested || needsPageRestore) {
    await recoverFromCanceledExit('single tap after exit dialog')
  }

  if (!microphone.isRecording) {
    await microphone.start()
    console.log('[G2 Gemini Live] Mic capture started.')
    setStatus('recording', 'Listening')
    setLastEvent('Mic capture started')
    await display.show('Listening...\nTap again to stop')
    return
  }

  const stats = await microphone.stop()
  console.log('[G2 Gemini Live] Mic capture stopped.', stats)
  setStatus('ready', stats.chunks > 0 ? 'Mic OK' : 'No PCM yet')
  setLastEvent(formatStats(stats))
  await display.show(formatMicResult(stats))
}

async function handleDoubleTap() {
  console.log('[G2 Gemini Live] Double tap detected. Requesting app exit.')
  exitRequested = true
  needsPageRestore = true
  setStatus('exiting', 'Exiting')
  setLastEvent('Double tap exit requested; cancel to continue')
  if (microphone.isRecording) {
    await microphone.stop()
  }
  await display.show('Exit requested\nCancel to continue')
  bridge.shutDownPageContainer(1)
}

async function recoverFromCanceledExit(reason: string) {
  if (recovery) return recovery

  recovery = restoreAfterExit(reason).finally(() => {
    recovery = null
  })

  return recovery
}

async function restoreAfterExit(reason: string) {
  console.log(`[G2 Gemini Live] Restoring mic test state after ${reason}.`)
  setStatus('ready', 'Restoring G2 page')
  setLastEvent('Exit canceled; restoring page/audio')
  setMicStats('Resetting G2 page/audio state before microphone retry.')
  await microphone.resetControl()
  await wait(200)
  await display.restore(READY_TEXT)
  exitRequested = false
  needsPageRestore = false
  setStatus('ready', 'Ready on G2')
  setLastEvent('Exit canceled; mic ready')
  setMicStats('Tap once to start G2 microphone diagnostics.')
}

async function handleSystemExitSignal() {
  console.log('[G2 Gemini Live] System exit signal received.')
  setStatus('exiting', 'System exit')
  setLastEvent('System exit signal received')
  await microphone.stop().catch(error => {
    console.warn('[G2 Gemini Live] Mic stop after system exit signal failed:', error)
  })
}

unsubscribe = bridge.onEvenHubEvent(event => {
  microphone.handleEvent(event)

  const gesture = interpretGesture(event)

  if (gesture === 'single-tap') {
    handleSingleTap().catch(error => {
      const message = (error as Error).message
      setStatus('error', message)
      setLastEvent(`Single tap failed: ${message}`)
      console.error('[G2 Gemini Live] Single tap handler failed:', error)
    })
    return
  }

  if (gesture === 'double-tap') {
    handleDoubleTap().catch(error => {
      setStatus('error', (error as Error).message)
      console.error('[G2 Gemini Live] Double tap handler failed:', error)
    })
    return
  }

  if (gesture === 'foreground-enter') {
    if (exitRequested || needsPageRestore) {
      recoverFromCanceledExit('foreground return').catch(error => {
        setStatus('error', (error as Error).message)
        console.error('[G2 Gemini Live] Exit recovery failed:', error)
      })
    }
    return
  }

  if (gesture === 'foreground-exit') {
    needsPageRestore = true
    setLastEvent('Foreground exit signal received')
    return
  }

  if (gesture === 'system-exit') {
    handleSystemExitSignal().catch(error => {
      setStatus('error', (error as Error).message)
      console.error('[G2 Gemini Live] System exit handling failed:', error)
    })
  }
})

window.addEventListener('beforeunload', () => {
  cleanup().catch(error => console.error('[G2 Gemini Live] Cleanup failed:', error))
})

function formatMicResult(stats: MicrophoneStats): string {
  if (stats.chunks === 0) {
    return `No PCM yet\nAudio events: ${stats.audioEvents}\nTap to retry`
  }

  return `Mic OK\nChunks: ${stats.chunks}\nBytes: ${stats.totalBytes}`
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function formatStats(stats: MicrophoneStats): string {
  return (
    `chunks=${stats.chunks}, ` +
    `bytes=${stats.totalBytes}, ` +
    `latest=${stats.latestChunkBytes}, ` +
    `duration≈${stats.durationSeconds.toFixed(1)}s`
  )
}

function formatStatsPanel(stats: MicrophoneStats, label: string): string {
  return [
    `[G2 Mic] ${label}`,
    `chunks=${stats.chunks}`,
    `bytes=${stats.totalBytes}`,
    `latestChunk=${stats.latestChunkBytes}`,
    `duration≈${stats.durationSeconds.toFixed(1)}s`,
    `audioEvents=${stats.audioEvents}`,
    `missingPcm=${stats.missingPcmEvents}`,
    `invalidPcm=${stats.invalidPcmEvents}`,
    `field=${G2_MIC_FIELD}`,
    `format=${G2_MIC_FORMAT}`,
  ].join('\n')
}
