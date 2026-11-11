import { readDocumentSource } from '../../../../shared/document-operations'
import { markdownTree } from '../../../../shared/document-blocks/markdown'
import type { ParsedDocument } from '../../../../shared/document-blocks'
import type { DocTab } from '../../../stores/useDocTabs'
import { isInLibrary } from './library-membership'

export function pageFrontmatter(content: string): Record<string, unknown> {
  try { return readDocumentSource(content).frontmatter } catch { /* silent-catch: Incomplete frontmatter while typing uses default presentation, without changing source. */ return {} }
}

/**
 * The title this tab's page header shows (M5: frontmatter `title`, else the file name), or undefined when the
 * tab has no page header: outside the library, not Markdown, or not yet bound to its object. Whether a
 * heading repeats the title follows the header, never the navigator's 页面 | 文件 switch (L4: once).
 */
export function pageHeaderTitle(tab: Pick<DocTab, 'path' | 'title' | 'content' | 'objectId' | 'objectBinding'>, vaultRoot: string | null): string | undefined {
  if (!isInLibrary(tab.path, vaultRoot) || !/\.md$/i.test(tab.path!) || !tab.objectId || tab.objectBinding?.status !== 'resolved') return undefined
  const title = pageFrontmatter(tab.content).title
  return typeof title === 'string' ? title : tab.title.replace(/\.md$/i, '')
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
