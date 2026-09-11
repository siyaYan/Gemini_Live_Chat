Milestone 2 has been physically validated on the G2.

The physical glasses microphone is successfully producing:

- event.audioEvent.audioPcm
- PCM signed 16-bit little-endian
- mono
- 16 kHz
- real non-zero audio chunks

Node has also been updated to the supported version.

Proceed with Milestone 3 only.

# Milestone 3 Goal

Connect the physical G2 microphone stream to Gemini Live and prove that Gemini can correctly understand/transcribe speech coming from the glasses.

Target:

G2 microphone
    ↓
audioPcm
    ↓
Gemini Live
    ↓
input transcription
    ↓
phone/dev console

Do NOT yet implement:

- Gemini audio playback
- AirPods output
- model-response rendering on G2
- pagination
- long-term conversation UX
- session resumption
- memory
- backend AI proxy
- tools/function calling

Those belong to later milestones.

# Important: Security

Do NOT embed my permanent GEMINI_API_KEY in:

- frontend TypeScript
- Vite env variables exposed to the browser
- app.json
- localStorage
- bundled JS
- Git

For a client-to-server Gemini Live connection, use Google's current recommended ephemeral-token flow.

The permanent API key may exist only in a small local development token issuer running on my Mac.

The G2/iPhone client should receive only a short-lived token.

If the current Google GenAI SDK supports ephemeral Live authentication cleanly in the browser/WebView, use it.

Otherwise use the documented constrained Live WebSocket endpoint directly.

Inspect the current official Gemini docs/types instead of guessing.

# Gemini Model

For the conversational assistant target, use the current Gemini Live conversational model already proven in my Python prototype:

gemini-3.1-flash-live-preview

Do NOT replace it with a transcription-only model just because this milestone only validates transcription.

We are validating the input side of the final conversational architecture.

# Live Configuration

The session should support:

- audio input
- inputAudioTranscription
- automatic VAD initially
- future AUDIO output compatibility

It is acceptable during Milestone 3 to ignore/discard Gemini's output audio.

The important output for this milestone is:

serverContent.inputTranscription

# Audio Input

Reuse the existing G2 microphone module.

Each valid:

event.audioEvent.audioPcm

chunk should be forwarded to the Gemini Live session.

Input format:

- PCM signed 16-bit little-endian
- mono
- 16 kHz

MIME:

audio/pcm;rate=16000

Do not resample because the G2 audio is already in Gemini's native input format.

Do not buffer several seconds before sending.

Stream chunks continuously with minimal latency.

If Gemini's JavaScript SDK requires base64 audio data, convert the Uint8Array safely without changing the PCM content.

# Suggested Modules

Add approximately:

src/gemini/live-session.ts
src/gemini/token-client.ts

and a small development-only token issuer outside the client bundle, for example:

dev/token-server.ts

or another clean structure consistent with the existing Vite project.

Keep:

src/g2/microphone.ts

responsible only for G2 capture.

Keep:

main.ts

as orchestration.

Do not put Gemini protocol code inside microphone.ts.

# Development Token Issuer

Create the smallest reasonable local development service that:

1. reads GEMINI_API_KEY from a server-side environment variable;
2. requests a short-lived Gemini Live ephemeral token;
3. returns only the ephemeral token to the client;
4. never returns/logs the permanent API key.

Add all relevant env files to .gitignore.

The token service is temporary development infrastructure.

Do not build the future Personal AI backend yet.

# Interaction

Keep the current tap interaction simple.

Suggested:

Startup:
"Gemini Mic Ready"

First single tap:

1. obtain ephemeral token
2. establish Gemini Live connection
3. start G2 microphone
4. display:
   "Listening..."

While recording:
- forward G2 PCM chunks directly to Gemini Live
- log aggregated send statistics
- print Gemini input transcription as it arrives

Second single tap:

1. stop G2 microphone
2. signal audio stream end if required by current Live API semantics
3. allow final transcription to arrive
4. close Live session cleanly
5. display:
   "Gemini Heard Me ✓"

Double tap:
- stop microphone if active
- close Gemini Live session if active
- shut down Even page cleanly

# Logging

Useful examples:

[Gemini Live] token acquired
[Gemini Live] connected
[Gemini Live] audio chunks sent=120 bytes=38400
[Gemini Live] transcript interim="Hello Gemini..."
[Gemini Live] transcript final="Hello Gemini, this audio is coming from my Even G2 glasses."
[Gemini Live] session closed

Do not log:
- permanent API key
- ephemeral token
- raw PCM arrays

# Failure Handling

Handle clearly:

- token fetch failure
- Gemini WebSocket connection failure
- connection closes unexpectedly
- audio arrives before Live session is ready
- microphone stop
- app exit

Do not make the app crash if Gemini is unavailable.

Display a short G2 error such as:

"Gemini connection failed"

and log the detailed reason to the console.

# Validation

Before stopping:

1. npm run build must pass.
2. Tell me how to start the local token issuer.
3. Tell me how to start the Vite dev server.
4. Tell me how to load it on physical G2.
5. Give me the exact expected console sequence.
6. Do not proceed to Milestone 4.

# Physical Acceptance Test

I should be able to:

1. load the app on my physical G2;
2. single tap;
3. see "Listening...";
4. say:

   "Hello Gemini, this audio is coming from my Even G2 glasses."

5. see that sentence, or a close transcription, in the phone/dev console;
6. single tap to stop;
7. see a successful final state;
8. double tap to exit cleanly.

# Completion Report

Report:

- files changed
- Gemini SDK / WebSocket APIs used
- ephemeral-token implementation
- how G2 PCM is converted/sent
- Live session lifecycle
- transcription handling
- build result
- physical test steps
- any unresolved browser/WebView limitations

Do not proceed to Milestone 4 automatically.
