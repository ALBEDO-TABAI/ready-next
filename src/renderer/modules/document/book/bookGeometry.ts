/**
 * bookGeometry.ts — 舞台尺寸 → 书页几何（纯函数）。
 *
 * 页宽高比取 0.74（贴近参考视频的平装书比例），书在工作区内居中，
 * 四周留白与底部胶囊条空间在此预留。
 */

export type BookMarginPreset = 'narrow' | 'normal' | 'wide'

export interface BookPageGeometry {
  pageWidth: number
  pageHeight: number
  contentWidth: number
  contentHeight: number
  paddingInner: number
  paddingOuter: number
  paddingTop: number
  paddingBottom: number
  /** 封面比内页块大出的 px */
  coverOverhang: number
  /** 前切口纸堆最大厚度 px */
  stackMaxPx: number
}

const PAGE_RATIO = 0.74
const MAX_PAGE_WIDTH = 560
const MAX_PAGE_HEIGHT = 780
const MARGIN_PRESETS: Record<BookMarginPreset, number> = {
  narrow: 0.07,
  normal: 0.1,
  wide: 0.13,
}

/** 让透视与纸张尺寸保持稳定比例，避免宽页在落定前被光学放宽。 */
export const resolveBookStagePerspective = (pageWidth: number) => Math.max(6000, pageWidth * 12)

/** 一个实际设备像素换算成 CSS px；不对高 DPR 截顶，避免接缝重复采样变宽。 */
export function cssPixelsForOnePhysicalPixel(devicePixelRatio: number): number {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  return 1 / ratio
}

export function resolveBookGeometry(
  stageWidth: number,
  stageHeight: number,
  margin: BookMarginPreset,
): BookPageGeometry {
  const maxPageHeight = Math.max(240, stageHeight - 132)
  const maxPageWidth = Math.max(200, (stageWidth - 96) / 2)
  let pageHeight = Math.min(maxPageHeight, MAX_PAGE_HEIGHT)
  let pageWidth = pageHeight * PAGE_RATIO
  if (pageWidth > maxPageWidth) {
    pageWidth = maxPageWidth
    pageHeight = pageWidth / PAGE_RATIO
  }
  pageWidth = Math.min(pageWidth, MAX_PAGE_WIDTH)
  pageHeight = Math.min(pageHeight, MAX_PAGE_HEIGHT)

  const marginPct = MARGIN_PRESETS[margin] ?? MARGIN_PRESETS.normal
  const paddingOuter = Math.round(pageWidth * marginPct)
  const paddingInner = Math.round(pageWidth * marginPct * 0.9)
  const paddingTop = Math.round(pageHeight * 0.085)
  const paddingBottom = Math.round(pageHeight * 0.095)
  return {
    pageWidth: Math.round(pageWidth),
    pageHeight: Math.round(pageHeight),
    contentWidth: Math.round(pageWidth - paddingInner - paddingOuter),
    contentHeight: Math.round(pageHeight - paddingTop - paddingBottom),
    paddingInner,
    paddingOuter,
    paddingTop,
    paddingBottom,
    coverOverhang: 7,
    stackMaxPx: 8,
  }
}
