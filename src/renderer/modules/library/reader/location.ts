import type { Layout } from './paginate'
import { chapterText } from './marks'

export interface BookLocation { chapter: number; from: number; to: number }
export function parseBookLocation(loc: string): BookLocation {
  const match = /^c(\d+):(\d+)\+(\d+)$/.exec(loc)
  if (!match) throw new Error('书内位置无效')
  const chapter = Number(match[1]), from = Number(match[2]), length = Number(match[3]), to = from + length
  if (![chapter, from, length, to].every(Number.isSafeInteger) || length < 1) throw new Error('书内位置无效')
  return { chapter, from, to }
}

/** Folios are one-based, offsets count non-whitespace UTF-16 units, just like paginate. */
export function pageOf(layout: Layout, at: { chapter: number; offset: number }): number {
  let page = layout.chapterPage[at.chapter] ?? layout.firstText
  for (let i = page; i < layout.pages.length; i++) {
    const p = layout.pages[i]
    if (p.kind === 'text' && p.chapter === at.chapter && p.start <= at.offset) page = i
  }
  return page + 1
}
export function resolveBookLocation(layout: Layout, at: BookLocation): number {
  if (!layout.pages.some(p => p.kind === 'text' && p.chapter === at.chapter)
    || at.to > chapterText(layout, at.chapter).replace(/\s/g, '').length) throw new Error('书内位置不存在，原文可能已修改')
  return pageOf(layout, { chapter: at.chapter, offset: at.from })
}
