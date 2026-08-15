/**
 * bookReadingPosition.ts — 阅读位置桥接。
 *
 * 复用既有 documentScrollAnchor 存储（与阅读会话/文件涌现统计同源）：
 * ratio = 页进度，anchorTitle = 页首块所在章节标题（captureMarkdownLineAnchor）。
 * 键与滚动快照一致（path || tabId），保证退出阅读后预览模式可接力。
 */

import {
  captureMarkdownLineAnchor,
  readDocumentReadingPositionMap,
  saveDocumentReadingPosition,
} from '../documentScrollAnchor'

export interface SaveBookReadingPositionInput {
  /** 与滚动快照一致的键：tab.path || tab.id */
  key: string
  content: string
  pageIndex: number
  pageCount: number
  /** 页首块的源码行号（1 起），用于章节锚点；未知时传 null */
  anchorLine: number | null
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

export function saveBookReadingPosition(input: SaveBookReadingPositionInput): void {
  if (!input.key) return
  const pageCount = Math.max(1, Math.floor(input.pageCount))
  const pageIndex = Math.min(Math.max(0, Math.floor(input.pageIndex)), pageCount - 1)
  const anchor = input.anchorLine !== null
    ? captureMarkdownLineAnchor(input.content, input.anchorLine)
    : null
  saveDocumentReadingPosition(input.key, {
    top: pageIndex,
    ratio: pageCount <= 1 ? 1 : clamp01(pageIndex / (pageCount - 1)),
    maxScroll: pageCount - 1,
    anchorTitle: anchor?.title ?? null,
    anchorOrdinal: anchor?.ordinal ?? null,
    anchorProgress: anchor?.progress ?? null,
  })
}

/** 读取已保存的页进度比（无记录返回 null → 进入时显示封面） */
export function readBookReadingRatio(key: string): number | null {
  if (!key) return null
  const snapshot = readDocumentReadingPositionMap().get(key)
  if (!snapshot) return null
  const ratio = Number(snapshot.ratio)
  if (!Number.isFinite(ratio)) return null
  return clamp01(ratio)
}

/** 页进度比 → 页索引 */
export function pageIndexForRatio(ratio: number, pageCount: number): number {
  if (pageCount <= 1) return 0
  return Math.min(Math.max(0, Math.round(clamp01(ratio) * (pageCount - 1))), pageCount - 1)
}

/** 每次进入阅读模式先呈现合起的书；已保存位置只决定开书后落到哪一页。 */
export function resolveBookEntryPage(ratio: number | null, pageCount: number): number {
  return ratio === null ? 0 : pageIndexForRatio(ratio, pageCount)
}
