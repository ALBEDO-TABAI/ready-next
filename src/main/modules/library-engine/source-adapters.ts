import { z } from 'zod'
import { toReadyUri, parseReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import { readingRuns, readingExcerpt, type RSSReadingRange } from '../../../shared/rss-reading'
import type { RSSArticle } from '../../../shared/rss-workspace'
import type { LibraryHighlight, LibraryBook } from '../../../shared/library'
import type { HighlightCodec } from './highlight-markdown'
import { compact, sliceText } from './highlight-anchors'

export interface SourceDocument {
  kind: 'book' | 'rss' | 'pdf' | 'web'
  ref: ReadyRef
  title: string
  author: string
  url: string
  snapshot: string
}
export function bookSource(book: LibraryBook): SourceDocument {
  return { kind: 'book', ref: { kind: 'book-location', book: book.id, loc: 'c0:0+1' }, title: book.title,
    author: book.author, url: book.source.url ?? '', snapshot: book.id }
}
export interface SourceSelection {
  source: SourceDocument
  text: string
  from: number
  to: number
  reference(highlight: LibraryHighlight): ReadyRef
}
const pointOffset = (text: string, offset: number) => compact(text.slice(0, offset)).length

export function rssSource(article: RSSArticle, range: RSSReadingRange): SourceSelection {
  const markdown = article.body.markdown ?? article.summary
  readingExcerpt(markdown, range) // validates boundaries, including surrogate pairs
  const runs = readingRuns(markdown)
  const offset = (point: RSSReadingRange['start']) => {
    const index = runs.findIndex(run => run.id === point.run)
    return runs.slice(0, index).reduce((n, run) => n + compact(run.text).length, 0) + pointOffset(runs[index].text, point.offset)
  }
  const point = (offset: number, end: boolean): RSSReadingRange['start'] => {
    let count = 0
    for (const run of runs) for (let i = 0; i < run.text.length; i++) {
      if (/\s/.test(run.text[i])) continue
      if (!end && count === offset) return { run: run.id, offset: i }
      count++
      if (end && count === offset) return { run: run.id, offset: i + 1 }
    }
    throw new Error('文章来源选区已失效')
  }
  return {
    source: { kind: 'rss', ref: { kind: 'rss-item', id: article.id }, title: article.title, author: article.author ?? '', url: article.link, snapshot: article.revision },
    text: runs.map(run => run.text).join('\n\n'), from: offset(range.start), to: offset(range.end),
    reference: h => ({ kind: 'rss-item', id: article.id, excerpt: { format: 'reading-v1', expectedRevision: article.revision,
      range: { start: point(h.from, false), end: point(h.to, true) }, offset: 0, length: 24000 } }),
  }
}

export const WebSelectionSchema = z.object({ url: z.string().url(), title: z.string().max(1000), text: z.string().min(1).max(2_000_000),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), exact: z.string().min(1).max(24000),
}).strict().refine(v => v.end > v.start && v.text.slice(v.start, v.end) === v.exact, '网页选区已变化')
export type WebSelection = z.infer<typeof WebSelectionSchema>
export function webSource(raw: unknown, snapshot: string): SourceSelection {
  const selection = WebSelectionSchema.parse(raw)
  const url = selection.url.split(':~:text=')[0].replace(/#$/, '')
  toReadyUri({ kind: 'web', url })
  const textPart = (value: string) => encodeURIComponent(value.replace(/\s+/g, ' ').trim()).replace(/-/g, '%2D').replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)
  return {
    source: { kind: 'web', ref: { kind: 'web', url }, title: selection.title || url, author: '', url, snapshot },
    text: selection.text, from: pointOffset(selection.text, selection.start), to: pointOffset(selection.text, selection.end),
    reference: h => {
      const prefix = textPart(sliceText(selection.text, Math.max(0, h.from - 32), h.from))
      const suffix = textPart(sliceText(selection.text, h.to, h.to + 32))
      return { kind: 'web', url: `${url}${url.includes('#') ? '' : '#'}:~:text=${prefix ? prefix + '-,' : ''}${textPart(h.text)}${suffix ? ',-' + suffix : ''}` }
    },
  }
}

/** PDF metadata can be saved now; the reader must supply a real page/range before annotation is exposed. */
export function pdfSource(input: { id: string; title: string; hash: string }): SourceDocument {
  return { kind: 'pdf', ref: { kind: 'file', id: input.id }, title: input.title, author: '', url: '', snapshot: input.hash }
}

export function sourceHighlightCodec(selection: SourceSelection): HighlightCodec {
  const original = new Map<string, string>()
  return {
    parseHeader(header, id) {
      const m = /^> \[!quote\|(yellow|green|blue|pink|pen)\] (.*?) · \[原文\]\((ready:\/\/\S+)\) <!-- source:c(\d+):(\d+)\+(\d+) -->$/.exec(header)
      if (!m) return null
      const parsed = parseReadyUri(m[3]), source = selection.source.ref
      if (!parsed.ok) return null
      const ref = parsed.ref
      if (source.kind === 'rss-item' && (ref.kind !== 'rss-item' || ref.id !== source.id)) return null
      if (source.kind === 'web' && (ref.kind !== 'web' || ref.url.split(':~:text=')[0].replace(/#$/, '') !== source.url)) return null
      original.set(id, header)
      return { color: m[1], title: m[2], chapter: Number(m[4]), from: Number(m[5]), to: Number(m[5]) + Number(m[6]) }
    },
    formatHeader(h) {
      if (h.location.status !== 'located') {
        const header = original.get(h.id)
        if (!header) throw new Error('未定位的标注缺少原文引用')
        return header
      }
      return `> [!quote|${h.color}] ${h.chapterTitle.replace(/[\r\n]/g, ' ')} · [原文](${toReadyUri(selection.reference(h)).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16)}`)}) <!-- source:c${h.chapter}:${h.from}+${h.to - h.from} -->`
    },
  }
}
