import { ipcMain } from 'electron'
import { getSkillsRuntimeManager } from './runtime-manager'
import { getDatabase } from '../database'
import { MODEL_PACK_IDS, type ModelPackId, type ModelSource } from '../../../shared/model-pack-types'
import { RuntimeProvisionError } from './runtime-provisioner'

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

  ipcMain.handle('skills:updateCustomSkillDescription', (_, payload: { skillId: string; description: string; name?: string }): SkillsIPCResponse => {
    try {
      if (!payload?.skillId) return { success: false, error: 'Missing skillId' }
      return { success: true, data: manager.updateCustomSkillDescription(payload.skillId, payload.description || '', payload.name) }
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

  // Skill-source diagnostics: probe github.com + 国内 mirror reachability so the
  // agent install path's fetch is observable. No install side effects.
  ipcMain.handle('skills:sourcesSelfTest', async (): Promise<SkillsIPCResponse> => {
    try {
      return { success: true, data: await manager.selfTestSkillSources() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  const isModelPackId = (value: unknown): value is ModelPackId =>
    typeof value === 'string' && (MODEL_PACK_IDS as readonly string[]).includes(value)

  ipcMain.handle('modelPacks:list', (): SkillsIPCResponse => {
    try {
      return { success: true, data: manager.listModelPacks() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('modelPacks:status', (_, payload?: { id?: string }): SkillsIPCResponse => {
    try {
      if (!isModelPackId(payload?.id)) return { success: false, error: 'Unknown model pack id' }
      return { success: true, data: manager.getModelPackStatus(payload.id) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('modelPacks:download', async (event, payload?: { id?: string; source?: ModelSource }): Promise<SkillsIPCResponse> => {
    try {
      if (!isModelPackId(payload?.id)) return { success: false, error: 'Unknown model pack id' }
      const result = await manager.startModelPackDownload({ id: payload.id, source: payload.source }, (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('modelPacks:downloadUpdate', { id: status.id, status })
        }
      })
      return { success: true, data: result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('modelPacks:cancel', (_, payload?: { id?: string }): SkillsIPCResponse => {
    try {
      if (!isModelPackId(payload?.id)) return { success: false, error: 'Unknown model pack id' }
      return { success: true, data: manager.cancelModelPackDownload(payload.id) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('modelPacks:selfTest', async (): Promise<SkillsIPCResponse> => {
    try {
      return { success: true, data: await manager.selfTestModelPacks() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // One-click runtime provisioning (Python + ffmpeg + core deps). See
  //   docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md
  ipcMain.handle('runtime:status', async (): Promise<SkillsIPCResponse> => {
    try {
      return { success: true, data: await manager.getRuntimeProvisioner().getStatus() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('runtime:provision', async (event, payload?: { force?: boolean }): Promise<SkillsIPCResponse> => {
    try {
      const data = await manager.getRuntimeProvisioner().provision({ force: payload?.force }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('runtime:provisionUpdate', progress)
      })
      return { success: true, data }
    } catch (error) {
      // silent-catch: Carry the structured kind so the renderer can branch (unreachable → offer
      //   mirror config; integrity → do not).
      const kind = error instanceof RuntimeProvisionError ? error.kind : undefined
      return { success: false, error: error instanceof Error ? error.message : String(error), data: kind ? { kind } : undefined }
    }
  })

  ipcMain.handle('runtime:cancel', (): SkillsIPCResponse => {
    try {
      manager.getRuntimeProvisioner().cancel()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('runtime:getMirror', (): SkillsIPCResponse => {
    try {
      return { success: true, data: getDatabase().getSetting('runtime_asset_mirror_base')?.trim() || '' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('runtime:setMirror', (_, payload?: { mirror?: string }): SkillsIPCResponse => {
    try {
      getDatabase().setSetting('runtime_asset_mirror_base', String(payload?.mirror ?? '').trim())
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('runtime:selfTest', async (): Promise<SkillsIPCResponse> => {
    try {
      return { success: true, data: await manager.getRuntimeProvisioner().getStatus() }
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
