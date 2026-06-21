import { useCallback, useEffect, useRef, useState } from 'react'

import { useBrowserTabs, type BrowserTab } from '../../stores/useBrowserTabs'
import { DEFAULT_BROWSER_URL, extractBrowserDomain } from './url-utils'

/**
 * Polls the agent-browser supervision state (plan §3.6): the control-gate state
 * + active background note-collection tasks. Polling remains the fallback; the
 * lease snapshot also has a push path so ownership chips update immediately
 * when the user takes over the visible browser surface.
 */

/** Agent-browser control-gate state (plan §3.6). */
export type AgentBrowserControlState = 'active' | 'pending_confirm' | 'frozen'
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

/** A background note-collection task surfaced to the supervision panel. */
export interface AgentBrowserCollectionTask {
  taskId: string
  kind: string
  status: 'queued' | 'running' | 'waiting_human' | 'paused' | 'completed' | 'failed' | 'cancelled'
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
  surfaces: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot> | null
  activeWriteSurface: AgentBrowserSurface | null
}

export interface BrowserLeaseSupervisionSnapshot {
  surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  activeWriteSurface?: AgentBrowserSurface | null
}

const EMPTY: AgentBrowserSupervisionState = { controlState: 'active', agentTabId: null, tasks: [], surfaces: null, activeWriteSurface: null }
const POLL_MS = 2500

interface BrowserTabInfoLike {
  id: string
  url: string
  title?: string
  domain?: string
  favicon?: string | null
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
    surfaces: snapshot.surfaces ?? current.surfaces,
    activeWriteSurface: hasActiveWriteSurface
      ? snapshot.activeWriteSurface ?? null
      : current.activeWriteSurface,
  }
}

export function useAgentBrowserSupervision(): AgentBrowserSupervisionState & {
  requestInterruption: () => Promise<void>
  confirmInterruption: () => Promise<void>
  dismissInterruption: () => Promise<void>
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
        setState({
          controlState: next.controlState,
          agentTabId: next.agentTabId,
          tasks: next.tasks ?? [],
          surfaces: next.surfaces ?? null,
          activeWriteSurface: next.activeWriteSurface ?? null,
        })
      }
    } catch {
      // silent-catch: transient IPC failure keeps the last known supervision state.
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const id = window.setInterval(refresh, POLL_MS)
    // Push: refresh immediately when the control gate changes (e.g. the user
    // touches the agent tab → pending_confirm) instead of waiting for the poll.
    const off = window.electronAPI?.browser?.onAgentControlChanged?.(() => {
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
    await window.electronAPI?.browser?.requestAgentInterruption?.()
    await refresh()
  }, [refresh])

  const confirmInterruption = useCallback(async () => {
    const result = await window.electronAPI?.browser?.confirmAgentInterruption?.()
    if (result?.frozen && result.takeoverTabId) {
      const api = window.electronAPI?.browser
      if (api) {
        await syncAgentTabFromRuntime(api, result.takeoverTabId).catch(() => undefined)
      }
      useBrowserTabs.getState().setSplitTabId(result.takeoverTabId)
    }
    await refresh()
  }, [refresh])

  const dismissInterruption = useCallback(async () => {
    await window.electronAPI?.browser?.dismissAgentInterruption?.()
    await refresh()
  }, [refresh])

  return { ...state, requestInterruption, confirmInterruption, dismissInterruption }
}
