import type { Nodes } from 'mdast'
import { anchoredBlocks, explicitBlockId, blockWithMarker } from './index'
import { setFrontmatterFields } from '../document-operations'
import { replaceRanges, type ReplacementRange } from '../document-blocks'
import { markdownTree } from '../document-blocks/markdown'

export function expandTemplate(source: string, title: string, now: Date, nextId: () => string, templateName = ''): string {
  const values: Record<string, string> = { title, date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
    time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` }
  let content = setFrontmatterFields(source, { set: {}, remove: ['ready_id'] })
  const blocks = anchoredBlocks(content), ids = new Map<string, string>(), declarations = new Map<number, ReplacementRange>()
  for (const block of blocks) {
    const id = explicitBlockId(content, block)
    if (!id) continue
    if (!ids.has(id)) ids.set(id, 'block-' + nextId())
    const owned = blockWithMarker(content, block), marker = /\^([\w-]+)[ \t]*$/.exec(owned.raw)
    if (!marker) continue
    const start = owned.start + marker.index + 1, end = start + id.length
    declarations.set(start, { start, end, expectedText: id, replacement: ids.get(id)! })
  }
  const ranges = [...declarations.values()]
  function references(node: Nodes, base: number) {
    if (node.type === 'text' && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      const offset = base + node.position.start.offset, raw = content.slice(offset, base + node.position.end.offset)
      for (const match of raw.matchAll(/\[\[([^\]\r\n#]*)#\^([\w-]+)\]\]/g)) {
        if (match[1] && match[1].replace(/\.md$/i, '') !== templateName) continue
        const replacement = ids.get(match[2]); if (!replacement) continue
        const start = offset + match.index
        ranges.push({ start, end: start + match[0].length, expectedText: match[0], replacement: `[[#^${replacement}]]` })
      }
    } else if ('children' in node) for (const child of node.children) references(child, base)
  }
  for (const block of blocks.filter(item => !item.children.some(child => child.kind === 'block') && !['code','mermaid','widget','html'].includes(item.type))) {
    references(markdownTree(block.raw), block.start)
  }
  content = replaceRanges(content, { type: 'replaceRanges', expectedVersion: 0, ranges }, 0)
  return content.replace(/\{\{(date|time|title)\}\}/g, (_, name: string) => values[name])
}
