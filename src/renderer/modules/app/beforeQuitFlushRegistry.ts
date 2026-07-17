import {
  RENDERER_STATE_FLUSH_LEASE_TIMEOUT_MS,
  type RendererStateFlushOutcome,
} from '../../../shared/renderer-state-flush'

type BeforeQuitFlushHandler = () => Promise<void> | void

interface BeforeQuitFlushAPI {
  onBeforeQuitFlush(handler: (requestId: string) => void): () => void
  onBeforeQuitFlushCancelled?(handler: (requestId: string) => void): () => void
  ackBeforeQuitFlushed(requestId: string, outcome: RendererStateFlushOutcome): void
}

interface BeforeQuitFlushBridgeOptions {
  setInteractionFrozen?(frozen: boolean): void
  leaseTimeoutMs?: number
  setTimeout?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout?(handle: ReturnType<typeof setTimeout>): void
}

const handlers = new Map<string, BeforeQuitFlushHandler>()

export function registerBeforeQuitFlushHandler(ownerId: string, handler: BeforeQuitFlushHandler): () => void {
  handlers.set(ownerId, handler)
  return () => {
    if (handlers.get(ownerId) === handler) handlers.delete(ownerId)
  }
}

export async function runBeforeQuitFlushHandlers(): Promise<void> {
  const results = await Promise.allSettled(
    [...handlers.values()].map((handler) => Promise.resolve().then(handler)),
  )
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(errors, '退出前有状态未能保存')
}

function describeFlushError(error: unknown): string {
  const collect = (value: unknown): unknown[] => value instanceof AggregateError
    ? value.errors.flatMap(collect)
    : [value]
  const details = collect(error)
    .map((item) => item instanceof Error ? item.message : String(item))
    .filter(Boolean)
  return (details.join('；') || '退出前有状态未能保存').slice(0, 2_000)
}

function setDefaultInteractionFrozen(frozen: boolean): void {
  if (typeof document === 'undefined') return
  const root = document.getElementById('root')
  if (root) root.inert = frozen
}

export function installBeforeQuitFlushBridge(
  api: BeforeQuitFlushAPI | undefined,
  options: BeforeQuitFlushBridgeOptions = {},
): () => void {
  if (!api) return () => undefined
  const heldRequests = new Map<string, ReturnType<typeof setTimeout>>()
  const setInteractionFrozen = options.setInteractionFrozen ?? setDefaultInteractionFrozen
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout
  const leaseTimeoutMs = options.leaseTimeoutMs ?? RENDERER_STATE_FLUSH_LEASE_TIMEOUT_MS
  const updateInteractionFreeze = () => setInteractionFrozen(heldRequests.size > 0)
  const releaseRequest = (requestId: string) => {
    const timer = heldRequests.get(requestId)
    if (timer === undefined) return
    clearTimer(timer)
    heldRequests.delete(requestId)
    updateInteractionFreeze()
  }
  const unsubscribeRequest = api.onBeforeQuitFlush((requestId) => {
    releaseRequest(requestId)
    const timer = setTimer(() => releaseRequest(requestId), leaseTimeoutMs)
    timer.unref?.()
    heldRequests.set(requestId, timer)
    updateInteractionFreeze()
    void runBeforeQuitFlushHandlers().then(
      () => api.ackBeforeQuitFlushed(requestId, { success: true }),
      (error) => {
        releaseRequest(requestId)
        api.ackBeforeQuitFlushed(requestId, {
          success: false,
          error: describeFlushError(error),
        })
      },
    )
  })
  const unsubscribeCancel = api.onBeforeQuitFlushCancelled?.((requestId) => {
    releaseRequest(requestId)
  }) ?? (() => undefined)
  return () => {
    unsubscribeRequest()
    unsubscribeCancel()
    for (const timer of heldRequests.values()) clearTimer(timer)
    heldRequests.clear()
    updateInteractionFreeze()
  }
}

export function resetBeforeQuitFlushRegistryForTests(): void {
  handlers.clear()
}
