import { readDocumentSource } from '../../../shared/document-operations'
import type { LibraryHighlight } from '../../../shared/library'
import { colorSchema } from './highlight-anchors'

export interface HighlightBlock { start: number; end: number; raw: string; highlight: LibraryHighlight }
export function annotationSection(content: string): { start: number; end: number } | null {
  const { bodyStart } = readDocumentSource(content)
  let offset = bodyStart, start: number | undefined, fence = ''
  for (const line of content.slice(bodyStart).match(/[^\n]+\n?|\n/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '' }
    else if (!fence) {
      if (start !== undefined && /^#{1,2}\s/.test(line)) return { start, end: offset }
      if (/^##[ \t]+标注[ \t]*\r?\n?$/.test(line)) start = offset + line.length
    }
    offset += line.length
  }
  return start === undefined ? null : { start, end: content.length }
}

export function parseHighlights(content: string, bookId: string): HighlightBlock[] {
  const section = annotationSection(content)
  const { bodyStart } = readDocumentSource(content)
  const body = content.slice(bodyStart)
  const blocks: HighlightBlock[] = []
  let previous = 0, fence = '', offset = 0
  for (const line of body.match(/[^\n]+\n?|\n/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '' }
    const id = !fence && /^\^(hl-[\w-]+)[ \t]*\r?\n?$/.exec(line)
    if (id) {
      const before = body.slice(previous, offset).replace(/\s+$/, '')
      // Walk backwards over the quote paragraph; leave unrelated prose untouched.
      const lines = before.split('\n')
      let first = lines.length - 1
      while (first > 0 && lines[first - 1].trim() !== '') first--
      const prefix = lines.slice(0, first).join('\n')
      const start = previous + (first ? prefix.length + 1 : 0)
      const raw = body.slice(start, offset + line.length)
      const rows = before.slice(first ? prefix.length + 1 : 0).split(/\r?\n/)
      const header = /^> \[!quote\|(yellow|green|blue|pink|pen)\] (.*?) · \[原文\]\(ready:\/\/read\/book\/([^#]+)#c(\d+):(\d+)\+(\d+)\)$/.exec(rows[0] ?? '')
      const quoteRows = rows.slice(1), divider = quoteRows.findIndex(row => /^>\s*$/.test(row))
      const strip = (row: string) => row.replace(/^> ?/, '')
      const text = (divider < 0 ? quoteRows : quoteRows.slice(0, divider)).map(strip).join('\n')
      const note = divider < 0 ? '' : quoteRows.slice(divider + 1).map(strip).join('\n')
      const chapter = Number(header?.[4] ?? 0), from = Number(header?.[5] ?? 0), to = from + Number(header?.[6] ?? 0)
      const valid = section && bodyStart + start >= section.start && bodyStart + offset < section.end && header && header[3] === encodeURIComponent(bookId) && text.trim() && quoteRows.every(row => /^>( |$)/.test(row)) && to > from && [chapter, from, to].every(Number.isSafeInteger)
      const highlight: LibraryHighlight = {
        id: id[1], chapter, from, to, chapterTitle: header?.[2] ?? '结构已修改',
        text: text || raw, note, color: colorSchema.parse(header?.[1] ?? 'yellow'),
        location: valid ? { status: 'unlocated', reason: '等待定位' } : { status: 'malformed', reason: '来源页中的标注格式已修改，请在来源页检查' },
        sourceLine: content.slice(0, bodyStart + start).split('\n').length,
      }
      blocks.push({ start: bodyStart + start, end: bodyStart + offset + line.length, raw, highlight })
      previous = offset + line.length
    }
    offset += line.length
  }
  const counts = new Map<string, number>()
  blocks.forEach(b => counts.set(b.highlight.id, (counts.get(b.highlight.id) ?? 0) + 1))
  blocks.forEach(b => { if (counts.get(b.highlight.id)! > 1) b.highlight.location = { status: 'malformed', reason: '来源页中有重复的标注 id' } })
  return blocks
}

export function formatHighlight(h: LibraryHighlight, bookId: string): string {
  const quote = (s: string) => s.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n')
  return `> [!quote|${h.color}] ${h.chapterTitle.replace(/[\r\n]/g, ' ')} · [原文](ready://read/book/${encodeURIComponent(bookId)}#c${h.chapter}:${h.from}+${h.to - h.from})\n${quote(h.text)}${h.note ? `\n>\n${quote(h.note)}` : ''}\n\n^${h.id}\n`
}

/** Replace only managed blocks. Malformed blocks and the user's other prose retain their bytes. */
export function rewriteHighlights(content: string, bookId: string, next: LibraryHighlight[], removed: Set<string>): string {
  const blocks = parseHighlights(content, bookId)
  let stripped = content
  for (const b of [...blocks].reverse()) {
    if (b.highlight.location.status !== 'malformed' || removed.has(b.highlight.id)) stripped = stripped.slice(0, b.start) + stripped.slice(b.end)
  }
  const section = annotationSection(stripped)
  const managed = next.filter(h => h.location.status !== 'malformed').sort((a, b) => a.chapter - b.chapter || a.from - b.from)
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const markdown = managed.map(h => formatHighlight(h, bookId)).join('\n').replace(/\n/g, newline)
  const body = section ? stripped.slice(section.start, section.end) : ''
  const replacement = newline + markdown + (markdown ? newline : '') + body.replace(/^\s+/, '')
  return section ? stripped.slice(0, section.start) + replacement + stripped.slice(section.end) : stripped + `${newline}## 标注${newline}${replacement}`
}
