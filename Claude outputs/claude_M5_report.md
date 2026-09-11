# Milestone 5 — Gemini native audio to the iPhone / AirPods

Date: 2026-09-11 · same Live session as M3/M4, no protocol change.

## Files changed

| File | Why |
| --- | --- |
| `src/audio/output.ts` | **new** — Web Audio playback: PCM conversion, scheduling cursor, queue safety, iOS unlock |
| `src/gemini/live-session.ts` | decodes `modelTurn` audio parts and forwards raw PCM + declared sample rate |
| `src/ui.ts` | Audio output status row and an `Enable Audio` button |
| `src/main.ts` | coordinates the two, cancels playback on interrupt, audio diagnostics |

Milestone 4's text path is untouched: display throttling, accumulation and state
mapping are exactly as validated. Audio was added as a parallel output, not
threaded through the display path.

## Audio format (verified, not assumed)

Current Live API docs: output is "raw, little-endian, 16-bit PCM" and "audio
output always uses a sample rate of 24kHz", delivered base64-encoded in
`serverContent.modelTurn.parts[].inlineData`.

Rather than hardcoding 24000, `live-session.ts` parses `rate=` out of the part's
`mimeType` and falls back to `GEMINI_OUTPUT_SAMPLE_RATE = 24000` only if absent.
If Google changes the rate, playback follows it.

## PCM conversion

```ts
const frames = Math.floor(pcm.byteLength / 2)
const buffer = context.createBuffer(1, frames, sampleRate)   // 24 kHz, not the context rate
const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2)
for (let i = 0; i < frames; i += 1) {
  channel[i] = view.getInt16(i * 2, true) / 32768
}
```

Three deliberate choices:

- **`DataView` with an explicit little-endian flag**, not `Int16Array` — the
  typed array would inherit the platform byte order.
- **`pcm.byteOffset` is passed.** The bytes come from a `Uint8Array` that may be
  a view into a larger buffer; ignoring the offset is the classic way to get
  static instead of speech.
- **Divide by 32768, not 32767** — this maps −32768 to exactly −1.0 and cannot
  overflow the [−1, 1] range.

Verified numerically in the cloud workspace:

```
direct : 0.000000 0.999969 -1.000000 0.000031 -0.000031
offset : 0.000000 0.999969 -1.000000 0.000031 -0.000031   (byteOffset 4)
odd len: 5 bytes -> 2 frames                              (no read past end)
chunk 4800 bytes -> 100.0 ms at 24 kHz
```

## AudioContext sample rate

The context is created with **no** explicit `sampleRate`. iOS may refuse or
silently ignore a forced rate, and a mismatch between the requested and actual
rate is a common source of chipmunk audio.

Instead the context runs at hardware rate (typically 48000, sometimes 44100) and
each `AudioBuffer` is created at the server's 24000. Web Audio resamples the
buffer natively on playback — browser-native resampling, as the milestone
prefers, with no hand-written interpolation. The actual rate is logged and shown
in the phone panel as `contextRate`.

## Playback queue

A single playback cursor, not a bare `start()` per packet:

```ts
const startAt = Math.max(context.currentTime + SCHEDULE_LEAD_SECONDS, this.nextPlaybackTime)
source.start(startAt)
this.nextPlaybackTime = startAt + buffer.duration
```

`SCHEDULE_LEAD_SECONDS` is 40 ms — enough that the first chunk of a turn is not
scheduled in the past when the context clock has moved past the cursor. The
`max()` is what prevents both overlap and gaps. Simulated:

```
fast arrival : 10.040 10.140 10.240 10.340   gapless = true
slow arrival : 10.040 10.540 11.040          never scheduled in the past = true
```

Backpressure, without dropping healthy packets:

- `queuedMs` = scheduled-but-unplayed time = `nextPlaybackTime - currentTime`
- above **4 s** → one warning per backlog episode (not per chunk)
- above **15 s** → chunks are dropped and counted in `droppedChunks`; that is
  leak territory, not lag
- chunks arriving while the context is suspended are dropped rather than banked,
  so unlocking never dumps a minute of stale answers at once

## iOS audio unlock

**A G2 tap does not grant user activation.** It arrives over the Even Hub bridge
as a JS callback, not a DOM UI event, so `AudioContext.resume()` from inside it
leaves the context suspended on iOS. This was worth checking rather than
assuming, and it decides the whole design.

So:

1. The context is created at app start; if it comes up suspended, state is
   `locked` and the phone shows `Enable Audio`.
2. One press of that button — a real DOM gesture — calls `resume()` plus a
   zero-length silent buffer (the long-standing WebKit nudge).
3. `attachGestureUnlock()` also listens once for any `touchend`/`mousedown` on
   the phone UI, so an incidental tap unlocks audio and the button is never
   needed.
4. Once running, it stays running for the session — one-time setup, not a tap
   per response.

## Interruption / barge-in

On `serverContent.interrupted`:

```
audioOutput.clear('interrupted')   // stop() every scheduled source, drop them
conversation.interrupt()           // discard the partial answer text
nextPlaybackTime = context.currentTime
```

Server-side cancellation alone is insufficient — audio already handed to Web
Audio keeps playing over the user. `clear()` calls `stop()` on every live
`AudioBufferSourceNode`, empties the set, and resets the cursor so the next turn
starts immediately rather than behind the discarded answer. Logged as
`[Audio] playback cancelled sources=N reason=interrupted` alongside
`[Gemini Live] interrupted`.

## Failure behaviour

Audio never takes the conversation down:

- no Web Audio in the WebView → state `error`, phone shows "Audio unavailable —
  continuing text-only", G2 text keeps working
- context creation or `resume()` throws → same
- context suspended → `locked`, chunks dropped, text unaffected
- malformed or sub-2-byte chunk → counted, logged once, skipped
- Gemini disconnects → M4 behaviour unchanged, playback cleared

`initialize()` returns a boolean the caller is free to ignore, which is the
point: there is no path where a dead AudioContext prevents the session starting.

## Build result

`tsc --noEmit --strict` passes on all four files (stubbed SDK types in the cloud
workspace). **`npm run build` still needs running on the Mac** — the device's
local Linux workspace has not started in any of these sessions, so nothing can
be executed there.

## Physical test procedure

Setup: G2 paired, AirPods connected **and selected as the iPhone output**, token
server and `npm run dev:host` running.

1. Load the app. Phone panel shows Audio: `Locked` or `Ready`.
2. If `Locked`, press **Enable Audio** once → `Ready (context 48000 Hz)`.
3. Single tap the G2 → `Listening...`
4. "Hi Gemini, tell me something interesting about Canberra in two sentences."
   → text on the glasses **and** voice in the AirPods.
5. Without tapping: "Can you make that shorter?" → context carried over, no
   reconnect (`turnsCompleted` increments, `socketOpened` unchanged).
6. While it is speaking: "Actually, stop. Tell me about Melbourne instead."
   → speech must cut off within a fraction of a second. Watch `cancellations`
   increment and `queuedMs` drop to ~0.
7. Single tap → mic stops, playback stops, last answer stays on the glasses.
8. Double tap ×2 → clean exit; `[Audio] AudioContext closed` in the console.

Panel fields worth watching: `state`, `contextRate`, `queuedMs` (should hover
low — hundreds of ms, not seconds), `droppedChunks` (should stay 0),
`cancellations` (only after a barge-in).

## AirPods routing

The app does not select an output device and has no Bluetooth UI. It plays into
the WebView's audio output; iOS routes that to whatever the phone currently has
selected. AirPods selected on the phone → Gemini's voice in the AirPods. Change
the output mid-session and iOS follows, with no app involvement.

## Unresolved limitations

- **Unlock is unverified on hardware.** Whether the Even Hub WebView starts the
  context suspended at all is unknown until tested; both paths are handled, but
  which one fires is a real question for the physical run.
- **Echo.** The G2 mic keeps streaming while Gemini speaks through the AirPods.
  With AirPods this should be fine, but on speaker Gemini may hear itself and
  self-interrupt. Real barge-in tuning is Milestone 6.
- **Backlog thresholds (4 s / 15 s) are guesses** with no hardware measurement
  behind them. If `droppedChunks` ever moves during a normal turn, they are too
  tight.
- **First-chunk latency** is at least the 40 ms scheduling lead plus network.
  Not tuned.
- **`sampleRate` is per chunk but the cursor is shared** — if Gemini ever mixed
  rates mid-turn the durations would still be right, but this is untested and
  unlikely to occur.
