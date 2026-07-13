export const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

export function beginBrowserMask(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, { detail: { locked: true } }))
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
