import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { GeminiAudioOutput, type AudioOutputStats } from './audio/output'
import { G2Display } from './g2/display'
import { interpretGesture } from './g2/gestures'
import { G2_MIC_FIELD, G2_MIC_FORMAT, G2MicrophoneProbe, type MicrophoneStats } from './g2/microphone'
import {
  GEMINI_AUDIO_MIME_TYPE,
  GEMINI_LIVE_MODEL,
  GeminiLiveSession,
  type GeminiLiveStats,
} from './gemini/live-session'
import { fetchGeminiEphemeralToken, resolveTokenUrl } from './gemini/token-client'
import { Conversation, type ConversationSnapshot } from './state/conversation'
import {
  mountUi,
  onEnableAudio,
  setAudioStatus,
  setEnableAudioVisible,
  setLastEvent,
  setMicStats,
  setStatus,
  setTranscript,
} from './ui'

const APP_VERSION = 'M5.0 gemini-live'
const READY_TEXT = `Gemini Ready\n${APP_VERSION}`
const EXIT_PROMPT_TEXT = 'Exit?\nNo: single tap\nYes: double tap'
const DISCONNECTED_TEXT = 'Gemini disconnected'

mountUi()
setStatus('connecting', 'Connecting to Even Hub bridge')

const bridge = await waitForEvenAppBridge()
const display = new G2Display(bridge)
const microphone = new G2MicrophoneProbe(bridge)
const conversation = new Conversation()
const audioOutput = new GeminiAudioOutput()

let latestMicStats: MicrophoneStats = microphone.getStats()
let latestGeminiStats: GeminiLiveStats | null = null
let liveSession: GeminiLiveSession | null = null
let lastGeminiFailure = ''
let latestAudioStats: AudioOutputStats = audioOutput.getStats()
/** Set on turnComplete so the next utterance clears the previous answer. */
let awaitingNextTurn = false

microphone.setStatsListener((stats, label) => {
  latestMicStats = stats
  renderDiagnostics(label)
})

conversation.setListener((snapshot, reason) => {
  renderConversation(snapshot)
  renderDiagnostics(`state ${snapshot.state} (${reason})`)
})

audioOutput.setListener((stats, reason) => {
  latestAudioStats = stats
  renderAudioStatus(stats)
  renderDiagnostics(`audio ${stats.state} (${reason})`)
})

onEnableAudio(() => {
  void audioOutput.unlock().then(unlocked => {
    setLastEvent(unlocked ? 'Audio enabled' : 'Audio still locked — try again')
  })
})

// Create the context up front so the phone UI can show Locked/Ready before the
// first tap, and let any phone touch unlock it without pressing the button.
void audioOutput.initialize().then(() => {
  latestAudioStats = audioOutput.getStats()
  renderAudioStatus(latestAudioStats)
})
audioOutput.attachGestureUnlock()

await display.mount(READY_TEXT)
setStatus('ready', 'Ready on G2')
setLastEvent(`${APP_VERSION} ready`)
setMicStats('Tap once to connect Gemini Live and start a conversation.')
setTranscript('No Gemini conversation yet.')
console.log(`[G2 Gemini Live] ${APP_VERSION} ready.`)

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
  await audioOutput.dispose().catch(error => {
    console.warn('[G2 Gemini Live] Audio dispose failed:', error)
  })
  unsubscribe()
  setStatus('exiting', 'Cleaned up')
  console.log('[G2 Gemini Live] Cleaned up event listener.')
}

async function handleSingleTap() {
  if (exitArmed) {
    exitArmed = false
    conversation.reset('idle')
    setStatus('ready', 'Ready on G2')
    setLastEvent('Exit canceled locally; ready')
    setMicStats('Exit canceled. Tap once more to connect Gemini Live.')
    await display.show(READY_TEXT)
    return
  }

  if (needsHostRecovery) {
    await recoverFromHostExit('single tap after foreground exit')
  }

  if (!microphone.isRecording) {
    await startConversation()
    return
  }

  await stopConversation(true)
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
    await stopConversation(false)
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
  audioOutput.clear('exit')
  await stopConversation(false)
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
  conversation.reset('idle')
  await microphone.resetControl()
  await wait(200)
  await display.restore(READY_TEXT)
  needsHostRecovery = false
  setStatus('ready', 'Ready on G2')
  setLastEvent('Host recovery complete; ready')
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
  const pcm = microphone.handleEvent(event)
  if (pcm) {
    liveSession?.sendPcm(pcm)
  }

  const gesture = interpretGesture(event)

  if (gesture === 'single-tap') {
    handleSingleTap().catch(error => {
      const message = (error as Error).message
      conversation.setState('error')
      setStatus('error', 'Gemini connection failed')
      setLastEvent(`Single tap failed: ${message}`)
      setTranscript(`Gemini connection failed: ${message}`)
      latestGeminiStats = liveSession?.getStats() ?? latestGeminiStats
      lastGeminiFailure = message
      renderDiagnostics('gemini failure')
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

async function startConversation() {
  latestGeminiStats = null
  lastGeminiFailure = ''
  awaitingNextTurn = false
  conversation.reset('connecting')
  setStatus('connecting', 'Gemini connecting')
  setLastEvent('Fetching Gemini ephemeral token')
  renderDiagnostics('connecting')
  await display.show('Connecting...')

  const tokenResponse = await fetchGeminiEphemeralToken()
  const session = createLiveSession()
  liveSession = session

  try {
    await session.connect(tokenResponse.token)
    setLastEvent('Gemini socket open; waiting for setupComplete')
    const setupResult = await session.waitForSetupComplete(10000)
    if (!setupResult.ok) {
      throw new Error(setupResult.reason ?? 'Gemini setupComplete failed')
    }
    // Audio is best-effort: a locked or broken AudioContext must still leave a
    // working text-only assistant.
    const audioReady = await audioOutput.initialize()
    if (!audioReady) {
      console.warn(`[Audio] not ready at session start (state=${audioOutput.getState()})`)
    }

    await microphone.start()
  } catch (error) {
    closeLiveSession('start failed')
    await microphone.stop().catch(stopError => {
      console.warn('[G2 Gemini Live] Mic stop after Gemini start failure failed:', stopError)
    })
    throw error
  }

  console.log('[G2 Gemini Live] Gemini Live conversation started.')
  setStatus('recording', 'Listening')
  setLastEvent('Gemini Live connected; mic streaming')
  conversation.setState('listening')
  await display.show('Listening...')
}

async function stopConversation(showResult: boolean) {
  const stats = await microphone.stop()
  audioOutput.stop()
  console.log('[G2 Gemini Live] Mic capture stopped.', stats)

  const session = liveSession
  if (session) {
    setLastEvent('Finalizing Gemini transcript')
    session.sendAudioStreamEnd()
    await session.waitForFinalTranscript(1600)
    latestGeminiStats = session.getStats()
    closeLiveSession('mic stopped')
  }

  renderDiagnostics('stopped')

  if (!showResult) {
    conversation.reset('idle')
    return
  }

  const snapshot = conversation.getSnapshot()
  conversation.setState('idle')
  setStatus('ready', snapshot.responseText ? 'Response received ✓' : 'No response yet')
  setLastEvent(snapshot.responseText ? `Gemini: ${snapshot.responseText}` : formatStats(stats))
  setTranscript(formatTranscript(snapshot))
  // Leave the last answer on the glasses; it is the useful thing to read.
  await display.show(snapshot.responseText ? `Gemini:\n${snapshot.responseText}` : READY_TEXT)
}

function createLiveSession(): GeminiLiveSession {
  return new GeminiLiveSession({
    onStatus(message) {
      setLastEvent(message)
    },
    onInterimInputTranscript(text) {
      beginNextTurnIfNeeded()
      conversation.setInterimInput(text)
    },
    onInputTranscript(delta) {
      beginNextTurnIfNeeded()
      conversation.appendInputDelta(delta)
    },
    onOutputTranscript(delta) {
      conversation.appendOutputDelta(delta)
    },
    onOutputAudio(pcm, sampleRate) {
      // Text and audio are independent outputs; queueing must never touch the
      // display path or its throttle.
      audioOutput.enqueue(pcm, sampleRate)
    },
    onGenerationComplete() {
      console.log('[G2 Display] response complete')
    },
    onTurnComplete() {
      conversation.completeTurn()
      // The answer stays on screen; the next utterance replaces it.
      awaitingNextTurn = true
    },
    onInterrupted() {
      // Server-side cancellation alone is not enough: audio already handed to
      // Web Audio would keep playing over the user. Drop it now.
      audioOutput.clear('interrupted')
      conversation.interrupt()
      awaitingNextTurn = false
    },
    onStats(stats, label) {
      latestGeminiStats = stats
      renderDiagnostics(`gemini ${label}`)
    },
    onError(error) {
      console.error('[Gemini Live] runtime error:', error)
      lastGeminiFailure = error.message
      setStatus('error', 'Gemini error')
      setLastEvent(error.message)
      renderDiagnostics('gemini error')
    },
    onClose(event) {
      console.log(`[Gemini Live] close observed code=${event.code}`)
      if (event.code === 1000 || !microphone.isRecording) return

      // Dropped mid-conversation: say so on the glasses, keep the app alive.
      conversation.setState('error')
      setStatus('error', 'Gemini disconnected')
      setLastEvent(`Gemini disconnected (code ${event.code})`)
      display.show(DISCONNECTED_TEXT).catch(displayError => {
        console.error('[G2 Gemini Live] Disconnect display failed:', displayError)
      })
    },
  })
}

/** A new utterance after a completed turn clears the previous answer. */
function beginNextTurnIfNeeded() {
  if (!awaitingNextTurn) return
  awaitingNextTurn = false
  conversation.startTurn()
}

function renderConversation(snapshot: ConversationSnapshot) {
  setTranscript(formatTranscript(snapshot))

  switch (snapshot.state) {
    case 'responding':
      display.showResponse(snapshot.responseText)
      return
    case 'thinking':
      display.queueStatus('Thinking...')
      return
    case 'listening':
      // Keep the previous answer visible between turns.
      if (snapshot.responseText) {
        display.showResponse(snapshot.responseText)
      } else {
        display.queueStatus('Listening...')
      }
      return
    default:
      return
  }
}

function renderAudioStatus(stats: AudioOutputStats) {
  setEnableAudioVisible(stats.state === 'locked')

  switch (stats.state) {
    case 'ready':
      setAudioStatus(`Ready (context ${stats.contextSampleRate} Hz)`)
      return
    case 'playing':
      setAudioStatus(`Playing — queued ${stats.queuedMs} ms`)
      return
    case 'locked':
      setAudioStatus('Locked — tap Enable Audio (iOS needs a phone tap)')
      return
    case 'error':
      setAudioStatus(`Audio unavailable — continuing text-only. ${stats.lastError}`)
      return
    default:
      setAudioStatus('Not initialised')
  }
}

function formatTranscript(snapshot: ConversationSnapshot): string {
  const lines: string[] = []
  const user = snapshot.userText || snapshot.interimUserText

  if (user) lines.push(`You: ${user}`)
  if (snapshot.responseText) lines.push(`Gemini: ${snapshot.responseText}`)
  if (!lines.length) return snapshot.state === 'listening' ? 'Listening for G2 speech...' : 'No Gemini conversation yet.'

  return lines.join('\n')
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

  const snapshot = conversation.getSnapshot()
  const stateLines = [`state=${snapshot.state}`, `turns=${snapshot.turnIndex}`, `glassesRenders=${display.getRenderCount()}`]

  const audioLines = [
    '[Audio]',
    `state=${latestAudioStats.state}`,
    `contextRate=${latestAudioStats.contextSampleRate}`,
    `queuedChunks=${latestAudioStats.chunksQueued}`,
    `playedChunks=${latestAudioStats.chunksPlayed}`,
    `droppedChunks=${latestAudioStats.chunksDropped}`,
    `queuedBytes=${latestAudioStats.bytesQueued}`,
    `queuedMs=${latestAudioStats.queuedMs}`,
    `scheduled=${latestAudioStats.scheduledSources}`,
    `cancellations=${latestAudioStats.cancellations}`,
  ]

  if (latestAudioStats.lastError) {
    audioLines.push(`audioError=${latestAudioStats.lastError}`)
  }

  if (!latestGeminiStats) {
    const tail = lastGeminiFailure ? [`failure=${lastGeminiFailure}`] : []
    return [...micLines, '', '[Conversation]', ...stateLines, '', ...audioLines, ...tail].join('\n')
  }

  const geminiLines = [
    '[Gemini Live]',
    `model=${GEMINI_LIVE_MODEL}`,
    `mime=${GEMINI_AUDIO_MIME_TYPE}`,
    `socketOpened=${latestGeminiStats.socketOpened}`,
    `setupComplete=${latestGeminiStats.setupComplete}`,
    `serverFrames=${latestGeminiStats.serverFrames}`,
    `sentChunks=${latestGeminiStats.audioChunksSent}`,
    `sentBytes=${latestGeminiStats.audioBytesSent}`,
    `dropped=${latestGeminiStats.audioChunksDropped}`,
    `interimIn=${latestGeminiStats.interimInputFrames}`,
    `inputFrames=${latestGeminiStats.inputTranscriptFrames}`,
    `outputFrames=${latestGeminiStats.outputTranscriptFrames}`,
    `outputAudioMessages=${latestGeminiStats.outputAudioMessages}`,
    `outputAudioBytes=${latestGeminiStats.outputAudioBytes}`,
    `turnsCompleted=${latestGeminiStats.turnsCompleted}`,
    `interruptions=${latestGeminiStats.interruptions}`,
    `duration≈${latestGeminiStats.durationSeconds.toFixed(1)}s`,
    `tokenUrl=${resolveTokenUrl()}`,
  ]

  if (latestGeminiStats.lastCloseCode !== null) {
    geminiLines.push(`closeCode=${latestGeminiStats.lastCloseCode}`)
  }
  if (latestGeminiStats.lastCloseReason) {
    geminiLines.push(`closeReason=${latestGeminiStats.lastCloseReason}`)
  }
  if (latestGeminiStats.lastServerError) {
    geminiLines.push(`serverError=${latestGeminiStats.lastServerError}`)
  }
  if (lastGeminiFailure) {
    geminiLines.push(`failure=${lastGeminiFailure}`)
  }

  return [...micLines, '', '[Conversation]', ...stateLines, '', ...audioLines, '', ...geminiLines].join('\n')
}

function renderDiagnostics(label: string) {
  latestAudioStats = audioOutput.getStats()
  setMicStats(formatStatsPanel(latestMicStats, label))
}
