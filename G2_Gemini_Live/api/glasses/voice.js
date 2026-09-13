import {
  consumeRateLimit,
  hasValidClientKey,
  sendJson,
  setCorsHeaders,
  voiceModelName,
} from '../_gemini.js'

const MAX_PCM_BYTES = 2 * 1024 * 1024
const DEFAULT_SAMPLE_RATE = 16000

export default async function handler(request, response) {
  setCorsHeaders(response, 'POST, GET, OPTIONS', 'Accept, Content-Type, X-G2-Gemini-Client-Key')

  if (request.method === 'OPTIONS') {
    response.status(204).end()
    return
  }

  if (request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      endpoint: '/glasses/voice',
      model: voiceModelName(),
      protected: Boolean(process.env.GEMINI_VOICE_CLIENT_KEY || process.env.GEMINI_TOKEN_CLIENT_KEY),
      maxPcmBytes: MAX_PCM_BYTES,
    })
    return
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed' })
    return
  }

  if (!process.env.GEMINI_VOICE_CLIENT_KEY && !process.env.GEMINI_TOKEN_CLIENT_KEY) {
    sendJson(response, 503, { error: 'voice_client_key_not_configured' })
    return
  }

  if (!hasValidClientKey(request)) {
    sendJson(response, 401, { error: 'unauthorized' })
    return
  }

  if (!consumeRateLimit(request, 'glasses_voice', 'GEMINI_VOICE_RATE_LIMIT_PER_MINUTE', 20)) {
    sendJson(response, 429, { error: 'rate_limited' })
    return
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    sendJson(response, 503, { error: 'gemini_api_key_not_configured' })
    return
  }

  const body = normalizeBody(request.body)
  const pcmBase64 = String(body.pcm_base64 ?? body.pcmBase64 ?? '')
  const sampleRate = Number(body.sample_rate ?? body.sampleRate ?? DEFAULT_SAMPLE_RATE)

  let pcm
  try {
    pcm = Buffer.from(pcmBase64, 'base64')
  } catch {
    sendJson(response, 400, { error: 'invalid_pcm_base64' })
    return
  }

  if (!pcm.length) {
    sendJson(response, 400, { error: 'empty_audio' })
    return
  }

  if (pcm.byteLength > MAX_PCM_BYTES) {
    sendJson(response, 413, { error: 'audio_too_large', maxPcmBytes: MAX_PCM_BYTES })
    return
  }

  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    sendJson(response, 400, { error: 'invalid_sample_rate' })
    return
  }

  try {
    const result = await askGeminiWithAudio(apiKey, pcm, Math.floor(sampleRate))
    sendJson(response, 200, result)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[Glasses Voice] Gemini audio request failed:', detail)
    sendJson(response, 502, {
      error: 'gemini_audio_request_failed',
      ...(process.env.GEMINI_VOICE_DEBUG === '1' ? { detail } : {}),
    })
  }
}

async function askGeminiWithAudio(apiKey, pcm, sampleRate) {
  const model = voiceModelName()
  const wav = pcmToWav(pcm, sampleRate)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelNameForPath(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

  const geminiResponse = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'Transcribe this spoken request and answer it for Even G2 smart glasses. ' +
                'Return strict JSON only with keys "transcript" and "display_text". ' +
                'The display_text must be short, natural, no markdown, and in the same language as the user.',
            },
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: wav.toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: Number(process.env.GEMINI_VOICE_MAX_OUTPUT_TOKENS ?? 320),
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!geminiResponse.ok) {
    const detail = await geminiResponse.text().catch(() => '')
    throw new Error(`Gemini generateContent returned ${geminiResponse.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`)
  }

  const payload = await geminiResponse.json()
  const text = extractText(payload)
  const parsed = parseJsonText(text)
  const transcript = cleanText(parsed?.transcript)
  const displayText = cleanText(parsed?.display_text ?? parsed?.answer ?? text)

  return {
    intent: transcript || displayText ? 'ask' : 'none',
    transcript,
    display_text: displayText || "Didn't catch that.",
    model,
  }
}

function extractText(payload) {
  return (
    payload?.candidates?.[0]?.content?.parts
      ?.map(part => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim() ?? ''
  )
}

function parseJsonText(text) {
  if (!text) return null
  const stripped = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    return JSON.parse(stripped)
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 900) : ''
}

function modelNameForPath(model) {
  return encodeURIComponent(String(model).replace(/^models\//, ''))
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  const dataSize = pcm.byteLength
  const byteRate = sampleRate * 2

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

function normalizeBody(body) {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  return body && typeof body === 'object' ? body : {}
}
