/**
 * Milestone 4 — conversation state.
 *
 * Deliberately small: a state label plus the two transcripts for the current
 * turn. It owns *accumulation*, which matters because Gemini Live streams
 * transcription in fragments — `outputTranscription.text` is a delta, not the
 * whole response, so assigning instead of appending shows only the last
 * fragment. The same applies to `inputTranscription`, which can arrive as
 * several finalized segments for one utterance.
 *
 * No Gemini protocol knowledge lives here; main.ts translates protocol events
 * into these calls.
 */

export type ConversationState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'responding' | 'error'

export interface ConversationSnapshot {
  state: ConversationState
  userText: string
  interimUserText: string
  responseText: string
  turnIndex: number
}

type ChangeListener = (snapshot: ConversationSnapshot, reason: string) => void

export class Conversation {
  private state: ConversationState = 'idle'
  private userText = ''
  private interimUserText = ''
  private responseText = ''
  private turnIndex = 0
  private listener: ChangeListener | null = null

  setListener(listener: ChangeListener | null): void {
    this.listener = listener
  }

  getState(): ConversationState {
    return this.state
  }

  getSnapshot(): ConversationSnapshot {
    return {
      state: this.state,
      userText: this.userText,
      interimUserText: this.interimUserText,
      responseText: this.responseText,
      turnIndex: this.turnIndex,
    }
  }

  setState(next: ConversationState, reason = next): void {
    if (this.state === next) return
    this.state = next
    this.emit(reason)
  }

  /** A finalized fragment of what the user said. */
  appendInputDelta(delta: string): void {
    if (!delta) return
    this.userText = join(this.userText, delta)
    this.interimUserText = ''
    // The user has stopped and Gemini has the utterance; it is now generating.
    if (this.state === 'listening') {
      this.state = 'thinking'
    }
    this.emit('input delta')
  }

  /** Low-latency partial, replaced wholesale on every update. */
  setInterimInput(text: string): void {
    this.interimUserText = text
    this.emit('interim input')
  }

  /** A fragment of Gemini's spoken answer, as text. */
  appendOutputDelta(delta: string): void {
    if (!delta) return
    this.responseText = join(this.responseText, delta)
    if (this.state !== 'responding') {
      this.state = 'responding'
    }
    this.emit('output delta')
  }

  /** Gemini finished this turn; the next user utterance starts a fresh one. */
  completeTurn(): void {
    if (!this.responseText && !this.userText) return
    this.turnIndex += 1
    this.state = 'listening'
    this.emit('turn complete')
  }

  /** Barge-in: the partial answer is no longer what Gemini will say. */
  interrupt(): void {
    this.responseText = ''
    this.state = 'listening'
    this.emit('interrupted')
  }

  /** Clears the accumulators but keeps the turn counter for the session log. */
  startTurn(): void {
    this.userText = ''
    this.interimUserText = ''
    this.responseText = ''
    this.emit('turn start')
  }

  reset(state: ConversationState = 'idle'): void {
    this.state = state
    this.userText = ''
    this.interimUserText = ''
    this.responseText = ''
    this.turnIndex = 0
    this.emit('reset')
  }

  private emit(reason: string): void {
    this.listener?.(this.getSnapshot(), reason)
  }
}

/**
 * Gemini's fragments already carry their own leading spaces (" is the capital"),
 * so plain concatenation is correct. This only guards the case where a fragment
 * begins mid-word after a fragment that ended on a word boundary.
 */
function join(existing: string, delta: string): string {
  if (!existing) return delta.trimStart()
  return existing + delta
}
