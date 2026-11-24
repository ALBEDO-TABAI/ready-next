import { useLayoutEffect } from 'react'

import { beginBrowserMask, endPersistentBrowserMask } from './browserViewMask'

export function rectanglesIntersect(
  left: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  right: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
): boolean {
  return left.width > 0
    && left.height > 0
    && right.width > 0
    && right.height > 0
    && left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top
}

/**
 * Every outlet mounts this hook (two in a split view), but the scan is global — all overlays against all native surfaces —
 * so one scan runs while any outlet is mounted: it starts with the first and stops with the last, never handed over
 * (a hand-over would drop and re-take the mask under an open menu). Two scans would each hide, mask and reveal the same
 * float and race each other's acknowledgements.
 */
let scanUsers = 0
let stopScan: (() => void) | null = null

export function useNativeSurfaceAwareOverlay(): void {
  useLayoutEffect(() => {
    scanUsers += 1
    if (!stopScan) stopScan = startOverlayScan()
    return () => {
      scanUsers -= 1
      // Outlets remounted in one commit (a split view closing) unmount before they mount again: wait for the commit to
      // finish, and keep the scan — and the mask under an open float — if an outlet is back.
      queueMicrotask(() => {
        if (scanUsers === 0 && stopScan) { stopScan(); stopScan = null }
      })
    }
  }, [])
}

function startOverlayScan(): () => void {
  {
    let frame: number | null = null
    let masked = false
    let hidePending = false
    let maskDesired = false
    let disposed = false
    let failed = false
    const hidden = new Map<HTMLElement, string>()

    const reveal = () => {
      for (const [element, visibility] of hidden) {
        element.style.visibility = visibility
        // Its entrance (data-float-motion, motion language M2) ran while it waited unseen for the web view to step
        // aside: start it again now that it can be seen.
        for (const animation of element.getAnimations?.() ?? []) {
          if (animation.playState !== 'finished' || element.hasAttribute('data-float-motion')) animation.currentTime = 0
        }
      }
      hidden.clear()
    }

    const scan = () => {
      frame = null
      if (disposed) return
      const surfaces = [...document.querySelectorAll<HTMLElement>('[data-ready-native-surface="browser"]')]
      const overlays = [...document.querySelectorAll<HTMLElement>('[data-ready-native-overlay]')]
      const intersecting = overlays.filter((overlay) => {
        const overlayRect = overlay.getBoundingClientRect()
        return surfaces.some((surface) => rectanglesIntersect(overlayRect, surface.getBoundingClientRect()))
      })
      maskDesired = intersecting.length > 0

      if (intersecting.length > 0) {
        if (!masked) {
          for (const element of intersecting) {
            if (hidden.has(element)) continue
            hidden.set(element, element.style.visibility)
            element.style.visibility = 'hidden'
          }
        }
        if (!masked && !hidePending && !failed) {
          hidePending = true
          void beginBrowserMask({ persistent: true, requireAck: true }).then((confirmed) => {
            hidePending = false
            if (!confirmed) { failed = true; return }
            if (disposed || !maskDesired) {
              masked = false
              reveal()
              void endPersistentBrowserMask()
              return
            }
            masked = true
            reveal()
            schedule()
          })
        }
        return
      }

      failed = false
      if (!hidePending) reveal()
      if (masked) {
        masked = false
        void endPersistentBrowserMask()
      }
    }

    const schedule = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(scan)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-ready-native-overlay'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (frame !== null) window.cancelAnimationFrame(frame)
      reveal()
      if (masked) void endPersistentBrowserMask()
    }
  }
}
