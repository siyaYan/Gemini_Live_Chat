Milestone 5 has been physically validated.

The full physical loop now works:

G2 microphone
    ↓
Gemini Live
    ├── response text → G2 display
    └── native audio → iPhone → AirPods

I have tested it physically and the experience already feels natural, similar to using Gemini Live directly. I can see and hear the response at the same time.

Proceed with Milestone 6: UX Hardening.

# Milestone 6 Goal

Turn the working prototype into a stable, clean, everyday-usable G2 voice assistant.

This milestone is NOT about adding major new capabilities.

Focus on:

- startup experience
- interaction model
- conversational behaviour
- display readability
- interruption behaviour
- connection recovery
- graceful degradation
- session lifecycle
- diagnostics
- general polish

Do NOT implement yet:

- long-term memory
- Obsidian
- RAG
- Mac mini Personal AI backend
- Claude/Codex Agent HUD
- news
- flashcards
- Morning Briefing
- tool/function calling
- multiple AI providers

Keep this application specifically focused on Gemini Live.

---

# 1. Interaction Model

Review the current tap behaviour and make it intuitive for daily use.

Preferred model:

App opens
    ↓
Ready

Single tap:
    ↓
Start Gemini session
    ↓
Listening

While session is active:

- microphone stays active
- Gemini Live session stays persistent
- multiple conversational turns work naturally
- no tap required between turns

Single tap while active:
    ↓
Stop conversation/session
    ↓
Ready

Double tap:
    ↓
Exit application cleanly

Keep gestures simple.

Do NOT create a complicated gesture vocabulary.

---

# 2. Startup UX

Make startup feel fast and understandable.

Suggested display progression:

Starting...
↓
Connecting...
↓
Listening

If an existing Gemini session can be established quickly, avoid unnecessary intermediate states.

Do not leave stale text from the previous session on screen.

When the app reaches usable state, the user should clearly know it is listening.

Target:

launch → usable conversation with minimal friction.

Measure and log approximate startup timings:

- bridge ready
- token acquired
- Gemini connected
- microphone active

Example:

[Startup]
bridge=120ms
token=180ms
gemini=540ms
mic=80ms
total=920ms

Do not obsess over micro-optimisation yet.

We simply want visibility into where startup latency occurs.

---

# 3. Conversation State

Keep a small explicit state model.

Recommended states:

idle
connecting
listening
thinking
responding
reconnecting
error

Do not introduce unnecessary substates.

State transitions should have a single source of truth.

Avoid unrelated modules independently deciding UI state.

Prefer something like:

conversation state
    ↓
main/orchestrator
    ↓
display + phone UI

---

# 4. G2 Display UX

The glasses should NOT behave like a terminal.

Prioritise glanceability.

Status messages should be extremely short:

Ready
Connecting...
Listening...
Thinking...
Speaking...
Reconnecting...

For Gemini responses:

- show readable natural text
- avoid diagnostic information
- avoid huge blocks
- keep line breaks sensible
- minimise flicker
- avoid changing the screen for every token

Continue using BLE-safe throttling.

---

# 5. Response Display Strategy

Improve the Milestone 4 response handling enough for real use.

Short responses:
display normally.

Longer responses:
implement lightweight pagination.

Use the official Even `text-heavy` template as the primary reference.

Requirements:

- split text into readable pages
- preserve words where possible
- avoid cutting in the middle of words
- page size should match practical G2 readability
- do not build a complex document reader

Automatic behaviour may be:

while Gemini is speaking:
show the most relevant/current response page

after response completes:
allow simple page navigation if necessary

If gestures required for pagination would conflict with start/stop conversation, prefer automatic paging or another minimal strategy.

Do not make UX overly complicated just to support rare very-long responses.

Gemini should normally be prompted to remain concise anyway.

---

# 6. System Instruction / Conversation Style

Tune Gemini specifically for glasses.

Create a clear system instruction approximately along these principles:

- natural conversational assistant
- concise by default
- answer conversationally
- prioritise spoken usefulness
- responses should usually be short enough for a small glasses display
- avoid markdown-heavy formatting
- avoid unnecessarily long lists
- expand only when explicitly requested
- be comfortable with interruption
- do not announce every action
- use natural spoken phrasing

I am also using this assistant partly to practise English.

Do NOT make it behave like an English teacher by default.

It should converse naturally.

If I ask for language correction or explanation, then it may teach.

Keep the system instruction in one clearly identifiable configuration location so we can tune it later without modifying core logic.

---

# 7. Language Behaviour

The assistant should naturally support both English and Chinese.

It should normally respond in the language I use.

If I switch languages during a conversation, Gemini should follow naturally.

Do not force a fixed language.

No separate translation layer is required.

---

# 8. Interruption / Barge-In Hardening

Milestone 5 already supports interruption.

Now make it robust.

When I begin speaking while Gemini is talking:

1. Gemini server interruption occurs.
2. current audio source stops.
3. queued audio is cleared.
4. playback cursor resets.
5. stale output transcript should stop updating.
6. new user speech becomes the active turn.

Ensure old response audio never resumes after interruption.

Log interruption latency approximately:

user speech / interruption detected
→ local audio stopped

Example:

[Interruption] playback stopped in 85ms

No need for laboratory-precision measurement.

We just want to identify obviously bad delays.

---

# 9. Avoid Self-Hearing / Echo Problems

Review whether Gemini's AirPods audio could leak back into the G2 microphone.

In normal AirPods use this may be limited, but we should protect the system where practical.

Do NOT build complex DSP.

Inspect:

- Gemini Live echo handling
- VAD behaviour
- whether audio output causes false microphone turns

If current behaviour is already stable, document that and do not over-engineer it.

If false turns occur, implement the smallest safe mitigation.

Do not simply mute the microphone whenever Gemini speaks because that would break natural interruption.

---

# 10. Connection Recovery

This is important for daily use.

Handle temporary Gemini disconnects gracefully.

If Live WebSocket unexpectedly closes:

display:

Reconnecting...

Attempt a small bounded reconnect strategy.

Example:

retry 1
wait 500ms

retry 2
wait 1s

retry 3
wait 2s

Do NOT retry forever.

After maximum attempts:

display:

Connection failed

Return the app to a usable Ready state where the user can tap to try again.

Do not require killing the Even Hub app after a network failure.

---

# 11. Token Expiry

Review the ephemeral-token lifetime and Live session lifetime.

If the token/session expires during normal use:

- detect it cleanly
- obtain a new ephemeral token
- reconnect if appropriate

Do not expose token details.

Do not refresh continuously when unnecessary.

Keep the implementation aligned with current Gemini Live token semantics.

---

# 12. Network Changes

Handle likely mobile situations:

Wi-Fi → cellular
cellular → Wi-Fi
temporary loss of connectivity

The app does not need seamless enterprise-grade handover.

But it should:

- detect connection loss
- stop stale audio playback
- avoid crashing
- attempt bounded reconnect
- show a meaningful status

---

# 13. Audio Reliability

Review the Milestone 5 playback implementation for:

- clicks
- gaps
- growing latency
- queue buildup
- AudioContext suspension
- long-session resource leaks

Keep lightweight metrics:

queued ms
playback latency estimate
underruns
interrupt clears

Do not log every audio packet.

If queue growth exceeds a reasonable threshold, log a warning.

Do not aggressively drop valid Gemini speech under normal conditions.

---

# 14. iOS Audio Unlock

Keep the audio-unlock flow as frictionless as possible.

If iOS requires:

Enable Audio

then:

- require it at most once per relevant app lifecycle
- clearly indicate whether audio is ready
- do not ask before every conversation

If the current G2/user gesture reliably unlocks audio in the Even WebView, prefer removing unnecessary phone interaction.

But verify physically rather than assuming.

---

# 15. Graceful Degradation

The assistant should remain useful when one component fails.

Examples:

Gemini audio fails but text works:
→ keep displaying text

G2 display update fails but audio works:
→ keep voice conversation running

mic fails:
→ stop session and show microphone error

token server unavailable:
→ show connection error and return to Ready

Avoid one subsystem failure killing everything unnecessarily.

---

# 16. Session Cleanup

Audit all cleanup paths.

On normal stop:

- stop G2 microphone
- close Gemini Live session
- clear audio buffers
- stop playback
- reset transcript state
- reset display
- release unnecessary resources

On double-tap exit:

perform full cleanup before:

shutDownPageContainer(...)

On connection error:

ensure old websocket/audio resources are not left alive.

Repeated:

start → stop → start → stop

must work without duplicate listeners or duplicated audio.

This should be physically tested multiple times.

---

# 17. Phone Companion UI

Keep the phone UI useful for debugging but visually minimal.

Suggested information:

G2 Mic: Active
Gemini: Connected
Audio: Ready
Session: 01:42

Optional development-only diagnostics:

sent audio
playback queue
reconnect count

Do not place technical debugging information on the G2.

If possible, separate normal UI from development diagnostics cleanly.

---

# 18. Config Module

Create a central configuration file if one does not already exist.

For example:

src/config.ts

Possible configuration:

- Gemini model
- system instruction
- display debounce
- response page length
- reconnect delays
- maximum reconnect attempts
- diagnostic logging flag

Avoid magic constants scattered across modules.

Do NOT put secrets in this config.

---

# 19. Development Logging

Introduce lightweight structured log categories if useful:

[G2]
[Gemini]
[Audio]
[Display]
[Session]
[Network]

Do not build a logging framework.

Simple helper functions are enough.

Production-facing behaviour should not depend on console logs.

---

# 20. Long-Session Test

I want this app to survive actual daily usage.

Do a code-level review for:

- event-listener leaks
- WebSocket leaks
- AudioContext leaks
- timers not cancelled
- duplicated G2 listeners
- unbounded transcript buffers
- unbounded audio queues

Do not attempt artificial multi-hour automated testing unless easy.

But structure the code so repeated and longer sessions are safe.

---

# Physical Acceptance Tests

Before declaring Milestone 6 complete, give me a checklist for these physical tests.

## Test A — Normal Conversation

Start app.

Ask:

"What's something interesting I could do this weekend?"

Verify:

- natural answer
- audio through AirPods
- text on G2
- return to Listening automatically

Ask another question without restarting.

---

## Test B — Interruption

Ask a question likely to generate a longer answer.

Interrupt Gemini mid-sentence.

Verify:

- audio stops quickly
- stale text stops
- new question is understood
- new response begins correctly

---

## Test C — Multiple Start/Stop

Perform:

start
talk
stop

five times.

Verify:

- no duplicate responses
- no duplicated audio
- no microphone failure
- no increasing latency

---

## Test D — Connection Failure

During an active session:

temporarily disable network connectivity.

Verify:

- app does not crash
- playback stops appropriately
- G2 displays Reconnecting...
- bounded reconnect occurs

Restore connectivity.

Verify app recovers or cleanly allows a new session.

---

## Test E — AirPods

Start with AirPods connected.

Verify audio goes to AirPods.

Change iPhone audio route if practical.

Verify app follows normal iOS routing and does not depend on hardcoded output devices.

---

## Test F — Long Response

Ask:

"Explain how a neural network learns, but give me a reasonably detailed explanation."

Verify:

- display remains readable
- pagination/truncation behaves properly
- BLE updates do not flicker excessively
- audio remains natural

---

## Test G — Language Switching

Say something in English.

Then switch to Chinese.

Then switch back to English.

Verify Gemini follows naturally without reconnecting.

---

# Acceptance Criteria

Milestone 6 is complete when the app feels like a small product rather than a technical demo.

Required:

- fast understandable startup
- natural persistent conversation
- reliable G2 text
- reliable AirPods audio
- clean interruption
- reasonable long-response handling
- bounded reconnect
- repeated start/stop stability
- graceful partial failure
- clean resource lifecycle
- central configuration
- concise glasses-oriented Gemini behaviour

No new major feature domains should be added.

---

# Completion Report

When finished, report:

1. files changed
2. final interaction model
3. conversation states
4. system instruction
5. display/pagination behaviour
6. reconnect strategy
7. token/session expiry handling
8. interruption improvements
9. audio reliability changes
10. cleanup/resource lifecycle
11. graceful degradation behaviour
12. build result
13. physical test checklist
14. remaining known limitations

Do NOT proceed automatically to memory, Personal AI backend, Agent HUD, RAG, or other Action Items.
