import { parseRSSCitationUrl, type RSSNavigableReference } from '../../../../../shared/rss-reference'
import { useMemo } from 'react'
import { MessageCodeBlock } from './MessageCodeBlock'
import { LocalFileChip, LocalMentionChip } from './LocalReferenceChip'
import {
  parseLocalReferences,
  type MentionResolution,
} from './local-reference'

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
  type: 'text' | 'bold' | 'italic' | 'code' | 'codeblock' | 'header' | 'bullet' | 'ordered-list' | 'table' | 'br'
  content: string
  level?: number // header level 1-3
  lang?: string // code block language
  indent?: number
  orderedList?: MarkdownOrderedList
  headers?: string[]
  rows?: string[][]
  aligns?: TableAlignment[]
}

export type TableAlignment = 'left' | 'center' | 'right' | null

export interface MarkdownOrderedListItem {
  content: string
  continuations: string[]
  nestedLists: MarkdownOrderedList[]
}

export interface MarkdownOrderedList {
  start: number
  delimiter: '.' | ')'
  indent: number
  items: MarkdownOrderedListItem[]
}

function markdownIndentColumns(value: string): number {
  let columns = 0
  for (const char of value) columns += char === '\t' ? 4 : 1
  return columns
}

type NumberedLine = {
  indent: number
  ordinal: number
  delimiter: '.' | ')'
  content: string
}

function parseNumberedLine(line: string): NumberedLine | null {
  const match = line.match(/^([ \t]*)(\d+)([.)])\s+(.+)$/)
  if (!match) return null
  const ordinal = Number(match[2])
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null
  return {
    indent: markdownIndentColumns(match[1]),
    ordinal,
    delimiter: match[3] as '.' | ')',
    content: match[4],
  }
}

function startsMarkdownBlock(line: string): boolean {
  return /^#{1,3}\s+/.test(line)
    || line.trimStart().startsWith('```')
    || /^\s*[-*]\s+/.test(line)
}

function parseOrderedListAt(
  lines: string[],
  startIndex: number,
): { list: MarkdownOrderedList; nextIndex: number } | null {
  const first = parseNumberedLine(lines[startIndex])
  if (!first) return null

  const list: MarkdownOrderedList = {
    start: first.ordinal,
    delimiter: first.delimiter,
    indent: first.indent,
    items: [],
  }
  let index = startIndex

  while (index < lines.length) {
    const marker = parseNumberedLine(lines[index])
    if (!marker || marker.indent !== list.indent || marker.delimiter !== list.delimiter) break

    const item: MarkdownOrderedListItem = {
      content: marker.content,
      continuations: [],
      nestedLists: [],
    }
    list.items.push(item)
    index += 1
    let blankCount = 0

    while (index < lines.length) {
      const line = lines[index]
      if (line.trim() === '') {
        blankCount += 1
        index += 1
        continue
      }

      const nextMarker = parseNumberedLine(line)
      if (nextMarker?.indent === list.indent) {
        if (nextMarker.delimiter === list.delimiter) break
        index -= blankCount
        return { list, nextIndex: index }
      }

      if (nextMarker && nextMarker.indent > list.indent) {
        const nested = parseOrderedListAt(lines, index)
        if (!nested) break
        item.nestedLists.push(nested.list)
        index = nested.nextIndex
        blankCount = 0
        continue
      }

      const indentMatch = line.match(/^([ \t]+)(.*)$/)
      if (indentMatch && markdownIndentColumns(indentMatch[1]) > list.indent) {
        item.continuations.push(indentMatch[2])
        index += 1
        blankCount = 0
        continue
      }

      if (blankCount === 0 && !startsMarkdownBlock(line)) {
        item.continuations.push(line)
        index += 1
        continue
      }

      index -= blankCount
      return { list, nextIndex: index }
    }
  }

  return { list, nextIndex: index }
}

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
    const bulletMatch = line.match(/^([ \t]*)[-*]\s+(.+)$/)
    if (bulletMatch) {
      nodes.push({
        type: 'bullet',
        content: bulletMatch[2],
        indent: markdownIndentColumns(bulletMatch[1]),
      })
      i++
      continue
    }

    // Ordered list. One semantic container owns the sequence; authored
    // ordinals after the first item do not become a second numbering truth.
    const orderedList = parseOrderedListAt(lines, i)
    if (orderedList) {
      nodes.push({
        type: 'ordered-list',
        content: '',
        orderedList: orderedList.list,
      })
      i = orderedList.nextIndex
      continue
    }

    // Empty line -> line break
    if (line.trim() === '') {
      nodes.push({ type: 'br', content: '' })
      i++
      continue
    }

    // Regular text line
    const textMatch = line.match(/^([ \t]+)(.*)$/)
    nodes.push(textMatch
      ? { type: 'text', content: textMatch[2], indent: markdownIndentColumns(textMatch[1]) }
      : { type: 'text', content: line })
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

function externalLink(href: string, label: string, key: string, onRSSReference?: (reference: RSSNavigableReference) => void): React.ReactNode {
  if (href.startsWith('ready-rss:')) {
    const reference = parseRSSCitationUrl(href)
    return reference && onRSSReference ? <button key={key} className="rss-citation-link" onClick={() => onRSSReference(reference)}>{label === href ? '查看 RSS 引用' : label}</button> : <span key={key}>{label}</span>
  }
  const citation = /^\d+$/.test(label.trim())
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer"
      className={citation ? 'ready-agent-link ready-agent-citation' : 'ready-agent-link'}
      data-ready-agent-citation={citation ? 'true' : undefined}
    >
      {label}
    </a>
  )
}

export interface InlineCitationSource {
  index: string
  href: string
  source: string
}

export function extractInlineCitationSources(content: string): InlineCitationSource[] {
  const sources = new Map<string, InlineCitationSource>()
  const pattern = /\[(\d+)\]\((https?:\/\/[^\s)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const index = match[1]
    const href = match[2]
    const key = `${index}:${href}`
    if (sources.has(key)) continue
    let source = href
    try {
      source = new URL(href).hostname.replace(/^www\./, '')
    } catch {
      // The renderer only links http(s) values. If URL parsing still fails,
      // the literal href is the truthful fallback label.
    }
    sources.set(key, { index, href, source })
  }
  return [...sources.values()]
}

function renderLocalReferenceParts(
  text: string,
  mentions: Readonly<Record<string, MentionResolution>> | null | undefined,
  keyPrefix: string,
): React.ReactNode[] {
  return parseLocalReferences(text).map((part, index) => {
    if (typeof part === 'string') return part
    if (part.kind === 'mention') {
      return (
        <LocalMentionChip
          key={`${keyPrefix}-m-${index}`}
          name={part.name}
          resolution={mentions?.[part.name] ?? null}
        />
      )
    }
    return (
      <LocalFileChip
        key={`${keyPrefix}-f-${index}`}
        path={part.path}
        line={part.line}
      />
    )
  })
}

/** Parse inline formatting: **bold**, *italic*, `code`, and safe http(s) links. */
export function renderInline(
  text: string,
  mentions?: Readonly<Record<string, MentionResolution>> | null,
  onRSSReference?: (reference: RSSNavigableReference) => void,
): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Ordering is significant: code consumes URLs before the bare-URL branch;
  // labelled links consume their URL before that same branch.
  const regex = /(`([^`]+)`)|(\[([^\]]+)\]\(((?:https?:\/\/|file:\/\/|ready-rss:\/\/)[^\s)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)|((?:https?|ready-rss):\/\/[^\s<>"'`]+)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderLocalReferenceParts(text.slice(lastIndex, match.index), mentions, `pre-${key}`))
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
      const href = match[5]
      if (href.startsWith('file://')) {
        let path = href.slice('file://'.length)
        try {
          path = decodeURI(path)
        } catch {
          // Keep the raw file URL path if it is not valid URI encoding.
        }
        parts.push(<LocalFileChip key={`a-${key++}`} path={path} />)
      } else {
        parts.push(externalLink(href, match[4], `a-${key++}`, onRSSReference))
      }
    } else if (match[6]) {
      // bold
      parts.push(<strong key={`b-${key++}`}>{match[7]}</strong>)
    } else if (match[8]) {
      // italic
      parts.push(<em key={`i-${key++}`}>{match[9]}</em>)
    } else if (match[10]) {
      const { href, trailing } = splitBareUrl(match[10])
      parts.push(externalLink(href, href, `a-${key++}`, onRSSReference))
      if (trailing) parts.push(trailing)
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(...renderLocalReferenceParts(text.slice(lastIndex), mentions, `tail-${key}`))
  }

  return parts.length > 0 ? parts : [text]
}

function StreamCaret({ visible }: { visible: boolean }) {
  if (!visible) return null
  return <span className="ready-stream-caret" data-ready-stream-caret="true" aria-hidden="true" />
}

function OrderedList({
  list,
  mentions,
  onRSSReference,
  streaming,
}: {
  list: MarkdownOrderedList
  mentions?: Readonly<Record<string, MentionResolution>> | null
  onRSSReference?: (reference: RSSNavigableReference) => void
  streaming: boolean
}): React.ReactElement {
  return (
    <ol
      start={list.start}
      data-ready-ordered-list="true"
      data-ready-list-delimiter={list.delimiter}
      data-ready-list-indent={list.indent || undefined}
    >
      {list.items.map((item, itemIndex) => {
        const lastItem = itemIndex === list.items.length - 1
        const caretOnContent = streaming
          && lastItem
          && item.continuations.length === 0
          && item.nestedLists.length === 0
        return (
          <li key={itemIndex}>
            <span>
              {renderInline(item.content, mentions, onRSSReference)}
              <StreamCaret visible={caretOnContent} />
            </span>
            {item.continuations.map((continuation, continuationIndex) => (
              <div key={`continuation-${continuationIndex}`} data-ready-list-continuation="true">
                {renderInline(continuation, mentions, onRSSReference)}
                <StreamCaret
                  visible={streaming
                    && lastItem
                    && continuationIndex === item.continuations.length - 1
                    && item.nestedLists.length === 0}
                />
              </div>
            ))}
            {item.nestedLists.map((nested, nestedIndex) => (
              <OrderedList
                key={`nested-${nestedIndex}`}
                list={nested}
                mentions={mentions} onRSSReference={onRSSReference}
                streaming={streaming && lastItem && nestedIndex === item.nestedLists.length - 1}
              />
            ))}
          </li>
        )
      })}
    </ol>
  )
}

export function MarkdownContent({
  content,
  streaming = false,
  mentions,
  onRSSReference,
}: {
  content: string
  streaming?: boolean
  mentions?: Readonly<Record<string, MentionResolution>> | null
  onRSSReference?: (reference: RSSNavigableReference) => void
}) {
  const nodes = useMemo(() => parseMarkdown(content), [content])
  const citationSources = useMemo(() => extractInlineCitationSources(content), [content])
  const lastContentIndex = useMemo(() => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (nodes[index].type !== 'br') return index
    }
    return -1
  }, [nodes])

  return (
    <div
      className="markdown-content ready-agent-prose"
      data-ready-streaming={streaming ? 'true' : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {nodes.map((node, idx) => {
        const showCaret = streaming && idx === lastContentIndex
        switch (node.type) {
          case 'header': {
            const fontSize = node.level === 1 ? 16 : node.level === 2 ? 14.5 : 13.5
            return (
              <div key={idx} style={{ fontSize, fontWeight: 700, marginTop: 6, marginBottom: 2 }}>
                {renderInline(node.content, mentions, onRSSReference)}
                <StreamCaret visible={showCaret} />
              </div>
            )
          }
          case 'codeblock':
            return (
              <MessageCodeBlock
                key={idx}
                language={node.lang || ''}
                code={node.content}
                streaming={showCaret}
              />
            )
          case 'bullet':
            return (
              <div
                key={idx}
                data-ready-list-indent={node.indent || undefined}
                style={{
                  paddingLeft: node.indent ? `calc(4px + ${node.indent}ch)` : 4,
                  display: 'flex',
                  gap: 6,
                }}
              >
                <span style={{ flexShrink: 0, color: 'var(--text-gray)' }}>&bull;</span>
                <span>
                  {renderInline(node.content, mentions, onRSSReference)}
                  <StreamCaret visible={showCaret} />
                </span>
              </div>
            )
          case 'ordered-list':
            return node.orderedList ? (
              <OrderedList
                key={idx}
                list={node.orderedList}
                mentions={mentions} onRSSReference={onRSSReference}
                streaming={showCaret}
              />
            ) : null
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
                          {renderInline(header, mentions, onRSSReference)}
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
                            {renderInline(row[columnIndex] || '', mentions, onRSSReference)}
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
            return (
              <div
                key={idx}
                data-ready-markdown-indent={node.indent || undefined}
                style={{ paddingLeft: node.indent ? `${node.indent}ch` : undefined }}
              >
                {renderInline(node.content, mentions, onRSSReference)}
                <StreamCaret visible={showCaret} />
              </div>
            )
        }
      })}
      {citationSources.length > 0 ? (
        <div
          className="ready-agent-citation-sources"
          data-ready-agent-citation-sources="true"
          aria-label="引用来源"
        >
          {citationSources.map((citation) => (
            <a
              key={`${citation.index}:${citation.href}`}
              className="ready-agent-citation-source"
              data-ready-agent-citation-source={citation.index}
              href={citation.href}
              target="_blank"
              rel="noreferrer"
              title={citation.href}
            >
              <span className="ready-agent-citation-source-index">[{citation.index}]</span>
              <span>{citation.source}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}
