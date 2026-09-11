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

export async function fetchGeminiEphemeralToken(tokenUrl = resolveTokenUrl()): Promise<GeminiTokenResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  const clientKey = import.meta.env.VITE_GEMINI_TOKEN_CLIENT_KEY?.trim()
  if (clientKey) headers['X-G2-Gemini-Client-Key'] = clientKey

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
  })

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
