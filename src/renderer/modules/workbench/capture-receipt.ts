import type { FastCardCanvasTarget, FastCardItem, FastCardTransferReceipt } from '../../../shared/fastcard'
import type { LibraryHighlightState } from '../../../shared/library'
import { showToast } from '../../components/ui/toast-store'
import { useDocTabs } from '../../stores/useDocTabs'
import { useFastCard } from '../../stores/useFastCard'
import { getTabBuffer } from '../document/block-editor/tab-buffer'
import { captureSelectionToAgent } from '../agent/drop-reference'
import { requestWorkbenchModeOpen } from './mode-transition'
import { openReadyRef } from './open-ready-ref'
import { captureAnswerAsPage, captureItem, captureToCanvas, captureToDocument, captureToFastCard, removeInsertedText, type CaptureSelection } from './capture'

// What every visible 收下 entry calls (W6 §3.2): the capture, then a light toast with 撤销 and 打开 that leaves the
// person where they are. 撤销 runs a real reverse operation of the same owner (FastCard remove, the transfer's undo,
// the page buffer, the page trash); nothing is faked.

const CAPTURE_TOAST_MS = 6000
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
export function reportCaptureError(error: unknown): void {
  console.warn('[capture] capture failed:', messageOf(error))
  showToast(messageOf(error), { tone: 'bad' })
}

function announce(message: string, { undo, open }: { undo?: () => Promise<void>; open: () => unknown }) {
  showToast(message, { durationMs: CAPTURE_TOAST_MS, actions: [
    ...(undo ? [{ label: '撤销', onClick: () => { void undo().then(() => showToast('已撤销')).catch(reportCaptureError) } }] : []),
    { label: '打开', onClick: () => { void Promise.resolve().then(open).catch(reportCaptureError) } },
  ] })
}

/**
 * 划线 stays each scene's own highlight; its toast opens the source page at the new mark. Only a book's highlight has
 * a remove path (`undo`); the source pages of web pages, 资讯 and PDFs have none, so those toasts offer 打开 only.
 */
export function announceHighlight(state: LibraryHighlightState, exact: string, undo?: () => Promise<void>): void {
  const words = (text: string) => text.replace(/\s+/g, '')
  const mark = [...state.highlights].reverse().find(highlight => words(highlight.text) === words(exact))
  announce(state.warning || (state.persistence === 'saved' ? '已划线到来源页' : '已加入来源页，请保存笔记'), { undo, open: () => {
    const tabs = useDocTabs.getState()
    tabs.openTab(state.sourcePath)
    if (mark) tabs.setPendingReveal({ path: state.sourcePath, lineStart: mark.sourceLine, selection: mark.text, requestedAt: Date.now() })
    requestWorkbenchModeOpen('document')
  } })
}

async function removeCard(id: string) {
  if (!await useFastCard.getState().removeItem(id)) throw new Error(useFastCard.getState().syncState.kind === 'error' ? '撤销失败，请查看暂存栏' : '未收到撤销回执')
}

export async function receiveToFastCard(selection: CaptureSelection): Promise<FastCardItem> {
  const item = await captureToFastCard(captureItem(selection))
  announce('已存入 FastCard', { undo: () => removeCard(item.id), open: () => useFastCard.getState().reveal(item.id) })
  return item
}

/** Without a target the transfer goes where FastCard's 保存到画板 goes: the last board, the first time 《灵感》. */
export async function receiveToCanvas(selection: CaptureSelection, target?: FastCardCanvasTarget): Promise<FastCardTransferReceipt> {
  const item = captureItem(selection)
  const receipt = await captureToCanvas(item, target)
  announce(`已存到画板《${receipt.title}》`, {
    undo: async () => {
      if (!await useFastCard.getState().undoTransfer(receipt)) throw new Error('画板上的卡片已改动，没有撤销')
      await removeCard(item.id)
    },
    open: () => openReadyRef({ kind: 'canvas', id: receipt.objectId, ...(receipt.nodeIds[0] ? { node: receipt.nodeIds[0] } : {}) }),
  })
  return receipt
}

export async function receiveToDocument(selection: CaptureSelection, tabId?: string): Promise<void> {
  const inserted = await captureToDocument(selection, tabId)
  announce(`已引用到《${inserted.title}》`, {
    undo: async () => removeInsertedText(getTabBuffer(inserted.tabId), inserted),
    open: () => { useDocTabs.getState().setActiveTab(inserted.tabId); requestWorkbenchModeOpen('document') },
  })
}

/** FastCard → 插入到文档: the card as a reference, as dropping it does (an image card also brings its picture). */
export function receiveFastCardToDocument(item: Pick<FastCardItem, 'id'>, title: string): Promise<void> {
  return receiveToDocument({ ref: { kind: 'fastcard', id: item.id }, title, text: '' })
}

/** 问 AI hands the selection to the composer; the open composer is its own receipt, so there is no toast. */
export function askAboutSelection(selection: CaptureSelection): Promise<void> {
  return captureSelectionToAgent(selection)
}

/** Draft first, then the Save To dialog; a cancelled save keeps the draft. 撤销 moves the saved page to the trash. */
export async function receiveAnswerAsPage(selection: CaptureSelection): Promise<string | null> {
  const { tabId, path } = await captureAnswerAsPage(selection)
  if (!path) return null
  const [location, vault] = await Promise.all([window.electronAPI.objects.resolvePath(path), window.electronAPI.vault.get()])
  announce(`已存为页面《${path.split(/[\\/]/).pop()!.replace(/\.md$/i, '')}》`, {
    undo: async () => {
      if (vault.status !== 'ready') throw new Error('资料库不可用，没有撤销')
      const result = await window.electronAPI.documentPages.operate({ type: 'trash', objectId: location.objectId, root: vault.root, operationId: crypto.randomUUID() })
      if (!result.ok) throw new Error(result.message)
      if (useDocTabs.getState().tabs.some(tab => tab.id === tabId)) useDocTabs.getState().closeTab(tabId)
    },
    open: () => openReadyRef({ kind: 'page', id: location.objectId }),
  })
  return path
}
