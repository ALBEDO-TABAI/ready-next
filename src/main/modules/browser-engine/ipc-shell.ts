import { ipcMain } from 'electron'
import type { BrowserViewBoundsUpdate } from '../../../shared/browser-view-layout'
import {
  BROWSER_VIEW_INTENT_ACK_CHANNEL,
  BROWSER_VIEW_INTENT_CHANNEL,
  type BrowserViewIntent,
} from '../../../shared/browser-view-intent'
import type { RegisterDormantBrowserTabsRequest, RegisterDormantBrowserTabsResult } from '../../../shared/browser-tab-session'
import { closeBrowserTabAndNotify } from './tab-close-notifier'

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
  createTab(url: string, options?: { background?: boolean }): Promise<{ success: boolean; tabId?: string; error?: string }>
  registerDormantTabs(request: RegisterDormantBrowserTabsRequest): RegisterDormantBrowserTabsResult
  openForCaptureTarget(url: string): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }>
  navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }>
  reorderTabs(tabIds: string[]): { success: boolean; error?: string }
  getTaskDownloadReceipts(request: { browserTaskId: string }): { success: boolean; downloadReceipts: import('../../../shared/browser-download-receipt').BrowserDownloadReceipt[]; error?: string }
  closeTaskTabs(request: { browserTaskId: string }): { success: boolean; closedTabIds: string[]; error?: string }
  closeTab(tabId: string): { success: boolean; error?: string }
  notifyTabClosed(tabId: string): void
  switchTab(tabId: string): {
    success: boolean
    error?: string
    previousActiveTabId?: string | null
    activeTabId?: string | null
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
  updateViewBounds(bounds: BrowserViewBoundsUpdate): { success: boolean }
  hideAllHosts(payload?: { requestId?: number }): { success: boolean }
  hideActiveHost(payload?: { requestId?: number }): { success: boolean }
  showActiveHost(payload?: { requestId?: number }): { success: boolean }
  applyBrowserViewIntent(intent: BrowserViewIntent): { success: boolean }
  fitActiveTabToBounds(tabId?: string | null): Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  captureWindowSnapshot(bounds: { x: number; y: number; width: number; height: number }): Promise<{ success: boolean; data?: string; error?: string }>
  captureViewportSnapshot(tabId?: string | null): Promise<{ success: boolean; data?: string; error?: string }>
  uploadLocalMediaFiles(tabId: string | null, payload: { files: string[]; x?: number; y?: number }): Promise<{
    success: boolean
    method?: 'file-input' | 'drop'
    targetDescription?: string
    assignedFileNames?: string[]
    error?: string
  }>
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
  createP7cLiveProofManualTab(): Promise<{ success: boolean; tabId?: string; error?: string }>
  startP7cLiveProofUserViewLease(): { success: boolean; leaseId?: string; tabId?: string; error?: string }
  prepareP7cLiveProofForegroundProbe(): Promise<{ success: boolean; state?: unknown; error?: string }>
  sampleP7cLiveProofActiveTabState(): Promise<{ success: boolean; state?: unknown; error?: string }>
  sendP7cLiveProofUserKey(key?: string): { success: boolean; error?: string }
  sendP7cLiveProofAgentClick(x?: number, y?: number): Promise<{
    success: boolean
    tabId?: string
    x?: number
    y?: number
    error?: string
  }>
  finishP7cLiveProofAgentAction(phase?: 'finish' | 'abort'): {
    success: boolean
    phase?: 'finish' | 'abort'
    error?: string
  }
  checkP7cLiveProofWriteDenied(): { success: boolean; errorKind?: string; error?: string }
  clearP7cLiveProofState(): { success: boolean; error?: string }
}

export function setupBrowserShellIPC(controller: BrowserShellIPCController): void {
  ipcMain.handle('browser:registerDormantTabs', (_, request: RegisterDormantBrowserTabsRequest) => {
    try {
      return controller.registerDormantTabs(request)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:createTab', async (_, url: string, options?: { background?: boolean }) => {
    try {
      const result = await controller.createTab(url, options)
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

  ipcMain.handle('browser:getTaskDownloadReceipts', (_event, request: { browserTaskId: string }) => controller.getTaskDownloadReceipts(request))

  ipcMain.handle('browser:closeTaskTabs', (_event, request: { browserTaskId: string }) => controller.closeTaskTabs(request))

  ipcMain.handle('browser:closeTab', (event, tabId: string) => {
    void event
    return closeBrowserTabAndNotify(controller, tabId)
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

  // Stage X4 PR-shell-1 — single BrowserViewIntent channel. Renderer
  // pushes declarative intents; main echoes the intentId back on
  // `browser:intent-ack` for ack-bearing intents (PR-shell-2 wires the
  // round-trip for `hide-all`). The legacy hideAll / showActive /
  // hideActiveHost / updateBounds channels are retired per CLAUDE.md
  // §0.5 "拒绝 legacy 兼容分支".
  //
  // The ack push uses the literal `'browser:intent-ack'` string so the
  // IPC-contract gate's PUSH scanner can correlate emitter and listener
  // (it AST-walks for string literals; non-literal channel emit sites
  // need allowlist entries).
  ipcMain.on(BROWSER_VIEW_INTENT_CHANNEL, (event, intent: BrowserViewIntent) => {
    controller.applyBrowserViewIntent(intent)
    if (!('expectsAck' in intent) || intent.expectsAck !== true) return
    try {
      // Literal channel name — keep in sync with
      // BROWSER_VIEW_INTENT_ACK_CHANNEL in shared/browser-view-intent.ts.
      event.sender.send('browser:intent-ack', { intentId: intent.intentId })
    } catch {
      // sender may be gone (window closed during in-flight intent); fine
    }
  })
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

  ipcMain.handle('browser:uploadLocalMediaFiles', async (_, payload: { tabId?: string | null; files?: string[]; x?: number; y?: number }) => {
    try {
      return await controller.uploadLocalMediaFiles(payload?.tabId ?? null, {
        files: Array.isArray(payload?.files) ? payload.files : [],
        x: payload?.x,
        y: payload?.y,
      })
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
  // Stage Y Y1.4 — IPC contract hardening (reduction-only): the legacy
  // ipcMain handle-style dual registration for browser:previewUpdateBounds
  // was removed. The preload (`src/preload/index.ts:368-371`) routes
  // `previewUpdateBounds` through `ipcRenderer.send`, so only the
  // `ipcMain.on(...)` listener below carries the live path. See
  // `docs/superpowers/plans/archive/2026-05-23-Y1-4-ipc-renderer-contract-hardening-implementation.md`.
  ipcMain.on(
    'browser:previewUpdateBounds',
    (_, bounds: { x: number; y: number; width: number; height: number }) => {
      controller.previewUpdateBounds(bounds)
    },
  )
  ipcMain.handle('browser:previewClose', () => controller.previewClose())
  ipcMain.handle('browser:previewGetState', () => controller.previewGetState())

  ipcMain.handle('browser:p7cLiveProofStartUserViewLease', () => {
    try {
      return controller.startP7cLiveProofUserViewLease()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofCreateManualTab', async () => {
    try {
      return await controller.createP7cLiveProofManualTab()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofPrepareForegroundProbe', async () => {
    try {
      return await controller.prepareP7cLiveProofForegroundProbe()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofSampleActiveTabState', async () => {
    try {
      return await controller.sampleP7cLiveProofActiveTabState()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofSendUserKey', (_, key?: string) => {
    try {
      return controller.sendP7cLiveProofUserKey(key)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofAgentClick', async (_, x?: number, y?: number) => {
    try {
      return await controller.sendP7cLiveProofAgentClick(x, y)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofFinishAgentAction', (_, phase?: 'finish' | 'abort') => {
    try {
      return controller.finishP7cLiveProofAgentAction(phase)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofCheckWriteDenied', () => {
    try {
      return controller.checkP7cLiveProofWriteDenied()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('browser:p7cLiveProofClear', () => {
    try {
      return controller.clearP7cLiveProofState()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
