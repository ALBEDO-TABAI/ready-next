import { ipcMain } from 'electron'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserTargetClaimState } from './browser-target-claims'
import type { BrowserTargetResumeRequest } from '../../../shared/browser-workflow-control'
import type { BrowserCapabilityTaskHandle } from './capability-types'
import {
  isBrowserSupervisionVisibleTaskStatus,
  isBrowserSurfacePresentingTaskStatus,
} from '../../../shared/browser-task-status'

/**
 * Agent-browser supervision IPC. Two surfaces:
 *   - immediate user takeover of the agent's browser control;
 *   - listing active agent-view browser tasks for the panel.
 *
 * The control gate + agent tab live on the controller; these handlers are a
 * thin bridge. The renderer polls listAgentTasks/getAgentControlState (no push
 * pipeline) — a progress panel does not need sub-second latency.
 */

export type AgentControlState = 'active' | 'frozen'
export type BrowserLeaseState = 'idle' | 'held' | 'takeover' | 'expired'

export interface BrowserLeaseSurfaceSnapshot {
  surface: AgentBrowserSurface
  state: BrowserLeaseState
  heldBy: string | null
  runId: string | null
  tabId: string | null
  leaseId: string | null
}

export interface BrowserLeaseSupervisionSnapshot {
  claims: Array<{
    partition: string
    tabId: string
    surface: AgentBrowserSurface
    state: BrowserTargetClaimState
    parentTaskId: string
    browserTaskId: string
    ownerRunId: string
    claimId: string
    generation: number
    suspensionCheckpointId: string | null
    suspensionReason: string | null
  }>
  surfaces: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  activeWriteSurface: AgentBrowserSurface | null
}

export type BrowserAgentSupervisionTask = Omit<BrowserCapabilityTaskHandle, 'kind'> & {
  kind: BrowserCapabilityTaskHandle['kind'] | 'browser_workflow' | 'browser_upload_workflow'
}

export interface BrowserSupervisionIPCController {
  requestAgentInterruption(): Promise<{ state: AgentControlState; frozen: boolean; takeoverTabId?: string | null }>
  getAgentControlState(): AgentControlState
  getAgentTabId(): string | null
  getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot
  listAgentCollectionTasks(): Promise<BrowserAgentSupervisionTask[]>
  resumeBrowserTarget(input: BrowserTargetResumeRequest): Promise<{ success: boolean; error?: string; errorKind?: string }>
}

export function setupBrowserSupervisionIPC(controller: BrowserSupervisionIPCController): void {
  ipcMain.handle('browser:requestAgentInterruption', async () => {
    try {
      return await controller.requestAgentInterruption()
    } catch (error) {
      return { state: 'active' as AgentControlState, frozen: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getAgentSupervisionState', async () => {
    try {
      const tasks = await controller.listAgentCollectionTasks()
      const activeTasks = tasks.filter((task) => isBrowserSupervisionVisibleTaskStatus(task.status))
      const surfaceTasks = activeTasks.filter((task) => isBrowserSurfacePresentingTaskStatus(task.status))
      return {
        controlState: controller.getAgentControlState(),
        agentTabId: surfaceTasks.length > 0 ? controller.getAgentTabId() : null,
        tasks: activeTasks,
        ...controller.getBrowserLeaseSnapshot(),
      }
    } catch (error) {
      return { controlState: 'active' as AgentControlState, agentTabId: null, tasks: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:resumeTargetClaim', async (_, input: BrowserTargetResumeRequest) => {
    try {
      return await controller.resumeBrowserTarget(input)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'resume_failed' }
    }
  })
}
