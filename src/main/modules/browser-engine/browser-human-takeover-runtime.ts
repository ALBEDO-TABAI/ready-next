import type {
  BrowserCapabilityTaskHandle
} from './capability-types'
import {
  createAgentTabUserInputTakeoverHandlers,
  isAgentNavigationEcho,
} from './agent-tab-control-gate'
import { getBrowserTargetClaimService } from './browser-target-claim-singleton'
import { isAgentBrowserError } from './agent-browser-errors'
import type { BrowserLeaseSupervisionSnapshot } from './ipc-supervision'
import { buildBrowserLeaseSupervisionSnapshot } from './browser-lease-supervision-snapshot'
import type {
  BrowserHumanTakeoverPhysicalTarget
} from '../../../shared/browser-workflow-control'
import { BrowserControllerHostRuntime } from './browser-controller-host-runtime'

export abstract class BrowserHumanTakeoverRuntime extends BrowserControllerHostRuntime {
  protected attachAgentTabSupervision(tabId: string): void {
    const webContents = this.tabs.get(tabId)?.view?.webContents
    if (!webContents || this.supervisedAgentTabWebContentsIds.has(webContents.id)) return
    this.supervisedAgentTabWebContentsIds.add(webContents.id)
    webContents.once('destroyed', () => {
      this.supervisedAgentTabWebContentsIds.delete(webContents.id)
    })
    const inputTakeover = createAgentTabUserInputTakeoverHandlers({
      isActivelyDriven: () => this.isAgentActivelyDrivingTab(tabId),
      isFrozen: () => this.pendingPhysicalTakeovers.has(tabId),
      isAgentKey: (key) => this.agentInputPassthrough.matchKey(key),
      isAgentMouse: () => this.agentInputPassthrough.matchMouse(),
      takeOver: () => { void this.requestAgentInterruption(tabId, 'physical_input') },
    })
    webContents.on('before-input-event', (event, input) => {
      inputTakeover.onKeyboardInput(event, input)
    })
    webContents.on('before-mouse-event', (event, mouse) => {
      inputTakeover.onMouseInput(event, mouse)
    })
  }

  /** A tab is actively driven only while its exact target claim is held. */
  protected isAgentActivelyDrivingTab(tabId: string): boolean {
    if (getBrowserTargetClaimService().list().some((claim) => (
      claim.logicalKey.tabId === tabId && claim.state === 'held'
    ))) return true
    return false
  }

  protected notifyAgentControlChanged(takeoverError?: string | null): void {
    this.sendToRenderer('browser:agentControlChanged', {
      state: this.getAgentControlState(),
      takeoverError: takeoverError || null,
    })
  }

  protected notifyBrowserLeaseChanged(): void {
    this.sendToRenderer('browser:leaseChanged', this.getBrowserLeaseSnapshot())
  }

  protected attachTargetClaimSupervision(tabId: string): void {
    this.attachAgentTabSupervision(tabId)
  }

  protected requestNavigationTakeover(
    tabId: string,
    action: 'navigate' | 'back' | 'forward' | 'reload',
  ): void {
    const claim = getBrowserTargetClaimService().list().find((candidate) => (
      candidate.logicalKey.tabId === tabId && candidate.state === 'held'
    ))
    const binding = this.workflowPhysicalBindings.get(tabId)
    const physicalTargetToken = this.getPhysicalTargetToken(tabId)
    if (
      !claim
      || !binding
      || binding.claimId !== claim.claimId
      || binding.generation !== claim.generation
      || binding.ownerRunId !== claim.ownerRunId
      || !physicalTargetToken
      || claim.physicalTargetToken !== physicalTargetToken
      || !claim.bootIncarnationId
    ) return
    void this.requestAgentInterruption(tabId, 'physical_input', 'navigation', {
      action,
      tabId,
      physicalTargetToken,
      bootIncarnationId: claim.bootIncarnationId,
      claimId: claim.claimId,
      generation: claim.generation,
      ownerRunId: claim.ownerRunId,
    })
  }

  getAgentTabId(): string | null {
    const tab = this.agentTabId ? this.tabs.get(this.agentTabId) : null
    return tab?.owner === 'agent' ? this.agentTabId : null
  }

  /** Agent-view browser tasks (for supervision and immediate takeover). */
  async listAgentCollectionTasks(): Promise<BrowserCapabilityTaskHandle[]> {
    return []
  }

  /**
   * Freeze and transfer agent-view control in one action. Everything before the
   * first await is synchronous so a real key/mouse event can continue to the
   * page after the lease has already rejected further agent writes.
   */
  async requestAgentInterruption(
    requestedTabId?: string | null,
    source: BrowserHumanTakeoverPhysicalTarget['source'] = 'supervision_button',
    signalSource: 'keyboard' | 'pointer' | 'navigation' | 'explicit-button' = source === 'supervision_button'
      ? 'explicit-button'
      : 'keyboard',
    expectedNavigationTarget?: {
      action: 'navigate' | 'back' | 'forward' | 'reload'
      tabId: string
      physicalTargetToken: string
      bootIncarnationId: string
      claimId: string
      generation: number
      ownerRunId: string
    },
  ): Promise<{
    state: 'active' | 'frozen'
    frozen: boolean
    takeoverTabId?: string | null
  }> {
    const claimService = getBrowserTargetClaimService()
    const claims = claimService.list().filter((claim) => claim.state === 'held')
    const selected = requestedTabId
      ? claims.find((claim) => claim.logicalKey.tabId === requestedTabId) || null
      : claims.find((claim) => claim.logicalKey.tabId === this.agentTabId)
        || claims[0]
        || null
    const takeoverTabId = requestedTabId || selected?.logicalKey.tabId || this.agentTabId
    const binding = takeoverTabId ? this.workflowPhysicalBindings.get(takeoverTabId) || null : null
    const physicalTargetToken = takeoverTabId ? this.getPhysicalTargetToken(takeoverTabId) : ''
    if (
      !selected
      || !takeoverTabId
      || !binding
      || binding.claimId !== selected.claimId
      || binding.generation !== selected.generation
      || !physicalTargetToken
      || (expectedNavigationTarget && (
        signalSource !== 'navigation'
        || expectedNavigationTarget.tabId !== takeoverTabId
        || expectedNavigationTarget.physicalTargetToken !== physicalTargetToken
        || expectedNavigationTarget.bootIncarnationId !== selected.bootIncarnationId
        || expectedNavigationTarget.claimId !== selected.claimId
        || expectedNavigationTarget.generation !== selected.generation
        || expectedNavigationTarget.ownerRunId !== selected.ownerRunId
      ))
    ) {
      return { state: this.getAgentControlState(), frozen: false, takeoverTabId: takeoverTabId || null }
    }
    if (isAgentNavigationEcho({
      signalSource,
      hasActiveAgentAction: claimService.hasActiveAgentAction({
        partition: selected.logicalKey.partition,
        tabId: selected.logicalKey.tabId,
        physicalTargetToken: selected.physicalTargetToken!,
        bootIncarnationId: selected.bootIncarnationId!,
        claimId: selected.claimId,
        generation: selected.generation,
        ownerRunId: selected.ownerRunId,
      }),
    })) {
      return { state: this.getAgentControlState(), frozen: false, takeoverTabId }
    }
    this.pendingPhysicalTakeovers.add(takeoverTabId)
    this.notifyAgentControlChanged()
    const frozen = claimService.takeOver({
      partition: selected.logicalKey.partition,
      tabId: selected.logicalKey.tabId,
      physicalTargetToken,
      bootIncarnationId: selected.bootIncarnationId!,
      claimId: selected.claimId,
      generation: selected.generation,
      ownerRunId: selected.ownerRunId,
    })
    if (isAgentBrowserError(frozen)) {
      this.notifyBrowserLeaseChanged()
      this.notifyAgentControlChanged('已封住 Agent 的页面写入；接管状态暂时无法持久化。')
      return { state: 'frozen', frozen: true, takeoverTabId }
    }

    if (takeoverTabId && this.tabs.has(takeoverTabId)) {
      this.updateTabRuntimeState(takeoverTabId, { owner: 'manual', activity: 'attention' })
      this.syncPopupContextForTab(takeoverTabId)
      if (takeoverTabId === this.agentTabId) this.agentTabId = null
    }
    this.pendingPhysicalTakeovers.delete(takeoverTabId)
    this.notifyBrowserLeaseChanged()
    this.notifyAgentControlChanged(null)

    return { state: 'frozen', frozen: true, takeoverTabId }
  }

  getAgentControlState(): 'active' | 'frozen' {
    const liveTabIds = new Set(this.tabs.keys())
    return this.pendingPhysicalTakeovers.size > 0
      || getBrowserTargetClaimService().list().some((claim) => (
        claim.state === 'user_owned'
        && Boolean(claim.physicalTargetToken)
        && Boolean(claim.bootIncarnationId)
        && liveTabIds.has(claim.logicalKey.tabId)
      ))
      ? 'frozen'
      : 'active'
  }

  getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot {
    return buildBrowserLeaseSupervisionSnapshot(
      getBrowserTargetClaimService(),
      this.activeTabId,
    )
  }

}
