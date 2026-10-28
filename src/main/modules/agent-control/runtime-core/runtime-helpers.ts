// B8-P (2026-07-05) — pure move of runtime.ts top-level helpers (HEAD lines
// 178–393): channel/schedule payload types,
// child-run summary types and projection parsing
// helpers. No behavior change; runtime.ts re-exports the public payload types
// so the external import face is unchanged.
import { isAwaitingUserInteractionState } from '../../../../shared/task-interaction-state'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import type {
  ChannelAdapterType,
  ChannelAttachment,
  ScopeRunSkillProgress,
  ScopeRunSummary,
} from '../contracts/types'

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
  messageVisibilityEpoch: number
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
  message_visibility_epoch: number
  status: string
  blocked_reason: string | null
  continuation_ref_json: string | null
  recent_artifacts_json: string | null
  created_at: string
  updated_at: string
}

interface CurrentVisibleSummaryStatement {
  all<T = unknown>(): T[]
}

export interface CurrentVisibleSummaryDatabase {
  prepare(sql: string): CurrentVisibleSummaryStatement
}

export function filterCurrentScopeRunSummaries(
  summaries: Iterable<ScopeRunSummary>,
  getConversationScope: (scopeId: string) => { messageVisibilityEpoch: number } | null,
): ScopeRunSummary[] {
  return Array.from(summaries).filter((item) => {
    const scope = getConversationScope(item.scopeId)
    return Boolean(
      scope
      && Number.isSafeInteger(item.messageVisibilityEpoch)
      && item.messageVisibilityEpoch === scope.messageVisibilityEpoch,
    )
  })
}

export function listCurrentProjectionBackedChildRunSummaries(
  rawDb: CurrentVisibleSummaryDatabase | null,
): {
  rows: ActiveChildRunSummaryForRuntime[]
  failure: { reason: 'projection_db_error'; message: string } | null
} {
  if (!rawDb) return { rows: [], failure: null }
  let rows: TaskProjectionChildSummaryRow[] = []
  try {
    rows = rawDb.prepare(`
      SELECT task.task_id, task.scope_id, task.message_visibility_epoch,
             task.status, task.blocked_reason, task.continuation_ref_json,
             task.recent_artifacts_json, task.created_at, task.updated_at
      FROM task_projections task
      INNER JOIN chat_conversations scope
        ON scope.id = task.scope_id
       AND scope.closed_at IS NULL
       AND scope.message_visibility_epoch = task.message_visibility_epoch
      WHERE task.task_id LIKE 'skill-child:%'
        AND task.status IN ('queued', 'running', 'blocked', 'failed')
      ORDER BY task.updated_at DESC
      LIMIT 100
    `).all<TaskProjectionChildSummaryRow>()
  } catch (error) {
    // silent-catch: the DB failure is returned to the caller as a projection_db_error result
    return {
      rows: [],
      failure: {
        reason: 'projection_db_error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  const mapped = rows.map((row) => {
    const continuation = parseRecordJson(row.continuation_ref_json)
    const artifacts = parseArrayJson(row.recent_artifacts_json)
    const childRunId = stringFromUnknown(continuation?.childRunId)
      || row.task_id.replace(/^skill-child:/, '')
    const skillId = stringFromUnknown(continuation?.skillId)
      || artifactMetaString(artifacts, 'skillId')
      || 'unknown'
    const outputDir = stringFromUnknown(continuation?.outputDir)
      || artifactMetaString(artifacts, 'outputDir')
      || ''
    const runStatePath = stringFromUnknown(continuation?.runStatePath)
      || artifactMetaString(artifacts, 'runStatePath')
      || ''
    return {
      childRunId,
      skillId,
      sessionId: null,
      scopeId: row.scope_id,
      messageVisibilityEpoch: row.message_visibility_epoch,
      status: childRunSummaryStatusFromProjection(row.status),
      startedAt: row.created_at || row.updated_at,
      outputDir,
      runStatePath,
      progress: progressFromUnknown(continuation?.progress),
      blockedReason: row.blocked_reason,
      liveness: row.status === 'queued' || row.status === 'running' || row.status === 'blocked'
        ? 'background' as const
        : null,
      closeStatus: row.status === 'failed' ? 'failed' : null,
    }
  }).filter((row) => Boolean(row.childRunId))
  return { rows: mapped, failure: null }
}

export type PendingInboundChannel = {
  channelId: string
  thread: string
  scopeId: string | null
  messageVisibilityEpoch: number | null
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
