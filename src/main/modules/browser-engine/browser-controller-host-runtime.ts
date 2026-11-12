import type { BrowserMainPushChannel } from '../../../shared/browser-ipc-channels'
import { BrowserWindow } from 'electron'
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import { findReusableCaptureTabId } from './capture-url-utils'
import {
  type BrowserHostView,
  type BrowserRect
} from './host-types'
import {
  resolveAgentPermissionRequestBinding,
  sameBrowserPermissionRequestBinding,
  type BrowserPermissionRequestBinding,
  type BrowserSitePermissionNotice
} from './browser-permission-policy'
import {
  downloadRemoteMediaDropUrls,
  scheduleRemoteMediaDropCleanup,
} from './remote-media-drop-cache'
import { parseBrowserLocalMediaDropUrl } from '../../../shared/browser-local-media-drop'
import { browserSnapshotService } from './browser-snapshot-service'
import { disposeBrowserPageMapAmbiguity } from './browser-page-map-ambiguity-cache'
import type {
  BrowserWorkflowWriteTarget
} from '../../../shared/browser-workflow-control'
import { extractBrowserDomain, type BrowserTabOwner, type Tab } from './browser-controller-contract-base'
import { BrowserControllerComposition } from './browser-controller-composition'

export abstract class BrowserControllerHostRuntime extends BrowserControllerComposition {
  protected logBrowserDiag(message: string): void {
    this.diagnosticsService.log(message)
  }

  protected isTabLeaseProtected(tabId: string): boolean {
    return getBrowserTargetClaimService().list()
      .some((claim) => claim.logicalKey.tabId === tabId && claim.state === 'held')
  }

  protected disposeTabRuntimeResources(tabId: string): void {
    this.dialogService.clear(tabId)
    this.fileChooserGuard.disposeTab(tabId)
    this.sessionPolicyService.expireSitePermissionRequestsForTab(tabId)
    this.pendingFileChooserNotices.delete(tabId)
    browserSnapshotService.disposeTab(this as never, tabId)
    disposeBrowserPageMapAmbiguity(tabId)
    this.webMcp.disposeTab(tabId)
    this.cdpSessionService.disposeTab(tabId)
    this.networkObserverService.disposeTab(tabId)
  }

  // ── Internal helpers ──────────────────────────────────────────────

  protected resolveOriginDomainForWebContentsId(webContentsId?: number): string {
    if (!webContentsId) return ''
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) {
        return tab.domain || extractBrowserDomain(tab.url)
      }
    }
    if (this.previewService.matchesWebContentsId(webContentsId)) {
      return extractBrowserDomain(this.previewService.getUrl())
    }
    return ''
  }

  protected resolveUrlForWebContentsId(webContentsId?: number): string {
    if (!webContentsId) return ''
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) {
        return tab.view.webContents.getURL() || tab.url
      }
    }
    if (this.previewService.matchesWebContentsId(webContentsId)) {
      return this.previewService.getUrl()
    }
    return ''
  }

  protected getTabIdForWebContents(webContentsId?: number): string | null {
    if (!webContentsId) return null
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) return tab.id
    }
    return null
  }

  protected partitionForTab(tabId: string): string | null {
    const tab = this.tabs.get(tabId)
    if (!tab) return null
    const profile = String(tab.profile || '').trim().toLowerCase()
    return profile ? `persist:browser-profile-${profile}` : 'persist:browser'
  }

  protected resolveAgentPermissionBinding(
    webContentsId: number | undefined,
    partition: string,
  ): BrowserPermissionRequestBinding | null {
    const tabId = this.getTabIdForWebContents(webContentsId)
    return tabId ? this.resolveAgentPermissionBindingForTab(tabId, partition) : null
  }

  protected resolveAgentPermissionBindingForTab(
    tabId: string,
    partition: string,
  ): BrowserPermissionRequestBinding | null {
    if (this.partitionForTab(tabId) !== partition) return null
    const workflowTarget = this.workflowPhysicalBindings.get(tabId) || null
    return resolveAgentPermissionRequestBinding({
      partition,
      tabId,
      physicalTargetToken: this.getPhysicalTargetToken(tabId) || null,
      workflowTarget,
      admittedTarget: workflowTarget && this.isBrowserWorkflowWriteAdmitted(workflowTarget)
        ? workflowTarget
        : null,
    })
  }

  protected isAgentPermissionBindingLive(binding: BrowserPermissionRequestBinding): boolean {
    return this.partitionForTab(binding.tabId) === binding.partition
      && this.getPhysicalTargetToken(binding.tabId) === binding.physicalTargetToken
  }

  protected recordFileChooserIntercepted(tabId: string, url: string): void {
    const partition = this.partitionForTab(tabId)
    const target = partition ? this.resolveAgentPermissionBindingForTab(tabId, partition) : null
    if (!target) return
    const records = this.pendingFileChooserNotices.get(tabId) || []
    records.push({
      target,
      notice: {
        kind: 'file_chooser_intercepted',
        permission: '',
        origin: url || tabId,
        at: new Date().toISOString(),
        guidance: 'The page opened a native file chooser. Use browser_find and browser_upload on this exact tab instead of waiting for the native dialog.',
      },
    })
    this.pendingFileChooserNotices.set(tabId, records.slice(-4))
  }

  consumeBrowserSiteNotices(target: BrowserWorkflowWriteTarget): BrowserSitePermissionNotice[] {
    if (!this.isBrowserWorkflowWriteAdmitted(target)) return []
    const notices = this.sessionPolicyService.consumeSitePermissionNotices(target)
    const fileChooserRecords = this.pendingFileChooserNotices.get(target.tabId) || []
    this.pendingFileChooserNotices.delete(target.tabId)
    for (const record of fileChooserRecords) {
      if (
        sameBrowserPermissionRequestBinding(record.target, {
          ...target,
        })
      ) notices.push(record.notice)
    }
    return notices
  }

  protected syncPopupContextForTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    const webContents = tab?.view?.webContents
    if (!tab || !webContents) return
    this.popupManager.bindWindow(webContents, {
      sourceTabId: tab.id,
      sourceOwner: tab.owner,
      profile: tab.profile ?? null,
    })
  }

  protected emitTabMeta(tabId: string): void {
    this.tabMetaService.emitTabMeta(tabId)
  }

  attachWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.hostLayoutService.setMainWindow(mainWindow)
    this.popupManager.setMainWindow(mainWindow)
    this.contextMenuService.setMainWindow(mainWindow)
    this.bookmarkTransferService.setMainWindow(mainWindow)
    this.utilityMenuService.setMainWindow(mainWindow)
  }

  protected createHost(partition: string): BrowserHostView {
    const view = this.hostLayoutService.createHost(partition)
    this.pageBackgroundService.reset(view)
    return view
  }

  detachHost(view: BrowserHostView): void {
    const tabId = this.getTabIdForWebContents(view.webContents.id)
    const owner = tabId ? this.taskWorkTabs.get(tabId) : null
    if (tabId && owner && owner.physicalTargetToken === this.getPhysicalTargetToken(tabId)
      && this.isAgentActivelyDrivingTab(tabId) && process.env.READY_BROWSER_BACKGROUND_SURFACE === '1') {
      this.hostLayoutService.mountBackgroundWorkHost(view)
      return
    }
    this.hostLayoutService.detachHost(view)
  }

  showHost(view: BrowserHostView, bounds: { x: number; y: number; width: number; height: number }): void {
    this.hostLayoutService.showHost(view, bounds)
  }

  hideHost(view: BrowserHostView): void {
    const tabId = this.getTabIdForWebContents(view.webContents.id)
    if (tabId && this.isAgentActivelyDrivingTab(tabId)) {
      const owner = this.taskWorkTabs.get(tabId)
      if (owner && owner.physicalTargetToken === this.getPhysicalTargetToken(tabId)
        && process.env.READY_BROWSER_BACKGROUND_SURFACE === '1') {
        this.hostLayoutService.mountBackgroundWorkHost(view)
        return
      }
      this.hostLayoutService.parkHost(view, this.currentBoundsForTab(tabId))
      return
    }
    this.hostLayoutService.hideHost(view)
  }

  sendToRenderer(channel: BrowserMainPushChannel, data: unknown): void {
    this.sendToRendererImmediate(channel, data)
  }

  protected sendToRendererImmediate(channel: BrowserMainPushChannel, data: unknown): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  notifyTabClosed(tabId: string): void {
    this.performanceRuntime.queueTabUpdate({
      type: 'closed',
      tabId,
      activeTabId: this.activeTabId,
    })
  }

  protected isDuplicateLocalMediaDrop(signature: string): boolean {
    const now = Date.now()
    for (const [key, startedAt] of this.localMediaDropRuns) {
      if (now - startedAt > 2500) this.localMediaDropRuns.delete(key)
    }
    const startedAt = this.localMediaDropRuns.get(signature)
    if (startedAt && now - startedAt <= 2500) return true
    this.localMediaDropRuns.set(signature, now)
    return false
  }

  protected handleLocalMediaDropNavigation(tabId: string, url: string): boolean {
    const request = parseBrowserLocalMediaDropUrl(url)
    if (!request) return false
    const remoteUrls = request.urls || []
    const dropSignature = JSON.stringify({ tabId, paths: request.paths, urls: remoteUrls })
    if (this.isDuplicateLocalMediaDrop(dropSignature)) {
      this.logBrowserDiag(`[browser-v3][local-media-drop][tab:${tabId}] ignored duplicate local=${request.paths.length} remote=${remoteUrls.length}`)
      return true
    }
    this.logBrowserDiag(`[browser-v3][local-media-drop][tab:${tabId}] received local=${request.paths.length} remote=${remoteUrls.length}`)
    void (async () => {
      let remoteFiles: string[] = []
      try {
        if (remoteUrls.length > 0) {
          this.sendToRenderer('browser:localMediaUploadStatus', {
            tabId,
            status: {
              kind: 'uploading',
              message: remoteUrls.length > 1 ? `正在准备 ${remoteUrls.length} 张网页图片...` : '正在准备网页图片...',
            },
          })
          const downloaded = await downloadRemoteMediaDropUrls(remoteUrls)
          remoteFiles = downloaded.files
          if (remoteFiles.length === 0 && request.paths.length === 0) {
            const firstError = downloaded.failed[0]?.error
            this.sendToRenderer('browser:localMediaUploadStatus', {
              tabId,
              status: {
                kind: 'error',
                message: firstError ? `网页图片下载失败：${firstError}` : '网页图片下载失败',
              },
            })
            return
          }
        }
        const files = [...request.paths, ...remoteFiles]
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'uploading',
            message: files.length > 1 ? `正在上传 ${files.length} 个素材...` : '正在上传素材...',
          },
        })
        const result = await this.uploadLocalMediaFiles(tabId, {
          files,
          x: request.x,
          y: request.y,
        })
        if (result.success) {
          this.sendToRenderer('browser:localMediaUploadStatus', {
            tabId,
            status: {
              kind: 'success',
              message: result.method === 'drop' ? '已把素材拖入网页' : '已把素材交给网页上传',
            },
          })
          return
        }
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'error',
            message: result.error || '网页没有接住这个素材',
          },
        })
      } catch (error) {
        this.sendToRenderer('browser:localMediaUploadStatus', {
          tabId,
          status: {
            kind: 'error',
            message: error instanceof Error ? error.message : '素材上传失败',
          },
        })
      } finally {
        scheduleRemoteMediaDropCleanup(remoteFiles)
      }
    })()
    return true
  }

  protected openPopupInTab(
    url: string,
    context: { sourceTabId?: string | null; sourceOwner?: BrowserTabOwner | null; profile?: string | null } = {},
  ): void {
    const agentOwned = context.sourceOwner === 'agent'
    void this.createTab(url, {
      background: agentOwned,
      openerTabId: context.sourceTabId ?? null,
      profile: context.profile ?? null,
    })
      .then((result) => {
        if (!result.success || !result.tabId) {
          this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${result.error || 'unknown error'}`)
          return
        }

        const tab = this.tabs.get(result.tabId)
        if (!tab) {
          this.logBrowserDiag(`[browser-v3][popup] created tab missing metadata tab=${result.tabId}`)
          return
        }

        if (agentOwned) {
          this.updateTabRuntimeState(result.tabId, {
            owner: 'agent',
            required: true,
            activity: 'running',
            lastAuditedAt: Date.now(),
          })
          this.syncPopupContextForTab(result.tabId)
          this.attachAgentTabSupervision(result.tabId)
        }
      })
      .catch((error) => {
        this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${String(error)}`)
      })
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow.isDestroyed() ? null : this.mainWindow
  }

  applyBounds(
    view: BrowserHostView,
    bounds: BrowserRect = this.viewBounds,
  ): void {
    this.hostLayoutService.applyBounds(view, bounds)
  }

  applyPreviewBounds(view: BrowserHostView): void {
    this.hostLayoutService.applyBounds(view, this.previewBounds)
  }

  protected hideActiveTabHost(): boolean {
    if (!this.activeTabId) return false
    const activeTab = this.tabs.get(this.activeTabId)
    if (!activeTab?.view) return false
    if (!this.hostLayoutService.isHostVisible(activeTab.view)) return false
    this.hideHost(activeTab.view)
    return true
  }

  protected restoreActiveTabHost(): void {
    if (!this.activeTabId) return
    const activeTab = this.tabs.get(this.activeTabId)
    if (activeTab?.view) {
      this.showHost(activeTab.view, this.viewBounds)
      this.applyBounds(activeTab.view)
    }
  }

  protected currentBoundsForTab(tabId: string): BrowserRect {
    if (tabId === this.splitTabId) return { ...this.splitViewBounds }
    if (tabId === this.activeTabId) return { ...this.viewBounds }
    const tab = this.tabs.get(tabId)
    const readBounds = (tab?.view as unknown as { getBounds?: () => BrowserRect })?.getBounds
    if (typeof readBounds === 'function') {
      try {
        const bounds = readBounds.call(tab?.view)
        if (
          bounds &&
          Number(bounds.width) > 20 &&
          Number(bounds.height) > 20 &&
          Number(bounds.x) > -10000 &&
          Number(bounds.y) > -10000
        ) {
          return {
            x: Math.round(Number(bounds.x)),
            y: Math.round(Number(bounds.y)),
            width: Math.round(Number(bounds.width)),
            height: Math.round(Number(bounds.height)),
          }
        }
      } catch {
        // silent-catch: fall back to the last primary BrowserView bounds.
      }
    }
    return { ...this.viewBounds }
  }

  protected clearSplitTabHost(): void {
    if (!this.splitTabId) return
    const splitTab = this.tabs.get(this.splitTabId)
    if (splitTab?.view) {
      this.detachHost(splitTab.view)
    }
    this.splitTabId = null
  }

  protected bindAppShortcutBridge(webContents: Electron.WebContents): void {
    this.appShortcutBridgeService.bind(webContents)
  }

  getActiveTab(): Tab | undefined {
    if (!this.activeTabId) return undefined
    return this.tabs.get(this.activeTabId)
  }

  protected findReusableTabForCapture(targetUrl: string): Tab | null {
    const candidateId = findReusableCaptureTabId(
      targetUrl,
      Array.from(this.tabs.values())
        .filter((tab) => tab.view)
        .map((tab) => ({
          id: tab.id,
          url: tab.view?.webContents.getURL() || tab.url,
        })),
      this.activeTabId,
    )
    return candidateId ? this.tabs.get(candidateId) || null : null
  }

  protected async loadWebContentsURL(
    webContents: Electron.WebContents,
    url: string,
    timeoutMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        webContents.removeListener('did-stop-loading', handleStop)
        webContents.removeListener('did-fail-load', handleFail as never)
      }

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }

      const handleStop = () => finish()
      const handleFail = (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return
        finish(new Error(`${errorDescription} (${errorCode})`))
      }

      webContents.on('did-stop-loading', handleStop)
      webContents.on('did-fail-load', handleFail as never)
      void webContents.loadURL(url).catch((error) => {
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

}
