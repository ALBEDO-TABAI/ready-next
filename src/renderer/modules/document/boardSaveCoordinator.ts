export interface BoardSaveSnapshot<T> {
  revision: number
  value: T
}

export interface BoardSaveCoordinatorOptions<T, R> {
  delayMs: number
  getSnapshot(): BoardSaveSnapshot<T> | null
  write(snapshot: BoardSaveSnapshot<T>): Promise<R>
  onSaveStart?(snapshot: BoardSaveSnapshot<T>): void
  onSaveSuccess?(snapshot: BoardSaveSnapshot<T>, result: R): void
  onSaveError?(snapshot: BoardSaveSnapshot<T>, error: unknown): void
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

export interface BoardSaveCoordinator {
  schedule(): void
  saveNow(): Promise<void>
  dispose(): Promise<void>
}

export function createBoardSaveCoordinator<T, R>(
  options: BoardSaveCoordinatorOptions<T, R>,
): BoardSaveCoordinator {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  let timer: ReturnType<typeof setTimeout> | null = null
  let tail = Promise.resolve()

  const cancelTimer = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const enqueue = (snapshot: BoardSaveSnapshot<T>): Promise<void> => {
    const operation = tail.then(async () => {
      options.onSaveStart?.(snapshot)
      try {
        const result = await options.write(snapshot)
        options.onSaveSuccess?.(snapshot, result)
      } catch (error) {
        options.onSaveError?.(snapshot, error)
        throw error
      }
    })
    tail = operation.catch(() => undefined)
    return operation
  }

  const saveNow = async (): Promise<void> => {
    cancelTimer()
    const snapshot = options.getSnapshot()
    if (!snapshot) {
      await tail
      return
    }
    await enqueue(snapshot)
  }

  return {
    schedule() {
      cancelTimer()
      timer = setTimer(() => {
        timer = null
        void saveNow().catch(() => undefined)
      }, options.delayMs)
    },
    saveNow,
    async dispose() {
      cancelTimer()
      const snapshot = options.getSnapshot()
      if (snapshot) await enqueue(snapshot)
      else await tail
    },
  }
}
