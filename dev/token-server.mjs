import http from 'node:http'

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview'
const TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'

const host = process.env.GEMINI_TOKEN_HOST ?? '0.0.0.0'
const port = Number(process.env.GEMINI_TOKEN_PORT ?? 8787)
const model = process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL
const useConstraints = process.env.GEMINI_TOKEN_CONSTRAINTS === '1'

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, model, constrained: useConstraints })
    return
  }

  if (request.method !== 'POST' || url.pathname !== '/token') {
    sendJson(response, 404, { error: 'not_found' })
    return
  }

  try {
    const token = await createEphemeralToken()
    console.log(`[Gemini Token] issued ephemeral token for model=${model} constrained=${useConstraints}`)
    sendJson(response, 200, token)
  } catch (error) {
    console.error('[Gemini Token] failed to issue token:', error)
    sendJson(response, 500, { error: 'token_issue_failed', detail: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, host, () => {
  console.log(`[Gemini Token] listening on http://${host}:${port}`)
  console.log('[Gemini Token] endpoint: POST /token')
})

async function createEphemeralToken() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString()
  const body = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
    ...(useConstraints
      ? {
          bidiGenerateContentSetup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
              },
            },
            inputAudioTranscription: {
              languageCodes: [],
            },
            outputAudioTranscription: {},
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
    throw new Error(`Gemini token API returned ${geminiResponse.status}${detail ? ` ${detail}` : ''}`)
  }

  const payload = await geminiResponse.json()
  const token = payload.name ?? payload.token?.name

  if (!token) {
    throw new Error('Gemini token API response missing token name')
  }

  return {
    token,
    expireTime: payload.expireTime ?? expireTime,
    newSessionExpireTime: payload.newSessionExpireTime ?? newSessionExpireTime,
    model,
  }
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}
