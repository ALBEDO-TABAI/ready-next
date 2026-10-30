import type { Nodes, RootContent } from 'mdast'
import { markdownTree } from './markdown'
import { parseInlineBlock } from './inline'
import { createPositionMap, fragmentHash, isValidUtf8 } from './positions'

export type BlockType = 'frontmatter' | 'paragraph' | 'heading' | 'list' | 'listItem' | 'taskItem'
  | 'blockquote' | 'thematicBreak' | 'code' | 'table' | 'image' | 'wikiLink' | 'embed' | 'callout'
  | 'columns' | 'column' | 'widget' | 'mermaid' | 'html' | 'unknown'
export interface SourceFragment {
  start: number; end: number; byteStart: number; byteEnd: number; raw: string; hash: string
}
export interface DocumentGap extends SourceFragment { kind: 'gap'; parentId: string | null }
export interface DocumentBlock extends SourceFragment {
  kind: 'block'; id: string; type: BlockType; parentId: string | null
  capability: 'rich' | 'source' | 'readonly'; sourceEditable: true
  children: DocumentSegment[]
  issue?: '分栏格式需修复'
  widths?: number[]
  callout?: { type: string; fold: '' | '-' | '+'; title: string }
}
export type DocumentSegment = DocumentBlock | DocumentGap
export interface ParsedDocument {
  source: string
  /** Non-overlapping ordered partition. Concatenating raw reproduces the complete source. */
  segments: DocumentSegment[]
  /** Parent/child lookup index; containers overlap descendants and must not be concatenated. */
  blocks: DocumentBlock[]
  positions: ReturnType<typeof createPositionMap>
}

function nodeRange(node: Nodes, base: number) {
  if (node.position?.start.offset === undefined || node.position.end.offset === undefined) throw new Error('Markdown node has no source position')
  return { start: base + node.position.start.offset, end: base + node.position.end.offset }
}

export const calloutHeader = /^( {0,3}>[ \t]*)\[!([\w-]+)(?:\|[\w-]+)?\]([-+]?)([^\r\n]*)/

export function parseDocumentBlocks(source: string): ParsedDocument {
  const positions = createPositionMap(source)
  const blocks: DocumentBlock[] = []
  function fragment(start: number, end: number): SourceFragment {
    const raw = source.slice(start, end)
    return { start, end, byteStart: positions.toByte(start), byteEnd: positions.toByte(end), raw, hash: fragmentHash(raw) }
  }
  function block(type: BlockType, start: number, end: number, parentId: string | null, capability: DocumentBlock['capability'] = 'rich'): DocumentBlock {
    const part = fragment(start, end)
    const result: DocumentBlock = { ...part, kind: 'block', id: `${start}:${end}:${type}:${part.hash}`, type, parentId, capability, sourceEditable: true, children: [] }
    blocks.push(result)
    return result
  }
  function cover(start: number, end: number, children: DocumentBlock[], parentId: string | null): DocumentSegment[] {
    const result: DocumentSegment[] = []
    let cursor = start
    for (const child of children) {
      if (child.start < cursor || child.end > end) throw new Error('Overlapping parser blocks')
      if (child.start > cursor) result.push({ ...fragment(cursor, child.start), kind: 'gap', parentId })
      result.push(child); cursor = child.end
    }
    if (cursor < end) result.push({ ...fragment(cursor, end), kind: 'gap', parentId })
    return result
  }
  function convert(node: Nodes, base: number, parentId: string | null): DocumentBlock {
    const { start, end } = nodeRange(node, base)
    const raw = source.slice(start, end)
    let type: BlockType = 'unknown'
    let capability: DocumentBlock['capability'] = 'rich'
    switch (node.type) {
      case 'paragraph':
        type = node.children.length === 1 && node.children[0].type === 'image' ? 'image'
          : /^!\[\[[^\r\n]+\]\]$/.test(raw) ? 'embed' : /^\[\[[^\r\n]+\]\]$/.test(raw) ? 'wikiLink' : 'paragraph'
        break
      case 'heading': case 'list': case 'thematicBreak': case 'table': type = node.type; break
      case 'listItem': type = typeof node.checked === 'boolean' ? 'taskItem' : 'listItem'; break
      case 'blockquote': type = calloutHeader.test(raw) ? 'callout' : 'blockquote'; break
      case 'code':
        type = node.lang === 'show-widget' || node.lang === 'widget' ? 'widget' : node.lang === 'mermaid' ? 'mermaid' : 'code'
        capability = 'source'; break
      case 'html': type = 'html'; capability = 'readonly'; break
      default: capability = 'readonly'
    }
    if ((type === 'paragraph' || type === 'heading') && parseInlineBlock(raw).capability === 'source') capability = 'source'
    if (node.type === 'table' && node.children.some(row => row.children.some(cell => {
      const range = nodeRange(cell, base)
      return parseInlineBlock(source.slice(range.start, range.end)).capability === 'source'
    }))) capability = 'source'
    const result = block(type, start, end, parentId, capability)
    if (type === 'callout') {
      const match = calloutHeader.exec(raw)!
      const fold = match[3] === '-' ? '-' : match[3] === '+' ? '+' : ''
      result.callout = { type: match[2], fold, title: match[4].trim() }
    }
    if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') {
      result.children = cover(start, end, node.children.map(child => convert(child, base, result.id)), result.id)
    }
    return result
  }

  // Strip only a recognized frontmatter envelope from parsing, never normalize its contents.
  const bom = source.startsWith('\uFEFF') ? 1 : 0
  const fm = /^---[ \t]*(?:\r\n|\n|\r)[\s\S]*?^(?:---|\.\.\.)[ \t]*(?=\r?$|\r)/m.exec(source.slice(bom))
  const prefix: DocumentBlock[] = []
  let base = bom
  if (fm?.index === 0) {
    base += fm[0].length
    prefix.push(block('frontmatter', bom, base, null, 'source'))
  }
  const nodes = markdownTree(source.slice(base)).children
  type Marker = { kind: 'open' | 'next' | 'end'; widths?: number[]; valid: boolean }
  function marker(node: RootContent): Marker | null {
    if (node.type !== 'html') return null
    const { start, end } = nodeRange(node, base)
    const raw = source.slice(start, end)
    const lineStart = Math.max(bom, Math.max(source.lastIndexOf('\n', start - 1), source.lastIndexOf('\r', start - 1)) + 1)
    if (!/^[ \t]*$/.test(source.slice(lineStart, start)) || /[\r\n]/.test(raw.trim())) return null
    if (/^<!-- ready:column(?:\s|-->)/.test(raw)) return { kind: 'next', valid: /^<!-- ready:column -->[ \t]*$/.test(raw) }
    if (raw.startsWith('<!-- ready:columns-end')) return { kind: 'end', valid: /^<!-- ready:columns-end -->[ \t]*$/.test(raw) }
    if (!raw.startsWith('<!-- ready:columns')) return null
    const match = /^<!-- ready:columns(?: widths=([\d.,]+))? -->[ \t]*$/.exec(raw)
    const widths = match?.[1]?.split(',').map(Number)
    return { kind: 'open', widths, valid: Boolean(match) && (!widths || widths.every(n => Number.isFinite(n) && n > 0)) }
  }
  const top: DocumentBlock[] = [...prefix]
  for (let i = 0; i < nodes.length; i++) {
    const opening = marker(nodes[i])
    if (opening?.kind !== 'open') {
      const ordinary = convert(nodes[i], base, null)
      if (opening) ordinary.issue = '分栏格式需修复'
      top.push(ordinary); continue
    }
    let depth = 1, endIndex = i + 1, valid = opening.valid
    const splits = [i]
    for (; endIndex < nodes.length; endIndex++) {
      const m = marker(nodes[endIndex])
      if (m && !m.valid) valid = false
      if (m?.kind === 'open') { depth++; valid = false }
      if (m?.kind === 'next' && depth === 1) splits.push(endIndex)
      if (m?.kind === 'end' && --depth === 0) break
    }
    valid &&= depth === 0 && (!opening.widths || opening.widths.length === splits.length)
    if (!valid) {
      const last = Math.min(endIndex, nodes.length - 1)
      for (; i <= last; i++) {
        const ordinary = convert(nodes[i], base, null)
        ordinary.issue = '分栏格式需修复'; top.push(ordinary)
      }
      i = last; continue
    }
    const group = block('columns', nodeRange(nodes[i], base).start, nodeRange(nodes[endIndex], base).end, null, 'source')
    group.widths = opening.widths ?? splits.map(() => 1)
    const columns = splits.map((split, index) => {
      const next = splits[index + 1] ?? endIndex
      const column = block('column', nodeRange(nodes[split], base).end, nodeRange(nodes[next], base).start, group.id, 'source')
      column.children = cover(column.start, column.end, nodes.slice(split + 1, next).map(node => convert(node, base, column.id)), column.id)
      return column
    })
    group.children = cover(group.start, group.end, columns, group.id)
    top.push(group); i = endIndex
  }
  return { source, positions, segments: cover(0, source.length, top, null), blocks: blocks.sort((a, b) => a.start - b.start || b.end - a.end) }
}

export function readDocumentBytes(bytes: Uint8Array):
  | { capability: 'source'; reason: string; bytes: Uint8Array }
  | { capability: 'blocks'; document: ParsedDocument } {
  if (!isValidUtf8(bytes)) return { capability: 'source', reason: '文件不是合法 UTF-8，块编辑会改变原始字节', bytes: bytes.slice() }
  return { capability: 'blocks', document: parseDocumentBlocks(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
}
