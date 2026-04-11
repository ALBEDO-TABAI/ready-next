import { ipcMain } from 'electron'

interface BrowserShellView {
  webContents: {
    close?: () => void
    loadURL(url: string): Promise<void>
    reload(): void
    navigationHistory: {
      canGoBack(): boolean
      canGoForward(): boolean
      goBack(): void
      goForward(): void
    }
  }
}

interface BrowserShellTab {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: string
  required: boolean
  activity: string
  lastAuditedAt: number | null
  view?: BrowserShellView
}

interface BrowserShellIPCController {
  tabs: Map<string, BrowserShellTab>
  activeTabId: string | null
  viewBounds: { x: number; y: number; width: number; height: number }
  createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }>
  openForCaptureTarget(url: string): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }>
  navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }>
  reorderTabs(tabIds: string[]): { success: boolean; error?: string }
  closeTab(tabId: string): { success: boolean; error?: string }
  switchTab(tabId: string): {
    success: boolean
    error?: string
    url?: string
    title?: string
    domain?: string
    favicon?: string | null
    owner?: string
    required?: boolean
    activity?: string
    lastAuditedAt?: number | null
    canGoBack?: boolean
    canGoForward?: boolean
  }
  goBack(tabId: string | null): { success: boolean; error?: string }
  goForward(tabId: string | null): { success: boolean; error?: string }
  reload(tabId: string | null): { success: boolean; error?: string }
  updateViewBounds(bounds: { x: number; y: number; width: number; height: number }): { success: boolean }
  hideAllHosts(payload?: { requestId?: number }): { success: boolean }
  hideActiveHost(payload?: { requestId?: number }): { success: boolean }
  showActiveHost(payload?: { requestId?: number }): { success: boolean }
  fitActiveTabToBounds(tabId?: string | null): Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  captureWindowSnapshot(bounds: { x: number; y: number; width: number; height: number }): Promise<{ success: boolean; data?: string; error?: string }>
  captureViewportSnapshot(tabId?: string | null): Promise<{ success: boolean; data?: string; error?: string }>
  getTabList(): unknown
  getTabContext(tabId?: string | null): Promise<unknown>
  previewOpen(url: string): Promise<{ success: boolean; error?: string }>
  previewNavigate(url: string): Promise<{ success: boolean; error?: string }>
  previewGoBack(): { success: boolean; error?: string }
  previewGoForward(): { success: boolean; error?: string }
  previewReload(): { success: boolean; error?: string }
  previewUpdateBounds(bounds: { x: number; y: number; width: number; height: number }): { success: boolean }
  previewClose(): { success: boolean }
  previewGetState(): unknown
}

export function setupBrowserShellIPC(controller: BrowserShellIPCController): void {
  ipcMain.handle('browser:createTab', async (_, url: string) => {
    try {
      const result = await controller.createTab(url)
      if (!result.success) return result
      const tab = controller.tabs.get(result.tabId!)
      return { success: true, tabId: result.tabId, title: tab?.title || 'Loading...' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:openForCaptureTarget', async (_, url: string) => {
    try {
      return await controller.openForCaptureTarget(url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:closeTab', (_, tabId: string) => {
    try {
      return controller.closeTab(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:switchTab', (_, tabId: string) => {
    try {
      return controller.switchTab(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:navigate', async (_, { tabId, url }: { tabId: string; url: string }) => {
    try {
      return await controller.navigate(tabId, url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:reorderTabs', (_, tabIds: string[]) => {
    try {
      return controller.reorderTabs(tabIds)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:goBack', (_, tabId: string) => {
    try {
      return controller.goBack(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:goForward', (_, tabId: string) => {
    try {
      return controller.goForward(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:reload', (_, tabId: string) => {
    try {
      return controller.reload(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:updateBounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
    return controller.updateViewBounds(bounds)
  })
  ipcMain.on('browser:updateBounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
    controller.updateViewBounds(bounds)
  })

  ipcMain.handle('browser:hideAll', (_, payload?: { requestId?: number }) => controller.hideAllHosts(payload))
  ipcMain.handle('browser:hideActiveHost', (_, payload?: { requestId?: number }) => controller.hideActiveHost(payload))

  ipcMain.handle('browser:showActive', (_, payload?: { requestId?: number }) => controller.showActiveHost(payload))
  ipcMain.handle('browser:fitActiveTabToBounds', async (_, tabId?: string | null) => {
    try {
      return await controller.fitActiveTabToBounds(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:captureWindowSnapshot', async (_, bounds: { x: number; y: number; width: number; height: number }) => {
    try {
      return await controller.captureWindowSnapshot(bounds)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:captureViewportSnapshot', async (_, tabId?: string | null) => {
    try {
      return await controller.captureViewportSnapshot(tabId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getTabs', () => controller.getTabList())

  ipcMain.handle('browser:getTabContext', async (_, tabId?: string) => {
    try {
      const context = await controller.getTabContext(tabId)
      return { success: true, data: context }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:previewOpen', async (_, payload: { url: string }) => {
    try {
      return await controller.previewOpen(payload.url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:previewNavigate', async (_, payload: { url: string }) => {
    try {
      return await controller.previewNavigate(payload.url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:previewGoBack', () => controller.previewGoBack())
  ipcMain.handle('browser:previewGoForward', () => controller.previewGoForward())
  ipcMain.handle('browser:previewReload', () => controller.previewReload())
  ipcMain.handle(
    'browser:previewUpdateBounds',
    (_, bounds: { x: number; y: number; width: number; height: number }) => controller.previewUpdateBounds(bounds),
  )
  ipcMain.on(
    'browser:previewUpdateBounds',
    (_, bounds: { x: number; y: number; width: number; height: number }) => {
      controller.previewUpdateBounds(bounds)
    },
  )
  ipcMain.handle('browser:previewClose', () => controller.previewClose())
  ipcMain.handle('browser:previewGetState', () => controller.previewGetState())
}
