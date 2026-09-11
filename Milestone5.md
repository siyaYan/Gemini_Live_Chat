Milestone 4 has been physically validated.

The current app can:

- capture physical G2 microphone audio
- stream G2 PCM to Gemini Live
- receive input transcription
- receive Gemini output transcription
- display Gemini response text on the physical G2

Proceed with Milestone 5 only.

# Milestone 5 Goal

Play Gemini Live's native audio response through the iPhone's currently selected audio output.

Target:

G2 microphone
    ↓
Gemini Live
    ├── output transcription → G2 display
    └── native PCM audio → iPhone → AirPods

The desired experience is:

I speak through the G2 microphone.
Gemini responds naturally.
I can read the response on G2.
I can simultaneously hear Gemini through AirPods.

Do NOT add:

- long-term memory
- RAG
- tools/function calling
- Mac mini Personal AI backend
- agent HUD
- news
- flashcards
- Morning Briefing
- model routing

Those are future phases.

# Important Architectural Principle

Do NOT convert Gemini's response to text and then run TTS.

Gemini Live already provides native audio.

Use the native Gemini Live audio stream directly.

Current expected model output format from our proven Python prototype:

- PCM signed 16-bit
- mono
- 24 kHz

Verify the exact current SDK/protocol behaviour rather than assuming blindly.

# Existing Pipeline

Milestone 4 already receives both:

- output transcription
- model audio content

Preserve the text path exactly:

Gemini output transcription
    ↓
buffer/throttle
    ↓
G2 display

Add the audio path independently:

Gemini native PCM
    ↓
audio playback queue
    ↓
WebView/iPhone audio output

Do not couple display timing to audio playback timing.

# New Module

Add approximately:

src/audio/output.ts

Responsibilities:

- initialise browser/WebView audio playback
- accept raw PCM chunks
- queue them in order
- convert PCM16 little-endian to a Web Audio-compatible representation
- play at 24 kHz
- minimise gaps between chunks
- stop/cancel immediately when needed
- expose lifecycle methods such as:

initialize()
enqueue(chunk)
start()
stop()
clear()
dispose()

Use names that fit the existing project architecture.

Do NOT put playback implementation inside Gemini Live protocol code.

`live-session.ts` should emit/forward audio data.

`output.ts` should only care about playback.

`main.ts` should coordinate them.

# Preferred Playback Technology

Inspect the current Even Hub runtime / WebView capabilities first.

Prefer browser-native Web Audio API.

Possible implementation:

AudioContext
    ↓
PCM16 → Float32
    ↓
AudioBuffer / scheduled playback

For the first implementation, a correctly scheduled AudioBuffer queue is acceptable.

Do NOT over-engineer AudioWorklet unless required for stable low-latency playback.

However, avoid naïvely calling `source.start()` independently for every packet, which may introduce gaps/clicks.

Maintain a playback cursor such as:

nextPlaybackTime

and schedule each buffer immediately after the previous one.

Conceptually:

nextPlaybackTime =
    max(audioContext.currentTime, nextPlaybackTime)

source.start(nextPlaybackTime)

nextPlaybackTime += buffer.duration

# PCM Conversion

Gemini output is expected to be:

PCM signed 16-bit little-endian

Convert each sample approximately as:

int16 / 32768.0

into Float32 values in [-1, 1].

Do not alter sample ordering.

Do not accidentally interpret the data as big-endian.

Do not resample unless the browser/WebView forces it.

If AudioContext internally runs at another rate such as 44.1 or 48 kHz, inspect whether creating a 24 kHz AudioBuffer is automatically resampled safely by Web Audio.

Prefer browser-native resampling rather than implementing our own unless necessary.

# AirPods Routing

The app should NOT attempt to select AirPods itself.

Expected behaviour:

iPhone audio output selection
    ↓
Even Hub WebView audio
    ↓
currently active iOS output device

If AirPods are selected on the iPhone, Gemini audio should route to AirPods.

Document this clearly.

Do not build Bluetooth-device-selection UI.

# Important iOS / WebView Constraint

Investigate audio autoplay / AudioContext restrictions.

iOS WebViews may require a user interaction before audio playback is allowed.

We already have user interaction from:

- G2 single tap
- phone companion UI

But verify whether a G2 gesture counts as browser user activation.

Do not assume it does.

Implement a clean audio-unlock mechanism if required.

For example, the phone UI may show:

"Enable Audio"

The user taps it once.

Then:

audioContext.resume()

After that, normal Gemini audio playback should work.

If audio can be unlocked reliably from the existing interaction flow, avoid adding unnecessary UI.

The goal is:

one-time setup at most,
not requiring a phone tap for every response.

# State Integration

Existing states may include:

idle
connecting
listening
thinking
responding
error

Milestone 5 should distinguish logically between:

model responding
audio actually playing

but do not create an overly complex state machine.

A possible UX:

Listening...
    ↓
Thinking...
    ↓
Gemini response text appears
    +
native audio plays

After response completes:
return to Listening...

because this should remain a continuous Live conversation.

Do not automatically close the session after every response.

# Continuous Conversation

Preserve the existing persistent Gemini Live session.

Expected loop:

user speaks
↓
Gemini answers
↓
user speaks again
↓
Gemini answers again

No reconnect between normal turns.

# CRITICAL: Interruption / Barge-In

This milestone should also correctly handle Gemini interruption events.

When I start speaking while Gemini is talking:

1. Gemini Live detects interruption.
2. server/model generation is interrupted.
3. local buffered playback must ALSO stop immediately.

It is not enough for the server to stop generation while previously received audio continues playing.

On interruption:

audioOutput.clear()
audioOutput.stopCurrentPlayback()

Reset scheduling state:

nextPlaybackTime = audioContext.currentTime

Then continue receiving/sending Live audio normally.

Log something like:

[Gemini Live] interrupted
[Audio] playback cancelled

This is essential for a natural voice-assistant experience.

# Audio Backpressure / Queue Safety

Prevent an unbounded playback queue.

Track useful values such as:

queued chunks
queued milliseconds
played chunks

Gemini should normally stream near real time, but if playback falls behind significantly:

- log a warning
- avoid allowing unlimited memory growth

Do not prematurely drop normal audio packets.

A simple bounded queue / scheduling guard is enough.

# Start / Stop Lifecycle

First single tap when idle:

1. acquire ephemeral token
2. connect Gemini Live
3. initialise/resume audio output
4. start G2 microphone
5. show:
   "Listening..."

During conversation:

G2 mic → Gemini
Gemini text → G2
Gemini audio → AirPods

Second single tap / explicit stop:

1. stop G2 microphone
2. stop/clear audio playback
3. close Gemini session
4. release audio resources if appropriate
5. return to ready state

Double tap / app exit:

1. stop G2 microphone
2. cancel playback immediately
3. close Gemini session
4. dispose AudioContext/resources
5. shut down Even page cleanly

# Display Behaviour

Preserve Milestone 4 display throttling.

The audio path must not cause extra BLE display updates.

Text and audio should be treated as two parallel outputs:

Gemini
├── text → G2
└── audio → phone

Do not try to synchronise every spoken word with every displayed word.

Near-simultaneous streaming is enough.

# Logging

Useful logs:

[Audio] AudioContext initialised sampleRate=48000
[Audio] playback unlocked
[Gemini Live] audio chunk bytes=4800
[Audio] queued duration=100ms
[Audio] playback started
[Audio] playback queue=220ms
[Gemini Live] interrupted
[Audio] playback cancelled

Avoid:

- raw PCM arrays
- logging every single tiny chunk
- ephemeral token values
- API keys

Aggregate frequent audio diagnostics.

# Error Handling

Handle gracefully:

- AudioContext creation fails
- AudioContext is suspended
- iOS refuses playback before user interaction
- malformed audio chunk
- Gemini disconnect
- playback underrun
- playback queue reset

If audio fails but Gemini text is still working:

DO NOT kill the entire conversation.

Continue showing text on G2.

Phone UI can indicate:

"Audio unavailable"

This is important:

audio failure should degrade to text-only mode rather than crash the assistant.

# Phone Companion UI

Keep it minimal.

Useful indicators:

Gemini: Connected
G2 Mic: Active
Audio: Ready / Locked / Playing / Error

If iOS requires manual audio activation:

show one button:

Enable Audio

Do not redesign the entire UI.

# Security

Preserve the Milestone 3 ephemeral-token architecture.

Do NOT move the permanent Gemini API key into the client for convenience.

Do NOT log ephemeral tokens.

# Validation

Before stopping:

1. `npm run build` passes.
2. Existing Milestones 1–4 still work.
3. Explain exactly how PCM playback is implemented.
4. Explain how iOS audio unlock is handled.
5. Explain how interruption clears buffered audio.
6. Give exact physical test steps.
7. Do not proceed to future Personal AI features.

# Physical Acceptance Test

Test setup:

- G2 connected to iPhone
- AirPods connected to iPhone
- AirPods selected as iPhone audio output
- Even Hub prototype loaded

Test:

1. Launch G2 Gemini Live.
2. Enable audio once on phone if required.
3. Single tap G2.
4. See:
   "Listening..."
5. Say:

   "Hi Gemini, tell me something interesting about Canberra in two sentences."

6. Verify:

   - G2 microphone captures speech
   - Gemini understands speech
   - response text appears on G2
   - Gemini native voice plays through AirPods

7. Ask a second question WITHOUT reconnecting:

   "Can you make that shorter?"

8. Verify persistent conversational context.

9. While Gemini is speaking, interrupt:

   "Actually, stop. Tell me about Melbourne instead."

10. Verify:

   - current Gemini speech stops quickly
   - buffered old audio does not continue
   - Gemini responds to the new request
   - new text appears on G2
   - new audio plays through AirPods

11. Stop the session.

12. Double tap and verify clean app shutdown.

# Acceptance Criteria

Milestone 5 is complete when this full physical loop works:

G2 mic
   ↓
Gemini Live
   ├── text → G2 ✅
   └── native voice → AirPods ✅

plus:

continuous multi-turn ✅
interruption stops local playback ✅
no permanent API key in client ✅

# Completion Report

Report:

- files changed
- audio playback implementation
- PCM conversion details
- AudioContext sample-rate behaviour
- AirPods/iOS routing behaviour
- audio-unlock behaviour
- playback queue strategy
- interruption/cancellation implementation
- fallback behaviour if audio fails
- build result
- physical test procedure
- unresolved iOS/Even WebView limitations

Do not proceed to the next project phase automatically.
