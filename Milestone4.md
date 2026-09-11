Milestone 3 has been physically validated.

The physical G2 microphone successfully streams audio to Gemini Live, and Gemini correctly produces input transcription from speech captured by the glasses.

Proceed with Milestone 4 only.

# Milestone 4 Goal

Display Gemini's response text on the physical G2 glasses.

Target pipeline:

G2 microphone
    ↓
Gemini Live
    ↓
Gemini model response
    ↓
output transcription
    ↓
G2 display

Do NOT yet implement:

- Gemini native audio playback
- AirPods output
- audio interruption handling on playback
- advanced pagination UX
- long-term memory
- backend AI routing
- RAG
- tools/function calling
- session resumption

Those belong to later milestones.

# Core Requirement

Use Gemini Live's output transcription from the same conversational session already implemented in Milestone 3.

The relevant response path should come from the current Gemini Live protocol / SDK, for example:

serverContent.outputTranscription

or the exact current SDK equivalent.

Do not invent field names.
Inspect the installed SDK/types or official docs if needed.

# Desired Behaviour

Startup:
"Gemini Ready"

First single tap:

1. acquire ephemeral token
2. connect Gemini Live
3. start G2 microphone
4. display:
   "Listening..."

User speaks.

When Gemini starts responding:

display:
"Thinking..."

Then as Gemini response text arrives, render it on G2.

Example:

User:
"What is the capital of Japan?"

G2 should eventually show something like:

"Tokyo is the capital of Japan."

Second single tap:
- stop mic
- close Gemini Live session cleanly
- return to a ready state

Double tap:
- clean shutdown as before

# Display Strategy

Do not send every tiny transcript token to the glasses.

The G2 display should be updated in a BLE-safe, throttled way.

Reuse the official ASR template's display throttling/debounce pattern.

Suggested behaviour:

- accumulate output transcription text in memory
- update the G2 display every ~100–200 ms at most
- avoid redundant updates if the text has not changed
- avoid flooding BLE/display updates

The exact debounce interval should follow the official template conventions where possible.

# Text Handling

For Milestone 4, keep pagination simple.

Preferred first version:

- show only the latest readable block of response text
- wrap naturally
- truncate if necessary
- no complex scrolling UI yet

However, inspect the official `text-heavy` template and Even Voice AI pagination logic as references.

If the response is longer than the visible G2 area, use the simplest safe approach.

Possible options:

1. show the latest N characters/lines;
2. use basic page splitting;
3. show first page only for this milestone.

Prefer the simplest solution that makes the response readable.

Do NOT overbuild full navigation yet.

# Suggested Modules

Keep existing:

src/gemini/live-session.ts
src/gemini/events.ts
src/g2/display.ts
src/g2/microphone.ts
src/g2/gestures.ts
src/state/conversation.ts
src/main.ts

If needed, extend:

src/g2/display.ts

with something like:

showStatus(...)
showResponse(...)
clearResponse(...)

Keep Gemini protocol handling out of display.ts.

# State Model

Add or refine a small conversation state such as:

idle
connecting
listening
thinking
responding
error

Do not create an unnecessarily complex state machine.

Example:

idle
  ↓ tap
connecting
  ↓ connected
listening
  ↓ user speech ends / model begins
thinking
  ↓ output transcription arrives
responding
  ↓ stop
idle

# Model Output

Continue using the same current Gemini Live conversational model from Milestone 3.

Do not switch to a separate text model.

We want the transcript generated from the same live conversational response that will later provide native audio.

# Console Logging

Useful logs:

[Gemini Live] output transcript delta="Tokyo"
[Gemini Live] output transcript delta=" is the capital..."
[G2 Display] response updated chars=32
[G2 Display] response complete

Do not log excessive per-token noise.

Prefer aggregated or meaningful debug logging.

# Error Handling

If Gemini returns no output transcription:

- do not crash
- keep the session alive if possible
- log the issue

If display update fails:

- log the detailed error
- keep Gemini session alive where reasonable

If the session disconnects:

display:
"Gemini disconnected"

# UX Detail

Keep G2 text concise and visually clean.

Suggested statuses:

"Connecting..."
"Listening..."
"Thinking..."
"Gemini:"
<response text>

Avoid verbose diagnostic text on the glasses.

Detailed diagnostics belong in console only.

# Validation

Before stopping:

1. `npm run build` must pass.
2. Preserve Milestone 3 functionality.
3. Give me exact physical test steps.
4. Tell me how output transcription is buffered/throttled.
5. Tell me what happens for long responses.
6. Do not proceed to Milestone 5.

# Physical Acceptance Test

I should be able to:

1. load the app on physical G2;
2. single tap;
3. see "Listening...";
4. say:

   "What is the capital of Japan?"

5. see Gemini's response text appear on the G2;
6. ask another short question in the same session;
7. see the next response update correctly;
8. single tap to stop;
9. double tap to exit cleanly.

# Completion Report

Report:

- files changed
- response-transcription field/API used
- buffering strategy
- display throttling strategy
- long-response behaviour
- state transitions
- build result
- physical G2 test steps
- unresolved display limitations

Do not proceed to Milestone 5 automatically.
