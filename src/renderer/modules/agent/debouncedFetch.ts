/**
 * Stage O §1.1 — debounced trigger used by ChatPanel's
 * `agent:taskProjectionsChanged` subscription. The push event can arrive
 * 5+ times in rapid succession (child-runner finalize close batches
 * several updates back-to-back); coalescing them into one fetch avoids
 * IPC churn while keeping the renderer responsive.
 *
 * `cancel()` is required: the effect cleanup calls it so a pending
 * timer doesn't fire after the component unmounts or the dependency
 * tuple changes.
 */
export interface DebouncedFetcher {
  run(): void
  cancel(): void
}

export function createDebouncedFetch(fn: () => void, delay: number): DebouncedFetcher {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    run: () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, delay)
    },
    cancel: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
