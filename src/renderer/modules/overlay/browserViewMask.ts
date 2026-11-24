import { nextIntentId } from '../../../shared/browser-view-intent'
import {
  createModeSwitchAckWaiter,
  type AckWaiterOutcome,
} from '../browser/modeSwitchAckWaiter'

export const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

export function didBrowserHideAck(outcome: AckWaiterOutcome): boolean {
  return outcome.outcome === 'ack'
}

/** Asks every native-page host for a still of its page before the native views step aside (useBrowserResizeFreeze,
 *  useOverlayPageStill). A host that takes the request passes the promise of its still to `hold`. */
export const BROWSER_FREEZE_REQUEST_EVENT = 'ready:browser-freeze-request'
export interface BrowserFreezeRequestDetail { hold: (still: Promise<unknown>) => void }
/** The longest an overlay waits for the stills; past it, the views step aside anyway (a page may then show blank). */
const FREEZE_REQUEST_TIMEOUT_MS = 250

/**
 * A float over a web page (motion language M2): the native views have to step aside, and without a stand-in a page
 * would go blank under the menu. Every host paints a fresh still of its page first, so the pages stay as they were
 * while the float is open. Resolves when all stills are up, when no host answers, or after the timeout.
 */
function requestBrowserFreeze(): Promise<void> {
  const held: Promise<unknown>[] = []
  window.dispatchEvent(new CustomEvent<BrowserFreezeRequestDetail>(BROWSER_FREEZE_REQUEST_EVENT, { detail: { hold: still => { held.push(still) } } }))
  if (!held.length) return Promise.resolve()
  return new Promise(resolve => {
    const timer = window.setTimeout(resolve, FREEZE_REQUEST_TIMEOUT_MS)
    void Promise.allSettled(held).then(() => { window.clearTimeout(timer); resolve() })
  })
}

export async function beginBrowserMask(options: { persistent?: boolean; requireAck?: boolean } = {}): Promise<boolean> {
  if (typeof window === 'undefined') return false
  const browser = window.electronAPI?.browser
  let alreadyHidden = false
  if (options.persistent) await requestBrowserFreeze()
  // Lock before sending hide so resize/focus cannot show a native view during the wait.
  if (options.requireAck) window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, {
    detail: { locked: true, alreadyHidden: true, persistent: options.persistent },
  }))
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
  if (options.requireAck) {
    if (!alreadyHidden) {
      if (options.persistent) await endPersistentBrowserMask()
      else await endBrowserMask()
    }
    return alreadyHidden
  }
  const detail = options.persistent
    ? { locked: true, alreadyHidden, persistent: true }
    : { locked: true, alreadyHidden }
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail }))
  return alreadyHidden
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
