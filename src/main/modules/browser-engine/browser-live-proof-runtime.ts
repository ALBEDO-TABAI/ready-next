import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import {
  bootIncarnationIdFromPhysicalTargetToken,
  partitionForBrowserProfile,
} from './browser-target-claims'
import { agentBrowserError, isAgentBrowserError } from './agent-browser-errors'
import { READY_BROWSER_BLANK_URL } from '../../../shared/browser-defaults'
import { publishBrowserAgentActionLifecycle } from './ipc-browser-lock-overlay'
import { type Tab } from './browser-controller-contract-base'
import { BrowserHumanTakeoverRuntime } from './browser-human-takeover-runtime'

export abstract class BrowserLiveProofRuntime extends BrowserHumanTakeoverRuntime {
  protected isP7cLiveProofEnabled(): boolean {
    return process.env.READY_P7C_LIVE_PROOF === '1'
  }

  protected async readP7cLiveProofPageState(tab: Tab): Promise<{
    focusToken: string
    scrollX: number
    scrollY: number
    url: string
    title: string
  }> {
    if (!tab.view?.webContents) throw new Error('active tab has no browser webContents')
    const pageState = await tab.view.webContents.executeJavaScript(`(() => {
      const active = document.activeElement;
      const tokenParts = [];
      if (active) {
        tokenParts.push(active.tagName || '');
        tokenParts.push(active.id || '');
        tokenParts.push(active.getAttribute('name') || '');
        tokenParts.push(active.getAttribute('role') || '');
        tokenParts.push(active.getAttribute('aria-label') || '');
        tokenParts.push(active.className && typeof active.className === 'string' ? active.className : '');
      }
      return {
        focusToken: tokenParts.join('#'),
        scrollX: Math.round(window.scrollX || document.documentElement.scrollLeft || document.body.scrollLeft || 0),
        scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0),
        url: location.href,
        title: document.title || '',
      };
    })()`, true) as {
      focusToken?: unknown
      scrollX?: unknown
      scrollY?: unknown
      url?: unknown
      title?: unknown
    }
    return {
      focusToken: String(pageState?.focusToken || ''),
      scrollX: Number(pageState?.scrollX || 0),
      scrollY: Number(pageState?.scrollY || 0),
      url: String(pageState?.url || tab.url || ''),
      title: String(pageState?.title || tab.title || ''),
    }
  }

  async prepareP7cLiveProofForegroundProbe(): Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.view?.webContents) return { success: false, error: 'no active browser webContents' }
    try {
      await tab.view.webContents.executeJavaScript(`(() => {
        document.title = 'Ready P7c2 foreground proof';
        document.body.innerHTML = [
          '<main id="ready-p7c2-proof-root" style="min-height:2400px;padding:24px;font-family:sans-serif">',
          '<label for="ready-p7c2-focus">P7c2 focus target</label>',
          '<input id="ready-p7c2-focus" name="ready-p7c2-focus" aria-label="P7c2 focus target" value="focus target" />',
          '<section style="height:1800px">scroll proof spacer</section>',
          '</main>'
        ].join('');
        const input = document.getElementById('ready-p7c2-focus');
        if (input) input.focus();
        window.scrollTo(0, 360);
        return true;
      })()`, true)
      const state = await this.readP7cLiveProofPageState(tab)
      return { success: true, state: { tabId: tab.id, ...state } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async sampleP7cLiveProofActiveTabState(): Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.view?.webContents) return { success: false, error: 'no active browser webContents' }
    try {
      const state = await this.readP7cLiveProofPageState(tab)
      return { success: true, state: { tabId: tab.id, ...state } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async createP7cLiveProofManualTab(): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const created = await this.createTab(READY_BROWSER_BLANK_URL)
    if (!created.success || !created.tabId) {
      return { success: false, error: created.error || 'failed to create p7c proof tab' }
    }
    this.updateTabRuntimeState(created.tabId, { owner: 'manual', activity: 'idle', required: false })
    return { success: true, tabId: created.tabId }
  }

  startP7cLiveProofUserViewLease(): { success: boolean; leaseId?: string; tabId?: string; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.id) return { success: false, error: 'no active browser tab' }
    const physicalTargetToken = this.getPhysicalTargetToken(tab.id)
    if (!physicalTargetToken) return { success: false, error: 'physical target unavailable' }
    const service = getBrowserTargetClaimService()
    const ownerRunId = `p7c-live-proof-${Date.now()}`
    const claim = service.acquire({
      partition: partitionForBrowserProfile(tab.profile),
      physicalTargetToken,
      bootIncarnationId: bootIncarnationIdFromPhysicalTargetToken(physicalTargetToken),
      profileId: tab.profile || null,
      surface: 'user-view',
      parentTaskId: 'p7c-live-proof',
      browserTaskId: 'p7c-live-proof',
      ownerRunId,
      scopeId: null,
      sessionId: null,
      tabId: tab.id,
      ttlMs: 30_000,
    })
    if (isAgentBrowserError(claim)) {
      return { success: false, error: claim.message || claim.errorCode }
    }
    this.p7cLiveProofClaimIdentity = {
      partition: claim.logicalKey.partition,
      tabId: claim.logicalKey.tabId,
      physicalTargetToken: claim.physicalTargetToken!,
      bootIncarnationId: claim.bootIncarnationId!,
      claimId: claim.claimId,
      generation: claim.generation,
      ownerRunId: claim.ownerRunId,
    }
    return { success: true, leaseId: claim.claimId, tabId: tab.id }
  }

  sendP7cLiveProofUserKey(key = 'a'): { success: boolean; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    const webContents = tab?.view?.webContents
    if (!webContents) return { success: false, error: 'no active browser webContents' }
    webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return { success: true }
  }

  async sendP7cLiveProofAgentClick(
    x = 140,
    y = 160,
  ): Promise<{ success: boolean; tabId?: string; x?: number; y?: number; error?: string }> {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const tab = this.getActiveTab()
    if (!tab?.id || !tab.view?.webContents) {
      return { success: false, error: 'no active browser webContents' }
    }
    try {
      const metrics = await this.getViewportMetrics(tab.id)
      const clickX = Math.max(0, Math.min(Math.max(0, metrics.width - 1), Math.round(x)))
      const clickY = Math.max(0, Math.min(Math.max(0, metrics.height - 1), Math.round(y)))
      publishBrowserAgentActionLifecycle('start')
      await this.dispatchMouse(tab.id, { type: 'mouseMoved', x: clickX, y: clickY, button: 'none' })
      await this.dispatchMouse(tab.id, {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await this.dispatchMouse(tab.id, {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      return { success: true, tabId: tab.id, x: clickX, y: clickY }
    } catch (error) {
      publishBrowserAgentActionLifecycle('abort')
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  finishP7cLiveProofAgentAction(
    phase: 'finish' | 'abort' = 'finish',
  ): { success: boolean; phase?: 'finish' | 'abort'; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    publishBrowserAgentActionLifecycle(phase)
    return { success: true, phase }
  }

  checkP7cLiveProofWriteDenied(): { success: boolean; errorKind?: string; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    const denied = this.p7cLiveProofClaimIdentity
      ? getBrowserTargetClaimService().checkWrite(this.p7cLiveProofClaimIdentity)
      : agentBrowserError('lease_required', 'proof claim missing')
    if (!denied) return { success: false, error: 'write was still allowed' }
    return { success: true, errorKind: denied.errorCode }
  }

  clearP7cLiveProofState(): { success: boolean; error?: string } {
    if (!this.isP7cLiveProofEnabled()) {
      return { success: false, error: 'p7c live proof is disabled' }
    }
    if (this.p7cLiveProofClaimIdentity) {
      getBrowserTargetClaimService().closeTarget(this.p7cLiveProofClaimIdentity)
    }
    this.p7cLiveProofClaimIdentity = null
    publishBrowserAgentActionLifecycle('abort')
    return { success: true }
  }

}
