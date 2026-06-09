import type { AgentInputItem } from '@openai/agents'
import type { TaskEventBridgePayload } from '../../browser-engine/task-event-bridge'
import type { ReminderTopic, SystemReminderRegistry } from './system-reminder-registry'

export const BACKGROUND_TASK_TERMINAL_REMINDER_TOPIC = 'background-task-terminal'

const activeRunCountsByScope = new Map<string, number>()
const activeScopeByTaskId = new Map<string, string>()
const pendingReminderTextsByScope = new Map<string, string[]>()

export function beginBackgroundTaskTerminalReminderRun(
  scopeId: string | null | undefined,
  taskId: string | null | undefined,
): () => void {
  const normalizedScopeId = normalizeId(scopeId)
  if (!normalizedScopeId) return () => {}

  activeRunCountsByScope.set(
    normalizedScopeId,
    (activeRunCountsByScope.get(normalizedScopeId) ?? 0) + 1,
  )

  const normalizedTaskId = normalizeId(taskId)
  if (normalizedTaskId) activeScopeByTaskId.set(normalizedTaskId, normalizedScopeId)

  return () => {
    const nextCount = (activeRunCountsByScope.get(normalizedScopeId) ?? 1) - 1
    if (nextCount > 0) activeRunCountsByScope.set(normalizedScopeId, nextCount)
    else activeRunCountsByScope.delete(normalizedScopeId)

    if (normalizedTaskId && activeScopeByTaskId.get(normalizedTaskId) === normalizedScopeId) {
      activeScopeByTaskId.delete(normalizedTaskId)
    }
  }
}

export function enqueueBackgroundTaskTerminalReminderFromBridge(
  payload: TaskEventBridgePayload,
): void {
  const scopeId = resolveScopeId(payload)
  if (!scopeId || !activeRunCountsByScope.has(scopeId)) return

  const existing = pendingReminderTextsByScope.get(scopeId) ?? []
  existing.push(buildBackgroundTaskTerminalReminderText(payload))
  pendingReminderTextsByScope.set(scopeId, existing)
}

export function drainBackgroundTaskTerminalReminders(
  scopeId: string | null | undefined,
): string[] {
  const normalizedScopeId = normalizeId(scopeId)
  if (!normalizedScopeId) return []
  const pending = pendingReminderTextsByScope.get(normalizedScopeId)
  if (!pending || pending.length === 0) return []
  pendingReminderTextsByScope.delete(normalizedScopeId)
  return pending
}

export function registerBackgroundTaskTerminalReminder(
  registry: SystemReminderRegistry,
  reminderTexts: readonly string[],
): void {
  const text = reminderTexts.map((item) => item.trim()).filter(Boolean).join('\n')
  if (!text) return
  registry.register({
    topic: BACKGROUND_TASK_TERMINAL_REMINDER_TOPIC as ReminderTopic,
    priority: 90,
    conflictsWith: [],
    text,
  })
}

export function prependSystemReminderInput(
  input: string | AgentInputItem[],
  reminderText: string,
): AgentInputItem[] {
  const reminderItem = {
    role: 'system',
    content: reminderText,
  } as AgentInputItem
  if (typeof input !== 'string') return [reminderItem, ...input]
  return [
    reminderItem,
    {
      role: 'user',
      content: input,
    } as AgentInputItem,
  ]
}

function buildBackgroundTaskTerminalReminderText(payload: TaskEventBridgePayload): string {
  const extra = asRecord(payload.extra)
  const summary = firstString(extra, ['summary', 'title', 'message', 'statusText'])
  const failureDetail = buildFailureDetail(payload, extra)
  return [
    `系统补充：后台任务 ${payload.taskId} 已进入终态：${statusLabel(payload.status)}。`,
    summary ? `摘要：${summary}` : null,
    failureDetail ? `失败明细：${failureDetail}` : null,
    '请在下一步回复或行动中纳入这个结果，不要把该后台任务继续当作运行中。',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function buildFailureDetail(
  payload: TaskEventBridgePayload,
  extra: Record<string, unknown> | null,
): string | null {
  const explicit = firstString(extra, [
    'error',
    'failure',
    'failureDetail',
    'failureDetails',
    'failedReason',
    'reason',
  ])
  if (explicit) return explicit

  const progress = asRecord(extra?.progress)
  const failed = progress ? Number(progress.failed) : 0
  if (Number.isFinite(failed) && failed > 0) return `失败 ${failed} 项`

  if (payload.status === 'failed') return '未提供失败明细'
  return null
}

function resolveScopeId(payload: TaskEventBridgePayload): string | null {
  const extra = asRecord(payload.extra)
  const explicit = readScopeId(extra)
  if (explicit) return explicit

  const mapped = activeScopeByTaskId.get(payload.taskId)
  return mapped || null
}

function readScopeId(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const direct = firstString(record, ['scopeId', 'sessionId', 'publicSessionId'])
  if (direct) return direct
  return readScopeId(asRecord(record.payload))
}

function statusLabel(status: TaskEventBridgePayload['status']): string {
  switch (status) {
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'paused':
      return '已暂停'
    case 'needs_attention':
      return '需要处理'
    case 'waiting_human':
      return '等待用户'
  }
}

function firstString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
