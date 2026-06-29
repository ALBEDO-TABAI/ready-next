import type { BrowserAggregateOptions, BrowserCapabilityTaskHandle, BrowserExtractStructuredOptions, BrowserExtractStructuredResult, BrowserStructuredItem } from './capability-types'
import type { BrowserTabContextData, BrowserUploadTarget, BrowserViewportMetrics } from './automation-types'
import type { BrowserController } from './ipc-handler'
import type { BrowserNetworkObserverHandle, BrowserNetworkObserverOptions } from './network-observer-service'

export interface BrowserAgentRuntime {
  getActiveTab(): {
    id: string
    url: string
    title: string
    domain: string
    active?: boolean
  } | undefined
  getTabContext(tabId?: string | null): Promise<BrowserTabContextData | null>
  executeJS(tabId: string | null, code: string): Promise<unknown>
  navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }>
  normalizedToCss(tabId: string | null, x: number, y: number): Promise<{ x: number; y: number; width: number; height: number }>
  dispatchMouse(tabId: string | null, payload: Record<string, unknown>): Promise<void>
  dispatchKey(tabId: string | null, payload: Record<string, unknown>): Promise<void>
  typeTextDirectly(tabId: string | null, text: string, options?: { useShiftEnterForNewline?: boolean }): Promise<void>
  screenshotAdvanced(tabId: string | null, options?: Record<string, unknown>): Promise<string>
  findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]>
  setFileInputFiles(tabId: string | null, payload: { files: string[]; selector?: string; target?: string; x?: number; y?: number }): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }>
  startTask(request: Record<string, unknown>): Promise<BrowserCapabilityTaskHandle>
  getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null>
  resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null>
  cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null>
  extractStructured(tabId: string | null, options: BrowserExtractStructuredOptions): Promise<BrowserExtractStructuredResult>
  aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[]
  startNetworkObserver?(tabId: string, options?: BrowserNetworkObserverOptions): Promise<BrowserNetworkObserverHandle>
}

export class BrowserAgentRuntimeAdapter implements BrowserAgentRuntime {
  constructor(private readonly controller: BrowserController) {}

  getActiveTab() {
    const activeTab = this.controller.getActiveTab()
    if (!activeTab) return undefined
    return {
      id: activeTab.id,
      url: activeTab.url,
      title: activeTab.title,
      domain: activeTab.domain,
      active: true,
    }
  }

  async getTabContext(tabId?: string | null): Promise<BrowserTabContextData | null> {
    return this.controller.getTabContext(tabId)
  }

  async executeJS(tabId: string | null, code: string): Promise<unknown> {
    return this.controller.executeJS(tabId, code)
  }

  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    return this.controller.navigate(tabId, url)
  }

  async normalizedToCss(tabId: string | null, x: number, y: number): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.controller.normalizedToCss(tabId, x, y)
  }

  async dispatchMouse(tabId: string | null, payload: Record<string, unknown>): Promise<void> {
    return this.controller.dispatchMouse(tabId, payload as any)
  }

  async dispatchKey(tabId: string | null, payload: Record<string, unknown>): Promise<void> {
    return this.controller.dispatchKey(tabId, payload as any)
  }

  async typeTextDirectly(tabId: string | null, text: string, options?: { useShiftEnterForNewline?: boolean }): Promise<void> {
    return this.controller.typeTextDirectly(tabId, text, options)
  }

  async screenshotAdvanced(tabId: string | null, options?: Record<string, unknown>): Promise<string> {
    return this.controller.screenshotAdvanced(tabId, options as any)
  }

  async findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]> {
    return this.controller.findUploadTargets(tabId)
  }

  async setFileInputFiles(tabId: string | null, payload: { files: string[]; selector?: string; target?: string; x?: number; y?: number }): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }> {
    return this.controller.setFileInputFiles(tabId, payload)
  }

  async startTask(request: Record<string, unknown>): Promise<BrowserCapabilityTaskHandle> {
    return this.controller.startTask(request as any)
  }

  async getTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.controller.getTask(taskId)
  }

  async resumeTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.controller.resumeTask(taskId)
  }

  async cancelTask(taskId: string): Promise<BrowserCapabilityTaskHandle | null> {
    return this.controller.cancelTask(taskId)
  }

  async extractStructured(tabId: string | null, options: BrowserExtractStructuredOptions): Promise<BrowserExtractStructuredResult> {
    return this.controller.extractStructured(tabId, options)
  }

  aggregateResults(items: BrowserStructuredItem[], options?: BrowserAggregateOptions): BrowserStructuredItem[] {
    return this.controller.aggregateResults(items, options)
  }

  async startNetworkObserver(tabId: string, options?: BrowserNetworkObserverOptions): Promise<BrowserNetworkObserverHandle> {
    return this.controller.startNetworkObserver(tabId, options)
  }
}
