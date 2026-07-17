type BeforeQuitFlushHandler = () => Promise<void> | void

interface BeforeQuitFlushAPI {
  onBeforeQuitFlush(handler: (requestId: string) => void): () => void
  ackBeforeQuitFlushed(requestId: string): void
}

const handlers = new Map<string, BeforeQuitFlushHandler>()

export function registerBeforeQuitFlushHandler(ownerId: string, handler: BeforeQuitFlushHandler): () => void {
  handlers.set(ownerId, handler)
  return () => {
    if (handlers.get(ownerId) === handler) handlers.delete(ownerId)
  }
}

export async function runBeforeQuitFlushHandlers(): Promise<void> {
  await Promise.allSettled([...handlers.values()].map((handler) => Promise.resolve().then(handler)))
}

export function installBeforeQuitFlushBridge(api: BeforeQuitFlushAPI | undefined): () => void {
  if (!api) return () => undefined
  return api.onBeforeQuitFlush((requestId) => {
    void runBeforeQuitFlushHandlers().finally(() => api.ackBeforeQuitFlushed(requestId))
  })
}

export function resetBeforeQuitFlushRegistryForTests(): void {
  handlers.clear()
}
