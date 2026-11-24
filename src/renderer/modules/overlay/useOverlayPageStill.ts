import { useEffect, type RefObject } from 'react'
import { BROWSER_FREEZE_REQUEST_EVENT, BROWSER_OVERLAY_LOCK_EVENT, type BrowserFreezeRequestDetail } from './browserViewMask'

/** How long a still stays after the native page is shown again, so there is never a blank frame in between. */
const STILL_RELEASE_DELAY_MS = 220

/**
 * A native page shown in a DOM host that is not the browser mode's (the RSS original-page preview): when a float covers
 * it and the native view steps aside, the host paints a still of the page first, so the page does not go blank under the
 * float (motion language M2; the browser mode does the same in useBrowserResizeFreeze).
 */
export function useOverlayPageStill(hostRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    let session = 0
    let locks = 0
    let requesting = false
    let disposed = false
    let inflight: Promise<void> | null = null
    let releaseTimer = 0
    const held = () => locks > 0 || requesting
    const clear = () => { const host = hostRef.current; if (host) host.style.backgroundImage = '' }
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<BrowserFreezeRequestDetail>).detail
      const host = hostRef.current
      const capture = window.electronAPI?.browser?.captureWindowSnapshot
      if (!detail || !host || !capture) return
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      requesting = true
      window.clearTimeout(releaseTimer)
      if (!inflight) {
        const mine = ++session
        const live = () => !disposed && mine === session && held()
        inflight = capture({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })
          .then(async result => {
            if (!result?.success || !result.data || !live()) return
            const src = `data:image/png;base64,${result.data}`
            const image = new Image()
            image.src = src
            await image.decode().catch(() => undefined)
            if (!live() || !hostRef.current) return
            Object.assign(hostRef.current.style, { backgroundImage: `url("${src}")`, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' })
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          })
          .finally(() => { inflight = null })
      }
      detail.hold(inflight)
    }
    // Masks are counted (persistent lock / unlock): the still stays while any of them hides the page.
    const onLock = (event: Event) => {
      const detail = (event as CustomEvent<{ locked?: boolean; persistent?: boolean }>).detail
      if (!detail?.persistent) return
      if (detail.locked !== false) { locks += 1; requesting = false; return }
      locks = Math.max(0, locks - 1)
      if (held()) return
      const mine = ++session
      window.clearTimeout(releaseTimer)
      releaseTimer = window.setTimeout(() => { if (mine === session && !held()) clear() }, STILL_RELEASE_DELAY_MS)
    }
    window.addEventListener(BROWSER_FREEZE_REQUEST_EVENT, onRequest)
    window.addEventListener(BROWSER_OVERLAY_LOCK_EVENT, onLock)
    return () => {
      disposed = true
      window.removeEventListener(BROWSER_FREEZE_REQUEST_EVENT, onRequest)
      window.removeEventListener(BROWSER_OVERLAY_LOCK_EVENT, onLock)
      window.clearTimeout(releaseTimer)
      clear()
    }
  }, [active, hostRef])
}
