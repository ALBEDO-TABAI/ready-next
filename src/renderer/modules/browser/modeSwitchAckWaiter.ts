/**
 * Stage X4 PR-shell-2 — mode-switch hide-all ack waiter.
 *
 * Per plan §9 lines 680–684, the renderer issues a `hide-all`
 * BrowserViewIntent before flipping workbench mode away from browser
 * and waits for the main-side ack carrying the matching `intentId`
 * before mounting the DOM-only overlay. Failure-protection rules:
 *
 * - **Ack timeout** (100 ms): if the main process does not ack within
 *   100 ms, the renderer assumes the ack was lost and proceeds with
 *   the state flip anyway, logging `mode-switch-ack-timeout`. The
 *   cost (1 frame of overlap risk) is acceptable; a permanent hang is
 *   not.
 * - **Stale ack**: each `hide-all` intent carries a monotonically
 *   increasing `intentId`; acks carrying a stale id are logged and
 *   ignored — renderer keeps waiting for the current one (until the
 *   timeout).
 * - **Cancelled mode switch**: if the user clicks a different mode
 *   while still waiting for ack, the in-flight switch is cancelled
 *   (intentId orphaned). The orphaned ack will arrive and be dropped
 *   per the stale-ack rule. The caller emits a fresh `hide-all` with
 *   the new id.
 *
 * This module is decoupled from `window.electronAPI` so the behavior
 * tests can drive it with a stub ack source.
 */

import type { BrowserViewIntentAck } from '../../../shared/browser-view-intent'

export const MODE_SWITCH_ACK_TIMEOUT_MS = 100

export type AckSource = (callback: (ack: BrowserViewIntentAck) => void) => () => void

export type AckWaiterOutcome =
  | { outcome: 'ack'; intentId: number }
  | { outcome: 'timeout'; intentId: number }
  | { outcome: 'cancelled'; intentId: number }

export interface AckWaiterDeps {
  setTimeout: (cb: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  log?: (event: 'mode-switch-ack-timeout' | 'mode-switch-ack-stale' | 'mode-switch-ack-cancelled', detail: { intentId: number; staleIntentId?: number }) => void
}

const defaultDeps: AckWaiterDeps = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  log: (event, detail) => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[ready][mode-switch] ${event}`, detail)
    }
  },
}

/**
 * Mode-switch ack waiter — single-flight contract:
 *
 * - `await` returns when EITHER the matching ack arrives OR the timeout
 *   fires. In both cases the caller proceeds to flip mode.
 * - `cancel()` orphans the waiter — promise resolves with
 *   `outcome: 'cancelled'` and the late-arriving ack (if any) is
 *   ignored.
 *
 * Construct one per mode-switch transition; do not reuse.
 */
export function createModeSwitchAckWaiter(
  ackSource: AckSource,
  intentId: number,
  deps: AckWaiterDeps = defaultDeps,
): { wait: Promise<AckWaiterOutcome>; cancel: () => void } {
  let resolveOutcome!: (outcome: AckWaiterOutcome) => void
  const wait = new Promise<AckWaiterOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  let settled = false
  const settle = (outcome: AckWaiterOutcome) => {
    if (settled) return
    settled = true
    deps.clearTimeout(timeoutHandle)
    unsubscribe()
    resolveOutcome(outcome)
  }

  const unsubscribe = ackSource((ack) => {
    if (settled) return
    if (ack.intentId !== intentId) {
      deps.log?.('mode-switch-ack-stale', { intentId, staleIntentId: ack.intentId })
      return
    }
    settle({ outcome: 'ack', intentId })
  })

  const timeoutHandle = deps.setTimeout(() => {
    if (settled) return
    deps.log?.('mode-switch-ack-timeout', { intentId })
    settle({ outcome: 'timeout', intentId })
  }, MODE_SWITCH_ACK_TIMEOUT_MS)

  const cancel = () => {
    if (settled) return
    deps.log?.('mode-switch-ack-cancelled', { intentId })
    settle({ outcome: 'cancelled', intentId })
  }

  return { wait, cancel }
}
