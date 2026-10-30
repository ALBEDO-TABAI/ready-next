import type { BlockEdit, DocumentBuffer, DocumentSelection, HistoryKind } from '../../../../shared/document-blocks'

/** One revision stream and one history per body. Async owners publish failures
 * through error/subscribe; apply always validates before changing the snapshot. */
export interface EditorBuffer {
  readonly owner: { kind: 'document'; tabId: string } | { kind: 'canvas'; nodeId: string }
  readonly snapshot: DocumentBuffer
  readonly error: string
  readonly flushers: Set<() => void>
  subscribe(listener: () => void): () => void
  apply(edit: BlockEdit, kind?: HistoryKind, group?: string): DocumentSelection | null
  travel(direction: 'undo' | 'redo'): DocumentSelection | null
  replace(content: string, kind?: HistoryKind, group?: string, selection?: DocumentSelection): void
  observe(content: string, dirty: boolean): void
  flush(): void
}
