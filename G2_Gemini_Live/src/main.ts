import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { G2Display } from './g2/display'
import { interpretGesture } from './g2/gestures'
import { G2_MIC_FIELD, G2_MIC_FORMAT, G2MicrophoneProbe, type MicrophoneStats } from './g2/microphone'
import { mountUi, setLastEvent, setMicStats, setStatus } from './ui'

const APP_VERSION = 'M2.2 soft-exit'
const READY_TEXT = `G2 Gemini Live\n${APP_VERSION}`
const EXIT_PROMPT_TEXT = 'Exit?\nTap: cancel + mic\nDouble tap: quit'

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
setLastEvent(`${APP_VERSION} mic test ready`)
setMicStats('Tap once to start G2 microphone diagnostics.')
console.log(`[G2 Gemini Live] ${APP_VERSION} mic test ready.`)

let cleanedUp = false
let exitArmed = false
let confirmedExit = false
let needsHostRecovery = false
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
  if (exitArmed) {
    exitArmed = false
    setLastEvent('Exit canceled locally; starting mic')
    await display.show(READY_TEXT)
  }

  if (needsHostRecovery) {
    await recoverFromHostExit('single tap after foreground exit')
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
  if (exitArmed) {
    await confirmExit()
    return
  }

  console.log('[G2 Gemini Live] Double tap detected. Local exit confirmation armed.')
  exitArmed = true
  setStatus('exiting', 'Exiting')
  setLastEvent('Exit armed: tap cancels, double tap quits')
  if (microphone.isRecording) {
    await microphone.stop()
  }
  setMicStats('Exit is armed. Single tap cancels and starts mic; double tap exits.')
  await display.show(EXIT_PROMPT_TEXT)
}

async function confirmExit() {
  console.log('[G2 Gemini Live] Exit confirmed. Requesting immediate app shutdown.')
  confirmedExit = true
  exitArmed = false
  setStatus('exiting', 'Exiting')
  setLastEvent('Exit confirmed')
  await microphone.stop()
  await display.show('Exiting...')
  const closed = await bridge.shutDownPageContainer(0)

  if (!closed) {
    confirmedExit = false
    setStatus('error', 'Exit request failed')
    setLastEvent('shutDownPageContainer(0) returned false')
  }
}

async function recoverFromHostExit(reason: string) {
  if (recovery) return recovery

  recovery = restoreAfterHostExit(reason).finally(() => {
    recovery = null
  })

  return recovery
}

async function restoreAfterHostExit(reason: string) {
  console.log(`[G2 Gemini Live] Restoring host page/audio state after ${reason}.`)
  setStatus('ready', 'Restoring G2 page')
  setLastEvent('Host foreground restored; resetting page/audio')
  setMicStats('Resetting G2 page/audio state before microphone retry.')
  await microphone.resetControl()
  await wait(200)
  await display.restore(READY_TEXT)
  needsHostRecovery = false
  setStatus('ready', 'Ready on G2')
  setLastEvent('Host recovery complete; mic ready')
  setMicStats('Tap once to start G2 microphone diagnostics.')
}

async function handleSystemExitSignal() {
  console.log('[G2 Gemini Live] System exit signal received.')
  confirmedExit = true
  setStatus('exiting', 'System exit')
  setLastEvent('System exit signal received')
  await cleanup()
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
    if (!confirmedExit && needsHostRecovery) {
      recoverFromHostExit('foreground return').catch(error => {
        setStatus('error', (error as Error).message)
        console.error('[G2 Gemini Live] Host recovery failed:', error)
      })
    }
    return
  }

  if (gesture === 'foreground-exit') {
    if (!confirmedExit) {
      needsHostRecovery = true
    }
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
