import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import {
  bootIncarnationIdFromPhysicalTargetToken
} from './browser-target-claims'
import {
  type BrowserViewBoundsUpdate
} from './host-types'
import {
  clearBrowserAgentPointer
} from './ipc-browser-lock-overlay'
import {
  isAllowedBrowserURL
} from './popup-policy'
import type { RegisterDormantBrowserTabsRequest, RegisterDormantBrowserTabsResult } from '../../../shared/browser-tab-session'
import { type BrowserTabActivity, type BrowserTabOwner } from './browser-controller-contract-base'
import { BrowserControllerInteractionRuntime } from './browser-controller-interaction-runtime'
import type { BrowserWorkTabOwnership } from './work-tab-ownership-store'

export abstract class BrowserControllerTabRuntime extends BrowserControllerInteractionRuntime {
  async createTab(
    url: string,
    options?: { background?: boolean; openerTabId?: string | null; profile?: string | null; owner?: BrowserTabOwner },
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (this.tabs.size === 0) this.workTabOwnershipStore.reconcile(this.tabs.values())
    if (!options?.background) this.clearSplitTabHost()
    const result = await this.tabLifecycleService.createTab(url, options)
    if (result.success && result.tabId) {
      this.attachTargetClaimSupervision(result.tabId)
      if (options?.owner === 'agent') {
        this.agentTabId = result.tabId
        this.attachAgentTabSupervision(result.tabId)
      }
      void this.dialogService.ensure(result.tabId).catch(() => undefined)
      this.performanceRuntime.reconcile()
      this.performanceRuntime.scheduleReclaim()
    }
    return result
  }

  getAgentWorkTab(browserTaskId: string): string | null {
    const tabId = this.agentWorkTabs.get(browserTaskId) || null
    if (!tabId || !this.getTaskWorkTabIds(browserTaskId).includes(tabId)) {
      if (tabId) this.agentWorkTabs.delete(browserTaskId)
      return null
    }
    return tabId
  }

  async ensureAgentWorkTab(
    browserTaskId: string,
    url = 'about:blank',
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    const current = this.getAgentWorkTab(browserTaskId)
    if (current) {
      const tab = this.tabs.get(current)
      const currentUrl = tab?.view?.webContents.getURL() || tab?.url || ''
      if (url && currentUrl !== url) {
        const navigation = await this.navigate(current, url)
        if (!navigation.success) return { success: false, error: navigation.error }
      }
      return { success: true, tabId: current }
    }
    return this.createAgentWorkTab(browserTaskId, url, null)
  }

  getTaskWorkTabIds(browserTaskId: string): string[] {
    const owned = new Map(this.workTabOwnershipStore.list().map(owner => [owner.tabId, owner]))
    return [...this.taskWorkTabs].filter(([tabId, owner]) =>
      owner.browserTaskId === browserTaskId
      && owned.get(tabId)?.ownerRunId === owner.ownerRunId
      && this.tabs.get(tabId)?.owner === 'agent'
      && this.getPhysicalTargetToken(tabId) === owner.physicalTargetToken,
    ).map(([tabId]) => tabId)
  }

  async createAgentWorkTab(browserTaskId: string, url: string, openerTabId: string | null) {
    const owner = this.workTabOwnershipStore.captureOwner(browserTaskId)
    const created = await this.createTab(url, { background: true, owner: 'agent', openerTabId })
    if (!created.success || !created.tabId) return created
    const physicalTargetToken = this.getPhysicalTargetToken(created.tabId)
    try {
      const tab = this.tabs.get(created.tabId)
      if (!tab || !physicalTargetToken) throw new Error('browser_physical_target_unavailable')
      this.workTabOwnershipStore.add(tab, openerTabId, owner)
      this.taskWorkTabs.set(created.tabId, { browserTaskId, ownerRunId: owner.ownerRunId, openerTabId, physicalTargetToken })
    } catch (error) {
      const closed = this.closeTab(created.tabId)
      if (closed.success) this.notifyTabClosed(created.tabId)
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: closed.success ? message : `${message}; ${closed.error}` }
    }
    this.agentWorkTabs.set(browserTaskId, created.tabId)
    const view = this.tabs.get(created.tabId)?.view
    if (view) this.hostLayoutService.mountBackgroundWorkHost(view)
    return created
  }

  selectTaskWorkTab(browserTaskId: string, tabId: string) {
    if (!this.getTaskWorkTabIds(browserTaskId).includes(tabId)) {
      return { success: false, error: 'browser_task_tab_not_owned' }
    }
    this.agentWorkTabs.set(browserTaskId, tabId)
    return { success: true, tabId, presented: false }
  }

  closeTaskTabs(request: { browserTaskId: string }) {
    const closedTabIds: string[] = []
    if (!request || typeof request.browserTaskId !== 'string' || !request.browserTaskId.trim()) {
      return { success: false, closedTabIds, error: 'browser_task_id_required' }
    }
    for (const { id: tabId } of this.getTabList().filter(tab => tab.browserTaskId === request.browserTaskId)) {
      const result = this.closeTab(tabId)
      if (!result.success) return { ...result, closedTabIds }
      this.notifyTabClosed(tabId)
      closedTabIds.push(tabId)
    }
    return { success: true, closedTabIds }
  }

  registerDormantTabs(request: RegisterDormantBrowserTabsRequest): RegisterDormantBrowserTabsResult {
    let restoredOwners: BrowserWorkTabOwnership[] = []
    const result = this.tabLifecycleService.registerDormantTabs(request, tabs => {
      this.workTabOwnershipStore.reconcile(tabs)
      restoredOwners = this.workTabOwnershipStore.list()
      const owned = new Map(restoredOwners.map(owner => [owner.tabId, owner]))
      for (const tab of this.tabs.values()) {
        const owner = owned.get(tab.id)
        tab.owner = owner ? 'agent' : 'manual'
        tab.required = false
        tab.activity = 'idle'
        tab.openerTabId = owner?.openerTabId ?? null
      }
    })
    if (result.success) {
      for (const tab of this.tabs.values()) this.emitTabMeta(tab.id)
      for (const owner of new Map(restoredOwners.map(owner => [owner.browserTaskId, owner])).values()) {
        this.sendToRenderer('agent:browserTaskAttentionChanged', { scopeId: owner.scopeId, browserTaskId: owner.browserTaskId })
      }
    }
    this.performanceRuntime.reconcile()
    return result
  }

  async openForCaptureTarget(
    url: string,
  ): Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }

    const reusable = this.findReusableTabForCapture(url)
    if (!reusable?.id) {
      const created = await this.createTab(url)
      return created.success
        ? { success: true, tabId: created.tabId, reused: false }
        : { success: false, error: created.error }
    }

    const currentUrl = reusable.view?.webContents.getURL() || reusable.url
    if (currentUrl !== url) {
      const navigation = await this.navigate(reusable.id, url)
      if (!navigation.success) {
        return { success: false, error: navigation.error }
      }
    }

    const switched = this.switchTab(reusable.id)
    if (!switched.success) {
      return { success: false, error: switched.error }
    }

    return { success: true, tabId: reusable.id, reused: true }
  }

  hasReusableCaptureTarget(url: string): boolean {
    return !!this.findReusableTabForCapture(url)
  }

  /**
   * Attach Chrome DevTools Protocol debugger to a tab's webContents.
   * Safe to call repeatedly.
   */
  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'navigate')
    if (resolvedTabId && !this.tabs.get(resolvedTabId)?.view) {
      const materialized = this.tabLifecycleService.materializeTab(resolvedTabId, {
        activate: resolvedTabId === this.activeTabId,
      })
      if (!materialized.success) return { success: false, error: materialized.error }
      this.performanceRuntime.reconcile()
    }
    return this.tabShellService.navigate(tabId, url)
  }

  materializeBrowserTab(
    tabId: string,
    options: { preserveViewport?: boolean } = {},
  ): { success: boolean; tabId?: string; error?: string } {
    const result = this.tabLifecycleService.materializeTab(tabId, { activate: false })
    if (result.success) {
      const partition = this.partitionForTab(tabId)
      const physicalTargetToken = this.getPhysicalTargetToken(tabId)
      if (partition && physicalTargetToken) {
        const service = getBrowserTargetClaimService()
        const current = service.read({ partition, tabId })
        try {
          service.replacePhysicalTarget({
            partition,
            tabId,
            physicalTargetToken,
            bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
          }, current?.state === 'held'
            ? this.targetCheckpointResolver?.(current.parentTaskId) || null
            : null)
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (options.preserveViewport) {
        const view = this.tabs.get(tabId)?.view
        if (!view) return { success: false, error: 'Tab could not be materialized' }
        this.hostLayoutService.parkHost(view, this.currentBoundsForTab(tabId))
      }
      this.performanceRuntime.reconcile()
    }
    return result
  }

  /**
   * Go back in the active tab.
   */
  goBack(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'back')
    return this.tabShellService.goBack(tabId)
  }

  goForward(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'forward')
    return this.tabShellService.goForward(tabId)
  }

  reload(tabId: string | null): { success: boolean; error?: string } {
    const resolvedTabId = tabId || this.activeTabId
    if (resolvedTabId) this.requestNavigationTakeover(resolvedTabId, 'reload')
    return this.tabShellService.reload(tabId)
  }

  closeTab(tabId: string): { success: boolean; error?: string } {
    const partition = this.partitionForTab(tabId)
    const result = this.workTabOwnershipStore.close(tabId, () => {
      if (this.tabs.has(tabId)) this.disposeTabRuntimeResources(tabId)
      return this.tabShellService.closeTab(tabId)
    })
    if (result.success) {
      if (partition) getBrowserTargetClaimService().closeTarget({ partition, tabId })
      this.taskWorkTabs.delete(tabId)
      this.workflowPhysicalBindings.delete(tabId)
      this.pendingPhysicalTakeovers.delete(tabId)
      this.performanceRuntime.disposeTab(tabId)
      for (const [browserTaskId, ownedTabId] of this.agentWorkTabs) {
        if (ownedTabId === tabId) this.agentWorkTabs.delete(browserTaskId)
      }
      if (this.agentTabId === tabId) this.agentTabId = null
    }
    return result
  }

  reorderTabs(tabIds: string[]): { success: boolean; error?: string } {
    return this.tabShellService.reorderTabs(tabIds)
  }

  switchTab(tabId: string): {
    success: boolean
    error?: string
    previousActiveTabId?: string | null
    activeTabId?: string | null
    url?: string
    title?: string
    domain?: string
    favicon?: string | null
    profile?: string | null
    owner?: BrowserTabOwner
    required?: boolean
    activity?: BrowserTabActivity
    lastAuditedAt?: number | null
    canGoBack?: boolean
    canGoForward?: boolean
  } {
    if (!this.tabs.get(tabId)?.view) {
      const materialized = this.tabLifecycleService.materializeTab(tabId)
      if (!materialized.success) return { success: false, error: materialized.error }
    }
    const result = this.tabShellService.switchTab(tabId)
    if (result.success) {
      this.performanceRuntime.noteInteraction(tabId)
      if (result.previousActiveTabId && result.previousActiveTabId !== (result.activeTabId ?? tabId)) {
        clearBrowserAgentPointer()
      }
    }
    return result
  }

  updateViewBounds(bounds: BrowserViewBoundsUpdate): { success: boolean } {
    clearBrowserAgentPointer()
    return this.tabShellService.updateViewBounds(bounds)
  }

  hideAllHosts(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.hideAll(payload)
  }

  hideActiveHost(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.hideActive(payload)
  }

  showActiveHost(payload?: { requestId?: number }): { success: boolean } {
    return this.browserVisibilityRuntime.showActive(payload)
  }

  /**
   * Stage X4 PR-shell-1 — single intent boundary. Renderer pushes
   * declarative BrowserViewIntent through `browser:intent`; this method
   * is the only writer onto `tabShellService.applyIntent`. For
   * `hide-all` and `show` intents we go through the same visibility
   * monotonic-id gate used by the legacy preload endpoints so that ack
   * ordering remains intact for PR-shell-2.
   */
  applyBrowserViewIntent(intent: import('../../../shared/browser-view-intent').BrowserViewIntent): { success: boolean } {
    return this.browserVisibilityRuntime.applyIntent(intent)
  }

  async fitActiveTabToBounds(tabId?: string | null): Promise<{ success: boolean; zoomFactor?: number; error?: string }> {
    try {
      const { view } = this.resolveTabView(tabId || null)
      const metrics = await view.webContents.executeJavaScript(`(() => {
        const root = document.documentElement
        const body = document.body
        if (!root || !body) {
          return { viewportWidth: 0, contentWidth: 0 }
        }

        const viewportWidth = Math.max(window.innerWidth || 0, root.clientWidth || 0)
        const contentWidth = Math.max(
          root.scrollWidth || 0,
          body.scrollWidth || 0,
          root.offsetWidth || 0,
          body.offsetWidth || 0,
          ...Array.from(document.querySelectorAll('body *'))
            .slice(0, 240)
            .map((node) => {
              if (!(node instanceof HTMLElement)) return 0
              const style = window.getComputedStyle(node)
              if (style.display === 'none' || style.visibility === 'hidden') return 0
              const rect = node.getBoundingClientRect()
              return rect.width > 40 && rect.height > 20 ? rect.right : 0
            }),
        )

        return { viewportWidth, contentWidth }
      })()`, true) as { viewportWidth?: number; contentWidth?: number }

      const viewportWidth = Math.max(0, Number(metrics?.viewportWidth || 0))
      const contentWidth = Math.max(0, Number(metrics?.contentWidth || 0))
      let zoomFactor = 1

      if (viewportWidth > 0 && contentWidth > viewportWidth + 24) {
        zoomFactor = Math.max(0.72, Math.min(1, viewportWidth / contentWidth))
      }

      view.webContents.setZoomFactor(zoomFactor)

      return { success: true, zoomFactor }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
