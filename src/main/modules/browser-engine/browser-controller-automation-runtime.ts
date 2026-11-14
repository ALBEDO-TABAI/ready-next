import { type BrowserExecutionDeadlineOptions } from './automation-service'
import type {
  BrowserKeyEventPayload,
  BrowserMouseEventPayload,
  BrowserScreenshotOptions, BrowserViewportMetrics
} from './automation-types'
import { type BrowserNetworkObserverHandle, type BrowserNetworkObserverOptions } from './network-observer-service'
import { BrowserControllerTabRuntime } from './browser-controller-tab-runtime'

export abstract class BrowserControllerAutomationRuntime extends BrowserControllerTabRuntime {
  async ensureDebugger(tabId: string | null): Promise<{ tabId: string }> {
    return this.automationService.ensureDebugger(tabId)
  }

  /**
   * Resolve viewport metrics in CSS pixels.
   * Prefers window.visualViewport and falls back to CDP layout metrics.
   */
  async getViewportMetrics(tabId: string | null): Promise<BrowserViewportMetrics> {
    return this.automationService.getViewportMetrics(tabId)
  }

  async retainTrustedInputSequence(tabId: string | null): Promise<() => void> {
    return this.automationService.retainTrustedInputSequence(tabId)
  }

  /**
   * Map normalized coordinates (0..999) into CSS pixel coordinates in viewport.
   */
  async normalizedToCss(tabId: string | null, x: number, y: number): Promise<{
    x: number
    y: number
    width: number
    height: number
  }> {
    return this.automationService.normalizedToCss(tabId, x, y)
  }

  /**
   * Dispatch low-level mouse event through CDP.
   */
  async dispatchMouse(tabId: string | null, payload: BrowserMouseEventPayload): Promise<void> {
    return this.automationService.dispatchMouse(tabId, payload)
  }

  /**
   * Dispatch low-level keyboard event through CDP.
   */
  async dispatchKey(tabId: string | null, payload: BrowserKeyEventPayload): Promise<void> {
    const resolved = this.resolveTabView(tabId)
    const previousPresentation = this.hostLayoutService.getHostPresentationState(resolved.view)
    const temporarilyParked = previousPresentation === 'detached' || previousPresentation === 'hidden'
    if (temporarilyParked) {
      this.hostLayoutService.parkHost(resolved.view, this.currentBoundsForTab(resolved.tabId))
    }
    try {
      return await this.automationService.dispatchKey(resolved.tabId, payload)
    } finally {
      if (temporarilyParked && this.hostLayoutService.getHostPresentationState(resolved.view) === 'parked') {
        if (previousPresentation === 'detached') this.hostLayoutService.detachHost(resolved.view)
        else this.hostLayoutService.hideHost(resolved.view)
      }
    }
  }

  /**
   * Insert text at current focus target via CDP.
   */
  async typeTextDirectly(
    tabId: string | null,
    text: string,
    options?: { useShiftEnterForNewline?: boolean },
  ): Promise<void> {
    return this.automationService.typeTextDirectly(tabId, text, options)
  }

  /**
   * Take screenshot in different modes.
   */
  async screenshotAdvanced(tabId: string | null, options?: BrowserScreenshotOptions): Promise<string> {
    return this.automationService.screenshotAdvanced(tabId, options)
  }

  /**
   * Execute JavaScript in a tab's webContents. Runs in BrowserView sandbox (isolated from Node).
   */
  async executeJS(tabId: string | null, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown> {
    this.assertNoPendingDialog(tabId)
    return this.automationService.executeJS(tabId, code, options)
  }

  /** D10 frame 穿透：列出主帧+子帧（frameKey '0'=主帧，子帧 pid-rid）。 */
  listContentFrames(tabId: string | null) {
    return this.automationService.listContentFrames(tabId)
  }

  /** D10 frame 穿透：在指定 frameKey 的帧内执行 JS（'0' 回落主帧路径）。 */
  async executeJSInFrame(tabId: string | null, frameKey: string, code: string, options?: BrowserExecutionDeadlineOptions): Promise<unknown> {
    this.assertNoPendingDialog(tabId)
    return this.automationService.executeJSInFrame(tabId, frameKey, code, options)
  }

  /**
   * Get the plain text content of a page (document.body.innerText), truncated to 30K chars.
   */
  async getPageContent(tabId: string | null): Promise<string> {
    this.assertNoPendingDialog(tabId)
    return this.automationService.getPageContent(tabId)
  }

  async startNetworkObserver(
    tabId: string,
    options?: BrowserNetworkObserverOptions,
  ): Promise<BrowserNetworkObserverHandle> {
    return this.networkObserverService.start(tabId, options)
  }

  async sendCdpCommand(
    tabId: string | null,
    method: string,
    params?: Record<string, unknown>,
    options?: import('./cdp-session-service').BrowserCdpCommandOptions,
  ): Promise<unknown> {
    return this.cdpSessionService.sendCommand(tabId, method, params, options)
  }

  async callFunctionOnBackendNode(
    tabId: string | null,
    backendDOMNodeId: number,
    functionDeclaration: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    this.assertNoPendingDialog(tabId)
    const resolved = await this.sendCdpCommand(tabId, 'DOM.resolveNode', {
      backendNodeId: backendDOMNodeId,
    }) as { object?: { objectId?: unknown } } | null
    const objectId = String(resolved?.object?.objectId || '')
    if (!objectId) throw Object.assign(new Error('backend_node_not_resolved'), { code: 'BACKEND_NODE_NOT_RESOLVED' })
    try {
      this.assertNoPendingDialog(tabId)
      const called = await this.sendCdpCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }) as {
        result?: { value?: unknown }
        exceptionDetails?: { text?: unknown; exception?: { description?: unknown } }
      } | null
      if (called?.exceptionDetails) {
        const message = String(called.exceptionDetails.exception?.description || called.exceptionDetails.text || 'backend_node_call_failed')
        throw Object.assign(new Error(message), { code: 'BACKEND_NODE_CALL_FAILED' })
      }
      return called?.result?.value
    } finally {
      await this.sendCdpCommand(tabId, 'Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }

  private assertNoPendingDialog(tabId: string | null): void {
    if (this.dialogService.hasPending(this.resolveTabView(tabId).tabId)) {
      throw Object.assign(new Error('有原生对话框待处理，请先用 browser_dialog 接受或拒绝。'), { code: 'dialog_open' })
    }
  }

  /**
   * D16 — tool-executor 在 agent 写租约生效的写动作前调用，武装该 tab 的
   * 文件选择器拦截（幂等、best-effort）。解除由租约转移监听统一处理。
   */
  async armAgentFileChooserGuard(tabId: string | null): Promise<void> {
    await this.fileChooserGuard.arm(tabId)
  }

}
