import { createRangeEdit, type BlockEdit, type DocumentBuffer, type DocumentSelection } from './commands'
import { DocumentBlockError } from './positions'
import { replaceRanges, type ReplaceRangesOperation } from './ranges'

export type HistoryKind = 'typing' | 'composition' | 'drag' | 'split' | 'paste' | 'edit' | 'external'
export interface HistoryEntry {
  kind: HistoryKind; group?: string; basedOnVersion: number
  forward: ReplaceRangesOperation[]; inverse: ReplaceRangesOperation[]
  selectionBefore: DocumentSelection; selectionAfter: DocumentSelection
}
export type HistoryResult = { ok: true; buffer: DocumentBuffer; selection: DocumentSelection }
  | { ok: false; code: 'version_conflict' | 'empty_history'; message: string }

/** Single owner of one document buffer, including external edits. Versions never go backwards. */
export class DocumentHistory {
  private buffer: DocumentBuffer
  private selection: DocumentSelection
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  constructor(content: string, version = 0, selection: DocumentSelection = { anchor: 0, focus: 0 }) {
    createRangeEdit({ content, version }, [], selection)
    this.buffer = { content, version }; this.selection = { ...selection }
  }
  get snapshot(): DocumentBuffer { return { ...this.buffer } }
  get entries(): readonly HistoryEntry[] { return structuredClone(this.past) }
  private result(): HistoryResult { return { ok: true, buffer: this.snapshot, selection: { ...this.selection } } }
  private conflict(): HistoryResult { return { ok: false, code: 'version_conflict', message: '历史与当前缓冲版本不一致，内容未改变' } }

  /** A group identifies one uninterrupted typing session or one compositionstart/compositionend cycle. */
  apply(edit: BlockEdit, metadata: { kind: HistoryKind; group?: string }): HistoryResult {
    if (edit.operation.expectedVersion !== this.buffer.version) return this.conflict()
    const verified = createRangeEdit(this.buffer, edit.operation.ranges, edit.selectionBefore, edit.selectionAfter)
    const content = replaceRanges(this.buffer.content, verified.operation, this.buffer.version)
    if (content === this.buffer.content) return this.result()
    const previous = this.past[this.past.length - 1]
    const merge = previous && metadata.group !== undefined && previous.group === metadata.group && previous.kind === metadata.kind
      && this.future.length === 0 && (metadata.kind === 'composition' || (metadata.kind === 'typing'
        && previous.selectionAfter.anchor === verified.selectionBefore.anchor && previous.selectionAfter.focus === verified.selectionBefore.focus))
    if (merge) {
      previous.forward.push(verified.operation); previous.inverse.unshift(verified.inverse)
      previous.selectionAfter = verified.selectionAfter
    } else {
      this.past.push({ ...metadata, basedOnVersion: this.buffer.version, forward: [verified.operation], inverse: [verified.inverse],
        selectionBefore: verified.selectionBefore, selectionAfter: verified.selectionAfter })
    }
    this.future = []; this.buffer = { content, version: this.buffer.version + 1 }; this.selection = verified.selectionAfter
    return this.result()
  }

  applyExternal(operation: ReplaceRangesOperation, selectionAfter: DocumentSelection): HistoryResult {
    if (operation.expectedVersion !== this.buffer.version) return this.conflict()
    return this.apply(createRangeEdit(this.buffer, operation.ranges, this.selection, selectionAfter), { kind: 'external' })
  }

  undo(expectedVersion: number): HistoryResult { return this.travel(expectedVersion, 'undo') }
  redo(expectedVersion: number): HistoryResult { return this.travel(expectedVersion, 'redo') }
  private travel(expectedVersion: number, direction: 'undo' | 'redo'): HistoryResult {
    if (expectedVersion !== this.buffer.version) return this.conflict()
    const from = direction === 'undo' ? this.past : this.future
    const to = direction === 'undo' ? this.future : this.past
    const entry = from[from.length - 1]
    if (!entry) return { ok: false, code: 'empty_history', message: '没有可恢复的历史记录' }
    let content = this.buffer.content
    try {
      for (const operation of direction === 'undo' ? entry.inverse : entry.forward) {
        content = replaceRanges(content, { ...operation, expectedVersion }, expectedVersion)
      }
    } catch (error) {
      if (error instanceof DocumentBlockError) return this.conflict()
      throw error
    }
    from.pop(); to.push(entry)
    this.buffer = { content, version: expectedVersion + 1 }
    this.selection = direction === 'undo' ? entry.selectionBefore : entry.selectionAfter
    return this.result()
  }
}
