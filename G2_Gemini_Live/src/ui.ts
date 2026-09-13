import { APP_VERSION, DIAGNOSTICS, LIFECYCLE } from './config'

/**
 * Phone companion UI.
 *
 * Two layers, deliberately separated: a small always-visible summary anyone can
 * read at a glance, and a collapsed diagnostics block for development. None of
 * this reaches the glasses.
 */

export type StatusKind = 'connecting' | 'ready' | 'recording' | 'exiting' | 'error'

export interface SummaryRows {
  mic: string
  gemini: string
  audio: string
  session: string
}

export interface TextAgentInfo {
  endpoint: string
  status: string
  model: string
  protected: boolean | null
  copied?: string
}

let statusEl: HTMLDivElement
let transcriptEl: HTMLDivElement
let lastEventEl: HTMLDivElement
let diagnosticsEl: HTMLPreElement
let enableAudioEl: HTMLButtonElement
let agentStatusEl: HTMLDivElement
let agentEndpointEl: HTMLDivElement
let agentModelEl: HTMLSpanElement
let agentProtectedEl: HTMLSpanElement
let agentCopiedEl: HTMLSpanElement
let copyAgentEndpointEl: HTMLButtonElement
let refreshAgentEl: HTMLButtonElement
let detailsEl: HTMLDetailsElement
const valueEls = new Map<keyof SummaryRows, HTMLSpanElement>()

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <div>
          <p class="eyebrow">${APP_VERSION}</p>
          <h1>G2 Gemini Live</h1>
        </div>
        <div id="status" class="status status-connecting">Connecting</div>
      </header>

      <section>
        <span class="label">Status</span>
        <dl class="rows">
          <div class="row"><dt>G2 Mic</dt><dd id="row-mic">—</dd></div>
          <div class="row"><dt>Gemini</dt><dd id="row-gemini">—</dd></div>
          <div class="row"><dt>Audio</dt><dd id="row-audio">—</dd></div>
          <div class="row"><dt>Session</dt><dd id="row-session">00:00</dd></div>
        </dl>
        <button id="enable-audio" type="button" hidden>Enable Audio</button>
        <p class="notice">${LIFECYCLE.audioNotice}</p>
      </section>

      <section>
        <span class="label">Modes</span>
        <div class="mode-grid">
          <article class="mode-card mode-card-primary">
            <strong>Voice Chat</strong>
            <p>Launch this plugin, wake the phone, then tap G2 once for Gemini Live + AirPods.</p>
          </article>
          <article class="mode-card">
            <strong>Text Chat</strong>
            <p>Tap once, speak, and read Gemini's text reply on the glasses. “Hey Even” uses the agent endpoint below.</p>
          </article>
        </div>
      </section>

      <section>
        <span class="label">Conversation</span>
        <div id="transcript">Waiting for Gemini Live...</div>
      </section>

      <section>
        <span class="label">Even AI Text Agent</span>
        <div id="agent-status" class="agent-status">Checking text agent backend...</div>
        <div class="agent-meta">
          <span>Model <b id="agent-model">—</b></span>
          <span>Token <b id="agent-protected">—</b></span>
        </div>
        <div id="agent-endpoint" class="endpoint">—</div>
        <div class="button-row">
          <button id="copy-agent-endpoint" type="button">Copy Agent URL</button>
          <button id="refresh-agent" type="button">Check Backend</button>
        </div>
        <p class="notice">
          Configure in Even app: Settings → Even AI → Agent Configuration → Add Agent.
          Paste this URL, then paste the same token you set as <code>EVEN_AI_AGENT_TOKEN</code> in Vercel.
        </p>
        <span id="agent-copied" class="copy-status"></span>
      </section>

      <details id="diagnostics-details"${DIAGNOSTICS.showPanel ? '' : ' hidden'}>
        <summary>Developer diagnostics</summary>
        <div class="detail-body">
          <span class="label">Last event</span>
          <div id="last-event">Waiting for bridge...</div>
          <pre id="diagnostics">Waiting for bridge...</pre>
        </div>
      </details>
    </main>
  `

  statusEl = app.querySelector<HTMLDivElement>('#status')!
  transcriptEl = app.querySelector<HTMLDivElement>('#transcript')!
  lastEventEl = app.querySelector<HTMLDivElement>('#last-event')!
  diagnosticsEl = app.querySelector<HTMLPreElement>('#diagnostics')!
  enableAudioEl = app.querySelector<HTMLButtonElement>('#enable-audio')!
  agentStatusEl = app.querySelector<HTMLDivElement>('#agent-status')!
  agentEndpointEl = app.querySelector<HTMLDivElement>('#agent-endpoint')!
  agentModelEl = app.querySelector<HTMLSpanElement>('#agent-model')!
  agentProtectedEl = app.querySelector<HTMLSpanElement>('#agent-protected')!
  agentCopiedEl = app.querySelector<HTMLSpanElement>('#agent-copied')!
  copyAgentEndpointEl = app.querySelector<HTMLButtonElement>('#copy-agent-endpoint')!
  refreshAgentEl = app.querySelector<HTMLButtonElement>('#refresh-agent')!
  detailsEl = app.querySelector<HTMLDetailsElement>('#diagnostics-details')!

  valueEls.set('mic', app.querySelector<HTMLSpanElement>('#row-mic')!)
  valueEls.set('gemini', app.querySelector<HTMLSpanElement>('#row-gemini')!)
  valueEls.set('audio', app.querySelector<HTMLSpanElement>('#row-audio')!)
  valueEls.set('session', app.querySelector<HTMLSpanElement>('#row-session')!)

  injectStyles()
}

export function setStatus(kind: StatusKind, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function setSummary(rows: Partial<SummaryRows>) {
  for (const [key, value] of Object.entries(rows) as Array<[keyof SummaryRows, string]>) {
    const el = valueEls.get(key)
    if (el && value !== undefined) el.textContent = value
  }
}

export function setTranscript(text: string) {
  if (!transcriptEl) return
  transcriptEl.textContent = text
}

export function setLastEvent(text: string) {
  if (!lastEventEl) return
  lastEventEl.textContent = text
}

export function setDiagnostics(text: string) {
  if (!diagnosticsEl || !detailsEl?.open) return
  diagnosticsEl.textContent = text
}

/** True when the diagnostics block is expanded — lets main skip the work. */
export function diagnosticsVisible(): boolean {
  return Boolean(detailsEl?.open)
}

/**
 * iOS only grants audio permission inside a real DOM gesture handler, and a G2
 * tap arrives over the Even Hub bridge rather than as a DOM event. This button
 * is the one reliable place to call AudioContext.resume().
 */
export function setEnableAudioVisible(visible: boolean) {
  if (!enableAudioEl) return
  if (enableAudioEl.hidden !== !visible) enableAudioEl.hidden = !visible
}

export function onEnableAudio(handler: () => void) {
  if (!enableAudioEl) return
  enableAudioEl.addEventListener('click', handler)
}

export function setTextAgentInfo(info: Partial<TextAgentInfo>) {
  if (info.endpoint !== undefined && agentEndpointEl) agentEndpointEl.textContent = info.endpoint
  if (info.status !== undefined && agentStatusEl) agentStatusEl.textContent = info.status
  if (info.model !== undefined && agentModelEl) agentModelEl.textContent = info.model
  if (info.protected !== undefined && agentProtectedEl) {
    agentProtectedEl.textContent = info.protected === null ? '—' : info.protected ? 'Configured' : 'Missing'
    agentProtectedEl.className = info.protected ? 'ok' : info.protected === false ? 'warn' : ''
  }
  if (info.copied !== undefined && agentCopiedEl) agentCopiedEl.textContent = info.copied
}

export function onCopyAgentEndpoint(handler: () => void) {
  if (!copyAgentEndpointEl) return
  copyAgentEndpointEl.addEventListener('click', handler)
}

export function onRefreshTextAgent(handler: () => void) {
  if (!refreshAgentEl) return
  refreshAgentEl.addEventListener('click', handler)
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    #app { min-height: 100%; display: flex; }
    .panel {
      width: 100%;
      max-width: 640px;
      margin: 0 auto;
      padding: 24px;
      box-sizing: border-box;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }
    h1 { margin: 0; font-size: 22px; font-weight: 650; }
    .eyebrow {
      margin: 0 0 4px;
      color: #a7a7a7;
      font-size: 12px;
      text-transform: uppercase;
    }
    .status {
      flex: 0 0 auto;
      padding: 5px 10px;
      border: 1px solid #3e3e3e;
      border-radius: 999px;
      font-size: 12px;
      color: #a7a7a7;
      white-space: nowrap;
    }
    .status-ready { border-color: #3cfa44; color: #3cfa44; background: rgba(60, 250, 68, 0.08); }
    .status-recording { border-color: #ff453a; color: #ff9f9a; background: rgba(255, 69, 58, 0.08); }
    .status-exiting { border-color: #7b7b7b; color: #e5e5e5; background: rgba(229, 229, 229, 0.06); }
    .status-error { border-color: #ff453a; color: #ff453a; background: rgba(255, 69, 58, 0.08); }
    section, details {
      border: 1px solid #3e3e3e;
      border-radius: 8px;
      background: #2e2e2e;
      padding: 16px;
      margin-bottom: 12px;
    }
    .label {
      display: block;
      color: #a7a7a7;
      font-size: 12px;
      margin-bottom: 10px;
      text-transform: uppercase;
    }
    .rows { margin: 0; }
    .mode-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .mode-card {
      border: 1px solid #3e3e3e;
      border-radius: 8px;
      padding: 12px;
      background: #262626;
    }
    .mode-card-primary {
      border-color: rgba(60, 250, 68, 0.55);
      background: rgba(60, 250, 68, 0.06);
    }
    .mode-card strong { display: block; font-size: 15px; margin-bottom: 6px; }
    .mode-card p { margin: 0; color: #cfcfcf; font-size: 13px; line-height: 1.4; }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid #383838;
    }
    .row:last-child { border-bottom: 0; }
    .row dt { color: #a7a7a7; font-size: 14px; }
    .row dd { margin: 0; font-size: 15px; text-align: right; word-break: break-word; }
    #transcript { font-size: 17px; word-break: break-word; white-space: pre-wrap; }
    .agent-status {
      font-size: 15px;
      margin-bottom: 10px;
    }
    .agent-meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: #a7a7a7;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .agent-meta b { color: #e5e5e5; font-weight: 600; }
    .agent-meta b.ok { color: #3cfa44; }
    .agent-meta b.warn { color: #ffcc00; }
    .endpoint {
      padding: 10px;
      border: 1px solid #3e3e3e;
      border-radius: 8px;
      background: #1f1f1f;
      color: #e5e5e5;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      word-break: break-all;
    }
    .button-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }
    .button-row button {
      padding: 10px 12px;
      border: 1px solid #4b4b4b;
      border-radius: 8px;
      background: #242424;
      color: #e5e5e5;
      font-size: 14px;
      font-weight: 600;
    }
    code {
      color: #e5e5e5;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .copy-status {
      display: block;
      min-height: 18px;
      margin-top: 8px;
      color: #3cfa44;
      font-size: 13px;
    }
    #enable-audio {
      margin-top: 14px;
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #3cfa44;
      border-radius: 8px;
      background: rgba(60, 250, 68, 0.12);
      color: #3cfa44;
      font-size: 16px;
      font-weight: 600;
    }
    #enable-audio[hidden] { display: none; }
    .notice {
      margin: 12px 0 0;
      color: #a7a7a7;
      font-size: 13px;
      line-height: 1.45;
    }
    details summary {
      color: #a7a7a7;
      font-size: 12px;
      text-transform: uppercase;
      cursor: pointer;
    }
    details[hidden] { display: none; }
    .detail-body { margin-top: 14px; }
    #last-event { font-size: 15px; word-break: break-word; margin-bottom: 12px; }
    #diagnostics {
      margin: 0;
      color: #e5e5e5;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
  `

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
