// B8-P (2026-07-05) — pure move of runtime.ts top-level helpers (HEAD lines
// 178–393): studio preroute-action builder, channel/schedule payload types,
// child-run summary types, and pending-task-event / projection parsing
// helpers. No behavior change; runtime.ts re-exports the public payload types
// so the external import face is unchanged.
import { isAwaitingUserInteractionState } from '../../../../shared/task-interaction-state'
import type { AgentSystemStudioRoutingSimulation } from '../../../../shared/agent-system-studio'
import type { TaskEventBridgePayload } from '../../browser-engine/task-event-bridge'
import { MAIN_AGENT_ID } from '../../repositories/agent-registry-repository'
import type { PrerouteResult } from '../agents/session-preroute'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type {
  ChannelAdapterType,
  ChannelAttachment,
  ScopeRunSkillProgress,
  ScopeRunSummary,
} from '../contracts/types'
import type { PendingTaskEventRow } from '../system-reminders/background-task-terminal-reminder'

export function buildStudioPrerouteActions(input: {
  result: PrerouteResult
  targetName: string | null
  targetStatus: string
}): AgentSystemStudioRoutingSimulation['actions'] {
  const targetId = input.result.decision.targetAgentId
  const targetLabel = input.targetName || targetId
  const hasSpecialistHit = targetId !== MAIN_AGENT_ID && input.targetStatus === 'active' && input.result.effect !== 'none'
  const hasPrecedentHit = hasSpecialistHit && input.result.decision.tier === 'precedent'
  return [{
    kind: 'use_once',
    label: hasSpecialistHit ? `本次用 ${targetLabel}` : '本次用专项 agent',
    description: hasSpecialistHit
      ? '只把这次请求交给该专项 agent，不改变路由卡。'
      : '当前样例没有命中可用专项 agent。',
    enabled: hasSpecialistHit,
  }, {
    kind: 'always_route',
    label: '总是路由这类',
    description: hasPrecedentHit
      ? '需要用户确认后才会让这类触发词长期生效。'
      : '只有命中可用路由卡后，才能把这类请求设成长期路由。',
    enabled: hasPrecedentHit,
  }, {
    kind: 'keep_main',
    label: '留在主 agent',
    description: '保持主 agent 处理这次请求，不启用专项分派。',
    enabled: true,
  }]
}

export interface UpsertChannelPayload {
  id?: string
  type: ChannelAdapterType
  name: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export type ActiveChildRunSummaryForRuntime = {
  childRunId: string
  skillId: string
  sessionId: string | null
  scopeId: string | null
  status: string
  startedAt: string
  outputDir: string
  runStatePath: string
  progress?: ScopeRunSkillProgress
  blockedReason?: string | null
  liveness?: 'background' | null
  closeStatus?: string | null
}

export interface TaskProjectionChildSummaryRow {
  task_id: string
  scope_id: string
  status: string
  blocked_reason: string | null
  continuation_ref_json: string | null
  recent_artifacts_json: string | null
  created_at: string
  updated_at: string
}

export type PendingInboundChannel = {
  channelId: string
  thread: string
  sender: string
  eventIds: string[]
  texts: string[]
  attachments: ChannelAttachment[]
  timer: NodeJS.Timeout | null
}

// B8-D R3 — demoted from a `this`-free private method on AgentControlRuntime
// (surgery-map P-level static-helper demotion): shared by the runtime's
// conversation-scope mappers and the extracted Schedule/ChannelConfig
// services.
export function tryParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function parseRecordJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseArrayJson(value: string | null | undefined): Array<Record<string, unknown>> {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        )
      : []
  } catch {
    return []
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parsePendingTaskEventPayload(row: PendingTaskEventRow): TaskEventBridgePayload | null {
  try {
    const parsed = JSON.parse(row.eventPayload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Partial<TaskEventBridgePayload>
    if (typeof record.taskId !== 'string' || typeof record.status !== 'string') return null
    return record as TaskEventBridgePayload
  } catch {
    return null
  }
}

export function resolvePendingTaskEventScopeId(payload: TaskEventBridgePayload | null): string | null {
  if (!payload) return null
  const extra = asRecord(payload.extra)
  return readScopeIdFromPendingEvent(extra)
}

export function readScopeIdFromPendingEvent(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const direct = stringFromUnknown(record.scopeId)
    || stringFromUnknown(record.sessionId)
    || stringFromUnknown(record.publicSessionId)
  if (direct) return direct
  return readScopeIdFromPendingEvent(asRecord(record.payload))
}

export function summarizePendingTaskEvent(payload: TaskEventBridgePayload): string {
  const extra = asRecord(payload.extra)
  const summary = stringFromUnknown(extra?.summary)
    || stringFromUnknown(extra?.title)
    || stringFromUnknown(extra?.message)
    || stringFromUnknown(extra?.statusText)
  return summary || `后台任务 ${payload.taskId} 已进入终态：${payload.status}`
}

export function buildPendingTaskNarrationPrompt(payload: TaskEventBridgePayload): string {
  const summary = summarizePendingTaskEvent(payload)
  return [
    '请向用户简短播报这个后台任务的最新结果，只做说明和下一步建议，不执行任何写入、浏览器操作或高风险动作。',
    `任务 ID：${payload.taskId}`,
    `状态：${payload.status}`,
    `摘要：${summary}`,
  ].join('\n')
}

export function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function progressFromUnknown(value: unknown): ScopeRunSkillProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Partial<ScopeRunSkillProgress>
  return {
    stage: record.stage ?? null,
    completed: record.completed ?? null,
    total: record.total ?? null,
    coverage: record.coverage ?? null,
    overallCoverage: record.overallCoverage ?? null,
    fingerprint: record.fingerprint ?? null,
    updatedAt: record.updatedAt ?? null,
    lastError: record.lastError ?? null,
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.activityUpdatedAt ? { activityUpdatedAt: record.activityUpdatedAt } : {}),
    ...(record.handoff ? { handoff: record.handoff } : {}),
  }
}

export function artifactMetaString(
  artifacts: Array<Record<string, unknown>>,
  key: string,
): string | null {
  for (const artifact of artifacts) {
    const meta = artifact.meta && typeof artifact.meta === 'object' && !Array.isArray(artifact.meta)
      ? artifact.meta as Record<string, unknown>
      : null
    const value = stringFromUnknown(meta?.[key])
    if (value) return value
  }
  return null
}

export function childRunSummaryStatusFromProjection(status: string): string {
  if (status === 'queued') return 'queued'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'killed'
  if (status === 'done') return 'completed'
  if (status === 'blocked') return 'blocked'
  return 'running'
}

export function canRespondToUserInteractionWithoutResumeHandle(params: {
  projection: TaskProjectionRecord | null
  scopeRunSummary: ScopeRunSummary | null
}): boolean {
  return isAwaitingUserInteractionState(params.projection)
    || isAwaitingUserInteractionState(params.scopeRunSummary)
}
