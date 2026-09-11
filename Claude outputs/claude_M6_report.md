# Milestone 6 — UX hardening

Date: 2026-09-11 · app version `M6.0 gemini-live`

## 1. Files changed

| File | Status | Why |
| --- | --- | --- |
| `src/config.ts` | **new** | every tunable in one place: model, system instruction, debounce, page geometry, reconnect delays, audio thresholds, diagnostics flags |
| `src/log.ts` | **new** | `log`/`warn`/`error` with categories `[G2] [Gemini] [Audio] [Display] [Session] [Network] [Startup]` — two helpers, not a framework |
| `src/g2/paginate.ts` | **new** | page splitting modelled on the official `text-heavy` template |
| `src/state/conversation.ts` | rewritten | `reconnecting` state, turn epochs, bounded transcript buffers |
| `src/g2/display.ts` | rewritten | status vs. paginated response, render/failure counters, `dispose()` |
| `src/gemini/live-session.ts` | rewritten | system instruction, close classification, interruption timestamps, idempotent close |
| `src/audio/output.ts` | rewritten | config-driven thresholds, underrun counter, interruption latency, debounced gesture hint |
| `src/ui.ts` | rewritten | glanceable summary + collapsed developer diagnostics |
| `src/main.ts` | rewritten | orchestration, reconnect, network handling, startup timings, single cleanup path |

`src/platform/wake-lock.ts` is not imported by M6 — the API is unsupported in
this WebView. Delete it: `rm -r G2_Gemini_Live/src/platform`.

## 2. Interaction model

```
app opens                     -> Ready
single tap (idle)             -> Connecting... -> Listening...
  mic stays open, session persists, turns flow with no tap between them
single tap (active)           -> stop, last answer stays on screen, Ready
single tap (dead socket)      -> restart cleanly instead of trying to stop
double tap                    -> exit prompt; double tap again exits
single tap (prompt showing)   -> cancel, back to Ready
```

No new gestures. Pagination is automatic rather than gesture-driven,
specifically so it cannot collide with start/stop.

## 3. Conversation states

`idle → connecting → listening → thinking → responding → listening`, plus
`reconnecting` and `error`.

The important structural change: `Conversation` is the **single source of
truth**, and `main.ts` is the only module that maps state to output. Display
and audio modules render and report; they never decide. A `displayLocked` flag
lets explicit screens (exit prompt, failure) own the glasses without a
streaming update stomping on them.

`turnEpoch` increments on interrupt and on turn start, so frames already in
flight when a turn was abandoned can be discarded rather than appended to the
next answer.

## 4. System instruction

Lives in `config.ts` as `SYSTEM_INSTRUCTION`, read only by the setup frame.
Substance:

- conversational, concise, two or three sentences by default
- answers are spoken *and* shown on a tiny display — short sentences win
- no markdown, lists, headings or emoji
- no "Sure!", no narrating what it is about to do
- interruption handled gracefully, never resumed or complained about
- ambiguity: make a sensible assumption and answer, don't open with a question

Language: replies in whatever language you speak, English and Mandarin both
expected, switches mid-conversation without comment. **It does not correct your
English unless you ask** — you practise English with this, but a tutor persona
would ruin it as an assistant. Ask for a correction and it will explain.

## 5. Display and pagination

Status lines are one or two words: `Ready` / `Connecting...` / `Listening...` /
`Thinking...` / `Speaking...` / `Reconnecting...`. No diagnostics ever reach the
glasses.

`paginate()` mirrors the official template: paragraph aware, oversized
paragraphs split at whitespace, never mid-word, lines costed against the
container at the 27 px LVGL line height. The inner box is 568×253 after padding
and the heading line, giving **9 lines per page**.

While an answer streams, the **last** page is shown, because that is where new
words arrive. On turn completion the page stays put so it can be read. The
heading shows `Gemini 2/3` only when there is more than one page.

One divergence from the template: it measures with `@evenrealities/pretext` for
pixel-accurate glyph advances, which is not installed here. `measureLines()`
estimates instead, and handles CJK at double width and per-character wrapping —
necessary for a bilingual assistant, since measuring Chinese with a Latin
advance would badly under-count lines and clip the page. The measurer is
injectable, so swapping in pretext later is one argument:

```ts
paginate(text, box, (t, w) => measureTextWrap(t, w).lineCount)
```

Verified:

```
box 568x253 -> 9 lines per page
short   -> 1 page
long    -> 2 pages (353, 216 chars), no mid-word cuts
           rejoined == source words: true      (nothing lost at the boundary)
chinese -> 1 page; CJK measured at 2x Latin width
```

## 6. Reconnect strategy

Bounded: 500 ms, 1 s, 2 s. Each attempt mints a **fresh token** — `uses: 1`
tokens are consumed by the first connect, and an auth-shaped close means the old
one is dead regardless. Attempts are skipped while `navigator.onLine` is false
rather than burning the budget offline.

The microphone keeps running throughout, so a successful reconnect resumes
mid-conversation with no tap. Chunks captured while disconnected are dropped by
the session rather than queued.

After three failures: `Connection failed / Tap to retry` on the glasses, session
torn down, app back to a tappable Ready. Never an infinite retry, and never a
state that needs the Even Hub app killed.

Close codes are classified rather than treated alike:

| Kind | Codes | Action |
| --- | --- | --- |
| `normal` | 1000, client-initiated | none |
| `auth` | 1008, or reason mentioning token/expired | reconnect with a new token |
| `retryable` | 1001, 1006, 1011, 1012, 1013 | reconnect |
| `fatal` | 1002, 1007 | stop — our setup is wrong, retrying repeats it |

## 7. Token and session expiry

A token is prefetched at startup and re-minted in the background when a session
starts, so a tap usually pays only socket + setup. `goAway` is logged and
surfaced; the close that follows is treated as retryable, so an expiring session
reconnects rather than dying. Token values are never logged.

## 8. Interruption hardening

On `interrupted`, in order: stop and disconnect every scheduled audio source,
clear the queue, reset the cursor to `currentTime`, clear the partial response
text, bump the turn epoch so stale transcript frames are discarded, return to
`listening`.

The session reads `interrupted` **before** any transcript or audio in the same
frame, so nothing from an abandoned turn is processed after cancellation. Local
latency is measured from frame-parse to cancellation and logged as
`[Audio] playback cancelled in 85ms sources=12 reason=interrupted`.

## 9. Audio reliability

- underrun counter: the cursor falling behind the clock **mid-answer** (not at
  turn start) means audio arrived too late to be gapless
- `queuedMs` visible; warn at 4 s, drop only past 15 s — that is leaking, not
  lagging
- sources are `disconnect()`ed as well as stopped on cancellation, so cancelled
  nodes are not left attached to the graph
- the gesture hint is debounced by 900 ms: **this is the Enable Audio button
  flicker you saw**. iOS flaps the context state while settling after a screen
  wake, and reading it instantaneously made the button appear and vanish. It now
  requires the context to be continuously unusable before showing.

## 10. Cleanup and resource lifecycle

One `cleanup()`, idempotent, reached by every exit path (double tap, system
exit, page unload). Audited symmetry: 4 window/document listeners and 1
interval, all removed; `GeminiLiveSession.close()` is idempotent and nulls its
handlers so a late frame cannot reach a forgotten session; `AudioContext` closed
and gesture listeners detached on dispose; display timer cancelled.

Transcript buffers are capped at 4000 characters, the audio queue at 15 s, so
neither grows without bound in a long session.

## 11. Graceful degradation

| Failure | Behaviour |
| --- | --- |
| audio unavailable | text keeps working, phone shows "Unavailable — text only" |
| audio suspended by iOS | text keeps working, Enable Audio appears after the debounce |
| display write fails | counted, logged, conversation continues |
| mic fails to start | session torn down, `Microphone error / Tap to retry` |
| token server down | connection error, back to Ready |
| network offline | playback cleared, `Reconnecting...`, retry on `online` |

No single subsystem failure takes the assistant down.

## 12. Echo / self-hearing

Reviewed, not over-engineered. Gemini's server-side VAD owns turn detection, and
with AirPods the leakage path into the G2 mic is weak. The mic is deliberately
**not** muted while Gemini speaks — that would break barge-in, which is the
whole point of Milestone 5's work.

`VAD` in `config.ts` is the place to tune if false turns appear on speaker.
The signal to watch is `interruptions` climbing in the panel without you having
spoken.

## 13. Build result

`tsc --noEmit --strict` clean across all nine files (stubbed SDK types in the
cloud workspace). Pagination and conversation logic verified by execution, shown
above. **`npm run build` still needs running on the Mac** — the device's local
shell has not started in any session, so I cannot execute there.

## 14. Physical test checklist

- [ ] **A — Normal conversation.** Ask "What's something interesting I could do this weekend?" Expect a short spoken answer, text on the glasses, automatic return to `Listening...`. Ask a second question without tapping.
- [ ] **B — Interruption.** Ask for something long, interrupt mid-sentence. Audio stops fast, stale text stops updating, the new question is understood. Check the console for `playback cancelled in Xms` — under ~150 ms is fine.
- [ ] **C — Five start/stop cycles.** No duplicate responses, no doubled audio, no mic failure, no latency creep. Watch `renders` and `reconnects` in diagnostics.
- [ ] **D — Connection failure.** Turn on Airplane Mode mid-session. Expect `Reconnecting...`, three bounded attempts, then `Connection failed / Tap to retry`. Restore network; a tap should start a fresh session.
- [ ] **E — AirPods.** Audio follows the iPhone's selected output. Change route mid-session; the app should not care.
- [ ] **F — Long response.** "Explain how a neural network learns, in reasonable detail." Expect multiple pages, `Gemini 1/3` style heading, readable without flicker.
- [ ] **G — Language switching.** English, then Chinese, then English. No reconnect, no comment from Gemini about the switch.

Diagnostics are now collapsed by default on the phone — expand "Developer
diagnostics" before a test run. Collapsed, the panel is not even rendered, which
keeps the per-second string building out of a normal session.

## 15. Known limitations

- **Pagination is estimated, not measured.** Without `@evenrealities/pretext`,
  line counts come from an average glyph advance. Deliberately conservative, so
  the failure mode is an under-filled page rather than a clipped one. If text
  looks short on hardware, lower `DISPLAY.averageCharWidthPx`.
- **No page navigation.** Long answers show the last page while streaming, then
  stay. Reading an earlier page is not possible without a gesture that would
  collide with start/stop.
- **Screen lock still ends the session.** Wake Lock is unsupported in this
  WebView; audio surviving a locked screen needs background audio mode in the
  host Even Hub app. Set Auto-Lock to Never for long sessions.
- **Reconnect loses in-flight turns.** A reconnect starts a fresh Live session,
  so conversational context up to that point is gone. Session resumption is a
  later milestone.
- **Echo mitigation is untested on speaker.** Only reasoned about, since I
  cannot test hardware.
- **None of this has run on the glasses.** Every change is typechecked and the
  pure logic is unit-tested, but the G2, iOS audio and BLE paths are unverified
  until you run it.
