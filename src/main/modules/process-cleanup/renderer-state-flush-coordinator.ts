export interface RendererStateFlushTarget {
  id: number
  send(requestId: string): void
}

interface RendererStateFlushCoordinatorDeps {
  createRequestId(): string
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

interface PendingRendererStateFlush {
  targetId: number
  resolve: () => void
  timeout: ReturnType<typeof setTimeout>
}

export class RendererStateFlushCoordinator {
  private readonly pending = new Map<string, PendingRendererStateFlush>()

  constructor(private readonly deps: RendererStateFlushCoordinatorDeps) {}

  request(target: RendererStateFlushTarget | null, timeoutMs: number): Promise<void> {
    if (!target) return Promise.resolve()
    const requestId = this.deps.createRequestId()
    return new Promise((resolve) => {
      const setTimer = this.deps.setTimeout ?? setTimeout
      const timeout = setTimer(() => this.settle(requestId), timeoutMs)
      timeout.unref?.()
      this.pending.set(requestId, { targetId: target.id, resolve, timeout })
      try {
        target.send(requestId)
      } catch {
        this.settle(requestId)
      }
    })
  }

  acknowledge(requestId: string, senderId: number): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.targetId !== senderId) return
    this.settle(requestId)
  }

  settleAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId)
  }

  private settle(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    ;(this.deps.clearTimeout ?? clearTimeout)(pending.timeout)
    this.pending.delete(requestId)
    pending.resolve()
  }
}
