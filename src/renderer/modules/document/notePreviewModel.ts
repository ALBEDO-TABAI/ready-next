import { BoundedLruCache } from '../../../shared/bounded-lru'
import { recordDocumentPerformanceCounter } from '../../../shared/document-performance-diagnostics'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'
import type { PluggableList, Plugin } from 'unified'
import { buildStructuredNotePreview } from '../../components/document/note-preview-parser'
import { buildPreviewBlockRenderKeys, buildPreviewBlockSourceLines } from './notePreviewBlockIdentity'

function createRemarkPlugins(): PluggableList {
  const parsedBlocks = new Map<string, Root>()
  const reuseParsedMarkdown: Plugin<[], Root> = function () {
    const parse = this.parser!
    this.parser = (source, file) => {
      const cached = parsedBlocks.get(source)
      if (cached) return cached
      recordDocumentPerformanceCounter('markdownParses')
      const tree = parse(source, file) as Root
      parsedBlocks.set(source, tree)
      return tree
    }
  }
  // Only the parse tree is reused. react-markdown still builds fresh HTML nodes
  // and runs its URL/HTML safety rules with the current component callbacks.
  return [remarkGfm, reuseParsedMarkdown]
}

function buildModel(content: string, notePath?: string | null) {
  const preview = buildStructuredNotePreview(content, notePath)
  return {
    content,
    preview,
    blockRenderKeys: buildPreviewBlockRenderKeys(content, preview.blocks),
    blockSourceLines: buildPreviewBlockSourceLines(content, preview.blocks),
    remarkPlugins: createRemarkPlugins(),
  }
}

// Keep parsed data for a few recent documents, never mounted editors or media.
// Exact source equality prevents old ranges/widgets from surviving an edit.
const recentPreviews = new BoundedLruCache<string, ReturnType<typeof buildModel>>(4)
const MAX_CACHED_SOURCE_CHARS = 1_000_000

export function resolveNotePreviewModel(content: string, notePath?: string | null) {
  const key = notePath || ''
  const cached = recentPreviews.get(key)
  if (cached?.content === content) return cached
  const next = buildModel(content, notePath)
  if (content.length <= MAX_CACHED_SOURCE_CHARS) recentPreviews.set(key, next)
  else recentPreviews.delete(key)
  return next
}
