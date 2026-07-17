import { nextIntentId } from '../../../shared/browser-view-intent'
import {
  createModeSwitchAckWaiter,
  type AckWaiterOutcome,
} from '../browser/modeSwitchAckWaiter'

export const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

export function didBrowserHideAck(outcome: AckWaiterOutcome): boolean {
  return outcome.outcome === 'ack'
}

export async function beginBrowserMask(options: { persistent?: boolean } = {}): Promise<void> {
  if (typeof window === 'undefined') return
  const browser = window.electronAPI?.browser
  let alreadyHidden = false
  if (browser?.sendIntent && browser.onIntentAck) {
    try {
      const intentId = nextIntentId()
      const waiter = createModeSwitchAckWaiter(browser.onIntentAck, intentId)
      browser.sendIntent({
        kind: 'hide-all',
        intentId,
        reason: 'overlay-open',
        expectsAck: true,
      })
      alreadyHidden = didBrowserHideAck(await waiter.wait)
    } catch {
      // silent-catch: native hide acknowledgement is best-effort; the DOM mask must still lock immediately.
      alreadyHidden = false
    }
  }
  const detail = options.persistent
    ? { locked: true, alreadyHidden, persistent: true }
    : { locked: true, alreadyHidden }
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail }))
}

export function beginPersistentBrowserMask(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail: { locked: true, persistent: true } }))
}

export async function endBrowserMask(): Promise<void> {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail: { locked: false } }))
  await new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') { resolve(); return }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

export async function endPersistentBrowserMask(): Promise<void> {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail: { locked: false, persistent: true } }))
  await new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') { resolve(); return }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}
