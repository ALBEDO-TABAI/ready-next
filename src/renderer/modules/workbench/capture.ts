import { ReadyRefSchema, readReadyRefTransfers, toReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import type { FastCardItem, FastCardCanvasTarget, FastCardTransferReceipt } from '../../../shared/fastcard'
import { setFrontmatterFields } from '../../../shared/document-operations'
import { createRangeEdit } from '../../../shared/document-blocks'
import { useFastCard } from '../../stores/useFastCard'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import { getTabBuffer } from '../document/block-editor/tab-buffer'
import type { EditorBuffer } from '../document/block-editor/editor-buffer'
import { inlineMarkdown, plainModel, newline } from '../document/block-editor/editing'
import { drafts, requestDraftSave } from '../document/drafts/runtime'

export interface CaptureSelection { ref: ReadyRef; title: string; text: string; pageUrl?: string }
/** Text a capture put into a page, so its toast can take exactly that text out again. */
export interface InsertedText { start: number; text: string }

/** All readers and assistant menus use the same persisted FastCard entry. Keep the item for explicit retries. */
export function captureItem(selection: CaptureSelection): FastCardItem {
  return { id: crypto.randomUUID(), kind: 'text', createdAt: Date.now(), title: selection.title, text: selection.text,
    source: { ref: ReadyRefSchema.parse(selection.ref), pageTitle: selection.title, ...(selection.pageUrl ? { pageUrl: selection.pageUrl } : {}) } }
}
/** The shelf stays as it was: the person is reading, and the capture's toast offers 打开. */
export async function captureToFastCard(item: FastCardItem): Promise<FastCardItem> {
  const store = useFastCard.getState()
  if (!await store.addItem(item, { open: false })) throw new Error(useFastCard.getState().syncState.kind === 'error' ? '收下失败，请查看暂存栏' : '未收到收下回执')
  return useFastCard.getState().items.find(value => value.id === item.id)!
}
/** Through FastCard's own transfer (receipt, retry, undo). The receipt goes to the caller's toast, not the shelf. */
export async function captureToCanvas(item: FastCardItem, target?: FastCardCanvasTarget): Promise<FastCardTransferReceipt> {
  await captureToFastCard(item)
  if (!await useFastCard.getState().saveToCanvas([item.id], target)) throw new Error('尚未存入画板，内容已保留在暂存栏')
  const receipt = useFastCard.getState().transferReceipt
  if (!receipt) throw new Error('未收到画板保存回执')
  useFastCard.getState().dismissReceipt()
  return receipt
}
export function referenceMarkdown(ref: ReadyRef, title: string): string {
  return inlineMarkdown(plainModel(), [{ text: title.replace(/[\r\n]/g, ' ') || '引用', marks: { reference: { kind: 'ready', ref } } }])
}

/** The buffer owns insertion and undo; the async image copy must not overwrite an intervening edit. */
export async function insertCapturedReference(buffer: EditorBuffer, selection: Omit<CaptureSelection, 'text'> & { text?: string }, at = buffer.snapshot.content.length): Promise<InsertedText> {
  buffer.flush()
  const snapshot = buffer.snapshot, ref = ReadyRefSchema.parse(selection.ref)
  let markdown = referenceMarkdown(ref, selection.title)
  if (ref.kind === 'fastcard') {
    const result = await window.electronAPI.browser.listFastCardItems()
    if (!result.success || !result.data) throw new Error(result.error || '读取收集失败')
    const item = result.data.find(item => item.id === ref.id)
    if (!item) throw new Error('收集已不存在')
    if (item.kind === 'image') {
      const tab = buffer.owner.kind === 'document' ? useDocTabs.getState().tabs.find(tab => buffer.owner.kind === 'document' && tab.id === buffer.owner.tabId) : undefined
      if (!tab?.objectId) throw new Error('请先把页面保存到资料库，再插入图片')
      const copied = await window.electronAPI.fastCard.documentImage({ itemId: item.id, pageId: tab.objectId })
      if (!copied.success || !copied.data) throw new Error(copied.error || '图片复制失败')
      markdown = `![${(item.alt || item.title || '图片').replace(/[[\]\r\n]/g, ' ')}](<${copied.data}>)\n\n${markdown}`
    }
  }
  const eol = newline(snapshot.content)
  if (selection.text) markdown = `${selection.text.split(/\r?\n/).map(line => `> ${line}`).join(eol)}${eol}${eol}${markdown}`
  const text = `${at && !snapshot.content.slice(0, at).endsWith('\n') ? eol + eol : ''}${markdown}${eol}${eol}`
  buffer.apply(createRangeEdit(snapshot, [{ start: at, end: at, expectedText: '', replacement: text }], { anchor: at, focus: at }, { anchor: at, focus: at + text.length }))
  return { start: at, text }
}
/** Undo of a capture into a page: only the inserted text, found where it was put or, after edits elsewhere, once. */
export function removeInsertedText(buffer: EditorBuffer, inserted: InsertedText): void {
  buffer.flush()
  const snapshot = buffer.snapshot, { content } = snapshot, length = inserted.text.length
  let start = content.slice(inserted.start, inserted.start + length) === inserted.text ? inserted.start : content.indexOf(inserted.text)
  if (start >= 0 && start !== inserted.start && content.indexOf(inserted.text, start + 1) >= 0) start = -1
  if (start < 0) throw new Error('引用的内容已经改动，没有撤销')
  buffer.apply(createRangeEdit(snapshot, [{ start, end: start + length, expectedText: inserted.text, replacement: '' }], { anchor: start, focus: start + length }, { anchor: start, focus: start }))
}

const editable = (tab: DocTab) => tab.kind !== 'library' && (!tab.path || /\.(md|markdown)$/i.test(tab.path))
/** 当前文档: the focused page; from 书房, a PDF or another mode, the page used most recently. */
export function currentDocumentTab(tabId?: string): DocTab {
  const state = useDocTabs.getState()
  const focused = state.tabs.find(tab => tab.id === (tabId || state.focusedPaneTabId || state.activeTabId))
  const tab = focused && editable(focused) ? focused : tabId ? undefined
    : state.tabs.filter(editable).sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0))[0]
  if (!tab) throw new Error('请先打开一个可编辑页面')
  return tab
}
/** A page tab that was never shown holds no text yet: read it from disk first, so the capture never replaces the page. */
export async function captureToDocument(selection: CaptureSelection, tabId?: string): Promise<InsertedText & { tabId: string; title: string }> {
  const tab = currentDocumentTab(tabId)
  if (tab.path && !tab.isDirty) {
    const read = await window.electronAPI.document.readFile(tab.path)
    const content = read.success ? read.content ?? (read.data && 'content' in read.data ? read.data.content : undefined) : undefined
    if (typeof content !== 'string') throw new Error(read.error || '无法读取页面')
    useDocTabs.getState().hydrateTabContentFromDisk(tab.id, content)
  }
  const inserted = await insertCapturedReference(getTabBuffer(tab.id), selection)
  return { ...inserted, tabId: tab.id, title: tab.title.replace(/\.(md|markdown)$/i, '') }
}

/** No alternate page writer: recoverable draft first, then the existing Save To picker. */
export async function captureAnswerDraft(selection: CaptureSelection): Promise<string> {
  if (selection.ref.kind !== 'conversation') throw new Error('回答必须有对话出处')
  const content = setFrontmatterFields(selection.text, { set: { ready_source: toReadyUri(selection.ref) } })
  const state = useDocTabs.getState(), tabId = state.createBackgroundTab({ title: selection.title, content })
  const tab = useDocTabs.getState().tabs.find(tab => tab.id === tabId)!
  if (tab.kind === 'library') throw new Error('不能把回答保存到书房标签')
  drafts.changed({ ...tab, isDirty: true })
  await drafts.flush(tabId)
  return tabId
}
/** The answer can be saved from any mode, so its Save To picker opens as a dialog where the person is. */
export async function captureAnswerAsPage(selection: CaptureSelection): Promise<{ tabId: string; path: string | null }> {
  const tabId = await captureAnswerDraft(selection)
  return { tabId, path: await requestDraftSave(tabId, undefined, 'dialog') }
}

export async function dropDocumentReference(data: Pick<DataTransfer, 'getData'>, buffer: EditorBuffer, at = buffer.snapshot.content.length): Promise<boolean> {
  const dropped = readReadyRefTransfers(data)
  if (!dropped.length) return false
  for (const item of dropped) {
    const before = buffer.snapshot.content.length
    await insertCapturedReference(buffer, item, at)
    at += buffer.snapshot.content.length - before
  }
  return true
}
