import { parseInlineBlock } from '../../../../shared/document-blocks'
import { markdownTree } from '../../../../shared/document-blocks/markdown'

// A GFM table as the page view edits it. A cell edit replaces only that cell's own characters; adding, moving or
// deleting a row or column rewrites the table's lines in the plain `| a | b |` form and keeps every cell's source.

/** A cell's trimmed source and where it sits in the table's raw text. A row shorter than the header has cells with start -1. */
export interface TableCell { start: number; end: number; raw: string }
export interface TableModel { eol: string; indent: string; align: string[]; rows: TableCell[][] }

function splitRow(line: string, offset: number): TableCell[] {
  const cells: TableCell[] = []
  let at = /^[ \t]*/.exec(line)![0].length
  if (line[at] === '|') at++
  let from = at, pipes = at > 0 && line[at - 1] === '|' ? 1 : 0
  const push = (to: number) => {
    const segment = line.slice(from, to), lead = /^[ \t]*/.exec(segment)![0].length
    const raw = segment.trim()
    // An empty cell keeps one space of padding on its left when there is room, so typed text lands between the pipes.
    const start = raw ? from + lead : from + Math.min(1, segment.length)
    cells.push({ start: offset + start, end: offset + start + raw.length, raw })
  }
  for (; at < line.length; at++) {
    if (line[at] === '\\') { at++; continue }
    if (line[at] === '|') { push(at); from = at + 1; pipes++ }
  }
  if (line.slice(from).trim() || !pipes) push(line.length)
  return cells
}

/** The table, or null when its source is not one this editor can keep byte-for-byte (the block then edits as source). */
export function parseTable(raw: string): TableModel | null {
  const lines: Array<{ text: string; offset: number }> = []
  const breaks = /\r\n|\n|\r/g
  let cursor = 0
  for (let match = breaks.exec(raw); match; match = breaks.exec(raw)) { lines.push({ text: raw.slice(cursor, match.index), offset: cursor }); cursor = match.index + match[0].length }
  lines.push({ text: raw.slice(cursor), offset: cursor })
  if (lines.length < 2 || lines.some(line => !line.text.trim() || /^[ \t]*>/.test(line.text))) return null
  const tree = markdownTree(raw).children
  if (tree.length !== 1 || tree[0].type !== 'table' || tree[0].children.length !== lines.length - 1) return null
  const align = splitRow(lines[1].text, lines[1].offset).map(cell => cell.raw)
  if (!align.length || align.some(cell => !/^:?-+:?$/.test(cell))) return null
  const rows = [lines[0], ...lines.slice(2)].map(line => {
    const cells = splitRow(line.text, line.offset).slice(0, align.length)
    while (cells.length < align.length) cells.push({ start: -1, end: -1, raw: '' })
    return cells
  })
  for (const cell of rows.flat()) {
    // An escaped pipe inside code or a [[wiki|alias]] means something else once the cell is read on its own.
    if (cell.raw.includes('\\|') && (cell.raw.includes('`') || cell.raw.includes('[['))) return null
    if (cell.raw && parseInlineBlock(cell.raw).capability !== 'rich') return null
  }
  return { eol: /\r\n|\n|\r/.exec(raw)![0], indent: /^[ \t]*/.exec(lines[0].text)![0], align, rows }
}

/** Inline Markdown as it must be written inside a cell: one line, pipes escaped. */
export function cellMarkdown(markdown: string): string {
  const line = markdown.replace(/[ \t]*(?:\r\n|\n|\r)[ \t]*/g, ' ').trim()
  const escaped = line.replace(/(\\*)\|/g, (match, slashes: string) => slashes.length % 2 ? match : `${slashes}\\|`)
  if (escaped !== line && (line.includes('`') || line.includes('[['))) throw new Error('单元格里的代码或 Wiki 链接不能带竖线，请用源码编辑这张表')
  return escaped
}

const line = (indent: string, cells: readonly string[]) => `${indent}| ${cells.join(' | ')} |`
function serialize(model: TableModel, rows: string[][], align: string[]): string {
  return [line(model.indent, rows[0]), line(model.indent, align), ...rows.slice(1).map(row => line(model.indent, row))].join(model.eol)
}
const grid = (model: TableModel) => model.rows.map(row => row.map(cell => cell.raw))
const moved = <T,>(items: T[], from: number, to: number) => { const next = [...items]; next.splice(to, 0, ...next.splice(from, 1)); return next }

/** The smallest replacement (offsets within the table's raw text) that sets one cell. */
export function setCell(raw: string, model: TableModel, row: number, column: number, markdown: string): { start: number; end: number; replacement: string } {
  const cell = model.rows[row][column]
  if (cell.start < 0) {
    const rows = grid(model); rows[row][column] = markdown
    return { start: 0, end: raw.length, replacement: serialize(model, rows, model.align) }
  }
  if (cell.raw || !markdown) return { start: cell.start, end: cell.end, replacement: markdown }
  const left = /[ \t]/.test(raw[cell.start - 1] ?? '') ? '' : ' ', right = /[ \t]/.test(raw[cell.start] ?? '') ? '' : ' '
  return { start: cell.start, end: cell.end, replacement: left + markdown + right }
}
/** A new empty row before body index `at` (1 is the first row under the header; rows.length appends). */
export function insertRow(model: TableModel, at: number): string {
  const rows = grid(model); rows.splice(Math.max(1, at), 0, model.align.map(() => ''))
  return serialize(model, rows, model.align)
}
export function deleteRow(model: TableModel, row: number): string {
  if (row < 1) throw new Error('表头不能删除')
  return serialize(model, grid(model).filter((_cells, index) => index !== row), model.align)
}
export function moveRow(model: TableModel, row: number, to: number): string {
  if (row < 1 || to < 1 || to >= model.rows.length) throw new Error('这一行不能移到那里')
  return serialize(model, moved(grid(model), row, to), model.align)
}
export function insertColumn(model: TableModel, at: number): string {
  return serialize(model, grid(model).map(row => { const next = [...row]; next.splice(at, 0, ''); return next }), (() => { const next = [...model.align]; next.splice(at, 0, '---'); return next })())
}
export function deleteColumn(model: TableModel, column: number): string {
  if (model.align.length < 2) throw new Error('表格至少保留一列')
  return serialize(model, grid(model).map(row => row.filter((_cell, index) => index !== column)), model.align.filter((_cell, index) => index !== column))
}
export function moveColumn(model: TableModel, column: number, to: number): string {
  if (to < 0 || to >= model.align.length) throw new Error('这一列不能移到那里')
  return serialize(model, grid(model).map(row => moved(row, column, to)), moved(model.align, column, to))
}
export const columnAlign = (delimiter: string): 'left' | 'center' | 'right' | undefined =>
  /^:-+:$/.test(delimiter) ? 'center' : /-:$/.test(delimiter) ? 'right' : /^:/.test(delimiter) ? 'left' : undefined
