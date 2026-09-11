# Milestone 4 — Gemini response text on the G2 display

Date: 2026-09-11 · builds on the Milestone 3 session, unchanged protocol.

## Files changed

| File | Why |
| --- | --- |
| `src/state/conversation.ts` | **new** — state label + transcript accumulation for the current turn |
| `src/g2/display.ts` | throttled render queue, `showStatus` / `showResponse` / `clearResponse` / `queueStatus`, glasses text fitting |
| `src/gemini/live-session.ts` | delta-shaped transcription callbacks, turn/generation/interrupt events, renamed stats |
| `src/main.ts` | orchestration, state→display mapping, richer diagnostics panel |

## Response-transcription API used

Verified against the current Live API reference rather than assumed.
`BidiGenerateContentServerContent` carries:

- `outputTranscription` — `BidiGenerateContentTranscription { text, languageCode }`, the model's spoken answer as text
- `inputTranscription` — same shape, finalized user speech
- `interimInputTranscription` — same shape, "low latency transcription updated while the user is speaking" (this field **is** real; the Milestone 3 code was right to read it)
- `generationComplete`, `turnComplete`, `interrupted` — booleans

Milestone 4 renders `outputTranscription`, from the same `gemini-3.1-flash-live-preview` session that already produces native audio. No second model.

## Buffering strategy

`outputTranscription.text` is a **delta**, not the whole answer. `"Tokyo"`, `" is the capital"`, `" of Japan."` arrive as three frames. The old code assigned rather than appended, so only the final fragment would ever have shown — the bug flagged at the end of Milestone 3, now fixed for both directions.

`Conversation` owns accumulation:

- `appendOutputDelta()` concatenates; deltas already carry their own leading spaces
- `appendInputDelta()` does the same for user speech, which can also arrive as several finalized segments
- `setInterimInput()` *replaces*, since interim partials are complete restatements
- `completeTurn()` bumps the turn counter and returns to `listening`, leaving the answer on screen
- `startTurn()` clears the accumulators when the next utterance begins
- `interrupt()` discards a partial answer on barge-in

No Gemini protocol knowledge lives in this module; `main.ts` translates events into these calls.

## Display throttling

Follows the official ASR template (`EvenHub_Templates_Reference/asr/src/main.ts`): a 120 ms leading-block debounce, with the comment "BLE render queue is slow".

- first delta schedules a write 120 ms out; deltas in between only update the pending text
- a write is skipped entirely if the text is unchanged
- writes are serialised through a promise chain, so a slow BLE write cannot interleave
- `showResponse()` is fire-and-forget: a display write must never block the WebSocket handler
- `show()` / `showStatus()` bypass the debounce for discrete moments (Ready, Connecting, Listening, exit prompt, error)

Worst case is ~8 BLE writes/second regardless of how fast Gemini streams. `glassesRenders` in the phone panel counts actual writes.

## Long responses

Simplest safe option from the milestone list: show the latest readable block.

`fitForGlasses()` collapses whitespace, and above ~230 characters keeps the **tail** rather than the head — the text is still streaming, so the end is what just arrived. The cut is pushed to the next word boundary (within 40 chars) and prefixed with `…`, so the first visible word is never half a word. 240 chars total is the template's stated rough fit for the 576x288 container; the body gets 230 because of the `Gemini:` heading line.

No scrolling, no page navigation — deliberately deferred.

## State transitions

```
idle --tap--> connecting --setupComplete--> listening
listening --inputTranscription--> thinking --first outputTranscription--> responding
responding --turnComplete--> listening      (answer stays on screen)
listening --next utterance--> (answer cleared) thinking --> responding
any --interrupted--> listening              (partial answer discarded)
any --socket close != 1000--> error         ("Gemini disconnected")
tap --> idle
```

Glasses text per state: `Connecting...` / `Listening...` / `Thinking...` / `Gemini:` + answer.

## Error handling

- no output transcription → nothing renders, session stays open, `outputFrames=0` visible in the panel
- display write fails → logged, session untouched (throttled writes catch their own rejections)
- socket closes mid-conversation → `Gemini disconnected` on the glasses, app stays alive
- connect failure → unchanged from M3, real close code/reason surfaced

## Build result

`tsc --noEmit --strict` passes on all four changed files (checked against a stubbed SDK in the cloud workspace; the Even Hub types could not be loaded there). **`npm run build` still needs to be run on the Mac** — the local Linux workspace on the device failed to start this session, so nothing could be executed there.

Behavioural check of the accumulation logic, run in the cloud workspace:

```
after input, state = thinking
state = responding
response = "Tokyo is the capital of Japan."
after turnComplete state = listening turns = 1
turn 2 response = "Canberra is the capital."
after interrupt response = "" state = listening
long input len = 372 -> fitted len = 227 starts: "…is Tokyo. The capital of Japa"
```

## Physical test steps

1. `npm run token` (terminal 1), `npm run dev:host` (terminal 2)
2. `npm run build` — must pass before the physical run
3. load on the G2; glasses show `Gemini Ready / M4.0 gemini-live`
4. single tap → `Connecting...` then `Listening...`
5. say "What is the capital of Japan?" → `Thinking...` then `Gemini:` + the answer
6. ask a second question in the same session → previous answer clears, new one renders
7. single tap → mic stops, last answer stays on the glasses, phone shows `Response received ✓`
8. double tap → exit prompt; double tap again → clean shutdown

Panel fields to watch: `outputFrames` > 0 (Gemini answering), `turnsCompleted` (multi-turn working), `glassesRenders` (should be far below `outputFrames` — that is the throttle earning its keep).

## Unresolved display limitations

- Long answers show only the tail; no way to read what scrolled past. Real pagination is a later milestone.
- The 230-char budget is inherited from the template's estimate, not measured on hardware. If text clips or wastes space on the real display, tune `GLASSES_CHAR_BUDGET` in `display.ts`.
- `interimInputTranscription` came back 0 frames in the Milestone 3 run. The handling is in place; if it stays 0, only finalized input segments drive the `thinking` transition, which is slightly later but still correct.
- Barge-in is wired (`interrupted` clears the partial answer) but untested — the mic keeps streaming while Gemini answers, which is Milestone 6 territory.
- Gemini's native audio is still discarded; `outputAudioMessages` counts it only as proof the model is answering. That is Milestone 5.
