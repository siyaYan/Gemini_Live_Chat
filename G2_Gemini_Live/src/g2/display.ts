import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

/**
 * 120 ms matches the official ASR template's debounce comment: "BLE render
 * queue is slow". Gemini emits output-transcription deltas far faster than
 * that, so without it every few characters would become a BLE write.
 */
const RENDER_DEBOUNCE_MS = 120

/**
 * Also from the ASR template: ~240 characters is a rough fit for the 576x288
 * text container at the default font. The response body gets slightly less
 * because of the "Gemini:" heading line.
 */
export const GLASSES_CHAR_BUDGET = 240
const RESPONSE_CHAR_BUDGET = GLASSES_CHAR_BUDGET - 10

export class G2Display {
  private desiredText = ''
  private lastRendered = ''
  private renderTimer: number | null = null
  private rendering: Promise<void> = Promise.resolve()
  private renderCount = 0

  constructor(private bridge: EvenAppBridge) {}

  async mount(initialText: string): Promise<void> {
    await this.createPage(initialText)
    this.desiredText = initialText
    this.lastRendered = initialText
  }

  async restore(text: string): Promise<void> {
    this.cancelPendingRender()
    this.lastRendered = ''

    try {
      await this.rebuildPage(text)
      this.desiredText = text
      this.lastRendered = text
      return
    } catch (error) {
      console.warn('[G2 Display] Page rebuild failed; trying startup create.', error)
    }

    try {
      await this.createPage(text)
      this.desiredText = text
      this.lastRendered = text
      return
    } catch (error) {
      console.warn('[G2 Display] Startup create failed during restore; trying text upgrade.', error)
      this.lastRendered = ''
      await this.show(text)
    }
  }

  /** Immediate write. Use for discrete state changes the user is waiting on. */
  async show(text: string): Promise<void> {
    this.cancelPendingRender()
    this.desiredText = text
    await this.flush()
  }

  /** Immediate write of a short status line ("Listening...", "Thinking..."). */
  async showStatus(status: string): Promise<void> {
    await this.show(status)
  }

  /**
   * Throttled write for streaming response text. Fire-and-forget by design:
   * transcription deltas must never block the WebSocket message handler.
   */
  showResponse(body: string, heading = 'Gemini:'): void {
    const fitted = fitForGlasses(body, RESPONSE_CHAR_BUDGET)
    this.queue(fitted ? `${heading}\n${fitted}` : heading)
  }

  /** Throttled status write, for status changes driven by streaming events. */
  queueStatus(text: string): void {
    this.queue(text)
  }

  clearResponse(readyText: string): void {
    this.queue(readyText)
  }

  getRenderCount(): number {
    return this.renderCount
  }

  private queue(text: string): void {
    this.desiredText = text
    if (this.renderTimer !== null) return

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null
      void this.flush().catch(error => {
        // A failed display write must not kill the Gemini session.
        console.error('[G2 Display] throttled render failed:', error)
      })
    }, RENDER_DEBOUNCE_MS)
  }

  private cancelPendingRender(): void {
    if (this.renderTimer === null) return
    window.clearTimeout(this.renderTimer)
    this.renderTimer = null
  }

  private flush(): Promise<void> {
    const text = this.desiredText
    if (text === this.lastRendered) return this.rendering

    this.lastRendered = text
    this.renderCount += 1
    console.log(`[G2 Display] response updated chars=${text.length} renders=${this.renderCount}`)

    this.rendering = this.rendering
      .catch(error => {
        console.warn('[G2 Display] Previous render failed:', error)
      })
      .then(() => this.upgrade(text))

    return this.rendering
  }

  private async createPage(text: string): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [this.createTextContainer(text)],
      }),
    )

    if (result !== 0) {
      throw new Error(`createStartUpPageContainer failed: ${result}`)
    }
  }

  private async rebuildPage(text: string): Promise<void> {
    const result = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: [this.createTextContainer(text)],
      }),
    )

    if (!result) {
      throw new Error('rebuildPageContainer returned false')
    }
  }

  private async upgrade(text: string): Promise<void> {
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content: text,
      }),
    )
  }

  private createTextContainer(content: string): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 4,
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content,
      isEventCapture: 1,
    })
  }
}

/**
 * Milestone 4 keeps pagination trivial: show the most recent readable block.
 * A long answer is tailed rather than truncated at the front, because the text
 * is still streaming in — the end is the part that just arrived. The cut is
 * moved to a word boundary so the first visible word is not half a word.
 */
export function fitForGlasses(text: string, budget = RESPONSE_CHAR_BUDGET): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= budget) return clean

  const tail = clean.slice(clean.length - budget)
  const boundary = tail.indexOf(' ')
  const trimmed = boundary > 0 && boundary < 40 ? tail.slice(boundary + 1) : tail

  return `…${trimmed}`
}
