import type { Nodes } from 'mdast'
import { markdownTree } from '../../../shared/document-blocks/markdown'
import { assertBoundary } from '../../../shared/document-blocks/positions'
import type { CodexCurrentDocumentAnchor, LibraryResourceSelection } from '../../../shared/ipc-contracts/agent-runtime'
import { toReadyUri } from '../../../shared/ready-ref'
import { digestCodexDocumentValue } from './codexCurrentDocumentAnchor'
import type { ChatAttachment } from './types'

type DocumentSelectionTab = { id: string; objectId?: string; draftId?: string; content: string; isDirty: boolean; path: string | null }
export async function buildLibraryDocumentSelection(attachment: ChatAttachment, tab: DocumentSelectionTab | undefined, root: string, anchor?: CodexCurrentDocumentAnchor, exactRange?: { start: number; end: number }): Promise<LibraryResourceSelection> {
  if (!tab || !tab.objectId && !tab.draftId) throw new Error('library_selection_identity_unavailable')
  if (tab.isDirty && (!tab.draftId || !anchor || anchor.tabId !== tab.id)) throw new Error('library_buffer_identity_unavailable')
  const quoted = attachment.source === 'document-quote' ? attachment.selection : tab.content
  if (quoted === undefined) throw new Error('library_selection_unavailable')
  const lines = tab.content.split(/(?<=\n)/)
  const lower = attachment.lineStart ? lines.slice(0, attachment.lineStart - 1).join('').length : 0
  const upper = attachment.lineEnd ? lines.slice(0, attachment.lineEnd).join('').length : tab.content.length
  const start = exactRange?.start ?? tab.content.indexOf(quoted, lower)
  const end = exactRange?.end ?? start + quoted.length
  assertBoundary(tab.content, start); assertBoundary(tab.content, end)
  const next = exactRange ? -1 : tab.content.indexOf(quoted, start + 1)
  if (end < start || tab.content.slice(start, end) !== quoted
    || !exactRange && (start < lower || end > upper || next >= 0 && next < upper)) throw new Error('library_selection_ambiguous')
  return {
    kind: 'document_selection', id: attachment.id, name: attachment.name,
    libraryId: await digestCodexDocumentValue(root), version: await digestCodexDocumentValue(tab.content),
    target: tab.objectId && !tab.isDirty ? { kind: 'object', uri: toReadyUri({ kind: tab.path?.toLowerCase().endsWith('.md') ? 'page' : 'file', id: tab.objectId }) } : { kind: 'draft', draftId: tab.draftId! },
    range: { start, end }, summary: { characters: quoted.length, digest: await digestCodexDocumentValue(quoted) }, access: 'text',
    ...(tab.isDirty ? { buffer: anchor } : {}),
  }
}

/** Map the selected DOM endpoints, not a repeated word search, to Markdown positions. */
export function librarySelectionRangeFromDOM(content: string, range: Range): { start: number; end: number } {
  const tree = markdownTree(content)
  function endpoint(container: Node, offset: number, end: boolean): number {
    const element = container.nodeType === 1 ? container as Element : container.parentElement
    const block = element?.closest<HTMLElement>('[data-ready-block-source-line]')
    if (!block) throw new Error('library_selection_ambiguous')
    const line = Number(block.dataset.readyBlockSourceLine)
    const surface = element?.closest('[contenteditable="true"], p, h1, h2, h3, h4, h5, h6, pre') ?? block
    if (!block.contains(surface)) throw new Error('library_selection_ambiguous')
    const prefix = range.cloneRange(); prefix.selectNodeContents(surface); prefix.setEnd(container, offset)
    const at = prefix.toString().length, rendered = surface.textContent || ''
    const candidates: number[] = []
    function visit(node: Nodes) {
      if (node.position?.start.line === line) {
        const spans: Array<{ text: string; start: number }> = []
        let supported = true
        function flatten(part: Nodes) {
          if ('children' in part) { part.children.forEach(flatten); return }
          const start = part.position?.start.offset, stop = part.position?.end.offset
          if (start === undefined || stop === undefined || part.type !== 'text' && part.type !== 'inlineCode') { supported = false; return }
          const raw = content.slice(start, stop)
          const inner = part.type === 'inlineCode' ? raw.indexOf(part.value) : 0
          if (inner < 0 || raw.slice(inner, inner + part.value.length) !== part.value || part.type === 'text' && raw !== part.value) { supported = false; return }
          spans.push({ text: part.value, start: start + inner })
        }
        flatten(node)
        if (supported && spans.map(span => span.text).join('') === rendered) {
          let cursor = 0
          for (const span of spans) {
            const stop = cursor + span.text.length
            if (end ? at > cursor && at <= stop : at >= cursor && at < stop) candidates.push(span.start + at - cursor)
            cursor = stop
          }
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
    if (new Set(candidates).size !== 1) throw new Error('library_selection_ambiguous')
    return candidates[0]
  }
  const start = endpoint(range.startContainer, range.startOffset, false), end = endpoint(range.endContainer, range.endOffset, true)
  if (end <= start) throw new Error('library_selection_ambiguous')
  return { start, end }
}
