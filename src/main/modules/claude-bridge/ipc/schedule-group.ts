import type { IpcMain } from 'electron'
import type {
  AgentScheduleDefinition,
  AgentScheduleOccurrence,
  ScheduleCreateRequest,
  ScheduleMutationErrorKind,
  SchedulePreview,
  SchedulePreviewRequest,
  ScheduleUpdateRequest,
  ScheduledTasksResponse,
} from '../../../../shared/scheduled-tasks'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export interface ScheduleGroupDeps {
  list(): AgentScheduleDefinition[]
  get(id: string): AgentScheduleDefinition | null
  preview(request: SchedulePreviewRequest): SchedulePreview
  create(request: ScheduleCreateRequest): Promise<AgentScheduleDefinition>
  update(request: ScheduleUpdateRequest): Promise<AgentScheduleDefinition | null>
  pause(id: string): Promise<AgentScheduleDefinition | null>
  resume(id: string): Promise<AgentScheduleDefinition | null>
  delete(id: string): Promise<boolean>
  runNow(id: string): Promise<AgentScheduleOccurrence | null>
  listOccurrences(scheduleId: string, limit?: number): AgentScheduleOccurrence[]
  emitChanged(scheduleId?: string): void
}

const CHANNELS = [
  'scheduledTasks:list',
  'scheduledTasks:get',
  'scheduledTasks:preview',
  'scheduledTasks:create',
  'scheduledTasks:update',
  'scheduledTasks:pause',
  'scheduledTasks:resume',
  'scheduledTasks:delete',
  'scheduledTasks:runNow',
  'scheduledTasks:listOccurrences',
] as const

function failure(error: unknown): ScheduledTasksResponse<never> {
  const message = error instanceof Error ? error.message : String(error)
  let kind: ScheduleMutationErrorKind = 'internal_error'
  if (/not found/i.test(message)) kind = 'not_found'
  else if (/request|required|empty/i.test(message)) kind = 'invalid_request'
  else if (/scope|conversation|agent|workspace|target/i.test(message)) kind = 'target_missing'
  else if (/time|date|timezone|schedule|interval|future/i.test(message)) kind = 'invalid_time'
  return { success: false, error: { kind, message } }
}

function requireId(payload: unknown): string {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !id.trim()) throw new Error('Schedule id is required')
  return id.trim()
}

function requirePreview(payload: unknown): SchedulePreviewRequest {
  const value = payload as Partial<SchedulePreviewRequest> | null
  if (!value || typeof value !== 'object' || !value.scheduleSpec || typeof value.timezone !== 'string') {
    throw new Error('Schedule preview request is required')
  }
  return value as SchedulePreviewRequest
}

function requireMutation<T extends ScheduleCreateRequest | ScheduleUpdateRequest>(
  payload: unknown,
  requireScheduleId: boolean,
): T {
  const value = payload as Partial<ScheduleUpdateRequest> | null
  if (!value || typeof value !== 'object') throw new Error('Schedule request is required')
  if (requireScheduleId && (typeof value.id !== 'string' || !value.id.trim())) {
    throw new Error('Schedule id is required')
  }
  if (!value.scheduleSpec || typeof value.timezone !== 'string' || typeof value.instruction !== 'string'
    || typeof value.name !== 'string' || typeof value.agentId !== 'string' || !value.agentId.trim()
    || !Array.isArray(value.workspaceRoots) || value.workspaceRoots.some((root) => typeof root !== 'string')
    || typeof value.enabled !== 'boolean' || !['coalesce_latest', 'skip'].includes(String(value.missedPolicy))
    || !['dedicated', 'existing'].includes(String(value.scopeMode))) {
    throw new Error('Schedule request is invalid')
  }
  if (value.scopeMode === 'existing' && (typeof value.scopeId !== 'string' || !value.scopeId.trim())) {
    throw new Error('Existing scope id is required')
  }
  return value as T
}

async function respond<T>(operation: () => T | Promise<T>): Promise<ScheduledTasksResponse<T>> {
  try {
    return { success: true, data: await operation() }
  } catch (error) {
    return failure(error)
  }
}

export const scheduleGroup: IpcChannelGroup<ScheduleGroupDeps> = {
  namespace: 'scheduledTasks',

  register(ipcMain: IpcMain, deps: ScheduleGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* handler may not exist */ }
    }

    ipcMain.handle('scheduledTasks:list', () => respond(() => deps.list()))
    ipcMain.handle('scheduledTasks:get', (_, payload) => respond(() => {
      const id = requireId(payload)
      const schedule = deps.get(id)
      if (!schedule) throw new Error(`Schedule not found: ${id}`)
      return schedule
    }))
    ipcMain.handle('scheduledTasks:preview', (_, payload: SchedulePreviewRequest) => respond(() => deps.preview(requirePreview(payload))))
    ipcMain.handle('scheduledTasks:create', (_, payload: ScheduleCreateRequest) => respond(async () => {
      const schedule = await deps.create(requireMutation<ScheduleCreateRequest>(payload, false))
      deps.emitChanged(schedule.id)
      return schedule
    }))
    ipcMain.handle('scheduledTasks:update', (_, payload: ScheduleUpdateRequest) => respond(async () => {
      const validPayload = requireMutation<ScheduleUpdateRequest>(payload, true)
      const schedule = await deps.update(validPayload)
      if (!schedule) throw new Error(`Schedule not found: ${payload?.id || ''}`)
      deps.emitChanged(schedule.id)
      return schedule
    }))

    ipcMain.handle('scheduledTasks:pause', (_, payload) => respond(async () => {
      const id = requireId(payload)
      const schedule = await deps.pause(id)
      if (!schedule) throw new Error(`Schedule not found: ${id}`)
      deps.emitChanged(id)
      return schedule
    }))
    ipcMain.handle('scheduledTasks:resume', (_, payload) => respond(async () => {
      const id = requireId(payload)
      const schedule = await deps.resume(id)
      if (!schedule) throw new Error(`Schedule not found: ${id}`)
      deps.emitChanged(id)
      return schedule
    }))
    ipcMain.handle('scheduledTasks:delete', (_, payload) => respond(async () => {
      const id = requireId(payload)
      if (!await deps.delete(id)) throw new Error(`Schedule not found: ${id}`)
      deps.emitChanged(id)
      return { id }
    }))
    ipcMain.handle('scheduledTasks:runNow', (_, payload) => respond(async () => {
      const id = requireId(payload)
      const occurrence = await deps.runNow(id)
      if (!occurrence) throw new Error(`Schedule not found or not runnable: ${id}`)
      deps.emitChanged(id)
      return occurrence
    }))
    ipcMain.handle('scheduledTasks:listOccurrences', (_, payload) => respond(() => {
      const scheduleId = typeof payload?.scheduleId === 'string' ? payload.scheduleId.trim() : ''
      if (!scheduleId) throw new Error('Schedule id is required')
      return deps.listOccurrences(scheduleId, payload?.limit)
    }))

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* already removed */ }
        }
      },
    }
  },
}

export const _scheduleGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
