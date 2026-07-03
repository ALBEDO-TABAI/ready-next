import { ipcMain } from 'electron'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserLeaseState } from './browser-write-lease'
import type { BrowserCapabilityTaskHandle } from './capability-types'
import type { BrowserWorkflowSession } from './browser-workflow-session'
import { isBrowserSupervisionVisibleTaskStatus } from '../../../shared/browser-task-status'

/**
 * Agent-browser supervision IPC (plan §3.6/§0.1). Two surfaces:
 *   - the two-step interrupt of the agent's browser control (freeze → confirm),
 *     so a user can only seize control after an explicit second confirmation;
 *   - listing the active background note-collection tasks for the panel.
 *
 * The control gate + agent tab live on the controller; these handlers are a
 * thin bridge. The renderer polls listAgentTasks/getAgentControlState (no push
 * pipeline) — a progress panel does not need sub-second latency.
 */

export type AgentControlState = 'active' | 'pending_confirm' | 'frozen'

export interface BrowserLeaseSurfaceSnapshot {
  surface: AgentBrowserSurface
  state: BrowserLeaseState
  heldBy: string | null
  runId: string | null
  tabId: string | null
  leaseId: string | null
}

export interface BrowserLeaseSupervisionSnapshot {
  surfaces: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
  activeWriteSurface: AgentBrowserSurface | null
}

export type BrowserAgentSupervisionTask = Omit<BrowserCapabilityTaskHandle, 'kind'> & {
  kind: BrowserCapabilityTaskHandle['kind'] | 'browser_workflow' | 'browser_upload_workflow'
}

export interface BrowserSupervisionIPCController {
  requestAgentInterruption(): { state: AgentControlState; pending: boolean }
  confirmAgentInterruption(): Promise<{ state: AgentControlState; frozen: boolean; takeoverTabId?: string | null }>
  dismissAgentInterruption(): { state: AgentControlState }
  getAgentControlState(): AgentControlState
  getAgentTabId(): string | null
  getBrowserLeaseSnapshot(): BrowserLeaseSupervisionSnapshot
  listAgentCollectionTasks(): Promise<BrowserAgentSupervisionTask[]>
  getActiveForegroundBrowserWorkflowSession?(): BrowserWorkflowSession | null
}

function foregroundWorkflowTask(session: BrowserWorkflowSession): BrowserAgentSupervisionTask {
  return {
    taskId: session.taskId,
    kind: 'browser_workflow',
    status: 'running',
    progress: {
      total: 1,
      completed: 0,
      failed: 0,
      currentLabel: '前台浏览器任务',
    },
    createdAt: new Date(session.startedAt).toISOString(),
    startedAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  }
}

export function setupBrowserSupervisionIPC(controller: BrowserSupervisionIPCController): void {
  ipcMain.handle('browser:requestAgentInterruption', () => {
    try {
      return controller.requestAgentInterruption()
    } catch (error) {
      return { state: 'active' as AgentControlState, pending: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:confirmAgentInterruption', async () => {
    try {
      return await controller.confirmAgentInterruption()
    } catch (error) {
      return { state: 'active' as AgentControlState, frozen: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:dismissAgentInterruption', () => {
    try {
      return controller.dismissAgentInterruption()
    } catch (error) {
      return { state: 'active' as AgentControlState, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getAgentSupervisionState', async () => {
    try {
      const foreground = controller.getActiveForegroundBrowserWorkflowSession?.() ?? null
      const tasks = [
        ...(foreground?.lane === 'agent-view' ? [foregroundWorkflowTask(foreground)] : []),
        ...(await controller.listAgentCollectionTasks()),
      ]
      const activeTasks = tasks.filter((task) => isBrowserSupervisionVisibleTaskStatus(task.status))
      const foregroundAgentTabId = foreground?.lane === 'agent-view' && foreground.status === 'running'
        ? foreground.boundTabId
        : null
      return {
        controlState: controller.getAgentControlState(),
        agentTabId: foregroundAgentTabId || (activeTasks.length > 0 ? controller.getAgentTabId() : null),
        tasks: activeTasks,
        ...controller.getBrowserLeaseSnapshot(),
      }
    } catch (error) {
      return { controlState: 'active' as AgentControlState, agentTabId: null, tasks: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
}
