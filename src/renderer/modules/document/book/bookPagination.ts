/**
 * bookPagination.ts — 书本分页引擎。
 *
 * 分两半：
 *  1. 纯函数页模型（buildBookPageModel / locatePageForAnchor / spread 映射），
 *     输入测量结果，输出每页的块条目与锚点 —— 可直接行为测试。
 *  2. DOM 测量（measureBookBlocks）：隐藏 CSS 多栏流（column-fill:auto）
 *     负责精确断页，读回每块落在哪一栏（=哪一页）。
 *
 * 跨页块保留原始起始偏移与栏序号；显示时重建同尺寸 CSS 多栏流并水平取出对应栏。
 * 不能用 contentHeight 做纵向平移：浏览器会为保住整行而在栏底留余量，固定高度平移会切字。
 */

export interface BookBlockMeasure {
  blockIdx: number
  /** 块起始栏（=起始页，0 起） */
  startCol: number
  /** 块结束栏（跨页块 > startCol） */
  endCol: number
  /** 块顶在起始栏内的 y 偏移 px */
  offsetY: number
  /** union rect 高度（信息项，跨栏块不可靠） */
  height: number
}

export interface BookPageEntry {
  blockIdx: number
  /** 非跨页块在本页内容盒内的 translateY */
  offsetY: number
  /** 是否上一页延续下来的片段 */
  continued: boolean
  /** 该块在自身分栏流中的第几栏。 */
  columnIndex: number
  /** 块是否实际跨页。 */
  spansPages: boolean
  /** 该块在起始页的真实页内顶部。 */
  startOffsetY: number
}

export interface BookPage {
  index: number
  entries: BookPageEntry[]
  /** 位置恢复锚点：本页首个非延续块及其页内偏移比 */
  anchorBlock: number
  anchorRatio: number
}

export interface BookPageModel {
  pages: BookPage[]
  pageCount: number
  contentWidth: number
  contentHeight: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function buildBookPageModel(
  measures: BookBlockMeasure[],
  contentWidth: number,
  contentHeight: number,
): BookPageModel {
  const safeHeight = Math.max(1, contentHeight)
  let pageCount = 1
  for (const measure of measures) {
    pageCount = Math.max(pageCount, measure.endCol + 1)
  }
  const pages: BookPage[] = []
  for (let index = 0; index < pageCount; index += 1) {
    const entries: BookPageEntry[] = []
    for (const measure of measures) {
      const startCol = Math.max(0, measure.startCol)
      const endCol = Math.max(startCol, measure.endCol)
      if (index < startCol || index > endCol) continue
      const continued = index > startCol
      entries.push({
        blockIdx: measure.blockIdx,
        offsetY: measure.offsetY,
        continued,
        columnIndex: index - startCol,
        spansPages: endCol > startCol,
        startOffsetY: measure.offsetY,
      })
    }
    const anchorEntry = entries.find((entry) => !entry.continued) ?? entries[0] ?? null
    pages.push({
      index,
      entries,
      anchorBlock: anchorEntry?.blockIdx ?? 0,
      anchorRatio: anchorEntry && !anchorEntry.continued
        ? clamp(anchorEntry.offsetY / safeHeight, 0, 1)
        : 0,
    })
  }
  return { pages, pageCount, contentWidth, contentHeight: safeHeight }
}

/** 重排/重进时按锚点找页：优先锚块起始页；块已不存在时取最近前溯块，最后回退第 0 页 */
export function locatePageForAnchor(
  model: BookPageModel,
  anchorBlock: number,
): number {
  if (model.pageCount <= 0) return 0
  let fallback = -1
  for (const page of model.pages) {
    for (const entry of page.entries) {
      if (entry.blockIdx === anchorBlock && !entry.continued) return page.index
      if (entry.blockIdx < anchorBlock) fallback = page.index
    }
  }
  return clamp(fallback, 0, model.pageCount - 1)
}

/** 扉页（spread0 左页）的页索引哨兵 */
export const BOOK_TITLE_PAGE = -1

export interface BookSpread {
  index: number
  /** 内容页索引、BOOK_TITLE_PAGE（扉页）或 null（无此页） */
  left: number | null
  right: number | null
}

/** 对开数：spread0 = [扉页, 第0页]，之后 [1,2] [3,4]… */
export function spreadCountForPages(pageCount: number): number {
  if (pageCount <= 0) return 0
  return 1 + Math.floor(pageCount / 2)
}

export function spreadAt(index: number, pageCount: number): BookSpread {
  if (index <= 0) {
    return { index: 0, left: BOOK_TITLE_PAGE, right: pageCount > 0 ? 0 : null }
  }
  const left = 2 * index - 1
  const right = 2 * index
  return {
    index,
    left: left < pageCount ? left : null,
    right: right < pageCount ? right : null,
  }
}

/** 内容页所属对开 */
export function spreadForPage(pageIndex: number): number {
  return Math.max(0, Math.floor((pageIndex + 1) / 2))
}

/**
 * 翻页叶片的正反面页码。
 * forward：正面=当前对开右页，背面=下一对开左页（均可为 null=空白纸面）。
 * backward：正面=当前对开左页，背面=前一对开右页。
 * 返回 null 表示该方向无页可翻。
 */
export function resolveFlipSheet(
  spreadIndex: number,
  pageCount: number,
  direction: 'forward' | 'backward',
): { front: number | null; back: number | null } | null {
  if (direction === 'forward') {
    const current = spreadAt(spreadIndex, pageCount)
    if (current.right === null) return null
    const next = spreadAt(spreadIndex + 1, pageCount)
    return { front: current.right, back: next.left }
  }
  if (spreadIndex <= 0) return null
  const current = spreadAt(spreadIndex, pageCount)
  if (current.left === null) return null
  const previous = spreadAt(spreadIndex - 1, pageCount)
  return { front: current.left, back: previous.right }
}

// --- DOM 测量（与纯模型隔离，jsdom 不可测，故保持最小） ---

/**
 * 读取隐藏多栏流：容器须为 column-width=contentWidth、column-gap:0、
 * column-fill:auto、height=contentHeight，块包裹元素带 data-book-block-idx。
 *
 * 跨栏块的 offsetY 必须取「首个分片」的顶部（Element.getClientRects 按分片返回），
 * 不能用 union rect（getBoundingClientRect）——后者把后续栏分片的 top=0 并进来，
 * 会把跨页块错排到页首（与正当块重叠）。
 */
export function measureBookBlocks(flowEl: HTMLElement): BookBlockMeasure[] {
  const flowRect = flowEl.getBoundingClientRect()
  const stride = Math.max(1, flowEl.clientWidth || flowRect.width)
  const measures: BookBlockMeasure[] = []
  const blocks = flowEl.querySelectorAll<HTMLElement>('[data-book-block-idx]')
  blocks.forEach((el) => {
    const blockIdx = Number(el.dataset.bookBlockIdx)
    if (!Number.isFinite(blockIdx)) return
    const union = el.getBoundingClientRect()
    const fragments = Array.from(el.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
    const first = fragments[0] ?? union
    const last = fragments[fragments.length - 1] ?? first
    const startCol = Math.max(0, Math.floor((first.left - flowRect.left + 1) / stride))
    const endCol = Math.max(startCol, Math.floor((last.right - 1 - flowRect.left) / stride))
    measures.push({
      blockIdx,
      startCol,
      endCol,
      offsetY: first.top - flowRect.top,
      height: union.height,
    })
  })
  return measures.sort((a, b) => a.blockIdx - b.blockIdx)
}
