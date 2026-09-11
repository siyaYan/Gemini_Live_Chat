import { log } from '../log'

/**
 * Conversation state — the single source of truth.
 *
 * Milestone 6 rule: no other module decides what the user sees. Protocol code
 * reports events, this class folds them into a state plus the current turn's
 * transcripts, and the orchestrator renders the result. Nothing else writes to
 * the display.
 *
 * It also owns accumulation, because Gemini streams transcription as fragments
 * — `outputTranscription.text` is a delta, not the whole answer.
 */

export type ConversationState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'responding'
  | 'reconnecting'
  | 'error'

export interface ConversationSnapshot {
  state: ConversationState
  userText: string
  interimUserText: string
  responseText: string
  turnIndex: number
  /** Bumped whenever a turn is abandoned, so late frames can be ignored. */
  turnEpoch: number
}

type ChangeListener = (snapshot: ConversationSnapshot, reason: string) => void

/** Transcript buffers are capped so a long session cannot grow without bound. */
const MAX_TURN_CHARS = 4000

export class Conversation {
  private state: ConversationState = 'idle'
  private userText = ''
  private interimUserText = ''
  private responseText = ''
  private turnIndex = 0
  private turnEpoch = 0
  private listener: ChangeListener | null = null

  setListener(listener: ChangeListener | null): void {
    this.listener = listener
  }

  getState(): ConversationState {
    return this.state
  }

  getEpoch(): number {
    return this.turnEpoch
  }

  getSnapshot(): ConversationSnapshot {
    return {
      state: this.state,
      userText: this.userText,
      interimUserText: this.interimUserText,
      responseText: this.responseText,
      turnIndex: this.turnIndex,
      turnEpoch: this.turnEpoch,
    }
  }

  setState(next: ConversationState, reason: string = next): void {
    if (this.state === next) return
    log('Session', `state ${this.state} -> ${next} (${reason})`)
    this.state = next
    this.emit(reason)
  }

  /** A finalized fragment of what the user said. */
  appendInputDelta(delta: string): void {
    if (!delta) return
    this.userText = clamp(join(this.userText, delta))
    this.interimUserText = ''

    // The user has stopped and Gemini has the utterance; it is now generating.
    if (this.state === 'listening') this.state = 'thinking'

    this.emit('input delta')
  }

  /** Low-latency partial; replaced wholesale on every update. */
  setInterimInput(text: string): void {
    this.interimUserText = clamp(text)
    this.emit('interim input')
  }

  /** A fragment of Gemini's answer, as text. */
  appendOutputDelta(delta: string): void {
    if (!delta) return
    this.responseText = clamp(join(this.responseText, delta))
    if (this.state !== 'responding') this.state = 'responding'
    this.emit('output delta')
  }

  /** Gemini finished the turn; the answer stays on screen until the next one. */
  completeTurn(): void {
    if (!this.responseText && !this.userText) return
    this.turnIndex += 1
    this.state = 'listening'
    this.emit('turn complete')
  }

  /**
   * Barge-in. The partial answer is no longer what Gemini will say, and the
   * epoch bump lets the orchestrator discard transcript frames that were
   * already in flight when the interruption landed.
   */
  interrupt(): void {
    this.responseText = ''
    this.turnEpoch += 1
    this.state = 'listening'
    this.emit('interrupted')
  }

  /** Clears the accumulators when a new utterance begins. */
  startTurn(): void {
    this.userText = ''
    this.interimUserText = ''
    this.responseText = ''
    this.turnEpoch += 1
    this.emit('turn start')
  }

  reset(state: ConversationState = 'idle'): void {
    this.state = state
    this.userText = ''
    this.interimUserText = ''
    this.responseText = ''
    this.turnIndex = 0
    this.turnEpoch += 1
    this.emit('reset')
  }

  private emit(reason: string): void {
    this.listener?.(this.getSnapshot(), reason)
  }
}

/**
 * Gemini's fragments carry their own leading spaces (" is the capital"), so
 * plain concatenation is correct.
 */
function join(existing: string, delta: string): string {
  if (!existing) return delta.trimStart()
  return existing + delta
}

function clamp(text: string): string {
  if (text.length <= MAX_TURN_CHARS) return text
  return text.slice(text.length - MAX_TURN_CHARS)
}
