import type { Nodes } from 'mdast'
import { markdownTree } from '../../../shared/document-blocks/markdown'
import { parseDocumentBlocks, replaceRanges, type ReplacementRange } from '../../../shared/document-blocks'
import { decodeMarkdownRefLocalCandidate, rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'

/** MDAST identifies destinations so code, labels and titles are never rewritten as paths. */
export function rewriteTemplateAttachments(source: string, rewrite: (path: string) => string, rewritePage: (page: string) => string): string {
  const ranges: ReplacementRange[] = []
  function destination(raw: string): string | null {
    const path = decodeMarkdownRefLocalCandidate(raw)
    if (path === null) return null
    const hash = path.indexOf('#'), suffix = hash < 0 ? '' : path.slice(hash)
    return rewrite(hash < 0 ? path : path.slice(0, hash)) + suffix
  }
  function visit(node: Nodes, base: number) {
    const start = node.position?.start.offset, end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    const raw = source.slice(base + start, base + end)
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      const replacement = destination(node.url)
      if (replacement === null) return
      const from = node.type === 'definition' ? raw.indexOf(':') + 1 : raw.indexOf('](') + 2
      const candidates = [node.url, node.url.replace(/[()]/g, '\\$&')]
      const literal = candidates.find(value => raw.indexOf(value, from) >= 0)
      if (!literal) throw new Error('无法确定模板附件的原始路径位置')
      const at = base + start + raw.indexOf(literal, from)
      ranges.push({ start: at, end: at + literal.length, expectedText: literal, replacement })
    } else if (node.type === 'text') {
      for (const match of raw.matchAll(/\[\[([^#|\]\r\n]+)((?:#[^|\]\r\n]*)?(?:\|[^\]\r\n]*)?)\]\]/g)) {
        const at = base + start + match.index
        ranges.push({ start: at, end: at + match[0].length, expectedText: match[0], replacement: `[[${rewritePage(match[1])}${match[2]}]]` })
      }
    } else if (node.type === 'html') {
      const replacement = rewriteMarkdownMediaRefs(raw, ref => destination(ref.rawDest))
      if (replacement !== raw) ranges.push({ start: base + start, end: base + end, expectedText: raw, replacement })
    } else if ('children' in node) for (const child of node.children) visit(child, base)
  }
  for (const block of parseDocumentBlocks(source).blocks.filter(block => !block.parentId && block.type !== 'frontmatter')) visit(markdownTree(block.raw), block.start)
  return replaceRanges(source, { type: 'replaceRanges', expectedVersion: 0, ranges }, 0)
}
