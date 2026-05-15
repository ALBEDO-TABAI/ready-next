export type DocumentScrollAnchorSnapshot = {
  top: number
  ratio: number
  maxScroll: number
  anchorTitle: string | null
  anchorOrdinal: number | null
  anchorProgress: number | null
}

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
