import { ipcMain } from 'electron'
import { getSkillsRuntimeManager } from './runtime-manager'
import type { SkillInputValue } from '../../../shared/skill-execution-types'

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

  ipcMain.handle('skills:executions:list', (_, payload?: {
    limit?: number
    sessionId?: string
    activeOnly?: boolean
  }): SkillsIPCResponse => {
    try {
      return {
        success: true,
        data: manager.listExecutions(payload?.limit, payload?.sessionId, Boolean(payload?.activeOnly)),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:get', (_, payload: { id: string }): SkillsIPCResponse => {
    try {
      if (!payload?.id) return { success: false, error: 'Missing id' }
      const detail = manager.getExecution(payload.id)
      return detail ? { success: true, data: detail } : { success: false, error: `Execution not found: ${payload.id}` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:submitInput', async (_, payload: {
    executionId: string
    inputs: Record<string, unknown>
  }): Promise<SkillsIPCResponse> => {
    try {
      if (!payload?.executionId) return { success: false, error: 'Missing executionId' }
      return {
        success: true,
        data: await manager.submitExecutionInput(payload.executionId, (payload.inputs || {}) as Record<string, SkillInputValue>),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:submitConfirmation', async (_, payload: {
    executionId: string
    stepId: string
    confirmed: boolean
  }): Promise<SkillsIPCResponse> => {
    try {
      if (!payload?.executionId || !payload?.stepId) return { success: false, error: 'Missing executionId or stepId' }
      return {
        success: true,
        data: await manager.submitExecutionConfirmation(payload.executionId, payload.stepId, Boolean(payload.confirmed)),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:submitAgentResult', async (_, payload: {
    executionId: string
    stepId: string
    textContent?: string
    outputs?: Record<string, unknown>
  }): Promise<SkillsIPCResponse> => {
    try {
      if (!payload?.executionId || !payload?.stepId) return { success: false, error: 'Missing executionId or stepId' }
      return {
        success: true,
        data: await manager.submitExecutionAgentResult({
          executionId: payload.executionId,
          stepId: payload.stepId,
          textContent: payload.textContent,
          outputs: (payload.outputs || {}) as Record<string, SkillInputValue>,
        }),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:restartFromStep', async (_, payload: {
    executionId: string
    stepId: string
    inputs?: Record<string, unknown>
  }): Promise<SkillsIPCResponse> => {
    try {
      if (!payload?.executionId || !payload?.stepId) return { success: false, error: 'Missing executionId or stepId' }
      return {
        success: true,
        data: await manager.restartExecutionFromStep(
          payload.executionId,
          payload.stepId,
          (payload.inputs || {}) as Record<string, SkillInputValue>,
        ),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('skills:executions:cancel', (_, payload: { executionId: string }): SkillsIPCResponse => {
    try {
      if (!payload?.executionId) return { success: false, error: 'Missing executionId' }
      const detail = manager.cancelExecution(payload.executionId)
      return detail ? { success: true, data: detail } : { success: false, error: `Execution not found: ${payload.executionId}` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

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
