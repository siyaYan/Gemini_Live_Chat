/**
 * Gemini Live connection probe — development only, runs on the Mac.
 *
 * Why: when the G2/WebView client says "setupComplete timeout" we cannot tell
 * whether the setup payload is wrong, the ephemeral token path is wrong, or the
 * iPhone WebView is the problem. This script reproduces the exact same
 * handshake from Node, where we can see every frame and the real close reason.
 *
 * Usage (from the repo root, with GEMINI_API_KEY exported or in dev/.env):
 *   node dev/live-probe.mjs
 *
 * It runs up to three checks:
 *   1. mint an ephemeral token (v1beta /auth_tokens)
 *   2. connect BidiGenerateContentConstrained?access_token=...   <- what the client does
 *   3. connect BidiGenerateContent?key=...                       <- direct key, isolates the setup payload
 *
 * The permanent API key never leaves this process and is never printed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
loadDotEnv(path.join(here, '.env'))

const MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.1-flash-live-preview'
const TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService'
const USE_CONSTRAINTS = process.env.GEMINI_TOKEN_CONSTRAINTS === '1'
const SETUP_TIMEOUT_MS = 12000

const SETUP = {
  setup: {
    model: `models/${MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
}

if (typeof WebSocket === 'undefined') {
  console.error('This probe needs Node 22+ (global WebSocket). Current:', process.version)
  console.error('Try: node --experimental-websocket dev/live-probe.mjs')
  process.exit(1)
}

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set (export it, or put it in dev/.env)')
  process.exit(1)
}

console.log(`model      = ${MODEL}`)
console.log(`node       = ${process.version}`)
console.log(`constraints= ${USE_CONSTRAINTS}`)
console.log('')

let token = null

// ---- 1. mint the ephemeral token -------------------------------------------
console.log('[1/3] minting ephemeral token ...')
try {
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString()
  const body = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
    ...(USE_CONSTRAINTS
      ? {
          liveConnectConstraints: {
            model: `models/${MODEL}`,
            config: {
              responseModalities: ['AUDIO'],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          },
        }
      : {}),
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  if (!response.ok) {
    console.error(`      FAIL http ${response.status}: ${text.slice(0, 500)}`)
  } else {
    const payload = JSON.parse(text)
    token = payload.name ?? payload.token?.name ?? null
    console.log(`      ok   response keys: ${Object.keys(payload).join(', ')}`)
    console.log(`      ok   token shape:   ${mask(token)}`)
    console.log(`      ok   expireTime:    ${payload.expireTime ?? expireTime}`)
    console.log(`      ok   newSession:    ${payload.newSessionExpireTime ?? newSessionExpireTime}`)
  }
} catch (error) {
  console.error('      FAIL', error?.message ?? error)
}
console.log('')

// ---- 2. constrained endpoint with the ephemeral token ----------------------
let constrained = { ok: false, detail: 'skipped (no token)' }
if (token) {
  console.log('[2/3] connecting BidiGenerateContentConstrained with access_token ...')
  constrained = await probe(`${WS_BASE}.BidiGenerateContentConstrained?access_token=${token}`)
  console.log(`      => ${constrained.ok ? 'setupComplete received' : 'FAILED: ' + constrained.detail}`)
  console.log('')
}

// ---- 3. direct key endpoint, same setup payload ----------------------------
console.log('[3/3] connecting BidiGenerateContent with the permanent key (payload sanity check) ...')
const direct = await probe(`${WS_BASE}.BidiGenerateContent?key=${apiKey}`)
console.log(`      => ${direct.ok ? 'setupComplete received' : 'FAILED: ' + direct.detail}`)
console.log('')

// ---- verdict ---------------------------------------------------------------
console.log('---------------- verdict ----------------')
if (constrained.ok) {
  console.log('Token + setup are fine from Node. The failure is in the iPhone WebView layer:')
  console.log('  - check the phone can reach the token server over the LAN')
  console.log('  - check the WebView is not blocking the wss:// upgrade')
} else if (direct.ok) {
  console.log('The setup payload is valid (direct key works), but the ephemeral token path fails.')
  console.log('Look at the close code/reason above:')
  console.log('  1008 / auth wording  -> token rejected: version mismatch, already used (uses=1), or expired')
  console.log('  1007                 -> the constrained endpoint rejected a setup field')
  console.log('Retry with GEMINI_TOKEN_CONSTRAINTS=1 so the token carries liveConnectConstraints.')
} else if (token) {
  console.log('Both paths failed with the same setup payload, so the setup message itself is the problem.')
  console.log(`Most likely the model name "${MODEL}" is not enabled for this key, or a setup field is unsupported.`)
} else {
  console.log('Token minting failed, so nothing downstream could work. Fix the /auth_tokens call first.')
}
process.exit(0)

function probe(url) {
  return new Promise(resolve => {
    const socket = new WebSocket(url)
    const frames = []
    let opened = false
    let done = false

    const finish = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `setupComplete timeout after ${SETUP_TIMEOUT_MS}ms (opened=${opened}, frames=${frames.length})`,
      })
    }, SETUP_TIMEOUT_MS)

    socket.onopen = () => {
      opened = true
      console.log('      socket open, sending setup')
      socket.send(JSON.stringify(SETUP))
    }

    socket.onmessage = async event => {
      const raw = typeof event.data === 'string' ? event.data : await blobToText(event.data)
      frames.push(raw)
      console.log(`      frame#${frames.length}: ${raw.slice(0, 400)}`)

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return
      }

      if (parsed.setupComplete) finish({ ok: true, detail: 'setupComplete' })
      if (parsed.error) finish({ ok: false, detail: `server error ${JSON.stringify(parsed.error).slice(0, 300)}` })
    }

    socket.onerror = event => {
      console.log(`      socket error: ${event?.message ?? 'unknown'}`)
    }

    socket.onclose = event => {
      console.log(`      socket closed code=${event.code} reason="${event.reason}"`)
      finish({
        ok: false,
        detail: `closed code=${event.code}${event.reason ? ` reason="${event.reason}"` : ''} (opened=${opened}, frames=${frames.length})`,
      })
    }
  })
}

async function blobToText(data) {
  if (data && typeof data.text === 'function') return data.text()
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return String(data)
}

function mask(value) {
  if (!value) return '(missing)'
  const [prefix] = value.split('/')
  return `${prefix}/…${value.slice(-4)} (length ${value.length})`
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
