Milestone 1 has been physically validated on my Even Reality G2.

The custom text rendered correctly and the tap interaction worked on the physical glasses.

Proceed with Milestone 2 only.

# Milestone 2 Goal

Prove that the physical G2 microphone audio can be captured reliably by our app.

Target pipeline:

G2 microphone
    ↓
Even Hub SDK audio stream
    ↓
audioPcm
    ↓
our microphone module
    ↓
diagnostic logging / validation

DO NOT connect Gemini yet.

Do not implement:
- Gemini Live
- API keys
- backend
- audio playback
- transcription
- AI responses
- long-term memory

# Important SDK Requirement

Use the current official Even Hub ASR template as the source of truth.

The previous architecture review established that the correct audio field is:

audioEvent.audioPcm

Do NOT reuse Even Voice AI's older:

audioEvent.data

Also continue using safe event routing with explicit event type handling.

# Desired Code Structure

Add approximately:

src/g2/microphone.ts

Keep:

src/main.ts

as orchestration only.

`microphone.ts` should own:

- enabling G2 microphone/audio capture
- receiving PCM events
- validating incoming chunks
- microphone start/stop lifecycle
- diagnostic statistics

Do not over-engineer it.

# Physical Test Behaviour

Add a simple interaction for testing.

Suggested flow:

Startup:
"G2 Gemini Live
Mic Test Ready"

Single tap:
start microphone capture

Display:
"Listening..."

Second single tap:
stop microphone capture

Display a short result such as:

"Mic OK
Chunks: 328"

or equivalent.

If this conflicts with existing Milestone 1 tap behaviour, refactor the tap state cleanly rather than adding hacks.

Double tap should still exit cleanly.

# Diagnostic Logging

While recording, log useful information without flooding the app.

Implementation note after physical testing:

- The Even app runs this WebView inside the Even companion app, so browser/Safari console inspection is not a reliable validation path.
- Keep console logs for development when available.
- Also show the same aggregated microphone diagnostics directly inside the Even companion UI under a `Mic diagnostics` panel.
- This panel is the primary physical-device validation surface.

I want to verify:

- audio events are actually arriving
- `audioPcm` exists
- chunk byte length
- number of chunks
- total bytes received
- approximate duration
- expected PCM format according to the SDK/template

Prefer aggregated logs, for example once per second, rather than logging every packet.

Example:

[G2 Mic]
chunks=84
bytes=26880
latestChunk=320
duration≈1.0s

Do not log raw PCM arrays continuously.

# Physical Validation Update

Physical Milestone 2 testing confirmed:

- The app renders and tap gestures still work on the physical G2.
- First single tap starts capture.
- Second single tap stops capture.
- The app reports `Mic OK` with nonzero chunk counts.
- The in-app diagnostics panel shows live aggregate values such as:

```
[G2 Mic] recording
chunks=84
bytes=26880
latestChunk=320
duration≈1.0s
audioEvents=84
missingPcm=0
invalidPcm=0
field=event.audioEvent.audioPcm
format=PCM signed 16-bit little-endian, mono, 16 kHz
```

# Exit Cancel Bugfix

Physical testing also found:

- If the user double tapped to open the Even exit confirmation dialog,
- then canceled exit,
- then single tapped again,
- microphone capture could fail or the app could remain in an exit-oriented state.

Required fix:

- Treat double tap as an exit request, not as final cleanup.
- Do not permanently unsubscribe the event listener just because an exit request was opened.
- If the user cancels/abandons the exit dialog and interacts again, restore the Milestone 2 mic-test state before starting capture.
- Confirmed exit should still stop the microphone and unload/exit cleanly.

Follow-up physical test finding:

- After the Even exit dialog was opened and canceled, the app could receive `FOREGROUND_EXIT_EVENT`.
- A later single tap could then fail with `audioControl(true) returned false`.
- This indicates the Even host/page/audio state may remain stale even though the WebView is still visible.

Follow-up recovery patch:

- Mark the page as needing restore after double tap and after `FOREGROUND_EXIT_EVENT`.
- On foreground return or next single tap, reset audio with `audioControl(false)` before retrying microphone capture.
- Force the G2 page container to be recreated before starting capture again.
- If the first `audioControl(true)` returns false, reset audio once, wait briefly, and retry once.
- Show single-tap failures in the in-app `Last event` panel instead of leaving a stale event message.

Second follow-up physical test finding:

- The same `audioControl(true) returned false` behavior can persist after the host exit dialog is opened and canceled.
- The official templates call `shutDownPageContainer(1)` for double-tap exit, but they do not handle a canceled exit dialog and resumed microphone capture.
- The installed SDK documents `createStartUpPageContainer` as the startup-only call and `rebuildPageContainer` as the later page rebuild call.

Second follow-up recovery patch:

- Replace the first double-tap host exit dialog with an in-app exit confirmation.
- First double tap now arms exit and shows: tap to cancel/start mic, double tap again to quit.
- Single tap while exit is armed cancels the local exit state and starts microphone capture without entering the host cancel path.
- Second double tap performs the actual exit with `shutDownPageContainer(0)`.
- Host foreground recovery now uses `rebuildPageContainer` before falling back to startup create/text upgrade.

Physical validation update:

- The soft-exit flow avoids the earlier microphone restart failure.
- Adjust the selection UX so exit confirmation behaves like:
  - Single tap = No/cancel only, return to ready.
  - Double tap = Yes/exit.
  - After canceling, a second single tap starts microphone capture.

# Audio Format

Inspect the installed/current official SDK/template and confirm the actual format.

We expect approximately:

- PCM signed 16-bit little-endian
- mono
- 16 kHz

But verify this from the current Even SDK/template rather than assuming it.

Report any discrepancy.

# Optional Useful Validation

If straightforward, add a DEVELOPMENT-ONLY way to collect a few seconds of PCM and export/save it for inspection.

Do not spend significant time on this if the Even Hub environment makes file export awkward.

The primary acceptance criterion is real PCM arriving reliably from the physical glasses.

# Permissions

Update `app.json` only with the minimum microphone/audio permission required by the current Even Hub SDK.

Do not add unrelated permissions.

# Validation

Before stopping:

1. `npm run build` must pass.
2. Tell me exactly how to load the updated prototype on the physical G2.
3. Give me the expected console output.
4. Give me a short physical test checklist.
5. Do not proceed to Milestone 3.

# Completion Report

When finished, report:

- files changed
- SDK APIs used
- microphone start/stop lifecycle
- confirmed PCM field
- confirmed audio format
- build result
- exact physical-G2 testing steps
- unresolved SDK/device issues
