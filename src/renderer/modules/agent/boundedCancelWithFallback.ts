/**
 * Stage U (PR 1, B.5) — bounded-wait helper for the sendMessage pre-send
 * cancel hook.
 *
 * The renderer's `cancelPendingAskUserQuestionsForCurrentScope` is the real
 * call site; this helper isolates the timing algorithm so it can be tested
 * without `window.electronAPI` / store globals.
 *
 * Algorithm:
 *   1. Start the cancel IPC (`cancelIpc()`).
 *   2. Race it against a `timeoutMs` setTimeout.
 *   3. If cancel wins: invoke `onCancelLanded(result)` (renderer folds card
 *      to `cancelled (user_typed_instead | cancel_persist_failed)`).
 *   4. If timeout wins: invoke `onTimeout()` (renderer marks card
 *      `localDisabled = true` and emits the timeout metric). The cancel
 *      promise is still awaited in the background so its late return can
 *      flip the card to terminal — onCancelLanded is invoked for late
 *      arrivals too.
 *
 * Returns the winner of the race so callers / tests can assert ordering.
 */

export type BoundedCancelOutcome =
  | { kind: 'cancelled'; result: { success: boolean; errorKind?: string } }
  | { kind: 'timeout' }
  | { kind: 'error'; error: unknown }

export interface BoundedCancelDeps {
  cancelIpc: () => Promise<{ success: boolean; errorKind?: string }>
  /** Side effect when timeout fires before cancel returns. Called exactly
   *  once even if late cancel arrives later. */
  onTimeout: () => void
  /** Side effect when cancel IPC resolves (including late arrivals after
   *  a timeout). Called at most once. */
  onCancelLanded: (result: { success: boolean; errorKind?: string }) => void
  /** Optional: invoked when cancel IPC rejects (after timeout or before).
   *  Defaults to a no-op. */
  onCancelError?: (error: unknown) => void
  timeoutMs: number
}

export async function boundedCancelWithFallback(
  deps: BoundedCancelDeps,
): Promise<BoundedCancelOutcome> {
  const { cancelIpc, onTimeout, onCancelLanded, onCancelError, timeoutMs } = deps
  let cancelSettled = false
  let timeoutFired = false

  const cancelPromise = cancelIpc()
    .then((result) => {
      cancelSettled = true
      onCancelLanded(result)
      return { kind: 'cancelled' as const, result }
    })
    .catch((error) => {
      cancelSettled = true
      if (onCancelError) onCancelError(error)
      return { kind: 'error' as const, error }
    })

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<BoundedCancelOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true
      if (!cancelSettled) onTimeout()
      resolve({ kind: 'timeout' })
    }, timeoutMs)
  })

  const winner = await Promise.race([cancelPromise, timeoutPromise])
  if (timeoutHandle) clearTimeout(timeoutHandle)
  // If timeout won, ensure the cancel promise's outcome callbacks STILL run
  // when (if ever) the IPC eventually resolves. We don't await — that would
  // make the bounded wait unbounded. Fire-and-forget cleanup is fine; the
  // onCancelLanded callback's idempotency is the caller's responsibility
  // (current callers only flip card status if it's still 'pending').
  if (winner.kind === 'timeout') {
    cancelPromise.catch(() => {
      /* error path already covered by onCancelError */
    })
  }
  // Silence unused-var lint — `timeoutFired` is for the call-site logging
  // contract: when both onTimeout and onCancelLanded fire (timeout then late
  // cancel), the call site can detect this combo via the returned `kind`.
  void timeoutFired
  return winner
}
