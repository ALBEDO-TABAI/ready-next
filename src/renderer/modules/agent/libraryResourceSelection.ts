import type { Nodes } from 'mdast'
import { markdownTree } from '../../../shared/document-blocks/markdown'
import { assertBoundary } from '../../../shared/document-blocks/positions'
import { libraryResourceSelectionSchema, type CodexCurrentDocumentAnchor, type LibraryResourceSelection } from '../../../shared/ipc-contracts/agent-runtime'
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

export type LibrarySelectionObject = { title: string } & ({ objectId: string; path?: never } | { path: string; objectId?: never })
type LibraryPageSelection = Extract<LibraryResourceSelection, { kind: 'document_selection' }> & { target: { kind: 'object'; uri: string } }
type SelectionItem = { id: string; name: string; target: { objectId: string } | { path: string } }
export type LibrarySelectionRequest =
  | (SelectionItem & { kind: 'board'; nodeIds: string[] })
  | { kind: 'book'; id: string; name: string; bookId: string; location: import('../library/reader/location').BookLocation }
  | (SelectionItem & { kind: 'database'; rows: SelectionItem[] })

function selectionItem(object: LibrarySelectionObject, name = object.title): SelectionItem {
  return { id: crypto.randomUUID(), name: [...name].slice(0, 300).join(''),
    target: object.objectId !== undefined ? { objectId: object.objectId } : { path: object.path } }
}
async function prepareSelection(request: LibrarySelectionRequest): Promise<LibraryResourceSelection[]> {
  try {
    const result = await window.electronAPI.library.prepareAgentSelection(request)
    if (!result.success) throw new Error(result.error)
    return result.data.map(resource => libraryResourceSelectionSchema.parse(resource))
  } catch (error) {
    throw new Error('无法引用所选资料，请确认资料已保存、位置有效且仍在当前资料库中，然后重新选择。', { cause: error })
  }
}

export async function buildLibraryBoardSelection(board: LibrarySelectionObject, nodeIds: readonly string[]): Promise<Extract<LibraryResourceSelection, { kind: 'board_selection' }>> {
  const [resource] = await prepareSelection({ ...selectionItem(board, `${board.title} · ${nodeIds.length} 张卡`), kind: 'board', nodeIds: [...nodeIds] })
  if (resource?.kind !== 'board_selection') throw new Error('画板引用返回异常，请重新选择。')
  return resource
}

/** location uses the reader's non-whitespace UTF-16 offsets; Main converts to chapter source offsets. */
export async function buildLibraryBookLocation(bookId: string, location: import('../library/reader/location').BookLocation, title: string, quote?: string): Promise<Extract<LibraryResourceSelection, { kind: 'book_location' }>> {
  const name = `《${title}》第 ${location.chapter + 1} 章${quote ? ` · ${[...quote].slice(0, 12).join('')}` : ''}`
  const [resource] = await prepareSelection({ kind: 'book', id: crypto.randomUUID(), name: [...name].slice(0, 300).join(''), bookId, location: { ...location } })
  if (resource?.kind !== 'book_location') throw new Error('书籍引用返回异常，请重新选择。')
  return resource
}

export async function buildLibraryDatabaseRows(database: LibrarySelectionObject, rows: readonly LibrarySelectionObject[]): Promise<LibraryPageSelection[]> {
  const resources = await prepareSelection({ ...selectionItem(database, `${database.title} · ${rows.length} 行`), kind: 'database', rows: rows.map(row => selectionItem(row)) })
  return resources.map(resource => {
    if (resource.kind !== 'document_selection' || resource.target.kind !== 'object') throw new Error('数据库引用返回异常，请重新选择。')
    return { ...resource, target: resource.target }
  })
}
