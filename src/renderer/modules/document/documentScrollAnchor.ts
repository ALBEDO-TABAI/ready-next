export type DocumentScrollAnchorSnapshot = {
  top: number
  ratio: number
  maxScroll: number
  anchorTitle: string | null
  anchorOrdinal: number | null
  anchorProgress: number | null
  /** 正文块的源码行与块内阅读进度，跨排版共享。 */
  sourceLine?: number
  sourceProgress?: number
}

type DocumentReadingPositionStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export type DocumentReadingPositionRecord = DocumentScrollAnchorSnapshot & {
  key: string
  updatedAt: number
}

export const DOCUMENT_READING_POSITIONS_KEY = 'ready-document-reading-positions-v1'
const MAX_DOCUMENT_READING_POSITIONS = 800

type HeadingEntry = {
  title: string
  line: number
  ordinal: number
}

export function getMarkdownHeadingTitle(line: string): string | null {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
  return match ? match[1].trim() : null
}

function collectHeadings(content: string): HeadingEntry[] {
  const counts = new Map<string, number>()
  return content
    .split('\n')
    .map((line, index) => {
      const title = getMarkdownHeadingTitle(line)
      if (!title) return null
      const ordinal = counts.get(title) || 0
      counts.set(title, ordinal + 1)
      return { title, line: index + 1, ordinal }
    })
    .filter((entry): entry is HeadingEntry => entry !== null)
}

export function captureMarkdownLineAnchor(content: string, lineNumber: number): {
  title: string
  ordinal: number
  progress: number
} | null {
  const lines = content.split('\n')
  const line = Math.max(1, Math.min(lines.length || 1, Math.floor(lineNumber)))
  const headings = collectHeadings(content)
  if (headings.length === 0) return null

  let current = headings[0]
  let currentIndex = 0
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].line <= line) {
      current = headings[index]
      currentIndex = index
      continue
    }
    break
  }

  const next = headings[currentIndex + 1]
  const sectionEnd = next ? next.line : lines.length + 1
  const sectionLength = Math.max(1, sectionEnd - current.line)
  const offset = Math.max(0, Math.min(sectionLength, line - current.line))
  return {
    title: current.title,
    ordinal: current.ordinal,
    progress: offset / sectionLength,
  }
}

export function resolveMarkdownLineFromAnchor(
  content: string,
  snapshot: Pick<DocumentScrollAnchorSnapshot, 'anchorTitle' | 'anchorOrdinal' | 'anchorProgress'>,
): number | null {
  if (!snapshot.anchorTitle) return null
  const headings = collectHeadings(content)
  const headingIndex = headings.findIndex((heading) => (
    heading.title === snapshot.anchorTitle
    && heading.ordinal === (snapshot.anchorOrdinal || 0)
  ))
  if (headingIndex < 0) return null

  const lines = content.split('\n')
  const heading = headings[headingIndex]
  const next = headings[headingIndex + 1]
  const sectionEnd = next ? next.line : lines.length + 1
  const sectionLength = Math.max(1, sectionEnd - heading.line)
  const progress = Math.max(0, Math.min(1, snapshot.anchorProgress ?? 0))
  return Math.max(1, Math.min(lines.length || 1, Math.round(heading.line + progress * sectionLength)))
}

function resolveReadingPositionStorage(
  storage?: DocumentReadingPositionStorage | null,
): DocumentReadingPositionStorage | null {
  if (storage) return storage
  const candidate = (globalThis as { localStorage?: DocumentReadingPositionStorage }).localStorage
  return candidate || null
}

function normalizeSnapshot(value: Partial<DocumentScrollAnchorSnapshot>): DocumentScrollAnchorSnapshot | null {
  const top = Number(value.top)
  const ratio = Number(value.ratio)
  const maxScroll = Number(value.maxScroll)
  if (!Number.isFinite(top) || !Number.isFinite(ratio) || !Number.isFinite(maxScroll)) return null
  return {
    ...(Number.isFinite(value.sourceLine) && Number(value.sourceLine) >= 1 ? {
      sourceLine: Math.floor(Number(value.sourceLine)),
      sourceProgress: Number.isFinite(value.sourceProgress) ? Math.max(0, Math.min(1, Number(value.sourceProgress))) : 0,
    } : {}),
    top: Math.max(0, top),
    ratio: Math.max(0, Math.min(1, ratio)),
    maxScroll: Math.max(0, maxScroll),
    anchorTitle: typeof value.anchorTitle === 'string' && value.anchorTitle.trim() ? value.anchorTitle : null,
    anchorOrdinal: Number.isFinite(value.anchorOrdinal) ? Math.max(0, Math.floor(Number(value.anchorOrdinal))) : null,
    anchorProgress: Number.isFinite(value.anchorProgress)
      ? Math.max(0, Math.min(1, Number(value.anchorProgress)))
      : null,
  }
}

function normalizeRecord(value: unknown): DocumentReadingPositionRecord | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DocumentReadingPositionRecord>
  const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
  const updatedAt = Number(candidate.updatedAt)
  const snapshot = normalizeSnapshot(candidate)
  if (!key || !snapshot || !Number.isFinite(updatedAt)) return null
  return { key, updatedAt, ...snapshot }
}

export function readDocumentReadingPositions(
  storage?: DocumentReadingPositionStorage | null,
): DocumentReadingPositionRecord[] {
  const target = resolveReadingPositionStorage(storage)
  if (!target) return []
  try {
    const parsed = JSON.parse(target.getItem(DOCUMENT_READING_POSITIONS_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeRecord)
      .filter((record): record is DocumentReadingPositionRecord => Boolean(record))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DOCUMENT_READING_POSITIONS)
  } catch {
    // silent-catch: corrupted reading-position cache should reset to empty.
    return []
  }
}

export function readDocumentReadingPositionMap(
  storage?: DocumentReadingPositionStorage | null,
): Map<string, DocumentScrollAnchorSnapshot> {
  const map = new Map<string, DocumentScrollAnchorSnapshot>()
  readDocumentReadingPositions(storage).forEach(({ key, updatedAt: _updatedAt, ...snapshot }) => {
    map.set(key, snapshot)
  })
  return map
}

export function loadDocumentReadingPosition(
  key: string,
  storage?: DocumentReadingPositionStorage | null,
): DocumentScrollAnchorSnapshot | null {
  const normalizedKey = key.trim()
  if (!normalizedKey) return null
  const record = readDocumentReadingPositions(storage).find((item) => item.key === normalizedKey)
  if (!record) return null
  const { key: _key, updatedAt: _updatedAt, ...snapshot } = record
  return snapshot
}

export function saveDocumentReadingPosition(
  key: string,
  snapshot: DocumentScrollAnchorSnapshot,
  storage?: DocumentReadingPositionStorage | null,
): void {
  const normalizedKey = key.trim()
  const target = resolveReadingPositionStorage(storage)
  const normalizedSnapshot = normalizeSnapshot(snapshot)
  if (!normalizedKey || !target || !normalizedSnapshot) return
  try {
    const rest = readDocumentReadingPositions(target).filter((item) => item.key !== normalizedKey)
    const next = [
      { key: normalizedKey, updatedAt: Date.now(), ...normalizedSnapshot },
      ...rest,
    ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DOCUMENT_READING_POSITIONS)
    target.setItem(DOCUMENT_READING_POSITIONS_KEY, JSON.stringify(next))
  } catch {
    // silent-catch: reading position is a convenience cache; failures should not block reading.
  }
}
