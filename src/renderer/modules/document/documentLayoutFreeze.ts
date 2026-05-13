const DOCUMENT_LAYOUT_FREEZE_SELECTOR = [
  '.document-editor-layout',
  '.document-preview-layout',
  '.ebook-viewer-layout',
].join(',')

type LayoutFreezeSnapshot = {
  element: HTMLElement
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
      width: element.style.width,
      minWidth: element.style.minWidth,
      maxWidth: element.style.maxWidth,
    })

    const frozenWidth = `${Math.ceil(rect.width)}px`
    element.style.width = frozenWidth
    element.style.minWidth = frozenWidth
    element.style.maxWidth = 'none'
  })

  return () => {
    snapshots.forEach(({ element, width, minWidth, maxWidth }) => {
      if (!element.isConnected) return
      element.style.width = width
      element.style.minWidth = minWidth
      element.style.maxWidth = maxWidth
    })
  }
}
