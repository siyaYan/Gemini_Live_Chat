import { timingSafeEqual } from 'node:crypto'

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview'
const TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
const RATE_BUCKETS = (globalThis.__g2GeminiRateBuckets ??= new Map())

export default async function handler(request, response) {
  setCorsHeaders(request, response)

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      model: modelName(),
      protected: Boolean(process.env.GEMINI_TOKEN_CLIENT_KEY),
      constrained: useConstraints(),
    })
    return
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return
  }

  if (!isAllowedOrigin(request)) {
    sendJson(response, 403, { error: 'origin_not_allowed' })
    return
  }

  if (!hasValidClientKey(request)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }

  if (!consumeRateLimit(request)) {
    sendJson(response, 429, { error: 'rate_limited' })
    return
  }

  try {
    const token = await createEphemeralToken()
    console.log(`[Gemini Token] issued ephemeral token model=${token.model} constrained=${token.constrained}`)
    sendJson(response, 200, token)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[Gemini Token] failed to issue token:', detail)
    sendJson(response, 500, {
      error: 'token_issue_failed',
      ...(process.env.GEMINI_TOKEN_DEBUG === '1' ? { detail } : {}),
    })
  }
}

async function createEphemeralToken() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured')

  const model = modelName()
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + newSessionMinutes() * 60 * 1000).toISOString()
  const body = {
    uses: tokenUses(),
    expireTime,
    newSessionExpireTime,
    ...(useConstraints()
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
  if (!token) throw new Error(`Gemini token API response missing token name (keys: ${Object.keys(payload).join(', ')})`)

  return {
    token,
    expireTime: payload.expireTime ?? expireTime,
    newSessionExpireTime: payload.newSessionExpireTime ?? newSessionExpireTime,
    model,
    constrained: useConstraints(),
  }
}

function modelName() {
  return process.env.GEMINI_LIVE_MODEL ?? DEFAULT_MODEL
}

function tokenUses() {
  const value = Number(process.env.GEMINI_TOKEN_USES ?? 1)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

function newSessionMinutes() {
  const value = Number(process.env.GEMINI_TOKEN_NEW_SESSION_MINUTES ?? 10)
  return Number.isFinite(value) && value > 0 ? value : 10
}

function useConstraints() {
  return process.env.GEMINI_TOKEN_CONSTRAINTS === '1'
}

function setCorsHeaders(request, response) {
  const origin = header(request, 'origin')
  response.setHeader('Access-Control-Allow-Origin', corsOrigin(origin))
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, X-G2-Gemini-Client-Key')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Vary', 'Origin')
}

function corsOrigin(origin) {
  if (!origin) return '*'
  if (allowedOrigins().includes('*')) return '*'
  return allowedOrigins().includes(origin) ? origin : 'null'
}

function isAllowedOrigin(request) {
  const origin = header(request, 'origin')
  if (!origin) return true
  const allowed = allowedOrigins()
  return allowed.includes('*') || allowed.includes(origin)
}

function allowedOrigins() {
  return (process.env.GEMINI_TOKEN_ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function hasValidClientKey(request) {
  const expected = process.env.GEMINI_TOKEN_CLIENT_KEY
  if (!expected) return true

  const actual = header(request, 'x-g2-gemini-client-key')
  if (!actual) return false

  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  if (expectedBytes.length !== actualBytes.length) return false

  return timingSafeEqual(expectedBytes, actualBytes)
}

function consumeRateLimit(request) {
  const limit = Number(process.env.GEMINI_TOKEN_RATE_LIMIT_PER_MINUTE ?? 30)
  if (!Number.isFinite(limit) || limit <= 0) return true

  const now = Date.now()
  const windowMs = 60 * 1000
  const key = clientIp(request)
  const bucket = RATE_BUCKETS.get(key)

  if (!bucket || now - bucket.startedAt > windowMs) {
    RATE_BUCKETS.set(key, { startedAt: now, count: 1 })
    pruneRateBuckets(now, windowMs)
    return true
  }

  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

function pruneRateBuckets(now, windowMs) {
  if (RATE_BUCKETS.size < 1000) return
  for (const [key, bucket] of RATE_BUCKETS.entries()) {
    if (now - bucket.startedAt > windowMs) RATE_BUCKETS.delete(key)
  }
}

function clientIp(request) {
  return header(request, 'x-forwarded-for').split(',')[0].trim() || header(request, 'x-real-ip') || 'unknown'
}

function header(request, name) {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function sendJson(response, statusCode, payload) {
  response.status(statusCode).json(payload)
}
