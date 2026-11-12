import type { PdfSelection } from '../../../shared/pdf-source-anchor'
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { RSSReadExcerptSchema } from '../../../shared/rss-excerpt'
import type { RSSReadExcerptInput } from '../../../shared/rss-excerpt'
import type { LibraryHighlightState } from '../../../shared/library'
import type { RSSContentStore } from '../database/rss-content-store'
import type { BrowserController } from '../browser-engine/browser-controller'
import { rssSource, webReadingSource, webSource } from './source-adapters'
import { RSSReadingRangeSchema, type RSSReadingRange } from '../../../shared/rss-reading'
import type { BrowserReadResult } from '../../../shared/browser-shell'
import type { SourceDocumentService } from './source-documents'

export type SourceReply = { success: true; data: LibraryHighlightState } | { success: false; error: string }
export interface SourceAnnotationsAPI {
  pdf(input: PdfSelection): Promise<SourceReply>
  rss(input: RSSReadExcerptInput): Promise<SourceReply>
  web(input: { tabId: string }): Promise<SourceReply>
  /** A selection in the browser's reading view: the article as the reader showed it (its revision) and the range. */
  webReading(input: { tabId: string; revision: string; range: RSSReadingRange }): Promise<SourceReply>
}

const READ_REFUSAL: Record<Exclude<BrowserReadResult, { success: true }>['error'], string> = {
  tab_missing: '网页已关闭，请重新选择', page_changed: '网页已切换，请重新选择', unsupported_protocol: '这个网页不能划线',
  not_readable: '这个网页读不出正文', too_large: '这个网页的正文太长', extraction_failed: '这个网页读不出正文',
}

// Runs only in the selected BrowserView. A DOM Range gives exact text and context without a network fetch.
export const WEB_SOURCE_SELECTION_SCRIPT = `(() => {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) throw new Error('请先在网页中选中文字');
  const range = selection.getRangeAt(0);
  if (!document.body.contains(range.startContainer) || !document.body.contains(range.endContainer)) throw new Error('选区不在网页正文中');
  const prefix = document.createRange(); prefix.selectNodeContents(document.body); prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length, exact = range.toString();
  return { url: location.href, title: document.title, text: document.body.textContent || '', start, end: start + exact.length, exact };
})()`

export function registerSourceAnnotationsIPC(ipcMain: Pick<IpcMain, 'handle'>, dependencies: {
  service(): Promise<SourceDocumentService>
  rss(): Pick<RSSContentStore, 'getArticle' | 'readExcerpt'>
  browser(): BrowserController | null
  /** The browser's reading of a tab's rendered article (the reading view's own source). */
  readTab(tabId: string): Promise<BrowserReadResult>
}) {
  const reply = async (work: () => Promise<LibraryHighlightState>): Promise<SourceReply> => {
    try { return { success: true, data: await work() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('sourceAnnotations:pdf', (_event, raw: unknown) => reply(async () => (await dependencies.service()).annotatePdf(raw)))
  ipcMain.handle('sourceAnnotations:rss', (_event, raw: unknown) => reply(async () => {
    const input = RSSReadExcerptSchema.parse(raw), store = dependencies.rss()
    store.readExcerpt(input)
    const article = store.getArticle(input.itemId)
    if (!article || article.revision !== input.expectedRevision) throw new Error('文章已变化，请重新选择')
    const service = await dependencies.service()
    return service.annotate(rssSource(article, input.range))
  }))
  ipcMain.handle('sourceAnnotations:web', (_event, raw: unknown) => reply(async () => {
    const { tabId } = z.object({ tabId: z.string().min(1) }).strict().parse(raw)
    const browser = dependencies.browser(), tab = browser?.tabs.get(tabId)
    if (!browser || !tab?.view || browser.getActiveTab()?.id !== tabId) throw new Error('请在当前网页中选择文字')
    const contents = tab.view.webContents
    const token = browser.getPhysicalTargetToken(tabId), url = contents.getURL()
    let navigated = false
    const navigation = (_event: Electron.Event, _url: string, _inPlace: boolean, main: boolean) => { if (main) navigated = true }
    contents.on('did-start-navigation', navigation)
    let selection: unknown
    try { selection = await contents.executeJavaScript(WEB_SOURCE_SELECTION_SCRIPT) }
    finally { contents.removeListener('did-start-navigation', navigation) }
    if (navigated || contents.isDestroyed() || browser.getPhysicalTargetToken(tabId) !== token || contents.getURL() !== url || browser.getActiveTab()?.id !== tabId) throw new Error('网页已切换，请重新选择')
    const hash = createHash('sha256').update(JSON.stringify(selection)).digest('hex')
    const source = webSource(selection, hash)
    if (source.source.url !== url.split(':~:text=')[0].replace(/#$/, '')) throw new Error('网页身份不一致')
    return (await dependencies.service()).annotate(source)
  }))
  ipcMain.handle('sourceAnnotations:webReading', (_event, raw: unknown) => reply(async () => {
    const { tabId, revision, range } = z.object({ tabId: z.string().min(1), revision: z.string().min(1), range: RSSReadingRangeSchema }).strict().parse(raw)
    // Read the page again rather than trust the words sent: the highlight is made from the article Main reads now.
    const read = await dependencies.readTab(tabId)
    if (!read.success) throw new Error(READ_REFUSAL[read.error])
    if (read.data.article.revision !== revision) throw new Error('网页内容已变化，请重新选择')
    return (await dependencies.service()).annotate(webReadingSource({ url: read.data.url, title: read.data.title, revision, markdown: read.data.text }, range))
  }))
}
