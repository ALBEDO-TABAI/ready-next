import {
  RENDERER_STATE_FLUSH_TIMEOUT_MS,
  type RendererStateFlushOutcome,
} from '../../../shared/renderer-state-flush'

export const DEFAULT_RENDERER_STATE_FLUSH_TIMEOUT_MS = RENDERER_STATE_FLUSH_TIMEOUT_MS

export interface RendererStateFlushTarget {
  id: number
  send(requestId: string): void
  cancel?(requestId: string): void
}

export interface RendererStateFlushLease {
  release(): void
}

interface RendererStateFlushCoordinatorDeps {
  createRequestId(): string
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

interface PendingRendererStateFlush {
  targetId: number
  resolve: (lease: RendererStateFlushLease) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  cancel?: (requestId: string) => void
}

export class RendererStateFlushCoordinator {
  private readonly pending = new Map<string, PendingRendererStateFlush>()
  private readonly held = new Map<string, () => void>()

  constructor(private readonly deps: RendererStateFlushCoordinatorDeps) {}

  request(target: RendererStateFlushTarget | null, timeoutMs: number): Promise<RendererStateFlushLease> {
    if (!target) return Promise.resolve({ release: () => undefined })
    const requestId = this.deps.createRequestId()
    return new Promise((resolve, reject) => {
      const setTimer = this.deps.setTimeout ?? setTimeout
      const timeout = setTimer(() => {
        this.cancel(requestId)
        this.reject(requestId, new Error(`renderer state flush timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timeout.unref?.()
      this.pending.set(requestId, {
        targetId: target.id,
        resolve,
        reject,
        timeout,
        cancel: target.cancel,
      })
      try {
        target.send(requestId)
      } catch (error) {
        this.cancel(requestId)
        this.reject(requestId, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  acknowledge(requestId: string, senderId: number, outcome: RendererStateFlushOutcome): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.targetId !== senderId) return
    if (outcome.success) this.settle(requestId)
    else this.reject(requestId, new Error(outcome.error || 'renderer state flush failed'))
  }

  settleAll(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.cancel(requestId)
      this.reject(requestId, new Error('renderer state flush coordinator was reset'))
    }
    for (const requestId of [...this.held.keys()]) this.release(requestId)
  }

  private cancel(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    try {
      pending.cancel?.(requestId)
    } catch {
      // Cancellation only releases a renderer-side interaction freeze; the
      // original flush failure remains authoritative even if that IPC send fails.
    }
  }

  private settle(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    ;(this.deps.clearTimeout ?? clearTimeout)(pending.timeout)
    this.pending.delete(requestId)
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.release(requestId)
    }
    this.held.set(requestId, () => {
      try {
        pending.cancel?.(requestId)
      } catch {
        // Renderer also owns a bounded lease watchdog, so a failed best-effort
        // release IPC cannot leave interaction frozen forever.
      }
    })
    pending.resolve({ release })
  }

  private reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    ;(this.deps.clearTimeout ?? clearTimeout)(pending.timeout)
    this.pending.delete(requestId)
    pending.reject(error)
  }

  private release(requestId: string): void {
    const release = this.held.get(requestId)
    if (!release) return
    this.held.delete(requestId)
    release()
  }
}
