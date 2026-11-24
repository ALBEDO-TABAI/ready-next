import { EASE_CSS, MOTION_MS, prefersReducedMotion } from '../../design/next/motion'

/** The text column's glide to its new place after a panel move. */
const GLIDE_ID = 'rn-document-layout-glide'

const DOCUMENT_LAYOUT_FREEZE_SELECTOR = [
  '.document-editor-layout',
  '.document-preview-layout',
  '.ebook-viewer-layout',
].join(',')

type LayoutFreezeSnapshot = {
  element: HTMLElement
  frozenWidth: string
  width: string
  minWidth: string
  maxWidth: string
}

export function freezeVisibleDocumentLayoutWidths(): () => void {
  if (typeof document === 'undefined') return () => {}

  const snapshots: LayoutFreezeSnapshot[] = []

  document.querySelectorAll<HTMLElement>(DOCUMENT_LAYOUT_FREEZE_SELECTOR).forEach((element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    snapshots.push({
      element,
      frozenWidth: `${Math.ceil(rect.width)}px`,
      width: element.style.width,
      minWidth: element.style.minWidth,
      maxWidth: element.style.maxWidth,
    })
  })

  snapshots.forEach(({ element, frozenWidth }) => {
    element.style.width = frozenWidth
    element.style.minWidth = frozenWidth
    element.style.maxWidth = 'none'
  })

  return () => {
    // Released, the text column takes the width of its new column, and its centred position moves with that. Measured
    // before and after, it glides there instead of jumping sideways (motion language M2): one layout, one transform.
    // Where it is seen now (a glide still running included), then the glide is dropped and the layout measured bare,
    // so a second release mid-glide starts from what is on screen instead of jumping.
    const before = snapshots.map(({ element }) => (element.isConnected ? element.getBoundingClientRect().left : 0))
    snapshots.forEach(({ element, width, minWidth, maxWidth }) => {
      if (!element.isConnected) return
      for (const animation of element.getAnimations?.() ?? []) if (animation.id === GLIDE_ID) animation.cancel()
      element.style.width = width
      element.style.minWidth = minWidth
      element.style.maxWidth = maxWidth
    })
    if (prefersReducedMotion()) return
    snapshots.forEach(({ element }, index) => {
      if (!element.isConnected || typeof element.animate !== 'function') return
      const shift = before[index] - element.getBoundingClientRect().left
      if (Math.abs(shift) < 1) return
      element.animate([{ transform: `translateX(${shift}px)` }, { transform: 'none' }], { id: GLIDE_ID, duration: MOTION_MS.d2, easing: EASE_CSS.out })
    })
  }
}
