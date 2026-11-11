import { readDocumentSource } from '../../../../shared/document-operations'
import { markdownTree } from '../../../../shared/document-blocks/markdown'
import type { ParsedDocument } from '../../../../shared/document-blocks'

export function pageFrontmatter(content: string): Record<string, unknown> {
  try { return readDocumentSource(content).frontmatter } catch { /* silent-catch: Incomplete frontmatter while typing uses default presentation, without changing source. */ return {} }
}

/** M5/L4: only the first top-level H1 is eligible. Strip heading delimiters and
 * trim both ends, then compare exactly; no case folding, inline-markup removal
 * or fuzzy matching. Return the original block so offsets, anchors and writes
 * always refer to the untouched source (including BOM/CRLF). */
export function duplicatePageHeading(parsed: ParsedDocument, title: string | undefined) {
  if (title === undefined) return undefined
  for (const block of parsed.blocks) {
    if (block.parentId || block.type !== 'heading') continue
    const heading = markdownTree(block.raw).children[0]
    if (heading?.type !== 'heading' || heading.depth !== 1) continue
    const text = block.raw.replace(/^ {0,3}#[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '')
      .replace(/\r?\n {0,3}=+[ \t]*$/, '').trim()
    return text === title.trim() ? block : undefined
  }
  return undefined
}
