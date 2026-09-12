/**
 * Central configuration — Milestone 6.
 *
 * Everything tunable lives here so behaviour can be adjusted without touching
 * orchestration or protocol code. No secrets: the ephemeral-token flow keeps
 * the API key on the dev issuer, and this file ships to the client.
 */

export const APP_VERSION = '0.1.3-beta'

// ---------------------------------------------------------------- Gemini ----

export const GEMINI = {
  model: 'gemini-3.1-flash-live-preview',
  inputMimeType: 'audio/pcm;rate=16000',
  /** Live API output is always 24 kHz; parsed from the server mimeType anyway. */
  outputSampleRate: 24000,
  tokenFetchTimeoutMs: 8000,
  setupTimeoutMs: 10000,
  openTimeoutMs: 8000,
  /** How long to wait for a last input transcript when stopping. */
  finalTranscriptTimeoutMs: 1600,
} as const

/**
 * Tuned for glasses, not for a chat window.
 *
 * Deliberately NOT an English tutor: Siya practises English with this, but a
 * teacher persona would ruin it as an assistant. It corrects only when asked.
 *
 * Edit freely — nothing else reads this string.
 */
export const SYSTEM_INSTRUCTION = `You are a voice assistant running on Even Realities G2 smart glasses.

How you speak:
- Be conversational and natural, like a knowledgeable friend talking.
- Be concise by default. Two or three sentences is usually right.
- Your answer is spoken aloud and also shown on a very small display, so favour
  short, clear sentences over completeness.
- Never use markdown, bullet points, numbered lists, headings or emoji. Plain
  spoken sentences only.
- Give a longer or more structured answer only when explicitly asked to.
- Do not preface answers with filler like "Sure!", "Great question" or
  "Let me help you with that". Just answer.
- Do not narrate what you are about to do. Do it.
- If you are interrupted, stop cleanly and respond to the new thing. Never
  complain about being interrupted or resume the previous answer.
- If a question is ambiguous, make a sensible assumption and answer it, then
  offer to adjust. Do not open with a clarifying question unless answering is
  genuinely impossible.

Language:
- Reply in whatever language the user speaks. English and Mandarin Chinese are
  both expected, and the user may switch mid-conversation. Follow them
  immediately and without comment.
- Do not correct the user's grammar, pronunciation or word choice unless they
  explicitly ask. If they do ask, explain briefly and naturally.`

/**
 * Voice activity detection. Left at the API defaults deliberately — see the
 * echo note in the Milestone 6 report. Raise startOfSpeechSensitivity only if
 * Gemini's own voice through the AirPods triggers false turns.
 */
export const VAD = {
  disabled: false,
} as const

// --------------------------------------------------------------- Display ----

export const DISPLAY = {
  width: 576,
  height: 288,
  containerId: 1,
  containerName: 'main',
  padding: 4,
  /**
   * 120 ms, from the official ASR template: "BLE render queue is slow".
   * Caps glasses writes at ~8/second however fast Gemini streams.
   */
  debounceMs: 120,
  /**
   * LVGL line height in the EvenHub build, per the text-heavy template.
   */
  lineHeightPx: 27,
  /**
   * Average glyph advance used by the built-in text measurer. The official
   * template uses @evenrealities/pretext for pixel-accurate measurement; if
   * that package is installed, swap the measurer in paginate.ts and delete
   * this. Conservative on purpose — under-filling a page is far better than
   * clipping one.
   */
  averageCharWidthPx: 13,
  /** Reserved for the "Gemini:" heading line. */
  headingLines: 1,
} as const

// ----------------------------------------------------------------- Audio ----

export const AUDIO = {
  /** Lead time so the first chunk of a turn is never scheduled in the past. */
  scheduleLeadSeconds: 0.04,
  /** Warn once the scheduled-but-unplayed backlog passes this. */
  queueWarnMs: 4000,
  /** Beyond this the queue is leaking, not lagging. */
  queueLimitMs: 15000,
  /**
   * The Enable Audio button is only shown after the context has been
   * continuously unusable for this long. iOS flaps the context state while it
   * settles after a screen wake, which made the button flicker.
   */
  gestureHintDelayMs: 900,
} as const

// --------------------------------------------------------------- Session ----

export const SESSION = {
  /**
   * Bounded reconnect. Never retry forever: a dead network should return the
   * app to Ready, not spin.
   */
  reconnectDelaysMs: [500, 1000, 2000],
  /**
   * A prefetched token removes a round trip from the first tap. Must stay
   * under the issuer's new-session window (GEMINI_TOKEN_NEW_SESSION_MINUTES,
   * currently 10 minutes).
   */
  tokenMaxAgeMs: 7 * 60 * 1000,
  /** Phone-UI session timer tick. */
  clockIntervalMs: 1000,
} as const

// ------------------------------------------------------------- Lifecycle ----

/**
 * iOS background behaviour, stated honestly rather than worked around.
 *
 * The Even Hub SDK (0.0.10) exposes `audioControl(isOpen)` for the microphone
 * and NO audio-output API at all, so playback must go through Web Audio inside
 * the WebView. Web Audio is suspended when iOS locks the screen, and a G2 tap
 * cannot resume it because it is not a DOM user gesture.
 *
 * Deliberately NOT attempted: a silent oscillator or looping silent buffer to
 * fake background audio. It does not survive a real iOS audio-session
 * interruption, and it was removed from this app after making recovery worse.
 *
 * Upstream: everything-evenhub issue #26 asks for a native audio-output API,
 * and issue #16 reports iOS terminating the WebView content process under
 * memory pressure while backgrounded.
 */
export const LIFECYCLE = {
  /**
   * Log a full state sample on every lifecycle transition. Cheap, and the only
   * way to know what this WebView really does on a locked phone.
   */
  probe: true,
  /**
   * Periodic sampling while a session runs, in ms. 0 disables it. Set to e.g.
   * 5000 when running the A-D background test matrix.
   */
  sampleIntervalMs: 0,
  /**
   * Shown on the phone so the limitation is stated rather than discovered.
   */
  audioNotice: 'Voice output works while Even is in the foreground. iOS may pause audio when the phone is locked.',
} as const

// ------------------------------------------------------------ Diagnostics ----

export const DIAGNOSTICS = {
  /** Verbose category logging. Behaviour must never depend on this. */
  verbose: import.meta.env.DEV || import.meta.env.VITE_VERBOSE_DIAGNOSTICS === '1',
  /** Show the raw stats panel on the phone. Never on the glasses. */
  showPanel: import.meta.env.DEV || import.meta.env.VITE_SHOW_DIAGNOSTICS === '1',
  /** Cap on raw server frames logged per session. */
  maxLoggedFrames: 6,
} as const
