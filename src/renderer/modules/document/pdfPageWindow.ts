export interface PdfPageRenderRange {
  start: number
  end: number
}

export interface PdfPageSlotRenderInputs {
  pageNumber: number
  shouldRender: boolean
  pageHeight: number
  scale: number
  registerPageRef: unknown
  recordPageHeight: unknown
}

export function arePdfPageSlotRenderInputsEqual(
  previous: PdfPageSlotRenderInputs,
  next: PdfPageSlotRenderInputs,
): boolean {
  if (previous.pageNumber !== next.pageNumber
    || previous.shouldRender !== next.shouldRender
    || previous.pageHeight !== next.pageHeight
    || previous.registerPageRef !== next.registerPageRef
    || previous.recordPageHeight !== next.recordPageHeight) return false
  if (!next.shouldRender) return true
  return previous.scale === next.scale
}

export function getPdfPageRenderRange(
  numPages: number,
  currentPage: number,
  radius = 3,
): PdfPageRenderRange {
  if (numPages <= 0) return { start: 0, end: -1 }
  const safeRadius = Math.max(0, Math.floor(radius))
  const center = Math.max(1, Math.min(numPages, Math.floor(currentPage) || 1))
  return {
    start: Math.max(1, center - safeRadius),
    end: Math.min(numPages, center + safeRadius),
  }
}

export function countPdfPagesInRange(range: PdfPageRenderRange): number {
  return Math.max(0, range.end - range.start + 1)
}
