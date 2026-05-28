import { ipcMain } from 'electron'
import { getSkillsRuntimeManager } from './runtime-manager'

interface SkillsIPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export function setupSkillsIPC(): void {
  const manager = getSkillsRuntimeManager()

  ipcMain.handle('skills:list', (): SkillsIPCResponse => {
    try {
      return { success: true, data: manager.listSkills() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:runtimeInfo', (): SkillsIPCResponse => {
    try {
      return { success: true, data: manager.getRuntimeInfo() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:importCustomSkill', (_, payload: { path: string }): SkillsIPCResponse => {
    try {
      if (!payload?.path) return { success: false, error: 'Missing path' }
      return { success: true, data: manager.importCustomSkill(payload.path) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:removeCustomSkill', (_, payload: { skillId: string }): SkillsIPCResponse => {
    try {
      if (!payload?.skillId) return { success: false, error: 'Missing skillId' }
      return { success: true, data: manager.removeCustomSkill(payload.skillId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:updateCustomSkillDescription', (_, payload: { skillId: string; description: string }): SkillsIPCResponse => {
    try {
      if (!payload?.skillId) return { success: false, error: 'Missing skillId' }
      return { success: true, data: manager.updateCustomSkillDescription(payload.skillId, payload.description || '') }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:install', async (_, payload: { skillId: string; force?: boolean }): Promise<SkillsIPCResponse> => {
    try {
      const skillId = payload?.skillId
      if (!skillId) return { success: false, error: 'Missing skillId' }
      const result = await manager.ensureSkillInstalled(skillId, Boolean(payload.force))
      return result.success
        ? { success: true, data: result }
        : { success: false, data: result, error: result.error || 'Install failed' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:run', async (_, payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    timeoutMs?: number
    sessionId?: string
    executionMode?: 'auto' | 'workflow' | 'direct'
  }): Promise<SkillsIPCResponse> => {
    try {
      const skillId = payload?.skillId
      if (!skillId) return { success: false, error: 'Missing skillId' }
      const result = await manager.runSkill({
        skillId,
        action: payload.action,
        params: payload.params,
        timeoutMs: payload.timeoutMs,
        sessionId: payload.sessionId,
        executionMode: payload.executionMode || 'workflow',
      })
      return result.success
        ? { success: true, data: result }
        : { success: false, data: result, error: result.error || 'Skill run failed' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:jobs:list', (_, payload?: { limit?: number }): SkillsIPCResponse => {
    try {
      const limit = payload?.limit
      return { success: true, data: manager.listJobs(limit) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:configuration:get', (_, payload: { skillId: string }): SkillsIPCResponse => {
    try {
      const skillId = payload?.skillId
      if (!skillId) return { success: false, error: 'Missing skillId' }
      const result = manager.getSkillConfiguration(skillId)
      if (!result) return { success: false, error: `Skill not found: ${skillId}` }
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:configuration:update', (_, payload: {
    skillId: string
    serviceBindings?: Record<string, string>
    fields?: Record<string, string | number | boolean | null>
  }): SkillsIPCResponse => {
    try {
      const skillId = payload?.skillId
      if (!skillId) return { success: false, error: 'Missing skillId' }
      return { success: true, data: manager.updateSkillConfiguration(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:funasrNano:status', (_, payload?: { targetDir?: string | null }): SkillsIPCResponse => {
    try {
      return { success: true, data: manager.getFunasrNanoModelStatus(payload || {}) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:funasrNano:download', async (event, payload?: { targetDir?: string | null }): Promise<SkillsIPCResponse> => {
    try {
      const result = await manager.startFunasrNanoModelDownload(payload || {}, (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('skills:funasrNano:downloadUpdate', status)
        }
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Phase 4: skills:executions:* IPC channels retired along with the
  // skill_executions state machine. The 7 removed handlers were:
  //   skills:executions:list / :get / :submitInput / :submitConfirmation
  //   :submitAgentResult / :restartFromStep / :cancel

  ipcMain.handle('skills:schedules:list', (): SkillsIPCResponse => {
    try {
      return { success: true, data: manager.listSchedules() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:schedules:create', (_, payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    intervalMinutes: number
    startAt?: string
  }): SkillsIPCResponse => {
    try {
      const schedule = manager.createSchedule({
        skillId: payload.skillId,
        action: payload.action,
        params: payload.params,
        intervalMinutes: payload.intervalMinutes,
        startAt: payload.startAt,
      })
      return { success: true, data: schedule }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:schedules:toggle', (_, payload: { id: string; enabled: boolean }): SkillsIPCResponse => {
    try {
      const schedule = manager.updateScheduleEnabled(payload.id, Boolean(payload.enabled))
      if (!schedule) return { success: false, error: `Schedule not found: ${payload.id}` }
      return { success: true, data: schedule }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:schedules:delete', (_, payload: { id: string }): SkillsIPCResponse => {
    try {
      const removed = manager.deleteSchedule(payload.id)
      return { success: true, data: { removed } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
