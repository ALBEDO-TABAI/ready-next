import type { Layout } from './paginate'
import { chapterText } from './marks'

import { parseBookLocation, type BookLocation } from '../../../../shared/book-location'
export { parseBookLocation, type BookLocation }

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
