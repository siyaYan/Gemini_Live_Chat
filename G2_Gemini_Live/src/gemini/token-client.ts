export interface GeminiTokenResponse {
  token: string
  expireTime?: string
  newSessionExpireTime?: string
  model?: string
}

export function resolveTokenUrl(): string {
  const configured = import.meta.env.VITE_GEMINI_TOKEN_URL?.trim()
  if (configured) return configured

  if (import.meta.env.PROD) return `${window.location.origin}/api/token`

  return `${window.location.protocol}//${window.location.hostname}:8787/token`
}

export interface EvenAiAgentHealth {
  ok: boolean
  endpoint: string
  model: string
  protected: boolean
}

export function resolveEvenAiAgentUrl(): string {
  const configured = import.meta.env.VITE_EVEN_AI_AGENT_URL?.trim()
  if (configured) return configured

  try {
    const url = new URL(resolveTokenUrl(), window.location.href)
    url.pathname = '/api/v1/chat/completions'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return `${window.location.origin}/api/v1/chat/completions`
  }
}

export async function fetchEvenAiAgentHealth(
  agentUrl = resolveEvenAiAgentUrl(),
  timeoutMs = 8000,
): Promise<EvenAiAgentHealth> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(agentUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      throw new Error(`Even AI agent check timed out after ${timeoutMs}ms (${agentUrl})`)
    }
    throw failure
  } finally {
    window.clearTimeout(timeout)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Even AI agent check failed: ${response.status}${detail ? ` ${detail}` : ''}`)
  }

  const payload = (await response.json()) as Partial<EvenAiAgentHealth>
  return {
    ok: Boolean(payload.ok),
    endpoint: payload.endpoint ?? '/api/v1/chat/completions',
    model: payload.model ?? 'unknown',
    protected: Boolean(payload.protected),
  }
}

export async function fetchGeminiEphemeralToken(
  tokenUrl = resolveTokenUrl(),
  timeoutMs = 8000,
): Promise<GeminiTokenResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  const clientKey = import.meta.env.VITE_GEMINI_TOKEN_CLIENT_KEY?.trim()
  if (clientKey) headers['X-G2-Gemini-Client-Key'] = clientKey

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
    })
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      throw new Error(`Token fetch timed out after ${timeoutMs}ms (${tokenUrl})`)
    }
    throw failure
  } finally {
    window.clearTimeout(timeout)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Token fetch failed: ${response.status}${detail ? ` ${detail}` : ''}`)
  }

  const payload = (await response.json()) as Partial<GeminiTokenResponse>

  if (!payload.token) {
    throw new Error('Token fetch failed: response missing token')
  }

  console.log('[Gemini Live] token acquired')

  return {
    token: payload.token,
    expireTime: payload.expireTime,
    newSessionExpireTime: payload.newSessionExpireTime,
    model: payload.model,
  }
}
