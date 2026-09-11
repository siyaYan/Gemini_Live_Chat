import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { DISPLAY } from '../config'
import { log, warn, error } from '../log'
import { paginate } from './paginate'

/**
 * The glasses are a glanceable surface, not a terminal.
 *
 * This module renders exactly two things: a short status line, or a page of
 * Gemini's answer. Diagnostics never reach it. It owns BLE throttling and page
 * splitting; it knows nothing about Gemini or conversation state.
 */

/** Inner box available to text, once padding is removed on both sides. */
const INNER_WIDTH = DISPLAY.width - DISPLAY.padding * 2
const INNER_HEIGHT = DISPLAY.height - DISPLAY.padding * 2 - DISPLAY.headingLines * DISPLAY.lineHeightPx

export interface DisplayStats {
  renders: number
  failures: number
  pages: number
  currentPage: number
}

export class G2Display {
  private desiredText = ''
  private lastRendered = ''
  private renderTimer: number | null = null
  private rendering: Promise<void> = Promise.resolve()
  private renders = 0
  private failures = 0
  private pages: string[] = []
  private pageIndex = 0
  private disposed = false

  constructor(private bridge: EvenAppBridge) {}

  getStats(): DisplayStats {
    return {
      renders: this.renders,
      failures: this.failures,
      pages: this.pages.length,
      currentPage: this.pages.length ? this.pageIndex + 1 : 0,
    }
  }

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
    } catch (failure) {
      warn('Display', 'page rebuild failed; trying startup create', failure)
    }

    try {
      await this.createPage(text)
      this.desiredText = text
      this.lastRendered = text
      return
    } catch (failure) {
      warn('Display', 'startup create failed during restore; falling back to text upgrade', failure)
      this.lastRendered = ''
      await this.show(text)
    }
  }

  /** Immediate write. For discrete moments the user is waiting on. */
  async show(text: string): Promise<void> {
    this.cancelPendingRender()
    this.clearResponse()
    this.desiredText = text
    await this.flush()
  }

  /** Throttled status write, for status driven by streaming events. */
  showStatus(status: string): void {
    this.clearResponse()
    this.queue(status)
  }

  /**
   * Render Gemini's answer, paginated.
   *
   * While the answer is still streaming we always show the LAST page, because
   * that is where the new words are arriving. Once the turn completes the page
   * stays put so it can be read.
   */
  showResponse(body: string, follow = true): void {
    const text = body.trim()

    if (!text) {
      this.clearResponse()
      return
    }

    this.pages = paginate(text, { width: INNER_WIDTH, height: INNER_HEIGHT })
    if (!this.pages.length) this.pages = [text]

    if (follow || this.pageIndex >= this.pages.length) {
      this.pageIndex = this.pages.length - 1
    }

    this.queue(this.composeResponse())
  }

  clearResponse(): void {
    this.pages = []
    this.pageIndex = 0
  }

  dispose(): void {
    this.disposed = true
    this.cancelPendingRender()
    this.clearResponse()
  }

  private composeResponse(): string {
    const page = this.pages[this.pageIndex] ?? ''
    // Only mark the page when there is more than one; a counter on every
    // two-sentence answer is noise on a display this small.
    const heading = this.pages.length > 1 ? `Gemini ${this.pageIndex + 1}/${this.pages.length}` : 'Gemini'
    return `${heading}\n${page}`
  }

  private queue(text: string): void {
    if (this.disposed) return
    this.desiredText = text
    if (this.renderTimer !== null) return

    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null
      void this.flush().catch(failure => {
        // A failed display write must never take down the conversation.
        this.failures += 1
        error('Display', 'throttled render failed', failure)
      })
    }, DISPLAY.debounceMs)
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
    this.renders += 1
    log('Display', `updated chars=${text.length} renders=${this.renders}`)

    this.rendering = this.rendering
      .catch(failure => {
        warn('Display', 'previous render failed', failure)
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
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: DISPLAY.containerId,
          containerName: DISPLAY.containerName,
          content: text,
        }),
      )
    } catch (failure) {
      this.failures += 1
      throw failure
    }
  }

  private createTextContainer(content: string): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: DISPLAY.width,
      height: DISPLAY.height,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: DISPLAY.padding,
      containerID: DISPLAY.containerId,
      containerName: DISPLAY.containerName,
      content,
      isEventCapture: 1,
    })
  }
}
