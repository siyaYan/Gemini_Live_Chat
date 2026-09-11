type StatusKind = 'connecting' | 'ready' | 'recording' | 'exiting' | 'error'

let statusEl: HTMLDivElement
let lastEventEl: HTMLDivElement
let micStatsEl: HTMLPreElement
let transcriptEl: HTMLDivElement

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <div>
          <p class="eyebrow">Milestone 2</p>
          <h1>G2 Gemini Live</h1>
        </div>
        <div id="status" class="status status-connecting">Connecting</div>
      </header>
      <section>
        <span>Last event</span>
        <div id="last-event">Waiting for bridge...</div>
      </section>
      <section>
        <span>Mic diagnostics</span>
        <pre id="mic-stats">Waiting for bridge...</pre>
      </section>
      <section>
        <span>Gemini transcript</span>
        <div id="transcript">Waiting for Gemini Live...</div>
      </section>
    </main>
  `

  statusEl = app.querySelector<HTMLDivElement>('#status')!
  lastEventEl = app.querySelector<HTMLDivElement>('#last-event')!
  micStatsEl = app.querySelector<HTMLPreElement>('#mic-stats')!
  transcriptEl = app.querySelector<HTMLDivElement>('#transcript')!
  injectStyles()
}

export function setStatus(kind: StatusKind, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

export function setLastEvent(text: string) {
  if (!lastEventEl) return
  lastEventEl.textContent = text
}

export function setMicStats(text: string) {
  if (!micStatsEl) return
  micStatsEl.textContent = text
}

export function setTranscript(text: string) {
  if (!transcriptEl) return
  transcriptEl.textContent = text
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
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: 0;
    }
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
    }
    .status-ready {
      border-color: #3cfa44;
      color: #3cfa44;
      background: rgba(60, 250, 68, 0.08);
    }
    .status-recording {
      border-color: #ff453a;
      color: #ff9f9a;
      background: rgba(255, 69, 58, 0.08);
    }
    .status-exiting {
      border-color: #7b7b7b;
      color: #e5e5e5;
      background: rgba(229, 229, 229, 0.06);
    }
    .status-error {
      border-color: #ff453a;
      color: #ff453a;
      background: rgba(255, 69, 58, 0.08);
    }
    section {
      border: 1px solid #3e3e3e;
      border-radius: 8px;
      background: #2e2e2e;
      padding: 16px;
      margin-bottom: 12px;
    }
    section span {
      display: block;
      color: #a7a7a7;
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    #last-event,
    #transcript,
    #mic-stats {
      font-size: 17px;
      word-break: break-word;
    }
    #mic-stats {
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
