import type { IpcRendererEvent } from 'electron'
import type { RendererStateFlushOutcome } from '../shared/renderer-state-flush'

type FlushListener = (event: IpcRendererEvent, requestId: string) => void
interface FlushTransport {
  /** Subscribes to Main's flush requests; returns the unsubscribe. */
  listen(listener: FlushListener): () => void
  answer(requestId: string, outcome: RendererStateFlushOutcome): void
}

/**
 * Main waits for this page to flush before quitting. Until the renderer installs its flush bridge nothing in
 * the page can hold unsaved state, so the preload answers for it; otherwise a quit during startup waits out the
 * timeout and is refused as "unsaved". Preload state lives exactly as long as the page, so a reload starts clean.
 */
export function createBeforeQuitFlushChannel(transport: FlushTransport) {
  let subscribers = 0
  transport.listen((_event, requestId) => {
    if (subscribers === 0) transport.answer(requestId, { success: true })
  })
  return (callback: (requestId: string) => void): (() => void) => {
    const stop = transport.listen((_event, requestId) => callback(requestId))
    subscribers += 1
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      subscribers -= 1
      stop()
    }
  }
}
