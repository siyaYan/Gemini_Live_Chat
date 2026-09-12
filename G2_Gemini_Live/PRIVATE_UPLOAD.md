# Private Even Hub Upload

This build is safe for private Even Hub testing only if the permanent Gemini key
stays on a server. The packaged `.ehpk` must contain only a public token-service
URL and, optionally, a private-build client key.

## What Even Hosts

Even Hub private builds run the real package path: build `dist/`, pack it into
an `.ehpk`, upload the `.ehpk` in the developer portal, then install it from the
Even app. The package can be cached/extracted on-device, so never put the
permanent Gemini API key in the client bundle.

This project uses Vercel for two separate backend routes:

```
Voice plugin -> Vercel /api/token -> Gemini auth_tokens API
Voice plugin -> Gemini Live websocket using ephemeral token
Even AI native agent -> Vercel /api/v1/chat/completions -> Gemini text model
```

## 1. Deploy Token Issuer to Vercel

From `G2_Gemini_Live/`, deploy this Vite app plus `api/token.js` to Vercel:

```bash
npm run deploy:vercel
```

Set these Vercel environment variables in the project settings:

```bash
GEMINI_API_KEY=your_real_gemini_key
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_TOKEN_USES=1
GEMINI_TOKEN_NEW_SESSION_MINUTES=10
GEMINI_TOKEN_RATE_LIMIT_PER_MINUTE=30
GEMINI_TOKEN_CONSTRAINTS=0
```

Optional private-build guard:

```bash
GEMINI_TOKEN_CLIENT_KEY=generate_a_random_long_value
```

That client key is not a true public-app secret because it is bundled into the
`.ehpk`, but it is useful friction for a private package and avoids completely
anonymous token minting.

## 2. Configure Private Package Build

Copy the example:

```bash
cp .env.production.example .env.production.local
```

Edit `.env.production.local`:

```bash
VITE_GEMINI_TOKEN_URL=https://YOUR_VERCEL_DOMAIN/api/token
# Optional if the text-agent route is on a different host:
# VITE_EVEN_AI_AGENT_URL=https://YOUR_VERCEL_DOMAIN/api/v1/chat/completions
VITE_GEMINI_TOKEN_CLIENT_KEY=same_value_as_GEMINI_TOKEN_CLIENT_KEY_if_used
VITE_VERBOSE_DIAGNOSTICS=0
VITE_SHOW_DIAGNOSTICS=0
```

Do not commit `.env.production.local`.

Important: if `VITE_GEMINI_TOKEN_URL` is not set, a production build falls back
to same-origin `/api/token`, which is useful when testing the Vercel-hosted web
app but usually wrong for an Even Hub `.ehpk`. Set the full Vercel URL before
packing a private Even upload.

`app.json` currently uses a broad private-test network whitelist. Once your
Vercel domain is final, narrow it to your token domain plus Gemini's API domain.

## 3. Build and Pack

```bash
npm run pack:private
```

Upload the generated file:

```text
G2_Gemini_Live/g2-gemini-live-v0.1.4.ehpk
```

In the Even Hub developer portal, open your app, go to Private builds, upload
the `.ehpk`, then install it from the Even Realities phone app.

## Security Notes

- `GEMINI_API_KEY` belongs only in Vercel environment variables or local
  `dev/.env`.
- `VITE_GEMINI_TOKEN_URL` is safe to bundle because it is only a URL.
- `VITE_GEMINI_TOKEN_CLIENT_KEY` is not safe for public distribution; use it
  only as private-build friction.
- Keep the Vercel endpoint rate limited and watch Gemini usage/billing.
- For a public release, add real user auth or a bring-your-own-key flow before
  issuing tokens.

## Optional: Even AI Text Agent

This is a native Even AI route, but the plugin now includes a setup/status panel
that makes it feel like one combined Gemini assistant. The plugin shows the
agent endpoint, checks whether the backend token is configured, and provides a
copy button for the Even AI Agent Configuration screen.

Use Even AI text mode when you want glasses-first Gemini without waking the
phone. It is text/HUD oriented, not Gemini Live audio. Use the plugin's Voice
Chat mode when you want the Gemini Live voice session and phone/AirPods audio
path.

Set these Vercel environment variables:

```bash
EVEN_AI_AGENT_TOKEN=generate_a_random_long_value
GEMINI_TEXT_MODEL=gemini-3.8-flash
```

After redeploying, configure the Even app:

```text
Settings → Even AI → Agent Configuration → Add Agent
Name: Gemini Text
Endpoint: https://even-gemini-live.siyayan.com/api/v1/chat/completions
API Key/Token: same value as EVEN_AI_AGENT_TOKEN
Save & Activate
```

The plugin's Text Agent card should report `Token Configured` after Vercel has
`EVEN_AI_AGENT_TOKEN` set and the deployment is live.
