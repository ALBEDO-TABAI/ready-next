import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Root } from 'mdast'
import { z } from 'zod'

const PointSchema = z.object({ run: z.number().int().nonnegative().describe('阅读文字片段的来源位置标识'), offset: z.number().int().nonnegative().describe('片段内字符位置') }).strict()
export const RSSReadingRangeSchema = z.object({ start: PointSchema, end: PointSchema }).strict()
export type RSSReadingRange = z.infer<typeof RSSReadingRangeSchema>
export interface ReadingRun { id: number; block: number; text: string }
const BLOCKS = new Set(['paragraph', 'heading', 'code', 'tableCell'])

/** One text projection for both the reader's DOM and version-bound excerpts. No saved copy and no text matching. */
function visitReadingRuns(root: Root, annotate: boolean): ReadingRun[] {
  const runs: ReadingRun[] = []
  const notes = new Map<string, Extract<Nodes, { type: 'footnoteDefinition' }>>(), order: string[] = []
  const collect = (node: Nodes) => {
    if (node.type === 'footnoteDefinition' && !notes.has(node.identifier.toUpperCase())) notes.set(node.identifier.toUpperCase(), node)
    if ('children' in node) node.children.forEach(collect)
  }
  collect(root)
  const visit = (node: Nodes, block: number) => {
    if (node.type === 'footnoteDefinition') return
    if (node.type === 'footnoteReference' && !order.includes(node.identifier.toUpperCase())) order.push(node.identifier.toUpperCase())
    const id = node.position?.start.offset
    if (id !== undefined && BLOCKS.has(node.type)) block = id
    let value: string | undefined
    if (node.type === 'text') value = node.value.replace(/[\t ]*(\r\n|\r|\n)[\t ]*/g, '$1')
    else if (node.type === 'inlineCode') value = node.value.replace(/\r\n|\r|\n/g, ' ')
    else if (node.type === 'code') value = node.value
    else if (node.type === 'html') value = node.value
    else if (node.type === 'break') value = '\n'
    if (id !== undefined && value !== undefined) {
      runs.push({ id, block: block < 0 ? id : block, text: value })
      if (annotate) {
        const isBreak = node.type === 'break'
        const wrap = node.type === 'text' || node.type === 'html' || isBreak
        const properties = { 'data-ready-reading-run': id, 'data-ready-reading-block': block < 0 ? id : block, ...(isBreak ? { style: 'white-space:pre' } : {}) }
        node.data = { ...node.data, ...(wrap ? { hName: 'span' } : {}), hProperties: node.type === 'code' ? {} : properties,
          hChildren: node.type === 'code'
            ? [{ type: 'element', tagName: 'span', properties, children: [{ type: 'text', value }] }, ...(value ? [{ type: 'text' as const, value: '\n' }] : [])]
            : [{ type: 'text', value }],
        }
        // Preserve a hard break as one annotated newline, without the default handler's extra unmarked text node.
        if (isBreak) Object.assign(node, { type: 'text', value })
      }
    }
    if ('children' in node) node.children.forEach((child) => visit(child, block))
  }
  visit(root, -1)
  // Match the shared Markdown renderer's footnote display order; generated numbers/backlinks are not article text.
  for (let index = 0; index < order.length; index++) notes.get(order[index])?.children.forEach((node) => visit(node, -1))
  return runs
}
export function remarkReadingAnchors() { return (tree: Root) => { visitReadingRuns(tree, true) } }
export function readingRuns(markdown: string): ReadingRun[] {
  return visitReadingRuns(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }), false)
}
function assertBoundary(text: string, offset: number): void {
  if (offset > text.length) throw new Error('excerpt_offset_out_of_range')
  if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] || '')) throw new Error('excerpt_offset_inside_surrogate')
}
export function readingExcerpt(markdown: string, input: RSSReadingRange): string {
  const range = RSSReadingRangeSchema.parse(input), runs = readingRuns(markdown)
  const start = runs.findIndex((r) => r.id === range.start.run), end = runs.findIndex((r) => r.id === range.end.run)
  if (start < 0 || end < start) throw new Error('excerpt_range_unavailable')
  assertBoundary(runs[start].text, range.start.offset); assertBoundary(runs[end].text, range.end.offset)
  if (start === end && range.end.offset <= range.start.offset) throw new Error('excerpt_range_empty')
  let text = ''
  for (let index = start; index <= end; index++) {
    if (index > start && runs[index].block !== runs[index - 1].block) text += '\n\n'
    text += runs[index].text.slice(index === start ? range.start.offset : 0, index === end ? range.end.offset : undefined)
  }
  if (!text) throw new Error('excerpt_range_empty')
  return text
}
