import { useCallback, useEffect, useRef, useState } from 'react'

import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'
import type { BrowserSupervisionVisibleTaskStatus } from '../../../shared/browser-task-status'

/**
 * Polls the agent-browser supervision state (plan §3.6): the control-gate state
 * + active agent-view browser tasks. Polling remains the fallback; the
 * lease snapshot also has a push path so ownership chips update immediately
 * when the user takes over the visible browser surface.
 */

/** Agent-browser control-gate state. */
export type AgentBrowserControlState = 'active' | 'frozen'
export type AgentBrowserSurface = 'user-view' | 'agent-view'
export type BrowserLeaseState = 'idle' | 'held' | 'takeover' | 'expired'

export interface BrowserLeaseSurfaceSnapshot {
  surface: AgentBrowserSurface
  state: BrowserLeaseState
  heldBy: string | null
  runId: string | null
  tabId: string | null
  leaseId: string | null
}

export interface BrowserTargetClaimSnapshot {
  partition: string
  tabId: string
  surface: AgentBrowserSurface
  state: 'held' | 'user_owned' | 'suspended' | 'expired' | 'released'
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  claimId: string
  generation: number
  suspensionCheckpointId: string | null
  suspensionReason: string | null
}

/** An agent-view browser task surfaced to the supervision panel. */
export interface AgentBrowserCollectionTask {
  taskId: string
  kind: string
  status: BrowserSupervisionVisibleTaskStatus | 'completed' | 'failed' | 'cancelled'
  progress: { total: number; completed: number; failed: number; currentLabel: string | null }
  result?: unknown
  error?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface AgentBrowserSupervisionState {
  controlState: AgentBrowserControlState
  agentTabId: string | null
  tasks: AgentBrowserCollectionTask[]
  claims: BrowserTargetClaimSnapshot[]
  surfaces: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot> | null
  activeWriteSurface: AgentBrowserSurface | null
  takeoverError: string | null
}

export interface BrowserLeaseSupervisionSnapshot {
  claims?: BrowserTargetClaimSnapshot[]
  surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  activeWriteSurface?: AgentBrowserSurface | null
}

const EMPTY: AgentBrowserSupervisionState = { controlState: 'active', agentTabId: null, tasks: [], claims: [], surfaces: null, activeWriteSurface: null, takeoverError: null }
const POLL_MS = 2500

interface BrowserTabInfoLike {
  id: string
  url: string
  title?: string
  domain?: string
  favicon?: string | null
  profile?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string | null
}

function toBrowserTab(tab: BrowserTabInfoLike): BrowserTab {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title || 'New Tab',
    loading: Boolean(tab.loading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    domain: tab.domain || extractBrowserDomain(tab.url),
    favicon: tab.favicon || undefined,
    profile: tab.profile || null,
    owner: tab.owner,
    required: tab.required,
    activity: tab.activity,
    lastAuditedAt: tab.lastAuditedAt,
    error: tab.error || undefined,
  }
}

async function syncAgentTabFromRuntime(
  api: NonNullable<typeof window.electronAPI>['browser'],
  agentTabId: string,
): Promise<void> {
  if (!api?.getTabs) return
  const runtimeTabs = await api.getTabs()
  if (!Array.isArray(runtimeTabs)) return
  const agentTab = runtimeTabs.find((tab) => tab.id === agentTabId)
  if (!agentTab) return

  const store = useBrowserTabs.getState()
  const nextTab = toBrowserTab(agentTab)
  if (store.tabs.some((tab) => tab.id === agentTabId)) {
    store.updateTab(agentTabId, nextTab)
  } else {
    store.addTab(nextTab)
  }

  const nextStore = useBrowserTabs.getState()
  if (nextStore.activeTabId !== agentTabId) return
  const fallback = nextStore.tabs.find((tab) => tab.id !== agentTabId && tab.owner !== 'agent')
  if (!fallback) return
  nextStore.setActiveTabId(fallback.id)
  nextStore.setUrlInput(fallback.url === DEFAULT_BROWSER_URL ? '' : fallback.url)
}

export function applyLeaseSnapshotToSupervisionState(
  current: AgentBrowserSupervisionState,
  snapshot: BrowserLeaseSupervisionSnapshot,
): AgentBrowserSupervisionState {
  const hasActiveWriteSurface = Object.prototype.hasOwnProperty.call(snapshot, 'activeWriteSurface')
  return {
    ...current,
    claims: snapshot.claims ?? current.claims,
    surfaces: snapshot.surfaces ?? current.surfaces,
    activeWriteSurface: hasActiveWriteSurface
      ? snapshot.activeWriteSurface ?? null
      : current.activeWriteSurface,
  }
}

export function useAgentBrowserSupervision(): AgentBrowserSupervisionState & {
  requestInterruption: () => Promise<void>
} {
  const [state, setState] = useState<AgentBrowserSupervisionState>(EMPTY)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.browser
    if (!api?.getAgentSupervisionState) return
    try {
      const next = await api.getAgentSupervisionState()
      if (mounted.current && next) {
        if (next.agentTabId) {
          await syncAgentTabFromRuntime(api, next.agentTabId)
        }
        setState((current) => ({
          controlState: next.controlState,
          agentTabId: next.agentTabId,
          tasks: next.tasks ?? [],
          claims: next.claims ?? [],
          surfaces: next.surfaces ?? null,
          activeWriteSurface: next.activeWriteSurface ?? null,
          takeoverError: current.takeoverError,
        }))
      }
    } catch {
      // silent-catch: transient IPC failure keeps the last known supervision state.
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const id = window.setInterval(refresh, POLL_MS)
    // Push: refresh immediately when the user takes over instead of waiting for
    // the next poll.
    const off = window.electronAPI?.browser?.onAgentControlChanged?.((event) => {
      if (mounted.current) {
        setState((current) => ({ ...current, controlState: event.state, takeoverError: event.takeoverError || null }))
      }
      void refresh()
    })
    const offLease = window.electronAPI?.browser?.onLeaseChanged?.((snapshot) => {
      if (!mounted.current) return
      setState((current) => applyLeaseSnapshotToSupervisionState(current, snapshot))
    })
    return () => {
      mounted.current = false
      window.clearInterval(id)
      off?.()
      offLease?.()
    }
  }, [refresh])

  const requestInterruption = useCallback(async () => {
    const result = await window.electronAPI?.browser?.requestAgentInterruption?.()
    if (result?.frozen && result.takeoverTabId) {
      const api = window.electronAPI?.browser
      if (api) {
        await syncAgentTabFromRuntime(api, result.takeoverTabId).catch(() => undefined)
      }
      useBrowserTabs.getState().setSplitTabId(result.takeoverTabId)
    }
    await refresh()
  }, [refresh])

  return { ...state, requestInterruption }
}
