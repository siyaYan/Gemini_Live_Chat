# Project Context — Even Reality G2 + Gemini Live

I am building a custom AI voice assistant for my Even Reality G2 glasses.

Please first inspect the existing codebase and understand the architecture before making major changes.

## Workspace

My workspace is approximately:

~/Desktop/Even_G2/

Existing projects:

1. Gemini_Live_Chat/
   - My Python proof-of-concept.
   - Gemini Live API has already been successfully tested.

2. Even_Voice_AI_Reference/
   - Clone of:
     https://github.com/MrScautHD/Even-Voice-AI
   - Use this as a reference implementation only.
   - Do NOT modify this repository directly.

3. EvenHub_Templates_Reference/
   - Clone of:
     https://github.com/even-realities/evenhub-templates
   - Contains the official Even Hub templates.
   - Use the official ASR template as the preferred clean foundation.
   - Do NOT modify this repository directly.

Create our actual app separately as:

G2_Gemini_Live/

---

# Main Goal

Build a natural real-time AI assistant for Even Reality G2 with this experience:

G2 microphone
    ↓
Gemini Live API
    ├── native audio response → iPhone → AirPods
    └── text/transcript → G2 display

The interaction should feel like a normal live voice conversation:

- continuous microphone input
- low latency
- automatic Voice Activity Detection
- multi-turn conversation
- interruption / barge-in
- natural Gemini native audio
- concise text shown on the glasses
- audio played through the phone's selected audio output, ideally AirPods

I do NOT want:

G2 → STT → text LLM → TTS

unless required as a fallback.

The preferred architecture is native Gemini Live audio-to-audio.

---

# What Has Already Been Proven

Inside `Gemini_Live_Chat`, the following prototypes already work.

## Test 1
Text → Gemini Live → native Gemini audio.

Working.

## Test 2
Mac microphone → Gemini Live → native Gemini voice.

Working.

Audio format used:

Input:
- PCM signed 16-bit
- mono
- 16 kHz

Output:
- PCM signed 16-bit
- mono
- 24 kHz

## Test 3
Continuous real-time conversation.

Working features:

- continuous microphone streaming
- Gemini Live persistent session
- VAD
- multi-turn conversation
- interruption
- input transcription
- output transcription
- native voice output

Python package:

google-genai

Environment variable:

GEMINI_API_KEY

Do not ask me to re-prove the Gemini Live API unless necessary.

---

# Important Architecture Decision

I do NOT want to simply fork Even Voice AI and replace GPT with Gemini.

Preferred approach:

Official Even ASR template
        +
selected useful patterns/components from Even Voice AI
        +
our existing Gemini Live architecture

Conceptually:

Official template = clean G2 foundation
Even Voice AI = reference/donor implementation
Gemini_Live_Chat = proven AI/audio prototype

---

# First Task: Architecture Review

Before implementing a lot of code:

1. Inspect the official ASR template.
2. Inspect Even Voice AI.
3. Inspect my Gemini_Live_Chat proof-of-concept.
4. Compare how they handle:
   - G2 microphone
   - PCM audio
   - Even Hub SDK lifecycle
   - display
   - gestures
   - application state
   - phone/WebView UI
   - audio playback
   - persistence/settings
   - AI/provider abstraction

Then give me a concise architecture recommendation.

Do NOT perform a large rewrite before doing this review.

---

# Components We May Reuse From Even Voice AI

Study these concepts in particular:

- G2 microphone handling
- display rendering
- response pagination
- gesture handling
- conversation state
- settings persistence
- phone companion UI
- audio output behaviour

However:

Do NOT preserve its existing pipeline if it is roughly:

speech recognition
→ GPT text request
→ TTS

That AI layer should be replaced by a native Gemini Live session.

---

# Desired New Architecture

Something approximately like:

G2_Gemini_Live/
├── src/
│   ├── main.ts
│   ├── g2/
│   │   ├── microphone.ts
│   │   ├── display.ts
│   │   └── gestures.ts
│   │
│   ├── gemini/
│   │   ├── live-session.ts
│   │   ├── audio-input.ts
│   │   └── events.ts
│   │
│   ├── audio/
│   │   └── output.ts
│   │
│   ├── state/
│   │   └── conversation.ts
│   │
│   ├── store.ts
│   └── ui.ts
│
├── index.html
├── app.json
└── package.json

Do not follow this structure blindly if the Even Hub SDK/template suggests a cleaner architecture.

Prefer the native conventions of the official SDK.

---

# Implementation Milestones

Please keep development incremental.

## Milestone 1 — Hello G2

Create/run our own Even Hub application.

Prove that we can:

- install/run our app on G2
- display custom text on the glasses
- detect at least one gesture/input event

No Gemini required yet.

## Milestone 2 — G2 Microphone

Prove:

G2 microphone
→ app receives PCM

Log enough information to verify:

- stream is active
- sample rate
- data length
- audio chunks are actually arriving

Do not connect Gemini until this works reliably.

## Milestone 3 — G2 → Gemini Live

Replace the Mac microphone from the Python proof-of-concept with G2 PCM.

Pipeline:

G2 PCM
→ Gemini Live WebSocket/session

Initially we only need to verify Gemini correctly receives and understands G2 speech.

## Milestone 4 — Gemini Text → G2

Use Gemini Live output transcription.

Display a concise version of Gemini's response on the glasses.

Requirements:

- readable on G2
- pagination if needed
- avoid huge text blocks
- minimise BLE/display update spam

## Milestone 5 — Gemini Audio → AirPods

Play Gemini native audio through the phone.

The phone's normal output routing should allow AirPods to receive it.

Avoid unnecessary TTS because Gemini Live already provides native audio.

## Milestone 6 — True Conversational UX

Add:

- continuous session
- multi-turn context
- VAD
- interruption/barge-in
- playback cancellation when interrupted
- clear start/stop behaviour
- useful G2 status states, e.g.

Listening
Thinking
Speaking

but keep the UI minimal.

---

# Security Requirement

Do NOT permanently embed my real Gemini API key into client-side JavaScript, TypeScript, app.json, Git, or the Even Hub package.

My current API key is only being used locally for development.

For production, plan for:

Mac mini / small backend
    ↓
real Gemini API key remains private
    ↓
issue short-lived / ephemeral credentials
    ↓
G2/iPhone client connects to Gemini Live

The permanent key must never be committed.

Also ensure:

.env
.env.*
API key files

are in .gitignore.

Never print the full API key to logs.

---

# Development Style

I am a software developer and I want to learn the Even Hub SDK while building this.

Therefore:

- don't hide everything behind a giant abstraction
- explain important G2-specific architecture decisions
- reuse existing code when appropriate
- avoid unnecessary boilerplate
- prefer small modules
- keep responsibilities separated
- preserve a clean path for future expansion

When changing an existing file, tell me briefly why.

When uncertain about an SDK method, inspect the installed package/template/docs instead of inventing an API.

---

# Important Scope Constraint

This is Action Item 1 of a larger personal AI project.

For NOW we are ONLY building:

G2 + Gemini Live voice assistant.

Do NOT start implementing:

- long-term memory
- Obsidian integration
- RAG
- flashcards
- news
- Morning Briefing
- Claude/Codex Agent HUD
- Tailscale backend
- Personal AI server

Those are future phases.

However, avoid architectural choices that would make those integrations unnecessarily difficult later.

---

# Future Project Context

Eventually my architecture will likely be:

                    Personal AI Backend
                    on Mac mini
                           │
          ┌────────────────┼────────────────┐
          │                │                │
      Memory/RAG       AI Agents        Services
       Obsidian       Claude/Codex      Briefing etc.
          │                │                │
          └────────────────┼────────────────┘
                           │
                        Tailscale
                           │
                    iPhone / G2
                           │
                     Even Hub apps

The AI models should remain replaceable.

Long-term memory should remain independent of the model provider.

But again: do not implement this yet.

---

# What I Want You To Do NOW

Start with:

1. inspect the three existing projects;
2. summarise the relevant architecture of each;
3. identify reusable code/patterns;
4. recommend the minimal architecture for `G2_Gemini_Live`;
5. identify any uncertainties about the current Even Hub SDK;
6. propose the exact files/modules for Milestone 1;
7. then wait for my confirmation before doing a large implementation.

Be practical and concise.
