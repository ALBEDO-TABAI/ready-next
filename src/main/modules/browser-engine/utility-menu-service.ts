import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { BrowserBookmark, BrowserDownload, BrowserHistoryEntry } from '../database'
import type {
  BrowserUtilityMenuCurrentTab,
  BrowserUtilityMenuRequest,
} from '../../../shared/browser-utility-menu'
import { buildBrowserUtilityMenuModel, type BrowserUtilityMenuItem, type BrowserUtilityMenuState } from './utility-menu-model'
import type { BrowserAdblockState } from './data-service'

interface BrowserUtilityMenuServiceHost {
  mainWindow: BrowserWindow
  getBookmarks: () => BrowserBookmark[]
  getDownloads: () => BrowserDownload[]
  getHistory: (limit?: number) => BrowserHistoryEntry[]
  getAdblockState: () => BrowserAdblockState
  isBookmarked: (url: string) => boolean
  addBookmark: (url: string, title: string) => void
  removeBookmarkByUrl: (url: string) => void
  importBookmarksFromDialog: () => Promise<unknown>
  exportBookmarksToDialog: () => Promise<unknown>
  clearHistory: () => void
  clearDownloads: () => void
  navigateToUrl: (url: string) => Promise<void> | void
  setAdblockEnabled: (enabled: boolean) => void
  toggleAdblockDomain: (domain: string) => void
  printCurrentTab: () => void
  openExternal: (url: string) => void
  sendToRenderer: (channel: string, data: unknown) => void
}

export class BrowserUtilityMenuService {
  constructor(private readonly host: BrowserUtilityMenuServiceHost) {}

  setMainWindow(mainWindow: BrowserWindow): void {
    this.host.mainWindow = mainWindow
  }

  showMenu(request: BrowserUtilityMenuRequest): { success: boolean } {
    const state = this.resolveState(request)
    const model = buildBrowserUtilityMenuModel(request.kind, state)
    const template = model.items.map((item) => this.toMenuTemplate(item, state))
    const menu = Menu.buildFromTemplate(template)
    menu.popup({
      window: this.host.mainWindow,
      x: Math.max(8, Math.round(request.anchorRect.left)),
      y: Math.max(8, Math.round(request.anchorRect.bottom + 6)),
    })
    return { success: true }
  }

  private resolveState(request: BrowserUtilityMenuRequest): BrowserUtilityMenuState {
    const adblockState = this.host.getAdblockState()
    const currentTab = this.resolveCurrentTab(request.currentTab)
    const currentDomain = request.currentDomain || currentTab?.domain || ''
    const adblockDomainWhitelisted = request.adblockDomainWhitelisted
      ?? (currentDomain
        ? adblockState.whitelistDomains.some((domain) => currentDomain === domain || currentDomain.endsWith(`.${domain}`))
        : false)

    return {
      currentTab,
      bookmarks: this.host.getBookmarks(),
      downloads: this.host.getDownloads(),
      history: this.host.getHistory(20),
      currentDomain,
      adblockEnabled: request.adblockEnabled ?? adblockState.enabled,
      adblockDomainWhitelisted,
    }
  }

  private resolveCurrentTab(currentTab?: BrowserUtilityMenuCurrentTab | null): BrowserUtilityMenuCurrentTab | null {
    if (!currentTab?.url) return null
    return currentTab
  }

  private toMenuTemplate(item: BrowserUtilityMenuItem, state: BrowserUtilityMenuState): MenuItemConstructorOptions {
    if (item.type === 'separator') {
      return { type: 'separator' }
    }

    if (item.type === 'submenu') {
      return {
        label: item.label || '',
        enabled: item.enabled ?? true,
        submenu: (item.items || []).map((entry) => this.toMenuTemplate(entry, state)),
      }
    }

    return {
      label: item.label || '',
      enabled: item.enabled ?? true,
      click: () => {
        this.executeAction(item, state)
      },
    }
  }

  private executeAction(item: BrowserUtilityMenuItem, state: BrowserUtilityMenuState): void {
    switch (item.action) {
      case 'toggle-current-bookmark': {
        const url = String(item.payload?.url || state.currentTab?.url || '').trim()
        if (!url) return
        const title = String(item.payload?.title || state.currentTab?.title || url).trim() || url
        if (this.host.isBookmarked(url)) {
          this.host.removeBookmarkByUrl(url)
          this.host.sendToRenderer('browser:bookmarksChanged', { action: 'utility-menu-remove', url })
        } else {
          this.host.addBookmark(url, title)
          this.host.sendToRenderer('browser:bookmarksChanged', { action: 'utility-menu-add', url })
        }
        return
      }
      case 'open-bookmark': {
        const url = String(item.payload?.url || '').trim()
        if (!url) return
        void this.host.navigateToUrl(url)
        return
      }
      case 'remove-bookmark': {
        const url = String(item.payload?.url || '').trim()
        if (!url) return
        this.host.removeBookmarkByUrl(url)
        this.host.sendToRenderer('browser:bookmarksChanged', { action: 'utility-menu-remove', url })
        return
      }
      case 'import-bookmarks':
        void this.host.importBookmarksFromDialog()
        return
      case 'export-bookmarks':
        void this.host.exportBookmarksToDialog()
        return
      case 'open-download': {
        const savePath = String(item.payload?.savePath || '').trim()
        const fallbackUrl = String(item.payload?.url || '').trim()
        if (savePath) {
          shell.showItemInFolder(savePath)
          return
        }
        if (fallbackUrl) {
          this.host.openExternal(fallbackUrl)
        }
        return
      }
      case 'clear-downloads':
        this.host.clearDownloads()
        return
      case 'open-history-entry': {
        const url = String(item.payload?.url || '').trim()
        if (!url) return
        void this.host.navigateToUrl(url)
        return
      }
      case 'clear-history':
        this.host.clearHistory()
        return
      case 'toggle-adblock':
        this.host.setAdblockEnabled(!state.adblockEnabled)
        return
      case 'toggle-current-site-adblock': {
        const domain = String(item.payload?.domain || state.currentDomain || '').trim()
        if (!domain) return
        this.host.toggleAdblockDomain(domain)
        return
      }
      case 'print':
        this.host.printCurrentTab()
        return
      case 'open-external': {
        const url = String(item.payload?.url || state.currentTab?.url || '').trim()
        if (!url) return
        this.host.openExternal(url)
        return
      }
      default:
        return
    }
  }
}
