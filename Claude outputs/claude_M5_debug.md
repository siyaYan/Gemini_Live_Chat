# Screen lock, background audio, and first-connect latency

Date: 2026-09-11 · follow-up to Milestone 5 (app version `M5.1 gemini-live`)

## The screen-lock question, answered honestly

**A web page inside the Even Hub WebView cannot grant itself background
execution.** When iOS locks the screen it hides the page, suspends the
AudioContext, throttles timers to near zero and eventually drops the WebSocket.
Surviving that requires the *native host app* to declare `UIBackgroundModes:
audio` and hold an active `AVAudioSession` — a property of the Even Hub app,
not something JavaScript can request. No amount of web-layer work overrides it.

So the fix is to stop the screen going dark, plus recover cleanly when it does
anyway.

### 1. Screen Wake Lock (`src/platform/wake-lock.ts`, new)

`navigator.wakeLock.request('screen')` is acquired when a conversation starts
and released when it stops, so it never sits draining the battery outside a
session. iOS revokes the lock every time the page is hidden and never restores
it, so `handleVisible()` re-acquires on the way back and counts how often that
happened. Unsupported or refused is logged and ignored — never fatal.

### 2. Visibility recovery (`src/main.ts`)

On `visibilitychange` → visible:

- re-acquire the wake lock
- `audioOutput.resume()` — an interrupted context stays suspended otherwise
- reset `nextPlaybackTime` to `currentTime`; the context clock advanced while
  suspended, so the old cursor is far in the past and every queued chunk would
  fire at once
- if the session should be live but the socket is gone, show
  `Gemini disconnected` rather than appearing to work

### 3. Interruption detection (`src/audio/output.ts`)

A `statechange` listener on the AudioContext catches iOS suspending it — screen
lock, an incoming call, a route change — counts it as `interruptions`, and moves
the state to `locked` instead of silently playing nothing.

### 4. Keep-alive

A looping silent buffer runs for the duration of a conversation, which makes iOS
less eager to tear the context down between turns. It does **not** buy
background playback; it only reduces mid-session teardown.

## First-connect latency

Instrumented rather than guessed. Every connect now logs and displays:

```
[Gemini Live] connect timings token=12ms socket=430ms setup=310ms total=752ms
```

`token` is the LAN round trip to the issuer, `socket` the wss handshake to
Google, `setup` the wait for `setupComplete`.

One structural improvement: a token is **prefetched at app start** and another
minted in the background as soon as a session begins, so the tap usually pays
`socket + setup` only. This needed a server change — the API's default
new-session window is 1 minute, too short for a warm token — so
`dev/token-server.mjs` now mints with a 10 minute window
(`GEMINI_TOKEN_NEW_SESSION_MINUTES`, still short-lived). Tokens remain `uses: 1`
and the permanent key never leaves the issuer.

**The token server must be restarted** for the new window to apply.

Read the three timings before optimising further — if `setup` dominates, that is
Google-side and nothing local will help.

## What to expect on the next physical run

- Screen should no longer dim or lock during a conversation; `wakeLock=held` in
  the phone panel confirms it.
- If it is `unsupported`, the WebView lacks the API and only the host-app route
  remains — worth raising with Even Realities.
- Locking manually should now recover on unlock rather than staying dead:
  `interruptions` increments, audio resumes, or a clear `Gemini disconnected`.
- Audio genuinely continuing with the screen off is **out of scope at the web
  layer**. If that becomes a requirement, it is a native Even Hub feature
  request, not an app change.
