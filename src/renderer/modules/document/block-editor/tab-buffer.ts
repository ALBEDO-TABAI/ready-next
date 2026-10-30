import { changedSpan } from './text-edit'
import { useDocTabs } from '../../../stores/useDocTabs'
import {
  DocumentHistory, createRangeEdit, type BlockEdit, type DocumentSelection, type HistoryKind, type HistoryResult,
} from '../../../../shared/document-blocks'

/** The tab owns text; this session owns its revision and unified history, across view mounts. */
export class TabBuffer {
  history: DocumentHistory
  readonly flushers = new Set<() => void>()
  constructor(readonly tabId: string, content: string) { this.history = new DocumentHistory(content) }
  get snapshot() { return this.history.snapshot }
  flush() { for (const flush of this.flushers) flush() }
  private publish(result: HistoryResult) {
    if (!result.ok) {
      if (result.code === 'empty_history') return null
      throw new Error(result.message)
    }
    useDocTabs.getState().updateTabContent(this.tabId, result.buffer.content)
    return result.selection
  }
  apply(edit: BlockEdit, kind: HistoryKind = 'edit', group?: string) {
    this.assertCurrent()
    return this.publish(this.history.apply(edit, { kind, group }))
  }
  assertCurrent() {
    const tab = useDocTabs.getState().tabs.find(item => item.id === this.tabId)
    if (!tab || tab.content !== this.snapshot.content) throw new Error('历史与当前缓冲版本不一致，内容未改变')
  }
  replace(content: string, kind: HistoryKind = 'edit', group?: string, selection?: DocumentSelection) {
    const before = this.snapshot
    if (before.content === content) return
    const after = selection ?? { anchor: content.length, focus: content.length }
    const change = changedSpan(before.content, content)
    this.apply(createRangeEdit(before, [{ ...change, expectedText: before.content.slice(change.start, change.end) }],
      { anchor: change.start, focus: change.end }, after), kind, group)
  }
  travel(direction: 'undo' | 'redo') {
    this.flush(); this.assertCurrent()
    return this.publish(this.history[direction](this.snapshot.version))
  }
  observe(content: string, dirty: boolean) {
    const before = this.snapshot
    if (before.content === content) return
    // Initial hydration is a baseline; subsequent changes, including external
    // writes and disk refreshes, are part of the same revision stream.
    if (!dirty && !before.content && !this.history.entries.length) { this.history = new DocumentHistory(content, before.version + 1); return }
    const result = this.history.applyExternal({ type: 'replaceRanges', expectedVersion: before.version,
      ranges: [{ start: 0, end: before.content.length, expectedText: before.content, replacement: content }] }, { anchor: 0, focus: 0 })
    if (!result.ok) throw new Error(result.message)
  }
}
const sessions = new Map<string, TabBuffer>()
export function getTabBuffer(tabId: string): TabBuffer {
  let session = sessions.get(tabId)
  if (!session) {
    const tab = useDocTabs.getState().tabs.find(item => item.id === tabId && item.kind !== 'library')
    if (!tab) throw new Error('文档标签已关闭')
    session = new TabBuffer(tabId, tab.content); sessions.set(tabId, session)
  }
  return session
}
useDocTabs.subscribe(state => {
  for (const [id, session] of sessions) {
    const tab = state.tabs.find(item => item.id === id && item.kind !== 'library')
    if (!tab) sessions.delete(id)
    else session.observe(tab.content, tab.isDirty)
  }
})
