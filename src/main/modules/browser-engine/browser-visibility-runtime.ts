import type { BrowserViewIntent } from '../../../shared/browser-view-intent'
import { BrowserVisibilityCommandState } from './visibility-command-state'

interface BrowserVisibilityRuntimeDeps {
  hideAllHosts(): { success: boolean }
  hideActiveHost(): { success: boolean }
  showActiveHost(): { success: boolean }
  applyIntent(intent: BrowserViewIntent): { success: boolean }
  clearAgentPointer(): void
  reconcileLoadStates(): void
  recordIntent(kind: BrowserViewIntent['kind']): void
  log(message: string): void
}

export class BrowserVisibilityRuntime {
  private readonly state = new BrowserVisibilityCommandState()

  constructor(private readonly deps: BrowserVisibilityRuntimeDeps) {}

  shouldPresentHosts(): boolean {
    return this.state.shouldPresentHosts()
  }

  hideAll(payload?: { requestId?: number }): { success: boolean } {
    if (!this.state.applyHide(payload?.requestId)) return { success: true }
    this.deps.clearAgentPointer()
    this.deps.log(`[browser-host][visibility] hideAll request=${String(payload?.requestId || 'none')}`)
    return this.applyAndReconcile(() => this.deps.hideAllHosts())
  }

  hideActive(payload?: { requestId?: number }): { success: boolean } {
    if (!this.state.applyHide(payload?.requestId)) return { success: true }
    this.deps.clearAgentPointer()
    this.deps.log(`[browser-host][visibility] hideActive request=${String(payload?.requestId || 'none')}`)
    return this.applyAndReconcile(() => this.deps.hideActiveHost())
  }

  showActive(payload?: { requestId?: number }): { success: boolean } {
    if (!this.state.applyShow(payload?.requestId)) return { success: true }
    this.deps.log(`[browser-host][visibility] showActive request=${String(payload?.requestId || 'none')}`)
    return this.applyAndReconcile(() => this.deps.showActiveHost())
  }

  applyIntent(intent: BrowserViewIntent): { success: boolean } {
    this.deps.recordIntent(intent.kind)
    if (intent.kind === 'hide-all') {
      if (!this.state.applyHide(intent.intentId)) return { success: true }
      this.deps.clearAgentPointer()
      this.deps.log(`[browser-host][intent] hide-all intentId=${intent.intentId} reason=${intent.reason}`)
    } else if (intent.kind === 'show') {
      if (!this.state.applyShow(intent.intentId)) return { success: true }
      this.deps.log(`[browser-host][intent] show intentId=${intent.intentId} tab=${intent.tabId} reason=${intent.reason}`)
    } else if (intent.kind === 'hide') {
      this.deps.clearAgentPointer()
      this.deps.log(`[browser-host][intent] hide intentId=${intent.intentId} tab=${intent.tabId} reason=${intent.reason}`)
    } else if (intent.kind === 'set-bounds') {
      this.deps.clearAgentPointer()
    } else if (intent.kind !== 'secondary-set-bounds') {
      return { success: false }
    }
    return this.applyAndReconcile(() => this.deps.applyIntent(intent))
  }

  private applyAndReconcile(action: () => { success: boolean }): { success: boolean } {
    const result = action()
    this.deps.reconcileLoadStates()
    return result
  }
}
