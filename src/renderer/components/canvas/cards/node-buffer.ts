import {
  DocumentHistory, createRangeEdit, type BlockEdit, type DocumentSelection, type HistoryKind, type HistoryResult,
} from '../../../../shared/document-blocks'
import type { CanvasNode, CanvasOperation } from '../../../../shared/ready-canvas'
import type { EditorBuffer } from '../../../modules/document/block-editor/editor-buffer'
import { changedSpan } from '../../../modules/document/block-editor/text-edit'
import { cardTextEdit } from './text-adapter'

type TextNode = Extract<CanvasNode, { type: 'text' }>
type Write = { operation: CanvasOperation; content: string; generation: number }

/** Local editing is synchronous; only the head of the queue may submit to the
 * canvas handle. Each write carries the hash of its exact predecessor. A rejected
 * queue returns to the confirmed body via this same history, retaining the draft
 * as an undoable entry, and never sends its dependent writes. */
export class NodeBuffer implements EditorBuffer {
  readonly owner: { kind: 'canvas'; nodeId: string }
  readonly history: DocumentHistory
  readonly flushers = new Set<() => void>()
  error = ''
  private listeners = new Set<() => void>()
  private queue: Write[] = []
  private pending: Promise<void> | null = null
  private generation = 0
  private confirmed: string
  private observed: string
  private acknowledgements: string[] = []
  constructor(private node: TextNode, private commit: (operations: CanvasOperation[]) => Promise<boolean>) {
    this.owner = { kind: 'canvas', nodeId: node.id }
    this.history = new DocumentHistory(node.text)
    this.confirmed = this.observed = node.text
  }
  get snapshot() { return this.history.snapshot }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify() { for (const listener of this.listeners) listener() }
  flush() { for (const flush of this.flushers) flush() }
  async finish() {
    this.flush()
    while (this.pending) await this.pending
    if (this.error) throw new Error(this.error)
  }
  private selection(result: HistoryResult) {
    if (result.ok) return result.selection
    if (result.code === 'empty_history') return null
    throw new Error(result.message)
  }
  private enqueue(operation: CanvasOperation) {
    this.queue.push({ operation, content: this.snapshot.content, generation: this.generation })
    this.error = ''; this.notify()
    if (!this.pending) this.pending = this.drain()
  }
  private async drain() {
    await Promise.resolve() // Publish pending before even a synchronous host rejection.
    try {
      while (this.queue.length) {
        const write = this.queue[0]
        try {
          if (!await this.commit([write.operation])) throw new Error('文字卡版本冲突或写入未获接受；未覆盖画板正文，可撤销取回未提交文字')
          if (write.generation !== this.generation) continue
          this.confirmed = write.content
          if (this.observed !== write.content) this.acknowledgements.push(write.content)
          this.queue.shift()
        } catch (cause) {
          console.warn('[node-buffer] commit text card failed:', cause instanceof Error ? cause.message : String(cause))
          if (write.generation !== this.generation) continue
          this.queue = []; this.generation++
          this.error = cause instanceof Error ? cause.message : String(cause)
          this.acceptExternal(this.confirmed)
          this.notify()
        }
      }
    } finally { this.pending = null }
  }

  apply(edit: BlockEdit, kind: HistoryKind = 'edit', group?: string) {
    const before = this.snapshot
    const { operation } = cardTextEdit({ ...this.node, text: before.content }, before.version, edit)
    const selection = this.selection(this.history.apply(edit, { kind, group }))
    if (before.content !== this.snapshot.content) this.enqueue(operation)
    return selection
  }
  replace(content: string, kind: HistoryKind = 'edit', group?: string, selection?: DocumentSelection) {
    const before = this.snapshot
    if (before.content === content) return
    const change = changedSpan(before.content, content)
    this.apply(createRangeEdit(before, [{ ...change, expectedText: before.content.slice(change.start, change.end) }],
      { anchor: change.start, focus: change.end }, selection ?? { anchor: content.length, focus: content.length }), kind, group)
  }
  travel(direction: 'undo' | 'redo') {
    this.flush()
    const before = this.snapshot, result = this.history[direction](before.version), selection = this.selection(result)
    if (result.ok && before.content !== result.buffer.content) {
      const change = changedSpan(before.content, result.buffer.content)
      const edit = createRangeEdit(before, [{ ...change, expectedText: before.content.slice(change.start, change.end) }], { anchor: change.start, focus: change.end }, result.selection)
      this.enqueue(cardTextEdit({ ...this.node, text: before.content }, before.version, edit).operation)
    }
    return selection
  }
  private acceptExternal(content: string) {
    const before = this.snapshot
    if (content === before.content) return
    this.selection(this.history.applyExternal({ type: 'replaceRanges', expectedVersion: before.version,
      ranges: [{ start: 0, end: before.content.length, expectedText: before.content, replacement: content }] }, { anchor: 0, focus: 0 }))
  }
  observe(content: string) {
    if (content === this.observed) return
    this.observed = content
    const acknowledged = this.acknowledgements.indexOf(content)
    if (acknowledged !== -1) { this.acknowledgements.splice(0, acknowledged + 1); return }
    if (this.queue[0]?.content === content) return
    this.confirmed = content; this.acknowledgements = []
    if (this.queue.length) {
      this.generation++; this.queue = []
      this.error = '文字卡版本冲突：画板正文已更新，未提交文字保留在撤销历史中'
    }
    this.acceptExternal(content)
    this.notify()
  }
}
