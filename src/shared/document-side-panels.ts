export type DocumentOutlineNodeKind = 'heading' | 'list' | 'paragraph'

export interface DocumentOutlineNode {
  id: string
  kind: DocumentOutlineNodeKind
  depth: number
  title: string
  summary: string
  excerpt: string
  lineStart: number
  lineEnd: number
  anchorTitle: string | null
  anchorOrdinal: number | null
  anchorProgress: number | null
}

export interface DocumentOutlineSnapshot {
  contentHash: string
  generatedAt: string
  lineCount: number
  wordCount: number
  nodes: DocumentOutlineNode[]
}

export type DocumentMarkKind = 'bookmark' | 'note'
export type DocumentMarkStatus = 'linked' | 'stale'

export interface DocumentMarkRecord {
  id: string
  kind: DocumentMarkKind
  documentPath: string
  title: string
  groupName: string
  noteText: string | null
  excerpt: string | null
  lineStart: number | null
  lineEnd: number | null
  anchorTitle: string | null
  anchorOrdinal: number | null
  anchorProgress: number | null
  anchorStatus: DocumentMarkStatus
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface DocumentMarkDraft {
  kind: DocumentMarkKind
  documentPath: string
  title?: string | null
  groupName?: string | null
  noteText?: string | null
  excerpt?: string | null
  lineStart?: number | null
  lineEnd?: number | null
  anchorTitle?: string | null
  anchorOrdinal?: number | null
  anchorProgress?: number | null
}

export interface DocumentMarkPatch {
  title?: string | null
  groupName?: string | null
  noteText?: string | null
  excerpt?: string | null
  lineStart?: number | null
  lineEnd?: number | null
  anchorTitle?: string | null
  anchorOrdinal?: number | null
  anchorProgress?: number | null
  anchorStatus?: DocumentMarkStatus
  sortOrder?: number
}

export interface DocumentMarkLocation {
  status: DocumentMarkStatus
  lineStart: number | null
  lineEnd: number | null
}

interface HeadingEntry {
  title: string
  line: number
  level: number
  ordinal: number
}

const MAX_OUTLINE_NODES = 220
const MAX_SUMMARY_LENGTH = 58

function cleanMarkdownText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^>\s*/g, '')
    .replace(/^[-*+]\s+/g, '')
    .replace(/^\d+[.)]\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(value: string, maxLength = MAX_SUMMARY_LENGTH): string {
  const clean = value.trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function getHeading(line: string): { title: string; level: number } | null {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
  if (!match) return null
  return {
    level: match[1].length,
    title: cleanMarkdownText(match[2]),
  }
}

function isListLine(line: string): boolean {
  return /^\s{0,6}(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim()
  return !trimmed || trimmed === '---' || trimmed.startsWith('```')
}

function collectHeadings(lines: string[]): HeadingEntry[] {
  const counts = new Map<string, number>()
  const headings: HeadingEntry[] = []
  lines.forEach((line, index) => {
    const heading = getHeading(line)
    if (!heading?.title) return
    const ordinal = counts.get(heading.title) || 0
    counts.set(heading.title, ordinal + 1)
    headings.push({
      title: heading.title,
      line: index + 1,
      level: heading.level,
      ordinal,
    })
  })
  return headings
}

function findSectionSummary(lines: string[], startLine: number, endLine: number): string {
  for (let line = startLine; line <= endLine; line += 1) {
    const clean = cleanMarkdownText(lines[line - 1] || '')
    if (clean) return truncate(clean)
  }
  return '暂无可读摘要'
}

function makeNodeId(kind: DocumentOutlineNodeKind, lineStart: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return `${kind}-${lineStart}-${slug || 'section'}`
}

function countWords(content: string): number {
  const latinWords = content.match(/[A-Za-z0-9_]+/g)?.length || 0
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length || 0
  return latinWords + cjkChars
}

function hashContent(content: string): string {
  let hash = 0
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

export function buildDocumentOutline(content: string, date = new Date()): DocumentOutlineSnapshot {
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const headings = collectHeadings(lines)
  const nodes: DocumentOutlineNode[] = []

  if (headings.length > 0) {
    headings.forEach((heading, index) => {
      if (nodes.length >= MAX_OUTLINE_NODES) return
      const next = headings[index + 1]
      const lineEnd = Math.max(heading.line, (next?.line || lines.length + 1) - 1)
      const summary = findSectionSummary(lines, heading.line + 1, lineEnd)
      nodes.push({
        id: makeNodeId('heading', heading.line, heading.title),
        kind: 'heading',
        depth: Math.min(5, heading.level - 1),
        title: heading.title,
        summary,
        excerpt: summary,
        lineStart: heading.line,
        lineEnd,
        anchorTitle: heading.title,
        anchorOrdinal: heading.ordinal,
        anchorProgress: 0,
      })
    })
  } else {
    let paragraphStart: number | null = null
    for (let index = 0; index < lines.length && nodes.length < MAX_OUTLINE_NODES; index += 1) {
      const line = lines[index]
      if (isIgnorableLine(line)) {
        paragraphStart = null
        continue
      }
      if (paragraphStart === null) paragraphStart = index + 1
      const clean = cleanMarkdownText(line)
      if (!clean) continue
      nodes.push({
        id: makeNodeId('paragraph', index + 1, clean),
        kind: 'paragraph',
        depth: 0,
        title: truncate(clean, 36),
        summary: truncate(clean),
        excerpt: truncate(clean, 90),
        lineStart: paragraphStart,
        lineEnd: index + 1,
        anchorTitle: null,
        anchorOrdinal: null,
        anchorProgress: null,
      })
      paragraphStart = null
    }
  }

  const listNodes: DocumentOutlineNode[] = []
  let listStart: number | null = null
  let listItems: string[] = []
  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index] || ''
    if (index < lines.length && isListLine(line)) {
      if (listStart === null) listStart = index + 1
      const clean = cleanMarkdownText(line)
      if (clean) listItems.push(clean)
      continue
    }

    if (listStart !== null && listItems.length >= 2) {
      const title = listItems[0]
      const owner = nodes.find((node) => listStart! >= node.lineStart && listStart! <= node.lineEnd)
      listNodes.push({
        id: makeNodeId('list', listStart, title),
        kind: 'list',
        depth: Math.min(5, (owner?.depth ?? 0) + 1),
        title: truncate(title, 36),
        summary: truncate(listItems.slice(0, 3).join(' / ')),
        excerpt: truncate(listItems.join(' / '), 90),
        lineStart: listStart,
        lineEnd: index,
        anchorTitle: owner?.anchorTitle ?? null,
        anchorOrdinal: owner?.anchorOrdinal ?? null,
        anchorProgress: owner ? (listStart - owner.lineStart) / Math.max(1, owner.lineEnd - owner.lineStart + 1) : null,
      })
    }
    listStart = null
    listItems = []
  }

  const merged = [...nodes, ...listNodes]
    .sort((a, b) => a.lineStart - b.lineStart || a.depth - b.depth)
    .slice(0, MAX_OUTLINE_NODES)

  return {
    contentHash: hashContent(normalized),
    generatedAt: date.toISOString(),
    lineCount: Math.max(1, lines.length),
    wordCount: countWords(normalized),
    nodes: merged,
  }
}

export function getOutlineNodeForLine(outline: DocumentOutlineSnapshot, line: number | null): DocumentOutlineNode | null {
  if (!line || line < 1) return outline.nodes[0] || null
  return (
    outline.nodes.find((node) => line >= node.lineStart && line <= node.lineEnd) ||
    [...outline.nodes].reverse().find((node) => node.lineStart <= line) ||
    outline.nodes[0] ||
    null
  )
}

export function getExcerptForLine(content: string, line: number | null): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const safeLine = line ? Math.max(1, Math.min(lines.length || 1, line)) : 1
  for (let index = safeLine - 1; index < Math.min(lines.length, safeLine + 8); index += 1) {
    const clean = cleanMarkdownText(lines[index] || '')
    if (clean) return truncate(clean, 90)
  }
  for (let index = safeLine - 2; index >= Math.max(0, safeLine - 8); index -= 1) {
    const clean = cleanMarkdownText(lines[index] || '')
    if (clean) return truncate(clean, 90)
  }
  return ''
}

export function resolveDocumentMarkLocation(mark: DocumentMarkRecord, content: string): DocumentMarkLocation {
  const normalized = content.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const outline = buildDocumentOutline(normalized)

  if (mark.anchorTitle) {
    const target = outline.nodes.find((node) => (
      node.kind === 'heading' &&
      node.anchorTitle === mark.anchorTitle &&
      node.anchorOrdinal === (mark.anchorOrdinal ?? 0)
    ))
    if (target) {
      const progress = Math.max(0, Math.min(1, mark.anchorProgress ?? 0))
      const lineStart = Math.max(1, Math.min(lines.length || 1, Math.round(target.lineStart + (target.lineEnd - target.lineStart) * progress)))
      return {
        status: 'linked',
        lineStart,
        lineEnd: mark.lineEnd && mark.lineStart ? lineStart + Math.max(0, mark.lineEnd - mark.lineStart) : lineStart,
      }
    }
  }

  const excerpt = mark.excerpt?.trim()
  if (excerpt) {
    const index = normalized.indexOf(excerpt)
    if (index >= 0) {
      const lineStart = normalized.slice(0, index).split('\n').length
      return {
        status: 'linked',
        lineStart,
        lineEnd: lineStart + excerpt.split('\n').length - 1,
      }
    }
  }

  const hadDurableAnchor = Boolean(mark.anchorTitle || mark.excerpt?.trim())
  if (!hadDurableAnchor && mark.lineStart && mark.lineStart >= 1 && mark.lineStart <= lines.length) {
    return {
      status: 'linked',
      lineStart: mark.lineStart,
      lineEnd: mark.lineEnd ?? mark.lineStart,
    }
  }

  return {
    status: 'stale',
    lineStart: null,
    lineEnd: null,
  }
}
