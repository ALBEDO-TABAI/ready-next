import { randomUUID } from 'crypto'

export type ScheduleTriggerSource = 'cron' | 'manual'

export interface ScheduleExecutionRecord {
  id: string
  name: string
  cron_expr: string
  prompt: string
  payload_json?: string | null
}

export interface ScheduleScopedSendPayload {
  scopeId: string
  agent: string
  message: string
  requestId: string
  userMessage: {
    id: string
    content: string
    timestamp: string
    meta: Record<string, unknown>
  }
}

export interface ScheduleExecutionDeps {
  parseJson: (value: string, fallback: Record<string, unknown>) => Record<string, unknown>
  sendScoped: (payload: ScheduleScopedSendPayload) => Promise<{ success: boolean; error?: string }>
  sendUnscoped: (
    agent: string,
    message: string,
    requestId: string,
  ) => Promise<{ success: boolean; error?: string }>
  markRun: (scheduleId: string) => void
  appendLog?: (message: string) => void
  now?: () => Date
  createId?: () => string
}

export async function executeAgentSchedule(
  schedule: ScheduleExecutionRecord,
  deps: ScheduleExecutionDeps,
  triggerSource: ScheduleTriggerSource = 'cron',
): Promise<{ success: boolean; error?: string }> {
  const prompt = schedule.prompt.trim()
  if (!prompt) return { success: false, error: 'Schedule prompt is empty' }

  const wrapped = `[cron:${schedule.name}] ${prompt}`
  const schedulePayload = deps.parseJson(schedule.payload_json || '{}', {})
  const readText = (key: string): string | null => {
    const value = schedulePayload[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  const scopeId = readText('scopeId') || readText('conversationId')
  const agent = readText('agent') || 'butler'
  const workspaceId = readText('workspaceId') || readText('workspaceRoot')
  const requestId = `schedule-${schedule.id}-${deps.createId?.() || randomUUID()}`

  deps.appendLog?.(
    [
      'agentSchedule.fire',
      `source=${triggerSource}`,
      `scheduleId=${schedule.id}`,
      `scopeId=${scopeId || '<unscoped>'}`,
      `workspaceId=${workspaceId || '<none>'}`,
    ].join(' '),
  )

  const result = scopeId
    ? await deps.sendScoped({
      scopeId,
      agent,
      message: wrapped,
      requestId,
      userMessage: {
        id: `msg-${requestId}`,
        content: wrapped,
        timestamp: (deps.now?.() || new Date()).toISOString(),
        meta: {
          source: 'agent_schedule',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          cronExpr: schedule.cron_expr,
          triggerSource,
          workspaceId,
        },
      },
    })
    : await deps.sendUnscoped(agent, wrapped, requestId)

  if (result.success) {
    deps.markRun(schedule.id)
  }
  return result
}
