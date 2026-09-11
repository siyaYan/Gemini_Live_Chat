The architecture review looks good. Proceed with Milestone 1 only.

## Goal

Create the actual project:

G2_Gemini_Live/

using the official Even Hub ASR template as the clean foundation.

Milestone 1 must prove only:

1. The custom app boots successfully through Even Hub.
2. Custom text renders on the physical G2 glasses.
3. A single-tap gesture is correctly detected.
4. A double-tap exits/stops the app cleanly.
5. Event routing follows the official template conventions and must not use the unsafe fallback behaviour identified in Even Voice AI.

Do NOT implement:

- Gemini
- microphone streaming
- API keys
- backend
- audio playback
- transcription
- pagination beyond what is necessary
- memory
- settings
- additional features

Keep this milestone intentionally small.

## Implementation guidance

Use the official ASR template as the source of truth for:

- Even Hub lifecycle
- bridge initialization
- event envelope handling
- eventType detection
- container creation
- display updates
- gesture handling
- cleanup / exit

Do not blindly copy Even Voice AI code.

Create only the files needed for this milestone, approximately:

G2_Gemini_Live/
├── src/
│   ├── main.ts
│   ├── g2/
│   │   ├── display.ts
│   │   └── gestures.ts
│   └── ui.ts
├── index.html
├── app.json
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .gitignore

Adjust this structure if the official template strongly suggests otherwise.

## Behaviour

On startup, display something clearly identifiable such as:

"G2 Gemini Live
Milestone 1 Ready"

Single tap:
- visibly change the text, e.g.
  "Tap detected ✓"
- log the event to the development console.

Double tap:
- execute the correct official exit/cleanup flow.
- log that the application is exiting.

Keep the phone UI extremely basic. It only needs enough information to confirm app state/debugging.

## Code quality

Keep `main.ts` primarily as orchestration.

`display.ts` should own G2 display operations.

`gestures.ts` should own gesture interpretation/handlers.

Do not create abstractions that Milestone 1 doesn't need.

Use current SDK APIs found in the cloned official template/package. Do not invent SDK methods.

## Validation before stopping

Before declaring Milestone 1 complete:

1. run the TypeScript/build checks;
2. fix compile errors;
3. tell me exactly how to launch/test the project through Even Hub on my physical G2;
4. give me a very short expected-test checklist.

Do NOT proceed to Milestone 2 automatically.

After implementation, report:

- files created/changed
- important SDK APIs used
- build result
- exact physical-G2 test procedure
- any unresolved SDK/device uncertainty
