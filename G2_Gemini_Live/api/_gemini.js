import { timingSafeEqual } from 'node:crypto'

export const GEMINI_OPENAI_CHAT_COMPLETIONS =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
export const DEFAULT_TEXT_MODEL = 'gemini-3.8-flash'
export const DEFAULT_VOICE_MODEL = 'gemini-3.8-flash'

const RATE_BUCKETS = (globalThis.__g2GeminiRouteRateBuckets ??= new Map())

export async function handleGeminiChatCompletions(request, response, options = {}) {
  setCorsHeaders(response, 'POST, GET, OPTIONS', 'Authorization, Content-Type, X-API-Key, X-Even-AI-Agent-Token')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      endpoint: options.endpoint ?? '/api/v1/chat/completions',
      model: textModelName(),
      protected: Boolean(process.env.EVEN_AI_AGENT_TOKEN),
    })
    return
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return
  }

  if (!process.env.EVEN_AI_AGENT_TOKEN) {
    sendJson(response, 503, { error: 'agent_token_not_configured' })
    return
  }

  if (!hasValidAgentToken(request)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    sendJson(response, 503, { error: 'gemini_api_key_not_configured' })
    return
  }

  const body = normalizeChatBody(request.body)
  body.model = textModelName()
  body.messages = withGlassesSystemPrompt(body.messages)

  try {
    const upstream = await fetch(GEMINI_OPENAI_CHAT_COMPLETIONS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    response.status(upstream.status)
    response.setHeader('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json')

    if (!upstream.body) {
      response.end(await upstream.text())
      return
    }

    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(Buffer.from(value))
    }
    response.end()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[Even AI Agent] Gemini request failed:', detail)
    sendJson(response, 502, { error: 'gemini_request_failed' })
  }
}

export function modelsResponse() {
  const model = textModelName()
  return {
    object: 'list',
    data: [{ id: model, object: 'model', created: 0, owned_by: 'gemini' }],
  }
}

export function normalizeChatBody(body) {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return parsed && typeof parsed === 'object' ? { ...parsed } : { messages: [] }
    } catch {
      return { messages: [] }
    }
  }

  if (!body || typeof body !== 'object') return { messages: [] }
  return { ...body }
}

export function textModelName() {
  return process.env.GEMINI_TEXT_MODEL ?? DEFAULT_TEXT_MODEL
}

export function voiceModelName() {
  return process.env.GEMINI_VOICE_MODEL ?? process.env.GEMINI_TEXT_MODEL ?? DEFAULT_VOICE_MODEL
}

export function withGlassesSystemPrompt(messages) {
  const safeMessages = Array.isArray(messages) ? messages : []
  return [
    {
      role: 'system',
      content:
        'You are a concise assistant on Even G2 smart glasses. Keep replies short, natural, and readable on a tiny display. Reply in the user language.',
    },
    ...safeMessages,
  ]
}

export function hasValidAgentToken(request) {
  const expected = process.env.EVEN_AI_AGENT_TOKEN
  const authorization = header(request, 'authorization')
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  const apiKey = header(request, 'x-api-key')
  const explicit = header(request, 'x-even-ai-agent-token')
  const queryToken = typeof request.query?.token === 'string' ? request.query.token : ''

  return [bearer, apiKey, explicit, queryToken].some(candidate => timingSafeStringEqual(candidate, expected))
}

export function hasValidClientKey(request) {
  const expected = process.env.GEMINI_VOICE_CLIENT_KEY || process.env.GEMINI_TOKEN_CLIENT_KEY
  if (!expected) return false

  return timingSafeStringEqual(header(request, 'x-g2-gemini-client-key'), expected)
}

export function consumeRateLimit(request, route, limitEnvName, defaultLimit = 20) {
  const limit = Number(process.env[limitEnvName] ?? defaultLimit)
  if (!Number.isFinite(limit) || limit <= 0) return true

  const now = Date.now()
  const windowMs = 60 * 1000
  const key = `${route}:${clientIp(request)}`
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

export function setCorsHeaders(response, methods = 'POST, GET, OPTIONS', headers = 'Accept, Content-Type') {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', methods)
  response.setHeader('Access-Control-Allow-Headers', headers)
  response.setHeader('Cache-Control', 'no-store')
}

export function header(request, name) {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export function sendJson(response, statusCode, payload) {
  response.status(statusCode).json(payload)
}

function timingSafeStringEqual(actual, expected) {
  if (!actual || !expected) return false

  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  if (expectedBytes.length !== actualBytes.length) return false

  return timingSafeEqual(expectedBytes, actualBytes)
}

function clientIp(request) {
  return header(request, 'x-forwarded-for').split(',')[0].trim() || header(request, 'x-real-ip') || 'unknown'
}

function pruneRateBuckets(now, windowMs) {
  if (RATE_BUCKETS.size < 1000) return
  for (const [key, bucket] of RATE_BUCKETS.entries()) {
    if (now - bucket.startedAt > windowMs) RATE_BUCKETS.delete(key)
  }
}
