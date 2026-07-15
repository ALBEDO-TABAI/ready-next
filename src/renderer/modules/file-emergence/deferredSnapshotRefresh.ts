export interface DeferredSnapshotRefreshHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (handle: number) => void
}

export interface DeferredSnapshotRefresh {
  schedule: () => void
  cancel: () => void
}

export function createDeferredSnapshotRefresh(
  refresh: () => void,
  host: DeferredSnapshotRefreshHost = window,
  options: { fallbackDelayMs?: number; idleTimeoutMs?: number } = {},
): DeferredSnapshotRefresh {
  const fallbackDelayMs = options.fallbackDelayMs ?? 1_200
  const idleTimeoutMs = options.idleTimeoutMs ?? 5_000
  let pending: { kind: 'idle' | 'timer'; id: number } | null = null

  const cancel = () => {
    if (!pending) return
    if (pending.kind === 'idle' && host.cancelIdleCallback) host.cancelIdleCallback(pending.id)
    else host.clearTimeout(pending.id)
    pending = null
  }

  const run = () => {
    pending = null
    refresh()
  }

  return {
    schedule: () => {
      cancel()
      if (host.requestIdleCallback && host.cancelIdleCallback) {
        pending = {
          kind: 'idle',
          id: host.requestIdleCallback(run, { timeout: idleTimeoutMs }),
        }
        return
      }
      pending = { kind: 'timer', id: host.setTimeout(run, fallbackDelayMs) }
    },
    cancel,
  }
}
