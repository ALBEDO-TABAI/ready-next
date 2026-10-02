/**
 * bookReadingPosition.ts — 阅读位置桥接。
 *
 * 复用既有 documentScrollAnchor 存储（与阅读会话/文件涌现统计同源）：
 * 正文块源码行与块内进度跨排版定位；ratio 与章节锚点保留给旧位置和统计。
 * 键与滚动快照一致（path || tabId），保证退出阅读后预览模式可接力。
 */

import {
  captureMarkdownLineAnchor,
  saveDocumentReadingPosition,
  resolveMarkdownLineFromAnchor,
  type DocumentScrollAnchorSnapshot,
} from '../documentScrollAnchor'
import type { PreviewBlock } from '../../../components/document/note-preview-parser'
import { locatePageForAnchor, type BookPageModel } from './bookPagination'

export interface SaveBookReadingPositionInput {
  /** 与滚动快照一致的键：tab.path || tab.id */
  key: string
  content: string
  pageIndex: number
  pageCount: number
  /** 页首块的源码行号（1 起），用于章节锚点；未知时传 null */
  anchorLine: number | null
  sourceProgress?: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** 字符偏移 → 源码行号（1 起） */
export function sourceLineForCharOffset(content: string, offset: number): number {
  const safeOffset = Math.max(0, Math.min(content.length, Math.floor(offset)))
  let line = 1
  for (let i = 0; i < safeOffset; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

export function saveBookReadingPosition(input: SaveBookReadingPositionInput): DocumentScrollAnchorSnapshot | undefined {
  if (!input.key) return
  const pageCount = Math.max(1, Math.floor(input.pageCount))
  const pageIndex = Math.min(Math.max(0, Math.floor(input.pageIndex)), pageCount - 1)
  const anchor = input.anchorLine !== null
    ? captureMarkdownLineAnchor(input.content, input.anchorLine)
    : null
  const snapshot: DocumentScrollAnchorSnapshot = {
    ...(input.anchorLine !== null ? { sourceLine: input.anchorLine, sourceProgress: input.sourceProgress ?? 0 } : {}),
    top: pageIndex,
    ratio: pageCount <= 1 ? 1 : clamp01(pageIndex / (pageCount - 1)),
    maxScroll: pageCount - 1,
    anchorTitle: anchor?.title ?? null,
    anchorOrdinal: anchor?.ordinal ?? null,
    anchorProgress: anchor?.progress ?? null,
  }
  saveDocumentReadingPosition(input.key, snapshot)
  return snapshot
}

/** 页进度比 → 页索引 */
export function pageIndexForRatio(ratio: number, pageCount: number): number {
  if (pageCount <= 1) return 0
  return Math.min(Math.max(0, Math.round(clamp01(ratio) * (pageCount - 1))), pageCount - 1)
}

/** 用正文块定位，不把滚动高度百分比当作书页百分比。 */
export function resolveBookPageForPosition(
  snapshot: DocumentScrollAnchorSnapshot | null,
  content: string,
  blocks: PreviewBlock[],
  model: BookPageModel,
): number {
  if (!snapshot) return 0
  const line = snapshot.sourceLine ?? resolveMarkdownLineFromAnchor(content, snapshot)
  if (line !== null && line !== undefined) {
    const lines = content.split('\n')
    const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, text) => sum + text.length + 1, 0)
    let blockIdx = blocks.findIndex(block => block.source && block.source.end > offset)
    if (blockIdx < 0) blockIdx = blocks.length - 1
    if (!snapshot.sourceProgress) return locatePageForAnchor(model, blockIdx)
    const pages = model.pages.filter(page => page.entries.some(entry => entry.blockIdx === blockIdx))
    if (pages.length) {
      const index = Math.min(pages.length - 1, Math.floor(clamp01(snapshot.sourceProgress ?? 0) * pages.length))
      return pages[index].index
    }
  }
  return pageIndexForRatio(snapshot.ratio, model.pageCount)
}
