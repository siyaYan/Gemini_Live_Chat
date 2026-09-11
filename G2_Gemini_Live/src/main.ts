import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { G2Display } from './g2/display'
import { interpretGesture } from './g2/gestures'
import { G2_MIC_FIELD, G2_MIC_FORMAT, G2MicrophoneProbe, type MicrophoneStats } from './g2/microphone'
import {
  GEMINI_AUDIO_MIME_TYPE,
  GEMINI_LIVE_MODEL,
  GeminiLiveSession,
  type GeminiLiveStats,
  type GeminiTranscriptEvent,
} from './gemini/live-session'
import { fetchGeminiEphemeralToken, resolveTokenUrl } from './gemini/token-client'
import { mountUi, setLastEvent, setMicStats, setStatus, setTranscript } from './ui'

const APP_VERSION = 'M3.0 gemini-live'
const READY_TEXT = `Gemini Mic Ready\n${APP_VERSION}`
const EXIT_PROMPT_TEXT = 'Exit?\nNo: single tap\nYes: double tap'

mountUi()
setStatus('connecting', 'Connecting to Even Hub bridge')

const bridge = await waitForEvenAppBridge()
const display = new G2Display(bridge)
const microphone = new G2MicrophoneProbe(bridge)
let latestMicStats: MicrophoneStats = microphone.getStats()
let latestGeminiStats: GeminiLiveStats | null = null
let latestTranscript = ''
let liveSession: GeminiLiveSession | null = null
microphone.setStatsListener((stats, label) => {
  latestMicStats = stats
  renderDiagnostics(label)
})
microphone.setPcmListener(pcm => {
  liveSession?.sendPcm(pcm)
})

await display.mount(READY_TEXT)
setStatus('ready', 'Ready on G2')
setLastEvent(`${APP_VERSION} ready`)
setMicStats('Tap once to connect Gemini Live and start G2 microphone streaming.')
setTranscript('No Gemini transcript yet.')
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
  closeLiveSession('cleanup')
  unsubscribe()
  setStatus('exiting', 'Cleaned up')
  console.log('[G2 Gemini Live] Cleaned up event listener.')
}

async function handleSingleTap() {
  if (exitArmed) {
    exitArmed = false
    setStatus('ready', 'Ready on G2')
    setLastEvent('Exit canceled locally; mic ready')
    setMicStats('Exit canceled. Tap once more to connect Gemini Live.')
    await display.show(READY_TEXT)
    return
  }

  if (needsHostRecovery) {
    await recoverFromHostExit('single tap after foreground exit')
  }

  if (!microphone.isRecording) {
    await startGeminiListening()
    return
  }

  await stopGeminiListening(true)
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
    await stopGeminiListening(false)
  }
  setMicStats('Exit selection active. Single tap = No/cancel; double tap = Yes/exit.')
  await display.show(EXIT_PROMPT_TEXT)
}

async function confirmExit() {
  console.log('[G2 Gemini Live] Exit confirmed. Requesting immediate app shutdown.')
  confirmedExit = true
  exitArmed = false
  setStatus('exiting', 'Exiting')
  setLastEvent('Exit confirmed')
  await stopGeminiListening(false)
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
  closeLiveSession('host recovery')
  await microphone.resetControl()
  await wait(200)
  await display.restore(READY_TEXT)
  needsHostRecovery = false
  setStatus('ready', 'Ready on G2')
  setLastEvent('Host recovery complete; mic ready')
  setMicStats('Tap once to connect Gemini Live.')
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
      setStatus('error', message.includes('Token') || message.includes('Gemini') ? 'Gemini connection failed' : message)
      setLastEvent(`Single tap failed: ${message}`)
      setTranscript(`Gemini connection failed: ${message}`)
      display.show('Gemini connection\nfailed').catch(displayError => {
        console.error('[G2 Gemini Live] Error display failed:', displayError)
      })
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

async function startGeminiListening() {
  latestTranscript = ''
  latestGeminiStats = null
  setStatus('connecting', 'Gemini connecting')
  setLastEvent('Fetching Gemini ephemeral token')
  setTranscript('Connecting to Gemini Live...')
  renderDiagnostics('connecting')
  await display.show('Connecting\nGemini Live...')

  const tokenResponse = await fetchGeminiEphemeralToken()
  const session = createLiveSession()
  liveSession = session

  try {
    await session.connect(tokenResponse.token)
    await microphone.start()
  } catch (error) {
    closeLiveSession('start failed')
    await microphone.stop().catch(stopError => {
      console.warn('[G2 Gemini Live] Mic stop after Gemini start failure failed:', stopError)
    })
    throw error
  }

  console.log('[G2 Gemini Live] Gemini Live capture started.')
  setStatus('recording', 'Listening')
  setLastEvent('Gemini Live connected; mic streaming')
  setTranscript('Listening for G2 speech...')
  renderDiagnostics('recording')
  await display.show('Listening...\nSay test phrase')
}

async function stopGeminiListening(showResult: boolean) {
  const stats = await microphone.stop()
  console.log('[G2 Gemini Live] Mic capture stopped.', stats)

  const session = liveSession
  if (session) {
    setLastEvent('Finalizing Gemini transcript')
    session.sendAudioStreamEnd()
    await session.waitForFinalTranscript(1600)
    closeLiveSession('mic stopped')
  }

  latestGeminiStats = session?.getStats() ?? latestGeminiStats
  renderDiagnostics('stopped')

  if (!showResult) return

  setStatus('ready', latestTranscript ? 'Gemini Heard Me ✓' : 'No transcript yet')
  setLastEvent(latestTranscript ? `Final: ${latestTranscript}` : formatStats(stats))
  setTranscript(latestTranscript || 'No final Gemini transcript received yet.')
  await display.show(latestTranscript ? 'Gemini Heard Me ✓' : 'Stopped\nNo transcript yet')
}

function createLiveSession(): GeminiLiveSession {
  return new GeminiLiveSession({
    onStatus(message) {
      setLastEvent(message)
    },
    onTranscript(transcript) {
      handleGeminiTranscript(transcript)
    },
    onStats(stats, label) {
      latestGeminiStats = stats
      renderDiagnostics(`gemini ${label}`)
    },
    onError(error) {
      console.error('[Gemini Live] runtime error:', error)
      setStatus('error', 'Gemini error')
      setLastEvent(error.message)
      setTranscript(`Gemini error: ${error.message}`)
    },
    onClose(event) {
      console.log(`[Gemini Live] close observed code=${event.code}`)
    },
  })
}

function handleGeminiTranscript(transcript: GeminiTranscriptEvent) {
  if (transcript.final) {
    latestTranscript = transcript.text
  }

  setTranscript(`${transcript.final ? 'Final' : 'Interim'}: ${transcript.text}`)
  setLastEvent(`${transcript.final ? 'Final' : 'Interim'} transcript received`)
}

function closeLiveSession(reason: string) {
  if (!liveSession) return
  liveSession.close(reason)
  liveSession = null
  console.log('[Gemini Live] session closed')
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
  const micLines = [
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
  ]

  if (!latestGeminiStats) return micLines.join('\n')

  return [
    ...micLines,
    '',
    '[Gemini Live]',
    `model=${GEMINI_LIVE_MODEL}`,
    `mime=${GEMINI_AUDIO_MIME_TYPE}`,
    `sentChunks=${latestGeminiStats.audioChunksSent}`,
    `sentBytes=${latestGeminiStats.audioBytesSent}`,
    `dropped=${latestGeminiStats.audioChunksDropped}`,
    `interim=${latestGeminiStats.interimTranscripts}`,
    `final=${latestGeminiStats.finalTranscripts}`,
    `outputAudioMessages=${latestGeminiStats.outputAudioMessages}`,
    `duration≈${latestGeminiStats.durationSeconds.toFixed(1)}s`,
    `tokenUrl=${resolveTokenUrl()}`,
  ].join('\n')
}

function renderDiagnostics(label: string) {
  setMicStats(formatStatsPanel(latestMicStats, label))
}
