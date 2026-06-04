import { ipcMain } from 'electron'
import type { BrowserCapabilityTaskHandle } from './capability-types'

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

export interface BrowserSupervisionIPCController {
  requestAgentInterruption(): { state: AgentControlState; pending: boolean }
  confirmAgentInterruption(): Promise<{ state: AgentControlState; frozen: boolean }>
  dismissAgentInterruption(): { state: AgentControlState }
  getAgentControlState(): AgentControlState
  getAgentTabId(): string | null
  listAgentCollectionTasks(): Promise<BrowserCapabilityTaskHandle[]>
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
      const tasks = await controller.listAgentCollectionTasks()
      return {
        controlState: controller.getAgentControlState(),
        agentTabId: controller.getAgentTabId(),
        tasks,
      }
    } catch (error) {
      return { controlState: 'active' as AgentControlState, agentTabId: null, tasks: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
}
