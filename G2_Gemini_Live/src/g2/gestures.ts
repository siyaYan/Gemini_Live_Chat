import { OsEventTypeList } from '@evenrealities/even_hub_sdk'

type EventEnvelope = {
  eventType?: OsEventTypeList
}

export type EvenHubGesture =
  | 'single-tap'
  | 'double-tap'
  | 'foreground-enter'
  | 'foreground-exit'
  | 'system-exit'
  | 'none'

export type EvenHubEventLike = {
  sysEvent?: EventEnvelope
  textEvent?: EventEnvelope
  listEvent?: EventEnvelope
}

export function interpretGesture(event: EvenHubEventLike): EvenHubGesture {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    return 'double-tap'
  }

  if (
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT ||
    listType === OsEventTypeList.CLICK_EVENT
  ) {
    return 'single-tap'
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    return 'foreground-enter'
  }

  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    return 'foreground-exit'
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    return 'system-exit'
  }

  return 'none'
}

function eventTypeOf(envelope?: EventEnvelope): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
