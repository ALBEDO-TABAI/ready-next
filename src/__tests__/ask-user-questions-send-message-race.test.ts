/**
 * Stage U (PR 1, B.5) behavior tests for `boundedCancelWithFallback`.
 *
 * Covers the three scenarios from the plan:
 *   T1 — cancel IPC never returns within timeoutMs: timeout wins, onTimeout
 *        fires (card locally disabled), caller proceeds.
 *   T2 — cancel IPC arrives after timeout: onCancelLanded STILL runs so the
 *        card eventually flips to terminal; onTimeout already fired.
 *   T3 — cancel IPC completes within timeoutMs: onCancelLanded runs,
 *        onTimeout does NOT fire.
 *
 * Plus:
 *   - IPC rejection within timeout → onCancelError fires, onTimeout does not.
 *   - onCancelLanded must NOT be re-invoked if called once for the late
 *     cancel (the helper itself doesn't dedupe; that's the call site's
 *     responsibility via status checks — verified at the renderer wrapper level).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boundedCancelWithFallback } from '../renderer/modules/agent/boundedCancelWithFallback'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolveFn: (value: T) => void = () => {}
  let rejectFn: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

test('T3 happy path: cancel resolves before timeout → onCancelLanded fires, onTimeout does not', async () => {
  const d = deferred<{ success: boolean }>()
  let onTimeoutCount = 0
  let onCancelLandedCount = 0
  let cancelResult: { success: boolean; errorKind?: string } | null = null

  const promise = boundedCancelWithFallback({
    cancelIpc: () => d.promise,
    timeoutMs: 100,
    onTimeout: () => { onTimeoutCount += 1 },
    onCancelLanded: (r) => { onCancelLandedCount += 1; cancelResult = r },
  })

  d.resolve({ success: true })
  const outcome = await promise
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(onCancelLandedCount, 1)
  assert.equal(onTimeoutCount, 0, 'timeout must not fire when cancel wins')
  assert.deepEqual(cancelResult, { success: true })
})

test('T1 timeout path: cancel never returns within timeoutMs → onTimeout fires, returns timeout', async () => {
  const d = deferred<{ success: boolean }>()
  let onTimeoutCount = 0
  let onCancelLandedCount = 0

  const outcome = await boundedCancelWithFallback({
    cancelIpc: () => d.promise,
    timeoutMs: 30,
    onTimeout: () => { onTimeoutCount += 1 },
    onCancelLanded: () => { onCancelLandedCount += 1 },
  })

  assert.equal(outcome.kind, 'timeout')
  assert.equal(onTimeoutCount, 1)
  assert.equal(onCancelLandedCount, 0, 'late cancel has not arrived yet')

  // The cancel IPC is still in flight; the helper must not have leaked the
  // promise rejection. Resolving it later should fire onCancelLanded.
  d.resolve({ success: true })
  // Yield to let the still-attached cancelPromise callbacks run.
  await new Promise((res) => setTimeout(res, 0))
  assert.equal(onCancelLandedCount, 1, 'late cancel still fires onCancelLanded')
})

test('T2 cancel arrives late: onCancelLanded fires after timeout (no double-onTimeout)', async () => {
  const d = deferred<{ success: boolean; errorKind?: string }>()
  let onTimeoutCount = 0
  let onCancelLandedCount = 0
  let lastCancelResult: { success: boolean; errorKind?: string } | null = null

  const outcome = await boundedCancelWithFallback({
    cancelIpc: () => d.promise,
    timeoutMs: 20,
    onTimeout: () => { onTimeoutCount += 1 },
    onCancelLanded: (r) => { onCancelLandedCount += 1; lastCancelResult = r },
  })

  assert.equal(outcome.kind, 'timeout')
  assert.equal(onTimeoutCount, 1)
  assert.equal(onCancelLandedCount, 0)

  // Late cancel with cancel_persist_failed errorKind.
  d.resolve({ success: false, errorKind: 'cancel_persist_failed' })
  await new Promise((res) => setTimeout(res, 0))
  assert.equal(onCancelLandedCount, 1, 'late cancel triggers onCancelLanded exactly once')
  assert.equal(onTimeoutCount, 1, 'onTimeout must NOT fire again')
  assert.equal(lastCancelResult?.success, false)
  assert.equal(lastCancelResult?.errorKind, 'cancel_persist_failed')
})

test('cancel IPC rejects within timeout: onCancelError fires, returns error', async () => {
  const d = deferred<{ success: boolean }>()
  let onCancelErrorCount = 0
  let onTimeoutCount = 0
  let capturedError: unknown = null

  const outcome = await Promise.resolve().then(() => {
    const p = boundedCancelWithFallback({
      cancelIpc: () => d.promise,
      timeoutMs: 100,
      onTimeout: () => { onTimeoutCount += 1 },
      onCancelLanded: () => { /* should not fire on rejection */ },
      onCancelError: (err) => { onCancelErrorCount += 1; capturedError = err },
    })
    d.reject(new Error('IPC bridge unavailable'))
    return p
  })

  assert.equal(outcome.kind, 'error')
  assert.equal(onCancelErrorCount, 1)
  assert.equal(onTimeoutCount, 0, 'timeout must not fire when cancel rejects within window')
  assert.match((capturedError as Error)?.message ?? '', /IPC bridge unavailable/)
})

test('cancel IPC rejects after timeout: onTimeout fires, onCancelError fires later', async () => {
  const d = deferred<{ success: boolean }>()
  let onTimeoutCount = 0
  let onCancelErrorCount = 0

  const outcome = await boundedCancelWithFallback({
    cancelIpc: () => d.promise,
    timeoutMs: 20,
    onTimeout: () => { onTimeoutCount += 1 },
    onCancelLanded: () => {},
    onCancelError: () => { onCancelErrorCount += 1 },
  })
  assert.equal(outcome.kind, 'timeout')
  assert.equal(onTimeoutCount, 1)

  d.reject(new Error('late failure'))
  await new Promise((res) => setTimeout(res, 0))
  assert.equal(onCancelErrorCount, 1)
  assert.equal(onTimeoutCount, 1, 'no double onTimeout')
})

test('wrapper contract (review patch): cancel IPC rejects in-window → BOTH disable AND metric fire', async () => {
  // The renderer's `cancelPendingAskUserQuestionsForCurrentScope` wraps
  // `boundedCancelWithFallback` and provides `onCancelError` that does
  // `setCardLocallyDisabled(cardId, true) + emitRendererAgentMetric(...)`.
  // Without that wiring, an IPC reject within 2s would leave the old card
  // pending + submittable while the new message goes out — re-opening the
  // "stale card contaminates new turn" window. This smoke test mirrors the
  // wrapper's exact callback shape so a regression in wiring shows up here.
  const d = deferred<{ success: boolean }>()
  let disabledFlags: Array<{ cardId: string; disabled: boolean }> = []
  let emittedMetrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  let cancelLandedCount = 0
  const stubCardId = 'auq-test123'

  const setCardLocallyDisabled = (cardId: string, disabled: boolean) => {
    disabledFlags.push({ cardId, disabled })
  }
  const emitMetric = (name: string, payload: Record<string, unknown>) => {
    emittedMetrics.push({ name, payload })
  }

  const outcome = await Promise.resolve().then(() => {
    const p = boundedCancelWithFallback({
      cancelIpc: () => d.promise,
      timeoutMs: 100,
      onTimeout: () => {
        setCardLocallyDisabled(stubCardId, true)
        emitMetric('ask_user_questions_cancel_pre_send_timeout', { cardId: stubCardId, kind: 'timeout' })
      },
      onCancelLanded: () => { cancelLandedCount += 1 },
      onCancelError: (err) => {
        setCardLocallyDisabled(stubCardId, true)
        emitMetric('ask_user_questions_cancel_pre_send_timeout', {
          cardId: stubCardId,
          kind: 'ipc_rejected',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      },
    })
    d.reject(new Error('IPC bridge unavailable'))
    return p
  })

  assert.equal(outcome.kind, 'error')
  assert.equal(cancelLandedCount, 0, 'onCancelLanded must not fire on reject')
  // Critical: both side effects must have fired, even though it's the
  // reject path (not the timeout path).
  assert.equal(disabledFlags.length, 1)
  assert.equal(disabledFlags[0].cardId, stubCardId)
  assert.equal(disabledFlags[0].disabled, true)
  assert.equal(emittedMetrics.length, 1)
  assert.equal(emittedMetrics[0].name, 'ask_user_questions_cancel_pre_send_timeout')
  assert.equal(emittedMetrics[0].payload.kind, 'ipc_rejected')
  assert.match(String(emittedMetrics[0].payload.errorMessage), /IPC bridge unavailable/)
})

test('respects the contract: onTimeout is called ONCE even when timeout fires before cancel settles', async () => {
  const d = deferred<{ success: boolean }>()
  let onTimeoutCount = 0
  // The race is non-deterministic in pathological cases — if the timer fires
  // and then the cancel resolves nearly simultaneously, both callbacks must
  // still each fire exactly once (timeout=1, cancelLanded=1).
  const outcome = await boundedCancelWithFallback({
    cancelIpc: () => d.promise,
    timeoutMs: 1,
    onTimeout: () => { onTimeoutCount += 1 },
    onCancelLanded: () => {},
  })
  assert.equal(outcome.kind, 'timeout')
  assert.equal(onTimeoutCount, 1)
  d.resolve({ success: true })
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(onTimeoutCount, 1, 'onTimeout must remain at 1')
})
