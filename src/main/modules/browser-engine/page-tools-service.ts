import type { WebContents } from 'electron'
import { browserPageCapabilitiesSchema, browserFindSchema, browserStopFindSchema, type BrowserFoundInPage, type BrowserPageCapabilities, type BrowserPageCapabilitiesChanged, type BrowserReadResult } from '../../../shared/browser-shell'
import { PAGE_CAPABILITIES_SCRIPT } from './page-capabilities-script'
import { extractRenderedArticle, READ_TAB_SCRIPT } from './read-tab'

const WORLD_ID = 1004
export type PageToolsContents = Pick<WebContents, 'getURL' | 'isDestroyed' | 'executeJavaScriptInIsolatedWorld' | 'findInPage' | 'stopFindInPage' | 'on' | 'removeListener'>
export class BrowserPageToolsService {
  private readonly pages = new Map<string, { contents: PageToolsContents; dispose(): void; epoch: number; requestId?: number; cache?: BrowserPageCapabilities; timer?: ReturnType<typeof setTimeout> }>()
  constructor(private readonly deps: {
    found(data: BrowserFoundInPage): void
    changed(data: BrowserPageCapabilitiesChanged): void
    log(error: unknown): void
  }) {}

  bind(tabId: string, contents: PageToolsContents): void {
    this.disposeTab(tabId)
    const page: { contents: PageToolsContents; dispose(): void; epoch: number; requestId?: number; cache?: BrowserPageCapabilities; timer?: ReturnType<typeof setTimeout> } = { contents, epoch: 0, dispose: () => {} }
    this.pages.set(tabId, page)
    const clear = () => {
      page.epoch++
      page.cache = undefined
      clearTimeout(page.timer)
      this.clearFind(tabId)
    }
    const schedule = () => {
      page.epoch++
      page.cache = undefined
      clearTimeout(page.timer)
      page.timer = setTimeout(() => {
        void this.capabilities(tabId).then(data => {
          if (this.pages.get(tabId) === page && page.cache === data) this.deps.changed({ tabId, ...data })
        }).catch(this.deps.log)
      }, 150)
    }
    const navigate = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) clear() }
    const inPage = (_event: unknown, _url: string, isMainFrame: boolean) => { if (isMainFrame) { clear(); schedule() } }
    const found = (_event: unknown, result: Omit<BrowserFoundInPage, 'tabId'>) => {
      if (page.requestId === result.requestId) this.deps.found({ tabId, ...result })
    }
    const destroyed = () => this.disposeTab(tabId)
    contents.on('did-start-navigation', navigate)
    contents.on('did-navigate-in-page', inPage)
    contents.on('did-finish-load', schedule)
    contents.on('found-in-page', found)
    contents.on('destroyed', destroyed)
    page.dispose = () => {
      clearTimeout(page.timer)
      contents.removeListener('did-start-navigation', navigate)
      contents.removeListener('did-navigate-in-page', inPage)
      contents.removeListener('did-finish-load', schedule)
      contents.removeListener('found-in-page', found)
      contents.removeListener('destroyed', destroyed)
    }
  }

  clearFind(tabId: string): void {
    const page = this.pages.get(tabId)
    if (!page) return
    page.requestId = undefined
    if (!page.contents.isDestroyed()) page.contents.stopFindInPage('clearSelection')
  }

  disposeTab(tabId: string): void {
    this.clearFind(tabId)
    this.pages.get(tabId)?.dispose()
    this.pages.delete(tabId)
  }

  find(input: unknown): { success: true; requestId: number } | { success: false; error: 'tab_missing' } {
    const { tabId, text, ...options } = browserFindSchema.parse(input)
    const page = this.pages.get(tabId)
    if (!page || page.contents.isDestroyed()) return { success: false, error: 'tab_missing' }
    const requestId = page.contents.findInPage(text, options)
    page.requestId = requestId
    return { success: true, requestId }
  }

  stopFind(input: unknown): { success: boolean; error?: string } {
    const { tabId, action } = browserStopFindSchema.parse(input)
    const page = this.pages.get(tabId)
    if (!page || page.contents.isDestroyed()) return { success: false, error: 'tab_missing' }
    page.requestId = undefined
    page.contents.stopFindInPage(action)
    return { success: true }
  }

  async capabilities(tabId: string): Promise<BrowserPageCapabilities> {
    const page = this.pages.get(tabId)
    if (!page || page.contents.isDestroyed()) return { url: '', readable: false, feeds: [] }
    const url = page.contents.getURL()
    if (!/^https?:\/\//i.test(url)) return { url, readable: false, feeds: [] }
    if (page.cache?.url === url) return page.cache
    const epoch = page.epoch
    const raw: unknown = await page.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: PAGE_CAPABILITIES_SCRIPT }])
    const data = browserPageCapabilitiesSchema.parse(raw)
    if (this.pages.get(tabId) !== page || epoch !== page.epoch || page.contents.isDestroyed() || page.contents.getURL() !== url || data.url !== url) return { url, readable: false, feeds: [] }
    page.cache = data
    return data
  }

  async read(tabId: string): Promise<BrowserReadResult> {
    const page = this.pages.get(tabId)
    if (!page || page.contents.isDestroyed()) return { success: false, error: 'tab_missing' }
    const url = page.contents.getURL(), epoch = page.epoch
    if (!/^https?:\/\//i.test(url)) return { success: false, error: 'unsupported_protocol' }
    try {
      const raw: unknown = await page.contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: READ_TAB_SCRIPT }])
      const result = await extractRenderedArticle(tabId, url, raw)
      if (this.pages.get(tabId) !== page || epoch !== page.epoch || page.contents.isDestroyed() || page.contents.getURL() !== url) return { success: false, error: 'page_changed' }
      return result
    } catch (error) {
      this.deps.log(error)
      return { success: false, error: 'extraction_failed' }
    }
  }
}
