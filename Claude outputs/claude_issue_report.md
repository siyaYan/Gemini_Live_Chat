# iOS background audio in an Even Hub plugin — what is actually possible

Date: 2026-09-11 · app version `M6.1 gemini-live`

## Verified facts (checked, not assumed)

**The installed SDK has no audio-output API.** `@evenrealities/even_hub_sdk`
0.0.10, `dist/index.d.ts`, every audio-related symbol:

```
AudioControl = "audioControl"
APP_REQUEST_AUDIO_CTR_SUCCESS / APP_REQUEST_AUDIO_CTR_FAILED
audioControl(isOpen: boolean): Promise<boolean>   // microphone only
onAudioData -> PCM bytes                          // input
```

Input only. Nothing for playback, no speaker handle, no background capability.
Playback therefore has to go through Web Audio inside the WebView, which iOS
suspends on lock.

**Upstream issue #26 is real and unanswered.**
`even-realities/everything-evenhub` #26, "Native/background audio-output API for
lock-screen playback and streaming speech". It asks for an `audio-playback`
permission plus a native output API owned by the Even app, with streaming PCM,
backpressure, and state reporting. Its second use case is verbatim our
situation: "real-time TTS replies arriving as 24-kHz mono PCM, playable while
locked". **No assignees, no labels, no maintainer reply.** Worth upvoting, but
not worth planning around.

**A bigger production risk than the audio question: issue #16.**
"iOS: plugin left permanently white after background WebContent process
termination — no host reload". When the Even app is backgrounded and iOS comes
under memory pressure, jetsam kills the WKWebView content process. The plugin
goes permanently white, JavaScript stops, taps fall through to the dashboard,
and the only recovery is relaunching from the app menu. The reporter sees it
"several times a day of normal phone use". The fix belongs in the host
(`webViewWebContentProcessDidTerminate` + reload); a plugin cannot fix it,
because its process is already gone.

This reframes backgrounding: it is not only "audio may pause", it is "the
plugin may cease to exist". Any production design that assumes the app survives
backgrounding is wrong today.

**Adjacent:** issue #13 asks for System Media / Now Playing API support — the
nearest thing to a sanctioned background-audio path if it ever lands.

## Where the shared analysis is right

- Foreground-only voice with honest degradation is the correct v1. Agreed.
- A G2 tap cannot unlock audio: it arrives over the Even Hub bridge, not as a
  DOM event, so it carries no user activation.
- **Do not add a silent oscillator or looping silent buffer.** This app shipped
  exactly that in M5.1 and it was removed in M5.3: it did not survive a real iOS
  audio-session interruption, and the dead source left behind made recovery
  worse rather than better. Independent corroboration of a mistake already paid
  for here.
- A native iOS companion with `AVAudioSession` is the only route that works
  today, and it is a different product, not a plugin change.

## What changed in the app (M6.1)

`src/platform/lifecycle.ts` (new) — one monitor owning every lifecycle signal.
`visibilitychange` alone was a genuine gap: on iOS, `pagehide`/`pageshow` fire
for WebKit page-cache transitions where visibilitychange may not, and
`pageshow` with `persisted === true` is the only way to know the page was
restored from the back/forward cache rather than merely revealed. `freeze` and
`resume` are handled where present.

Every transition logs one structured line:

```
[Session] lifecycle pagehide visibility=hidden audio=suspended queued=820ms
          ctxTime=41.20s socket=open mic=20/s out=17/s played=0/s since=3.10s
```

`ctxTime` is the AudioContext clock. If it stops advancing across a transition,
iOS stopped the context — that single number answers most of the background
question. `since` exposes frozen wall-clock gaps.

Also: the phone now states the limitation instead of letting you discover it —
*"Voice output works while Even is in the foreground. iOS may pause audio when
the phone is locked."* — and the Audio row reads "Paused by iOS (app not in
foreground)" rather than offering an Enable Audio button that cannot help while
hidden.

## The experiment to run before production

Set `LIFECYCLE.sampleIntervalMs = 5000` in `src/config.ts`, then run the four
cases with the console attached:

| Case | Setup |
| --- | --- |
| A | screen on, Even app foreground — baseline |
| B | screen on, Even app backgrounded (swipe to another app) |
| C | lock the screen **while Gemini is already speaking** |
| D | phone already locked, speak to G2, Gemini starts a **new** response |

For each, the questions the log answers directly:

- does `ctxTime` keep advancing? (audio clock alive)
- does `socket=` stay `ready`? (WebSocket survives)
- does `mic=` stay non-zero? (G2 PCM still arriving)
- does `out=` stay non-zero? (Gemini still sending audio)
- does `played=` stay non-zero? (anything actually reaching the ears)
- how large is `since=` on the first sample after returning? (how long frozen)

C and D are the interesting ones: C tells you whether an in-flight answer
survives, D whether a locked phone can start one at all.

Worth also noting whether the plugin ever comes back white after a long
background — that is issue #16, not an audio bug, and it changes what v1 should
promise.

## Recommended production posture for v1

1. Ship foreground voice. Do not promise locked-screen audio.
2. Degrade to text-only on background, and say so on the phone. Done.
3. Recover on return: resume the context, reconnect the session, offer Enable
   Audio only when a gesture can actually help. Done.
4. Keep Auto-Lock long, or Never, during real use — the only reliable mitigation
   available to a plugin today.
5. Upvote issue #26 and ask in the Even developer Discord whether a native audio
   output API exists in an unreleased build. Reference #13 as well.
6. Treat a native iOS companion as a separate future product, not a fix.

## One thing worth checking locally

This project is pinned to SDK **0.0.10**; 0.0.15 was mentioned in discussion but
could not be verified from here (the npm registry is unreachable through this
sandbox's proxy). Worth running:

```bash
npm view @evenrealities/even_hub_sdk version
npm view @evenrealities/even_hub_sdk versions --json
```

If a newer version exists, install it in a scratch folder and grep its types
before upgrading:

```bash
grep -niE "audio|speaker|play|media|background" node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts
```

A new output API would change this entire picture, and it is a two-minute check.
