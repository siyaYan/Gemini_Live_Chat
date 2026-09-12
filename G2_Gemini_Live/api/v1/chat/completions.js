const GEMINI_OPENAI_CHAT_COMPLETIONS =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const DEFAULT_MODEL = 'gemini-3.8-flash'

export default async function handler(request, response) {
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      endpoint: '/api/v1/chat/completions',
      model: modelName(),
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

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    sendJson(response, 503, { error: 'gemini_api_key_not_configured' })
    return
  }

  const body = normalizeBody(request.body)
  body.model = modelName(body.model)
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

function normalizeBody(body) {
  if (!body || typeof body !== 'object') return { messages: [] }
  return { ...body }
}

function modelName() {
  return process.env.GEMINI_TEXT_MODEL ?? DEFAULT_MODEL
}

function withGlassesSystemPrompt(messages) {
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

function isAuthorized(request) {
  const expected = process.env.EVEN_AI_AGENT_TOKEN
  const authorization = header(request, 'authorization')
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  const apiKey = header(request, 'x-api-key')
  const explicit = header(request, 'x-even-ai-agent-token')
  const queryToken = typeof request.query?.token === 'string' ? request.query.token : ''

  return [bearer, apiKey, explicit, queryToken].some(candidate => candidate && candidate === expected)
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key, X-Even-AI-Agent-Token')
  response.setHeader('Cache-Control', 'no-store')
}

function header(request, name) {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

function sendJson(response, statusCode, payload) {
  response.status(statusCode).json(payload)
}
