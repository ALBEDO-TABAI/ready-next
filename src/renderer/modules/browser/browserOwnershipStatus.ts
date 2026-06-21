export type BrowserOwnershipControlState = 'active' | 'pending_confirm' | 'frozen'
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
  | 'pending-confirm'
  | 'frozen'
  | 'takeover'

export interface BrowserOwnershipStatus {
  kind: BrowserOwnershipKind
  label: string
  detail: string
  tone: 'neutral' | 'agent' | 'warning'
}

export function resolveBrowserOwnershipStatus(input: {
  activeTab: BrowserOwnershipTabLike | null
  agentTabId: string | null
  activeAgentTaskCount: number
  controlState: BrowserOwnershipControlState
  surfaces?: Record<BrowserOwnershipSurface, BrowserOwnershipSurfaceSnapshot> | null
  activeWriteSurface?: BrowserOwnershipSurface | null
}): BrowserOwnershipStatus {
  if (input.controlState === 'frozen') {
    return {
      kind: 'frozen',
      label: '已接管',
      detail: 'Agent 浏览器控制已冻结',
      tone: 'warning',
    }
  }
  if (input.controlState === 'pending_confirm') {
    return {
      kind: 'pending-confirm',
      label: '等待确认',
      detail: '确认后中断 Agent 浏览器控制',
      tone: 'warning',
    }
  }
  if (input.surfaces?.['user-view']?.state === 'takeover' || input.surfaces?.['agent-view']?.state === 'takeover') {
    return {
      kind: 'takeover',
      label: '用户接管',
      detail: 'Agent 写入已暂停',
      tone: 'warning',
    }
  }
  if (input.activeWriteSurface === 'user-view') {
    const heldBy = input.surfaces?.['user-view']?.heldBy
    return {
      kind: 'agent-current',
      label: 'Agent 协作当前页',
      detail: heldBy ? `当前可见页写锁：${heldBy}` : 'Agent 正在协作当前可见页',
      tone: 'agent',
    }
  }
  if (input.activeWriteSurface === 'agent-view') {
    const heldBy = input.surfaces?.['agent-view']?.heldBy
    return {
      kind: 'agent-background',
      label: 'Agent 后台页',
      detail: heldBy ? `后台 Agent 页写锁：${heldBy}` : 'Agent 正在后台 Agent 页工作',
      tone: 'agent',
    }
  }
  if (input.activeTab?.owner === 'agent' || (input.agentTabId && input.activeTab?.id === input.agentTabId)) {
    return {
      kind: 'agent-current',
      label: 'Agent 协作当前页',
      detail: 'Agent 正在使用可见浏览器',
      tone: 'agent',
    }
  }
  if (input.agentTabId || input.activeAgentTaskCount > 0) {
    return {
      kind: 'agent-background',
      label: 'Agent 后台页',
      detail: input.activeAgentTaskCount > 0
        ? `${input.activeAgentTaskCount} 个后台 Agent 浏览任务`
        : '后台 Agent 标签页待命',
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
