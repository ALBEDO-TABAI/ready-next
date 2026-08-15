export type BrowserOwnershipControlState = 'active' | 'frozen'
export type BrowserOwnershipSurface = 'user-view' | 'agent-view'
export type BrowserOwnershipLeaseState = 'idle' | 'held' | 'takeover' | 'expired'

export interface BrowserOwnershipSurfaceSnapshot {
  surface: BrowserOwnershipSurface
  state: BrowserOwnershipLeaseState
  heldBy: string | null
  runId: string | null
  tabId: string | null
  leaseId: string | null
}

export interface BrowserOwnershipTabLike {
  id: string
  owner?: 'manual' | 'agent'
  activity?: 'idle' | 'running' | 'attention'
}

export type BrowserOwnershipKind =
  | 'user-view'
  | 'agent-current'
  | 'agent-background'
  | 'frozen'
  | 'takeover'

export interface BrowserOwnershipStatus {
  kind: BrowserOwnershipKind
  label: string
  detail: string
  tone: 'neutral' | 'agent' | 'warning'
}

function surfaceMatchesTab(
  surface: BrowserOwnershipSurfaceSnapshot | null | undefined,
  currentTabId: string | null,
): boolean {
  return Boolean(surface && (!surface.tabId || !currentTabId || surface.tabId === currentTabId))
}

export function resolveBrowserOwnershipStatus(input: {
  activeTab: BrowserOwnershipTabLike | null
  agentTabId: string | null
  activeAgentTaskCount: number
  controlState: BrowserOwnershipControlState
  surfaces?: Record<BrowserOwnershipSurface, BrowserOwnershipSurfaceSnapshot> | null
  claims?: ReadonlyArray<{ tabId: string; state: string; surface?: BrowserOwnershipSurface }> | null
  activeWriteSurface?: BrowserOwnershipSurface | null
}): BrowserOwnershipStatus {
  const currentTabId = input.activeTab?.id || null
  const claims = input.claims ?? []
  const currentHeld = currentTabId
    ? claims.find((claim) => claim.tabId === currentTabId && claim.state === 'held')
    : null
  const claimTakeover = currentTabId
    ? claims.find((claim) => claim.tabId === currentTabId && claim.state === 'user_owned')
    : null
  const takeoverSurface = claimTakeover
    ? {
        surface: 'user-view' as const,
        state: 'takeover' as const,
        heldBy: null,
        runId: null,
        tabId: claimTakeover.tabId,
        leaseId: null,
      }
    : input.surfaces?.['user-view']?.state === 'takeover'
      ? input.surfaces['user-view']
      : input.surfaces?.['agent-view']?.state === 'takeover'
        ? input.surfaces['agent-view']
        : null
  const takeoverOnCurrentPage = Boolean(
    takeoverSurface
    && (
      !takeoverSurface.tabId
      || !currentTabId
      || takeoverSurface.tabId === currentTabId
    ),
  )
  const otherTabTakeover = Boolean(
    claims.some((claim) => (
      claim.state === 'user_owned'
      && Boolean(claim.tabId)
      && claim.tabId !== currentTabId
    ))
    || (
      takeoverSurface?.tabId
      && currentTabId
      && takeoverSurface.tabId !== currentTabId
    ),
  )
  const otherTabHeld = claims.some((claim) => (
    claim.state === 'held'
    && Boolean(claim.tabId)
    && claim.tabId !== currentTabId
  ))
  const userViewHeldOnCurrent = Boolean(
    currentHeld?.surface === 'user-view'
    || (
      !currentHeld
      && input.surfaces?.['user-view']?.state === 'held'
      && surfaceMatchesTab(input.surfaces['user-view'], currentTabId)
    ),
  )
  const currentTabOccupied = Boolean(currentHeld || userViewHeldOnCurrent)
  const backgroundOccupied = Boolean(
    otherTabHeld
    || input.surfaces?.['agent-view']?.state === 'held'
    || input.activeWriteSurface === 'agent-view'
    || input.activeAgentTaskCount > 0,
  )
  if (input.controlState === 'frozen' && (takeoverOnCurrentPage || !otherTabTakeover)) {
    return {
      kind: 'frozen',
      label: '已接管',
      detail: 'Agent 浏览器控制已冻结',
      tone: 'warning',
    }
  }
  if (takeoverOnCurrentPage && takeoverSurface) {
    return {
      kind: 'takeover',
      label: '用户接管',
      detail: 'Agent 写入已暂停',
      tone: 'warning',
    }
  }
  if (currentTabOccupied) {
    const heldBy = currentHeld?.surface === 'agent-view'
      ? input.surfaces?.['agent-view']?.heldBy
      : input.surfaces?.['user-view']?.heldBy
    return {
      kind: 'agent-current',
      label: 'Agent 协作当前页',
      detail: heldBy ? `当前可见页写锁：${heldBy}` : 'Agent 正在协作当前可见页',
      tone: 'agent',
    }
  }
  if (input.activeTab?.activity === 'running'
    && (input.activeTab.owner === 'agent' || (input.agentTabId && input.activeTab.id === input.agentTabId))) {
    return {
      kind: 'agent-current',
      label: 'Agent 协作当前页',
      detail: 'Agent 正在使用可见浏览器',
      tone: 'agent',
    }
  }
  if (backgroundOccupied) {
    const heldBy = input.surfaces?.['agent-view']?.heldBy
    return {
      kind: 'agent-background',
      label: 'Agent 后台页',
      detail: heldBy
        ? `后台 Agent 页写锁：${heldBy}`
        : input.activeAgentTaskCount > 0
          ? `${input.activeAgentTaskCount} 个后台 Agent 浏览任务`
          : 'Agent 正在其他标签页工作',
      tone: 'agent',
    }
  }
  return {
    kind: 'user-view',
    label: '用户浏览',
    detail: '当前可见页由你控制',
    tone: 'neutral',
  }
}
