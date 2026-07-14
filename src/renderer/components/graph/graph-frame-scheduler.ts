export interface LatestFrameScheduler<T> {
  schedule(value: T): void
  flush(): void
  cancel(): void
}

export function createLatestFrameScheduler<T>(
  commit: (value: T) => void,
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (handle: number) => void,
): LatestFrameScheduler<T> {
  let pending: T | undefined
  let frameHandle: number | null = null

  const commitPending = () => {
    frameHandle = null
    if (pending === undefined) return
    const next = pending
    pending = undefined
    commit(next)
  }

  return {
    schedule(value) {
      pending = value
      if (frameHandle === null) frameHandle = requestFrame(commitPending)
    },
    flush() {
      if (frameHandle !== null) cancelFrame(frameHandle)
      commitPending()
    },
    cancel() {
      if (frameHandle !== null) cancelFrame(frameHandle)
      frameHandle = null
      pending = undefined
    },
  }
}
