/**
 * Development-only ephemeral token issuer for the Gemini Live API.
 *
 * The permanent GEMINI_API_KEY lives only in this process. The browser/WebView
 * client receives a short-lived token name and nothing else.
 *
 * Changes for Milestone 3 debugging:
 *  - loads dev/.env automatically so the key does not have to be exported
 *  - constrained mode now uses the current `liveConnectConstraints` field
 *    (the older `bidiGenerateContentSetup` shape is rejected by v1beta)
 *  - /health reports whether a key is present, so the phone can check the
 *    server without a round trip through the Live API
 *  - token API failures are echoed to the client so the phone panel can show
 *    the real reason instead of a generic failure
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
loadDotEnv(path.join(here, '.env'))

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview'
const TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'

const host = process.env.GEMINI_TOKEN_HOST ?? '0.0.0.0'
const port = Number(process.env.GEMINI_TOKEN_PORT ?? 8787)
const model = process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL
const useConstraints = process.env.GEMINI_TOKEN_CONSTRAINTS === '1'
const uses = Number(process.env.GEMINI_TOKEN_USES ?? 1)
/**
 * Minutes a minted token stays valid for STARTING a session. The API default is
 * 1 minute, which is too short to prefetch a token at app start and still use
 * it on the first G2 tap. 10 minutes keeps the warm-token path usable while
 * staying short-lived.
 */
const newSessionMinutes = Number(process.env.GEMINI_TOKEN_NEW_SESSION_MINUTES ?? 10)

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      model,
      constrained: useConstraints,
      uses,
      newSessionMinutes,
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
      node: process.version,
    })
    return
  }

  if (request.method !== 'POST' || url.pathname !== '/token') {
    sendJson(response, 404, { error: 'not_found' })
    return
  }

  try {
    const token = await createEphemeralToken()
    console.log(`[Gemini Token] issued ephemeral token for model=${model} constrained=${useConstraints} uses=${uses}`)
    sendJson(response, 200, token)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[Gemini Token] failed to issue token:', detail)
    sendJson(response, 500, { error: 'token_issue_failed', detail })
  }
})

server.listen(port, host, () => {
  console.log(`[Gemini Token] listening on http://${host}:${port}`)
  console.log(`[Gemini Token] model=${model} constrained=${useConstraints} apiKey=${process.env.GEMINI_API_KEY ? 'present' : 'MISSING'}`)
  console.log('[Gemini Token] endpoints: POST /token, GET /health')
})

async function createEphemeralToken() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set (export it or put it in dev/.env)')
  }

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + newSessionMinutes * 60 * 1000).toISOString()
  const body = {
    uses,
    expireTime,
    newSessionExpireTime,
    ...(useConstraints
      ? {
          liveConnectConstraints: {
            model: `models/${model}`,
            config: {
              responseModalities: ['AUDIO'],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          },
        }
      : {}),
  }

  const geminiResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!geminiResponse.ok) {
    const detail = await geminiResponse.text().catch(() => '')
    throw new Error(`Gemini token API returned ${geminiResponse.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`)
  }

  const payload = await geminiResponse.json()
  const token = payload.name ?? payload.token?.name

  if (!token) {
    throw new Error(`Gemini token API response missing token name (keys: ${Object.keys(payload).join(', ')})`)
  }

  return {
    token,
    expireTime: payload.expireTime ?? expireTime,
    newSessionExpireTime: payload.newSessionExpireTime ?? newSessionExpireTime,
    model,
    constrained: useConstraints,
  }
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-G2-Gemini-Client-Key')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    if (process.env[match[1]] !== undefined) continue
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}
