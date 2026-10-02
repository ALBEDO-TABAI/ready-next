import { ipcMain } from 'electron'
import { BrowserDataService } from './data-service'
import type { BrowserDownloadUrlToDirectoryPayload } from './download-service'

interface BrowserDataIPCController {
  getAdblockState: () => unknown
  getDiagnostics: (options?: { includePerformance?: boolean }) => unknown
  setAdblockEnabled: (enabled: boolean) => unknown
  toggleAdblockDomain: (domain: string) => unknown
  importBookmarksFromDialog: () => Promise<unknown>
  exportBookmarksToDialog: () => Promise<unknown>
  showUtilityMenu: (payload: unknown) => { success: boolean }
  downloadUrlToDirectory: (payload: BrowserDownloadUrlToDirectoryPayload) => Promise<unknown>
  tabs: Map<string, { view?: { webContents: { print: () => void } } }>
}

export function setupBrowserDataIPC(
  controller: BrowserDataIPCController,
  dataService: BrowserDataService,
): void {
  ipcMain.handle('browser:getAdblockState', () => {
    return { success: true, data: controller.getAdblockState() }
  })

  ipcMain.handle('browser:getDiagnostics', (_, options?: { includePerformance?: boolean }) => {
    return { success: true, data: controller.getDiagnostics(options) }
  })

  ipcMain.handle('browser:setAdblockEnabled', (_, payload: { enabled: boolean }) => {
    try {
      return { success: true, data: controller.setAdblockEnabled(Boolean(payload.enabled)) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:toggleAdblockDomain', (_, payload: { domain: string }) => {
    try {
      return { success: true, data: controller.toggleAdblockDomain(payload.domain) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:addBookmark', (_, { url, title, favicon }: { url: string; title: string; favicon?: string }) => {
    try {
      const id = dataService.addBookmark(url, title, favicon)
      return { success: true, id }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:removeBookmark', (_, url: string) => {
    try {
      dataService.removeBookmarkByUrl(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getBookmarks', () => {
    try {
      return { success: true, data: dataService.getBookmarks() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:isBookmarked', (_, url: string) => {
    try {
      return { success: true, bookmarked: dataService.isBookmarked(url) }
    } catch {
      return { success: false, bookmarked: false }
    }
  })

  ipcMain.handle('browser:importBookmarks', async () => controller.importBookmarksFromDialog())
  ipcMain.handle('browser:exportBookmarks', async () => controller.exportBookmarksToDialog())

  ipcMain.handle('browser:getHistory', (_, limit?: number) => {
    try {
      return { success: true, data: dataService.getHistory(limit) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:clearHistory', () => {
    try {
      dataService.clearHistory()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:searchHistory', (_, query: string) => {
    try {
      return { success: true, data: dataService.searchHistory(query) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getDownloads', () => {
    try {
      return { success: true, data: dataService.getDownloads() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:clearDownloads', () => {
    try {
      dataService.clearDownloads()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:downloadUrlToDirectory', async (_, payload: BrowserDownloadUrlToDirectoryPayload) => {
    try {
      return await controller.downloadUrlToDirectory(payload)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:print', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      tab.view.webContents.print()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:showUtilityMenu', (_, payload: unknown) => {
    try {
      return controller.showUtilityMenu(payload)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
