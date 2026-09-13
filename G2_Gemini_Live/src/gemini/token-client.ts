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

export interface GlassesVoiceResponse {
  intent: 'ask' | 'note' | 'none'
  transcript: string
  display_text: string
  model?: string
}

export function resolveEvenAiAgentUrl(): string {
  const configured = import.meta.env.VITE_EVEN_AI_AGENT_URL?.trim()
  if (configured) return configured

  try {
    const url = new URL(resolveTokenUrl(), window.location.href)
    url.pathname = '/glasses/agent/v1/chat/completions'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return `${window.location.origin}/glasses/agent/v1/chat/completions`
  }
}

export function resolveGlassesVoiceUrl(): string {
  const configured = import.meta.env.VITE_GLASSES_VOICE_URL?.trim()
  if (configured) return configured

  try {
    const url = new URL(resolveTokenUrl(), window.location.href)
    url.pathname = '/glasses/voice'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return `${window.location.origin}/glasses/voice`
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

export async function fetchGlassesVoice(
  pcm: Uint8Array,
  sampleRate: number,
  voiceUrl = resolveGlassesVoiceUrl(),
  timeoutMs = 30000,
): Promise<GlassesVoiceResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const clientKey = import.meta.env.VITE_GEMINI_TOKEN_CLIENT_KEY?.trim()
  if (clientKey) headers['X-G2-Gemini-Client-Key'] = clientKey

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(voiceUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        pcm_base64: bytesToBase64(pcm),
        sample_rate: sampleRate,
      }),
    })
  } catch (failure) {
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      throw new Error(`Text voice request timed out after ${timeoutMs}ms (${voiceUrl})`)
    }
    throw failure
  } finally {
    window.clearTimeout(timeout)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(formatVoiceRequestFailure(response.status, detail))
  }

  const payload = (await response.json()) as Partial<GlassesVoiceResponse>
  return {
    intent: payload.intent ?? 'ask',
    transcript: payload.transcript ?? '',
    display_text: payload.display_text ?? '',
    model: payload.model,
  }
}

function formatVoiceRequestFailure(status: number, detail: string): string {
  const errorCode = parseServerErrorCode(detail)

  if (errorCode === 'voice_client_key_not_configured') {
    return 'Text backend missing GEMINI_TOKEN_CLIENT_KEY in Vercel; set it and redeploy'
  }

  if (errorCode === 'unauthorized') {
    return 'Text backend rejected client key; make Vercel and .env.production.local match, then repack'
  }

  if (errorCode === 'rate_limited') {
    return 'Text backend rate limited; wait a minute and retry'
  }

  if (errorCode === 'gemini_api_key_not_configured') {
    return 'Text backend missing GEMINI_API_KEY in Vercel'
  }

  return `Text voice request failed: ${status}${detail ? ` ${detail}` : ''}`
}

function parseServerErrorCode(detail: string): string {
  try {
    const payload = JSON.parse(detail) as { error?: unknown }
    return typeof payload.error === 'string' ? payload.error : ''
  } catch {
    return ''
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
