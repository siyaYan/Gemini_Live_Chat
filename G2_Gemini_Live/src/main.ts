import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { GeminiAudioOutput, type AudioOutputStats } from './audio/output'
import { APP_VERSION, GEMINI, LIFECYCLE, SESSION } from './config'
import { G2Display } from './g2/display'
import { interpretGesture } from './g2/gestures'
import { G2_MIC_FIELD, G2_MIC_FORMAT, G2MicrophoneProbe, type MicrophoneStats } from './g2/microphone'
import {
  GEMINI_AUDIO_MIME_TYPE,
  GEMINI_LIVE_MODEL,
  GeminiLiveSession,
  type CloseKind,
  type GeminiLiveStats,
} from './gemini/live-session'
import { fetchGeminiEphemeralToken, resolveTokenUrl } from './gemini/token-client'
import { log, warn, error } from './log'
import { LifecycleMonitor, type LifecycleSample } from './platform/lifecycle'
import { Conversation, type ConversationSnapshot } from './state/conversation'
import {
  diagnosticsVisible,
  mountUi,
  onEnableAudio,
  setDiagnostics,
  setEnableAudioVisible,
  setLastEvent,
  setStatus,
  setSummary,
  setTranscript,
} from './ui'

/**
 * Orchestrator.
 *
 * Milestone 6 rule: this file is the ONLY place that decides what the user
 * sees. Conversation state is the single source of truth; protocol, audio and
 * display modules report and render but never decide.
 */

const GLASSES = {
  ready: 'Ready',
  starting: 'Starting...',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
  exitPrompt: 'Exit?\nNo: single tap\nYes: double tap',
  exiting: 'Exiting...',
  connectionFailed: 'Connection failed\nTap to retry',
  micFailed: 'Microphone error\nTap to retry',
  offline: 'No network\nTap to retry',
} as const

// ------------------------------------------------------------- bootstrap ----

const bootStartedAtMs = performance.now()
mountUi()
setStatus('connecting', 'Connecting to Even Hub bridge')
setSummary({ mic: 'Idle', gemini: 'Disconnected', audio: 'Not initialised', session: '00:00' })

const bridge = await waitForEvenAppBridge()
const bridgeReadyMs = Math.round(performance.now() - bootStartedAtMs)

const display = new G2Display(bridge)
const microphone = new G2MicrophoneProbe(bridge)
const conversation = new Conversation()
const audioOutput = new GeminiAudioOutput()

// ----------------------------------------------------------------- state ----

let latestMicStats: MicrophoneStats = microphone.getStats()
let latestGeminiStats: GeminiLiveStats | null = null
let latestAudioStats: AudioOutputStats = audioOutput.getStats()
let liveSession: GeminiLiveSession | null = null

/** True between a successful start and any stop, including while reconnecting. */
let sessionActive = false
/** Suppresses reconnect while we are deliberately tearing the session down. */
let stopping = false
let reconnecting = false
let reconnectCount = 0
let sessionStartedAtMs = 0
/** Set on turnComplete so the next utterance clears the previous answer. */
let awaitingNextTurn = false
/**
 * While true, conversation renders must not touch the glasses — an explicit
 * screen (exit prompt, error) is showing and owns the display.
 */
let displayLocked = false
let lastFailure = ''

let cachedToken: { token: string; fetchedAt: number } | null = null
let connectTimings = { tokenMs: 0, socketMs: 0, setupMs: 0, totalMs: 0 }
let micStartMs = 0
let startupReported = false

let cleanedUp = false
let exitArmed = false
let confirmedExit = false
let needsHostRecovery = false
let recovery: Promise<void> | null = null
let unsubscribe = () => {}
let clockTimer: number | null = null

// ------------------------------------------------------------- listeners ----

microphone.setStatsListener((stats, label) => {
  latestMicStats = stats
  renderDiagnostics(label)
})

conversation.setListener(snapshot => {
  renderConversation(snapshot)
})

audioOutput.setListener((stats, reason) => {
  latestAudioStats = stats
  renderSummary()
  setEnableAudioVisible(stats.needsGesture)
  renderDiagnostics(`audio ${stats.state} (${reason})`)
})

onEnableAudio(() => {
  void audioOutput.unlock().then(unlocked => {
    latestAudioStats = audioOutput.getStats()
    setEnableAudioVisible(latestAudioStats.needsGesture)
    renderSummary()

    if (!unlocked) {
      setLastEvent('iOS refused to resume audio — try once more')
      return
    }

    // Unlocking only fixes the AudioContext. If Gemini is gone there is
    // nothing to play, and saying "Audio enabled" would be misleading.
    if (!sessionActive) {
      setLastEvent('Audio enabled — tap the glasses once to start a conversation')
      return
    }

    if (!liveSession?.isReady) {
      setLastEvent('Audio enabled, but the Gemini session is down — tap the glasses to reconnect')
      return
    }

    setLastEvent('Audio enabled')
  })
})

// Create the context up front so the phone can show Locked/Ready before the
// first tap, and let any phone touch restore it after an iOS interruption.
void audioOutput.initialize().then(() => {
  latestAudioStats = audioOutput.getStats()
  renderSummary()
})
audioOutput.attachGestureUnlock()

await display.mount(GLASSES.ready)
conversation.reset('idle')
setStatus('ready', 'Ready')
setLastEvent(`${APP_VERSION} ready · bridge ${bridgeReadyMs}ms`)
setTranscript('Tap the glasses once to start a conversation.')
log('Startup', `${APP_VERSION} ready; bridge=${bridgeReadyMs}ms`)

void prefetchToken()

clockTimer = window.setInterval(() => {
  // One timer drives the session clock, the gesture-hint debounce, and the
  // silent-context check that spots an AudioContext reporting `running` while
  // nothing is actually rendering.
  latestAudioStats = audioOutput.poll()
  setEnableAudioVisible(latestAudioStats.needsGesture)
  renderSummary()
}, SESSION.clockIntervalMs)

/**
 * One monitor owns every lifecycle signal — visibilitychange, pagehide,
 * pageshow, freeze, resume — and logs a full state sample on each, so the
 * background behaviour of this WebView can be measured instead of guessed.
 */
const lifecycle = new LifecycleMonitor(
  {
    audioState: () => latestAudioStats.state,
    audioQueuedMs: () => audioOutput.getStats().queuedMs,
    audioContextTime: () => audioOutput.getContextTime(),
    audioChunksPlayed: () => audioOutput.getStats().chunksPlayed,
    socketState: () => (liveSession?.isReady ? 'ready' : liveSession?.isConnected ? 'open' : 'closed'),
    micChunks: () => latestMicStats.chunks,
    outputChunks: () => latestGeminiStats?.outputAudioMessages ?? 0,
  },
  sample => handleLifecycle(sample),
  LIFECYCLE.sampleIntervalMs,
)

function handleLifecycle(sample: LifecycleSample) {
  if (sample.event === 'hidden' || sample.event === 'pagehide' || sample.event === 'freeze') {
    // iOS suspends Web Audio here and there is no supported way to keep it
    // running: the SDK has no audio-output API (issue #26) and silent-audio
    // tricks do not survive a real audio-session interruption.
    if (sessionActive) setLastEvent('Backgrounded — iOS may pause audio until you return')
    return
  }

  // Visible again: restore what can be restored, degrade honestly otherwise.
  void audioOutput.recoverAfterForeground(sample.event).then(() => {
    latestAudioStats = audioOutput.getStats()
    setEnableAudioVisible(latestAudioStats.needsGesture)
    renderSummary()
  })

  if (sessionActive && !liveSession?.isReady) {
    void beginReconnect(sample.event === 'pageshow-restored' ? 'restored from page cache' : 'returned from background')
  }
}

const onOffline = () => {
  warn('Network', 'offline')
  setLastEvent('Network offline')
  if (!sessionActive) return
  audioOutput.clear('offline')
  conversation.setState('reconnecting', 'network offline')
}

const onOnline = () => {
  log('Network', 'online')
  setLastEvent('Network back online')
  if (sessionActive && !liveSession?.isReady) void beginReconnect('network restored')
}

const onBeforeUnload = () => {
  void cleanup()
}

if (LIFECYCLE.probe) lifecycle.attach()
window.addEventListener('offline', onOffline)
window.addEventListener('online', onOnline)
window.addEventListener('beforeunload', onBeforeUnload)

unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = microphone.handleEvent(event)
  if (pcm) liveSession?.sendPcm(pcm)

  const gesture = interpretGesture(event)

  if (gesture === 'single-tap') {
    handleSingleTap().catch(failure => reportTapFailure(failure as Error))
    return
  }

  if (gesture === 'double-tap') {
    handleDoubleTap().catch(failure => {
      setStatus('error', (failure as Error).message)
      error('G2', 'double tap handler failed', failure)
    })
    return
  }

  if (gesture === 'foreground-enter') {
    if (!confirmedExit && needsHostRecovery) {
      recoverFromHostExit('foreground return').catch(failure => {
        setStatus('error', (failure as Error).message)
        error('G2', 'host recovery failed', failure)
      })
    }
    return
  }

  if (gesture === 'foreground-exit') {
    if (!confirmedExit) needsHostRecovery = true
    setLastEvent('Foreground exit signal received')
    return
  }

  if (gesture === 'system-exit') {
    handleSystemExitSignal().catch(failure => {
      setStatus('error', (failure as Error).message)
      error('G2', 'system exit handling failed', failure)
    })
  }
})

// ---------------------------------------------------------------- gestures --

async function handleSingleTap() {
  if (exitArmed) {
    exitArmed = false
    displayLocked = false
    setStatus('ready', 'Ready')
    setLastEvent('Exit canceled')
    await display.show(GLASSES.ready)
    conversation.reset('idle')
    return
  }

  if (needsHostRecovery) {
    await recoverFromHostExit('single tap after foreground exit')
  }

  // A session whose socket died while hidden still has the mic marked as
  // recording. Tapping must start a NEW session, not stop one already gone.
  if (sessionActive && !liveSession?.isConnected) {
    log('Session', 'tap on a dead session; restarting')
    await stopSession(false)
    await startSession()
    return
  }

  if (sessionActive || microphone.isRecording) {
    await stopSession(true)
    return
  }

  await startSession()
}

async function handleDoubleTap() {
  if (exitArmed) {
    await confirmExit()
    return
  }

  log('G2', 'double tap; exit confirmation armed')
  exitArmed = true
  displayLocked = true
  setStatus('exiting', 'Exiting')
  setLastEvent('Exit armed: tap cancels, double tap quits')
  if (sessionActive || microphone.isRecording) await stopSession(false)
  await display.show(GLASSES.exitPrompt)
}

async function confirmExit() {
  log('G2', 'exit confirmed; shutting down')
  confirmedExit = true
  exitArmed = false
  setStatus('exiting', 'Exiting')
  setLastEvent('Exit confirmed')

  await cleanup()
  await display.show(GLASSES.exiting)

  const closed = await bridge.shutDownPageContainer(0)
  if (!closed) {
    confirmedExit = false
    setStatus('error', 'Exit request failed')
    setLastEvent('shutDownPageContainer(0) returned false')
  }
}

async function handleSystemExitSignal() {
  log('G2', 'system exit signal received')
  confirmedExit = true
  setStatus('exiting', 'System exit')
  setLastEvent('System exit signal received')
  await cleanup()
}

function reportTapFailure(failure: Error) {
  lastFailure = failure.message
  displayLocked = true
  conversation.setState('error', 'tap failed')
  setStatus('error', 'Gemini connection failed')
  setLastEvent(`Tap failed: ${failure.message}`)
  setTranscript(`Connection failed: ${failure.message}`)
  latestGeminiStats = liveSession?.getStats() ?? latestGeminiStats
  renderDiagnostics('tap failure')
  display.show(GLASSES.connectionFailed).catch(displayFailure => {
    error('Display', 'error display failed', displayFailure)
  })
  error('Session', 'tap handler failed', failure)
}

// -------------------------------------------------------- session control ----

async function startSession() {
  lastFailure = ''
  displayLocked = false
  reconnectCount = 0
  awaitingNextTurn = false
  latestGeminiStats = null
  conversation.reset('connecting')
  setStatus('connecting', 'Connecting')
  setLastEvent('Starting Gemini session')

  if (!navigator.onLine) {
    displayLocked = true
    await display.show(GLASSES.offline)
    throw new Error('No network connection')
  }

  try {
    await connectLiveSession()
  } catch (failure) {
    await teardownSession('connect failed')
    throw failure
  }

  // M5.0 did this and M6 dropped it by accident: a context that has been
  // suspended since boot is never retried otherwise, so the first session of
  // the app can start with audio dead and no attempt to revive it.
  const audioReady = await audioOutput.initialize()
  if (!audioReady) {
    warn('Audio', `not ready at session start (state=${audioOutput.getState()})`)
    setLastEvent('Audio locked — tap Enable Audio on this screen')
  }

  const micStartedAt = performance.now()
  try {
    await microphone.start()
  } catch (failure) {
    await teardownSession('mic failed')
    displayLocked = true
    await display.show(GLASSES.micFailed)
    throw failure
  }
  micStartMs = Math.round(performance.now() - micStartedAt)

  sessionActive = true
  sessionStartedAtMs = performance.now()
  conversation.setState('listening', 'session started')
  setStatus('recording', 'Listening')

  reportStartup()

  // Mint the next token in the background so a reconnect is fast too.
  void prefetchToken()
}

/** Token -> socket -> setupComplete, timed. Leaves `liveSession` set on success. */
async function connectLiveSession() {
  const startedAt = performance.now()
  const token = await takeToken()
  const tokenAt = performance.now()

  const session = createLiveSession()
  liveSession = session

  await session.connect(token)
  const socketAt = performance.now()

  const setupResult = await session.waitForSetupComplete(GEMINI.setupTimeoutMs)
  const setupAt = performance.now()

  connectTimings = {
    tokenMs: Math.round(tokenAt - startedAt),
    socketMs: Math.round(socketAt - tokenAt),
    setupMs: Math.round(setupAt - socketAt),
    totalMs: Math.round(setupAt - startedAt),
  }

  if (!setupResult.ok) {
    throw new Error(setupResult.reason ?? 'Gemini setupComplete failed')
  }

  log(
    'Gemini',
    `connect token=${connectTimings.tokenMs}ms socket=${connectTimings.socketMs}ms ` +
      `setup=${connectTimings.setupMs}ms total=${connectTimings.totalMs}ms`,
  )
}

async function stopSession(showResult: boolean) {
  stopping = true
  sessionActive = false
  reconnecting = false

  const stats = await microphone.stop().catch(failure => {
    warn('G2', 'mic stop failed', failure)
    return latestMicStats
  })

  audioOutput.stop()

  const session = liveSession
  if (session) {
    setLastEvent('Finalizing transcript')
    session.sendAudioStreamEnd()
    await session.waitForFinalTranscript(GEMINI.finalTranscriptTimeoutMs)
    latestGeminiStats = session.getStats()
    closeLiveSession('session stopped')
  }

  stopping = false
  renderDiagnostics('stopped')

  const snapshot = conversation.getSnapshot()

  if (!showResult) {
    conversation.reset('idle')
    return
  }

  conversation.setState('idle', 'stopped by user')
  setStatus('ready', 'Ready')
  setLastEvent(snapshot.responseText ? 'Session ended' : formatMicStats(stats))
  setTranscript(formatTranscript(snapshot))

  // Leave the last answer on the glasses; it is the useful thing to read.
  displayLocked = true
  await display.show(snapshot.responseText ? `Gemini\n${snapshot.responseText.slice(-220)}` : GLASSES.ready)
}

/** Release everything without touching the display or user-facing state. */
async function teardownSession(reason: string) {
  sessionActive = false
  reconnecting = false
  stopping = true

  await microphone.stop().catch(failure => warn('G2', `mic stop during ${reason} failed`, failure))
  audioOutput.clear(reason)
  closeLiveSession(reason)

  stopping = false
}

function closeLiveSession(reason: string) {
  const session = liveSession
  if (!session) return
  liveSession = null
  session.close(reason)
  log('Gemini', `session closed (${reason})`)
}

// ------------------------------------------------------------- reconnect ----

function handleUnexpectedClose(kind: CloseKind) {
  if (!sessionActive || stopping || reconnecting) return

  if (kind === 'fatal') {
    void failSession('Gemini rejected the session; not retrying')
    return
  }

  void beginReconnect(kind === 'auth' ? 'token expired' : 'connection lost')
}

/**
 * Bounded reconnect: three attempts at 500ms / 1s / 2s, each with a freshly
 * minted token, then give up and return to Ready. Never retry forever — a dead
 * network should leave a usable app, not a spinning one.
 *
 * The microphone stays running throughout, so a successful reconnect resumes
 * mid-conversation without another tap. Chunks captured while disconnected are
 * dropped by the session rather than queued.
 */
async function beginReconnect(reason: string) {
  if (!sessionActive || reconnecting || stopping) return

  reconnecting = true
  audioOutput.clear('reconnecting')
  conversation.setState('reconnecting', reason)
  setStatus('connecting', 'Reconnecting')
  setLastEvent(`Reconnecting: ${reason}`)
  warn('Network', `reconnect started (${reason})`)

  for (const [index, delay] of SESSION.reconnectDelaysMs.entries()) {
    if (!sessionActive || stopping) break

    await wait(delay)
    if (!sessionActive || stopping) break

    if (!navigator.onLine) {
      log('Network', `attempt ${index + 1} skipped: still offline`)
      continue
    }

    reconnectCount += 1
    log('Network', `reconnect attempt ${index + 1}/${SESSION.reconnectDelaysMs.length}`)

    try {
      closeLiveSession('reconnect')
      // A fresh token every attempt: uses=1 tokens are consumed by the first
      // connect, and an auth-shaped close means the old one is dead anyway.
      cachedToken = null
      await connectLiveSession()

      reconnecting = false
      conversation.setState('listening', 'reconnected')
      setStatus('recording', 'Listening')
      setLastEvent(`Reconnected after ${index + 1} attempt(s)`)
      log('Network', 'reconnected')
      void prefetchToken()
      return
    } catch (failure) {
      warn('Network', `reconnect attempt ${index + 1} failed`, failure)
    }
  }

  reconnecting = false
  if (sessionActive && !stopping) await failSession('Reconnect attempts exhausted')
}

/** Bounded failure: tear down, say so, and leave the app tappable. */
async function failSession(reason: string) {
  error('Session', `session failed: ${reason}`)
  lastFailure = reason
  await teardownSession('session failed')

  conversation.reset('error')
  setStatus('error', 'Connection failed')
  setLastEvent(reason)
  setTranscript('Connection failed. Tap the glasses once to try again.')
  displayLocked = true
  await display.show(GLASSES.connectionFailed).catch(failure => {
    error('Display', 'failure display failed', failure)
  })
  renderDiagnostics('session failed')
}

// --------------------------------------------------------- host recovery ----

async function recoverFromHostExit(reason: string) {
  if (recovery) return recovery
  recovery = restoreAfterHostExit(reason).finally(() => {
    recovery = null
  })
  return recovery
}

async function restoreAfterHostExit(reason: string) {
  log('G2', `restoring page/audio state after ${reason}`)
  setStatus('connecting', 'Restoring')
  setLastEvent('Host foreground restored; resetting page/audio')

  await teardownSession('host recovery')
  await microphone.resetControl()
  await wait(200)
  await display.restore(GLASSES.ready)

  needsHostRecovery = false
  displayLocked = false
  conversation.reset('idle')
  setStatus('ready', 'Ready')
  setLastEvent('Host recovery complete')
}

// ------------------------------------------------------- Gemini callbacks ----

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
      // Text and audio are independent outputs; queueing never touches the
      // display path or its throttle.
      audioOutput.enqueue(pcm, sampleRate)
    },
    onGenerationComplete() {
      log('Gemini', 'generation complete')
    },
    onTurnComplete() {
      conversation.completeTurn()
      awaitingNextTurn = true
    },
    onInterrupted(detectedAtMs) {
      // Server-side cancellation alone is not enough: audio already handed to
      // Web Audio would keep playing over the user.
      audioOutput.clear('interrupted', detectedAtMs)
      conversation.interrupt()
      awaitingNextTurn = false
    },
    onStats(stats, label) {
      latestGeminiStats = stats
      renderDiagnostics(`gemini ${label}`)
    },
    onError(failure) {
      error('Gemini', 'runtime error', failure)
      lastFailure = failure.message
      setLastEvent(failure.message)
    },
    onClose(event, kind) {
      log('Gemini', `close observed code=${event.code} kind=${kind}`)
      handleUnexpectedClose(kind)
    },
  })
}

/** A new utterance after a completed turn clears the previous answer. */
function beginNextTurnIfNeeded() {
  if (!awaitingNextTurn) return
  awaitingNextTurn = false
  conversation.startTurn()
}

// ----------------------------------------------------------------- tokens ----

async function prefetchToken(): Promise<void> {
  if (cachedToken && performance.now() - cachedToken.fetchedAt < SESSION.tokenMaxAgeMs) return

  try {
    const response = await fetchGeminiEphemeralToken()
    cachedToken = { token: response.token, fetchedAt: performance.now() }
    log('Gemini', 'token prefetched')
  } catch (failure) {
    // Not fatal: the tap path fetches one itself and reports the real error.
    warn('Gemini', `token prefetch failed: ${(failure as Error).message}`)
  }
}

/** Consumes the warm token if it is still inside the issuer's window. */
async function takeToken(): Promise<string> {
  const cached = cachedToken
  cachedToken = null

  if (cached && performance.now() - cached.fetchedAt < SESSION.tokenMaxAgeMs) {
    log('Gemini', 'using prefetched token')
    return cached.token
  }

  const response = await fetchGeminiEphemeralToken()
  return response.token
}

// -------------------------------------------------------------- rendering ----

function renderConversation(snapshot: ConversationSnapshot) {
  setTranscript(formatTranscript(snapshot))
  renderSummary()

  if (displayLocked) return

  switch (snapshot.state) {
    case 'idle':
      display.showStatus(GLASSES.ready)
      return
    case 'connecting':
      display.showStatus(GLASSES.connecting)
      return
    case 'reconnecting':
      display.showStatus(GLASSES.reconnecting)
      return
    case 'thinking':
      display.showStatus(GLASSES.thinking)
      return
    case 'responding':
      // Audio can start before the first transcript fragment arrives.
      if (snapshot.responseText) display.showResponse(snapshot.responseText, true)
      else display.showStatus(GLASSES.speaking)
      return
    case 'listening':
      // Keep the previous answer readable between turns.
      if (snapshot.responseText) display.showResponse(snapshot.responseText, false)
      else display.showStatus(GLASSES.listening)
      return
    case 'error':
      return
  }
}

function renderSummary() {
  const state = conversation.getState()

  setSummary({
    mic: microphone.isRecording ? 'Active' : 'Idle',
    gemini: describeGemini(state),
    audio: describeAudio(latestAudioStats),
    session: formatClock(sessionActive ? performance.now() - sessionStartedAtMs : 0),
  })
}

function describeGemini(state: string): string {
  if (state === 'reconnecting') return `Reconnecting (${reconnectCount})`
  if (liveSession?.isReady) return 'Connected'
  if (liveSession?.isConnected) return 'Connecting'
  if (lastFailure) return 'Error'
  return 'Disconnected'
}

function describeAudio(stats: AudioOutputStats): string {
  switch (stats.state) {
    case 'ready':
      return 'Ready'
    case 'playing':
      return `Playing (${stats.queuedMs} ms queued)`
    case 'locked':
      if (stats.stalled) return 'Stalled — tap Enable Audio to rebuild'
      if (document.visibilityState !== 'visible') return 'Paused by iOS (app not in foreground)'
      return stats.needsGesture ? 'Paused — tap Enable Audio' : 'Starting...'
    case 'error':
      return 'Unavailable — text only'
    default:
      return 'Not initialised'
  }
}

function formatTranscript(snapshot: ConversationSnapshot): string {
  const lines: string[] = []
  const user = snapshot.userText || snapshot.interimUserText

  if (user) lines.push(`You: ${user}`)
  if (snapshot.responseText) lines.push(`Gemini: ${snapshot.responseText}`)

  if (!lines.length) {
    return snapshot.state === 'listening' ? 'Listening...' : 'Tap the glasses once to start a conversation.'
  }

  return lines.join('\n\n')
}

function formatClock(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function formatMicStats(stats: MicrophoneStats): string {
  return `chunks=${stats.chunks}, bytes=${stats.totalBytes}, duration≈${stats.durationSeconds.toFixed(1)}s`
}

function reportStartup() {
  if (startupReported) return
  startupReported = true
  log(
    'Startup',
    `bridge=${bridgeReadyMs}ms token=${connectTimings.tokenMs}ms ` +
      `gemini=${connectTimings.socketMs + connectTimings.setupMs}ms mic=${micStartMs}ms ` +
      `total=${bridgeReadyMs + connectTimings.totalMs + micStartMs}ms`,
  )
}

function renderDiagnostics(label: string) {
  // Skip the string building entirely when the panel is collapsed.
  if (!diagnosticsVisible()) return
  latestAudioStats = audioOutput.getStats()
  setDiagnostics(buildDiagnostics(label))
}

function buildDiagnostics(label: string): string {
  const snapshot = conversation.getSnapshot()
  const displayStats = display.getStats()

  const lines = [
    `[G2 Mic] ${label}`,
    `chunks=${latestMicStats.chunks}`,
    `bytes=${latestMicStats.totalBytes}`,
    `latestChunk=${latestMicStats.latestChunkBytes}`,
    `audioEvents=${latestMicStats.audioEvents}`,
    `missingPcm=${latestMicStats.missingPcmEvents}`,
    `invalidPcm=${latestMicStats.invalidPcmEvents}`,
    `field=${G2_MIC_FIELD}`,
    `format=${G2_MIC_FORMAT}`,
    '',
    '[Session]',
    `state=${snapshot.state}`,
    `turns=${snapshot.turnIndex}`,
    `epoch=${snapshot.turnEpoch}`,
    `reconnects=${reconnectCount}`,
    `online=${navigator.onLine}`,
    `connect=token ${connectTimings.tokenMs}ms / socket ${connectTimings.socketMs}ms / setup ${connectTimings.setupMs}ms`,
    `startup=bridge ${bridgeReadyMs}ms / mic ${micStartMs}ms`,
    '',
    '[Display]',
    `renders=${displayStats.renders}`,
    `failures=${displayStats.failures}`,
    `page=${displayStats.currentPage}/${displayStats.pages}`,
    '',
    '[Audio]',
    `state=${latestAudioStats.state}`,
    `contextRate=${latestAudioStats.contextSampleRate}`,
    `queuedChunks=${latestAudioStats.chunksQueued}`,
    `playedChunks=${latestAudioStats.chunksPlayed}`,
    `droppedChunks=${latestAudioStats.chunksDropped}`,
    `queuedMs=${latestAudioStats.queuedMs}`,
    `scheduled=${latestAudioStats.scheduledSources}`,
    `underruns=${latestAudioStats.underruns}`,
    `cancellations=${latestAudioStats.cancellations}`,
    `interruptions=${latestAudioStats.interruptions}`,
    `needsGesture=${latestAudioStats.needsGesture}`,
    `stalled=${latestAudioStats.stalled}`,
    `contextGeneration=${latestAudioStats.contextGeneration}`,
  ]

  if (latestAudioStats.lastError) lines.push(`audioError=${latestAudioStats.lastError}`)

  lines.push('', '[Gemini]', `model=${GEMINI_LIVE_MODEL}`, `mime=${GEMINI_AUDIO_MIME_TYPE}`, `tokenUrl=${resolveTokenUrl()}`)

  if (latestGeminiStats) {
    lines.push(
      `socketOpened=${latestGeminiStats.socketOpened}`,
      `setupComplete=${latestGeminiStats.setupComplete}`,
      `serverFrames=${latestGeminiStats.serverFrames}`,
      `sentChunks=${latestGeminiStats.audioChunksSent}`,
      `sentBytes=${latestGeminiStats.audioBytesSent}`,
      `dropped=${latestGeminiStats.audioChunksDropped}`,
      `inputFrames=${latestGeminiStats.inputTranscriptFrames}`,
      `outputFrames=${latestGeminiStats.outputTranscriptFrames}`,
      `outputAudioBytes=${latestGeminiStats.outputAudioBytes}`,
      `turnsCompleted=${latestGeminiStats.turnsCompleted}`,
      `interruptions=${latestGeminiStats.interruptions}`,
    )

    if (latestGeminiStats.lastCloseCode !== null) {
      lines.push(`closeCode=${latestGeminiStats.lastCloseCode} (${latestGeminiStats.lastCloseKind})`)
    }
    if (latestGeminiStats.lastCloseReason) lines.push(`closeReason=${latestGeminiStats.lastCloseReason}`)
    if (latestGeminiStats.lastServerError) lines.push(`serverError=${latestGeminiStats.lastServerError}`)
  }

  if (lastFailure) lines.push('', `failure=${lastFailure}`)

  return lines.join('\n')
}

// ----------------------------------------------------------------- cleanup --

/**
 * Idempotent, and the only place resources are released. Every exit path —
 * double tap, system exit, page unload — funnels through here so repeated
 * start/stop cycles cannot leak listeners, timers, sockets or audio nodes.
 */
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true

  sessionActive = false
  stopping = true
  reconnecting = false

  if (clockTimer !== null) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }

  await microphone.stop().catch(failure => warn('G2', 'mic stop during cleanup failed', failure))
  closeLiveSession('cleanup')
  await audioOutput.dispose().catch(failure => warn('Audio', 'dispose failed', failure))
  display.dispose()

  lifecycle.detach()
  window.removeEventListener('offline', onOffline)
  window.removeEventListener('online', onOnline)
  window.removeEventListener('beforeunload', onBeforeUnload)
  unsubscribe()
  unsubscribe = () => {}

  setStatus('exiting', 'Cleaned up')
  log('Session', 'cleaned up')
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
