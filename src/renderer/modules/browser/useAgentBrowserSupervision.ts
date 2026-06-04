import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Polls the agent-browser supervision state (plan §3.6): the control-gate state
 * + active background note-collection tasks. A progress panel does not need
 * sub-second latency, so we poll (2.5s) rather than add a push pipeline; the
 * data bridge is browser.getAgentSupervisionState. Returns the state plus the
 * two-step interrupt actions.
 */

/** Agent-browser control-gate state (plan §3.6). */
export type AgentBrowserControlState = 'active' | 'pending_confirm' | 'frozen'

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
}

const EMPTY: AgentBrowserSupervisionState = { controlState: 'active', agentTabId: null, tasks: [] }
const POLL_MS = 2500

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
        setState({ controlState: next.controlState, agentTabId: next.agentTabId, tasks: next.tasks ?? [] })
      }
    } catch {
      // transient IPC failure — keep the last known state
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
    return () => {
      mounted.current = false
      window.clearInterval(id)
      off?.()
    }
  }, [refresh])

  const requestInterruption = useCallback(async () => {
    await window.electronAPI?.browser?.requestAgentInterruption?.()
    await refresh()
  }, [refresh])

  const confirmInterruption = useCallback(async () => {
    await window.electronAPI?.browser?.confirmAgentInterruption?.()
    await refresh()
  }, [refresh])

  const dismissInterruption = useCallback(async () => {
    await window.electronAPI?.browser?.dismissAgentInterruption?.()
    await refresh()
  }, [refresh])

  return { ...state, requestInterruption, confirmInterruption, dismissInterruption }
}
