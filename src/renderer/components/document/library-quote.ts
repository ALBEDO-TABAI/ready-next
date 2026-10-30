// The existing source-block reader is pure (no Main services or I/O). Reuse its
// duplicate-id, section and malformed-block rules rather than inventing another codec.
import { parseHighlights } from '../../../main/modules/library-engine/highlight-markdown'
import { readDocumentSource } from '../../../shared/document-operations'
import { LIBRARY_FIELDS } from '../../../shared/library'

export function parseQuoteEmbed(raw: string) {
  const match = /^!\[\[([^\]\n]+)#\^(hl-[\w-]+)(?:\|[^\]\n]*)?\]\]$/.exec(raw.trim())
  return match ? { page: match[1], id: match[2] } : null
}
export function readQuoteCard(content: string, bookId: string, title: string, id: string) {
  const matches = parseHighlights(content, bookId).filter(b => b.highlight.id === id)
  if (matches.length !== 1 || matches[0].highlight.location.status === 'malformed') return null
  const h = matches[0].highlight
  const fields = readDocumentSource(content).frontmatter
  const author = fields[LIBRARY_FIELDS.author]
  return { title: typeof fields.title === 'string' ? fields.title : title,
    author: typeof author === 'string' ? author : '',
    chapter: h.chapterTitle, color: h.color, text: h.text, note: h.note,
    uri: `ready://read/book/${encodeURIComponent(bookId)}#c${h.chapter}:${h.from}+${h.to - h.from}` }
}
