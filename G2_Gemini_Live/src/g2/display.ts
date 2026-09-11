import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

export class G2Display {
  private currentText = ''
  private rendering: Promise<void> = Promise.resolve()

  constructor(private bridge: EvenAppBridge) {}

  async mount(initialText: string): Promise<void> {
    await this.createPage(initialText)
    this.currentText = initialText
  }

  async restore(text: string): Promise<void> {
    this.currentText = ''

    try {
      await this.createPage(text)
      this.currentText = text
    } catch (error) {
      console.warn('[G2 Display] Page restore failed; trying text upgrade.', error)
      this.currentText = ''
      await this.show(text)
    }
  }

  async show(text: string): Promise<void> {
    if (text === this.currentText) return
    this.currentText = text
    this.rendering = this.rendering
      .catch(error => {
        console.warn('[G2 Display] Previous render failed:', error)
      })
      .then(() => this.upgrade(text))
    await this.rendering
  }

  private async createPage(text: string): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: DISPLAY_WIDTH,
            height: DISPLAY_HEIGHT,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 4,
            containerID: CONTAINER_ID,
            containerName: CONTAINER_NAME,
            content: text,
            isEventCapture: 1,
          }),
        ],
      }),
    )

    if (result !== 0) {
      throw new Error(`createStartUpPageContainer failed: ${result}`)
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
}
