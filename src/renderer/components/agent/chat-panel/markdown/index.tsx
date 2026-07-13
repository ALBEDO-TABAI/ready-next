import { useMemo } from 'react'

// ---------------------------------------------------------------------------
// Lightweight Markdown renderer (no external deps)
// Supports: **bold**, *italic*, `inline code`, http(s) links, ```code blocks```,
//           # headers, bullet lists (- / *), numbered lists, line breaks
// ---------------------------------------------------------------------------
//
// Stage V V1.2 — extracted from ChatPanel.tsx (was lines 88-98 + 173-522).
// This module owns the pure markdown rendering pipeline used by ChatMessages
// via ChatPanel's `renderMarkdown` callback. It has zero `useAgent` / store /
// IPC dependencies — purely string -> ReactNode rendering. Behavior must
// remain byte-for-byte identical to the previous inline implementation; the
// V6 fixture (`chat-panel-baseline.test.ts`) snapshot diff must stay at 0.

export interface MarkdownNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'header' | 'bullet' | 'numbered' | 'table' | 'br'
  content: string
  level?: number // header level 1-3
  lang?: string // code block language
  headers?: string[]
  rows?: string[][]
  aligns?: TableAlignment[]
}

export type TableAlignment = 'left' | 'center' | 'right' | null

export function parseMarkdown(raw: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      nodes.push({ type: 'codeblock', content: codeLines.join('\n'), lang })
      i++ // skip closing ```
      continue
    }

    const table = parseTableAt(lines, i)
    if (table) {
      nodes.push({
        type: 'table',
        content: '',
        headers: table.headers,
        rows: table.rows,
        aligns: table.aligns,
      })
      i = table.nextIndex
      continue
    }

    // Header (# ## ###)
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headerMatch) {
      nodes.push({ type: 'header', content: headerMatch[2], level: headerMatch[1].length })
      i++
      continue
    }

    // Bullet list (- or *)
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/)
    if (bulletMatch) {
      nodes.push({ type: 'bullet', content: bulletMatch[1] })
      i++
      continue
    }

    // Numbered list
    const numMatch = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (numMatch) {
      nodes.push({ type: 'numbered', content: numMatch[1] })
      i++
      continue
    }

    // Empty line -> line break
    if (line.trim() === '') {
      nodes.push({ type: 'br', content: '' })
      i++
      continue
    }

    // Regular text line
    nodes.push({ type: 'text', content: line })
    i++
  }

  return nodes
}

function parseTableAt(
  lines: string[],
  startIndex: number,
): { headers: string[]; rows: string[][]; aligns: TableAlignment[]; nextIndex: number } | null {
  if (startIndex + 1 >= lines.length) return null
  const headers = splitMarkdownTableRow(lines[startIndex])
  if (headers.length < 2) return null

  const aligns = parseMarkdownTableSeparator(lines[startIndex + 1])
  if (!aligns || aligns.length < 2) return null

  const columnCount = Math.max(headers.length, aligns.length)
  const rows: string[][] = []
  let index = startIndex + 2

  while (index < lines.length) {
    if (lines[index].trim() === '') break
    const cells = splitMarkdownTableRow(lines[index])
    if (cells.length < 2) break
    rows.push(normalizeMarkdownTableCells(cells, columnCount))
    index += 1
  }

  return {
    headers: normalizeMarkdownTableCells(headers, columnCount),
    rows,
    aligns: normalizeMarkdownTableAligns(aligns, columnCount),
    nextIndex: index,
  }
}

function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (!hasMarkdownTablePipe(trimmed)) return []
  if (isMarkdownTablePipe(trimmed[0])) trimmed = trimmed.slice(1)
  if (isMarkdownTablePipe(trimmed[trimmed.length - 1])) trimmed = trimmed.slice(0, -1)

  const cells: string[] = []
  let cell = ''
  let inInlineCode = false

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '\\' && index + 1 < trimmed.length) {
      cell += trimmed[index + 1]
      index += 1
      continue
    }
    if (char === '`') {
      inInlineCode = !inInlineCode
      cell += char
      continue
    }
    if (!inInlineCode && isMarkdownTablePipe(char)) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell.trim())
  return cells
}

function parseMarkdownTableSeparator(line: string): TableAlignment[] | null {
  const cells = splitMarkdownTableRow(line)
  if (cells.length < 2) return null
  const aligns: TableAlignment[] = []

  for (const cell of cells) {
    const marker = cell.replace(/\s/g, '')
    if (!/^:?-{1,}:?$/.test(marker)) return null
    const starts = marker.startsWith(':')
    const ends = marker.endsWith(':')
    aligns.push(starts && ends ? 'center' : ends ? 'right' : starts ? 'left' : null)
  }

  return aligns
}

function normalizeMarkdownTableCells(cells: string[], count: number): string[] {
  if (cells.length === count) return cells
  const normalized = cells.slice(0, count)
  while (normalized.length < count) normalized.push('')
  return normalized
}

function normalizeMarkdownTableAligns(aligns: TableAlignment[], count: number): TableAlignment[] {
  if (aligns.length === count) return aligns
  const normalized = aligns.slice(0, count)
  while (normalized.length < count) normalized.push(null)
  return normalized
}

function hasMarkdownTablePipe(line: string): boolean {
  return line.includes('|') || line.includes('｜')
}

function isMarkdownTablePipe(char: string | undefined): boolean {
  return char === '|' || char === '｜'
}

function splitBareUrl(raw: string): { href: string; trailing: string } {
  let end = raw.length
  while (end > 0 && /[.,!?;:，。！？；：]/.test(raw[end - 1])) end -= 1
  while (end > 0 && raw[end - 1] === ')') {
    const value = raw.slice(0, end)
    const opens = (value.match(/\(/g) || []).length
    const closes = (value.match(/\)/g) || []).length
    if (closes <= opens) break
    end -= 1
  }
  return { href: raw.slice(0, end), trailing: raw.slice(end) }
}

function externalLink(href: string, label: string, key: string): React.ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2 }}
    >
      {label}
    </a>
  )
}

/** Parse inline formatting: **bold**, *italic*, `code`, and safe http(s) links. */
export function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Ordering is significant: code consumes URLs before the bare-URL branch;
  // labelled links consume their URL before that same branch.
  const regex = /(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(https?:\/\/[^\s<>"'`]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    if (match[1]) {
      // inline code
      parts.push(
        <code
          key={`ic-${key++}`}
          style={{
            background: 'var(--bg-code)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.9em',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
          }}
        >
          {match[2]}
        </code>
      )
    } else if (match[3]) {
      // labelled Markdown link; regex only admits http(s)
      parts.push(externalLink(match[5], match[4], `a-${key++}`))
    } else if (match[6]) {
      // bold
      parts.push(<strong key={`b-${key++}`}>{match[7]}</strong>)
    } else if (match[8]) {
      // italic
      parts.push(<em key={`i-${key++}`}>{match[9]}</em>)
    } else if (match[10]) {
      const { href, trailing } = splitBareUrl(match[10])
      parts.push(externalLink(href, href, `a-${key++}`))
      if (trailing) parts.push(trailing)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

export function MarkdownContent({ content }: { content: string }) {
  const nodes = useMemo(() => parseMarkdown(content), [content])

  // Bug fix: numbered list ordinals must reflect position *within the list*,
  // not the node's index in the whole document. The line-based parser emits
  // each numbered line as its own node and inserts `br` nodes between blank
  // lines, so `idx + 1` was producing 3, 5, 7, 9 (odd numbers from the array
  // index plus the leading text/br) for an agent reply that wrote 1, 2, 3, 4.
  // Walk the node list once to compute a stable ordinal that only counts
  // `numbered` items and is interrupted by any non-numbered, non-br node.
  const numberedOrdinals = useMemo(() => {
    const out = new Array<number>(nodes.length).fill(0)
    let counter = 0
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      if (node.type === 'numbered') {
        counter += 1
        out[i] = counter
      } else if (node.type !== 'br') {
        // Any non-br interruption (paragraph, header, code block, bullet)
        // ends the current ordered list. The next numbered item starts over.
        counter = 0
      }
    }
    return out
  }, [nodes])

  return (
    <div className="markdown-content" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {nodes.map((node, idx) => {
        switch (node.type) {
          case 'header': {
            const fontSize = node.level === 1 ? 16 : node.level === 2 ? 14.5 : 13.5
            return (
              <div key={idx} style={{ fontSize, fontWeight: 700, marginTop: 6, marginBottom: 2 }}>
                {renderInline(node.content)}
              </div>
            )
          }
          case 'codeblock':
            return (
              <pre
                key={idx}
                style={{
                  background: 'var(--bg-code)',
                  padding: '10px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: '4px 0',
                  lineHeight: 1.5
                }}
              >
                {node.content}
              </pre>
            )
          case 'bullet':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span style={{ flexShrink: 0, color: 'var(--text-gray)' }}>&bull;</span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'numbered':
            return (
              <div key={idx} style={{ display: 'flex', gap: 6, paddingLeft: 4 }}>
                <span
                  style={{
                    flexShrink: 0,
                    color: 'var(--text-gray)',
                    minWidth: 14,
                    textAlign: 'right'
                  }}
                >
                  {numberedOrdinals[idx]}.
                </span>
                <span>{renderInline(node.content)}</span>
              </div>
            )
          case 'table': {
            const headers = node.headers || []
            const rows = node.rows || []
            const aligns = node.aligns || []
            return (
              <div key={idx} className="agent-markdown-table-scroll">
                <table className="agent-markdown-table">
                  <thead>
                    <tr>
                      {headers.map((header, columnIndex) => (
                        <th
                          key={`h-${columnIndex}`}
                          style={{ textAlign: aligns[columnIndex] || undefined }}
                        >
                          {renderInline(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, rowIndex) => (
                      <tr key={`r-${rowIndex}`}>
                        {headers.map((_, columnIndex) => (
                          <td
                            key={`c-${rowIndex}-${columnIndex}`}
                            style={{ textAlign: aligns[columnIndex] || undefined }}
                          >
                            {renderInline(row[columnIndex] || '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
          case 'br':
            return <div key={idx} style={{ height: 6 }} />
          default:
            return <div key={idx}>{renderInline(node.content)}</div>
        }
      })}
    </div>
  )
}
