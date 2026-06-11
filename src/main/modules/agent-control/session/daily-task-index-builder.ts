import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { isSkillChildRunTerminalStatus } from '../../../../shared/skill-child-run-status'
import { logAgentMetric } from '../metrics'

/**
 * Daily task index v1 (EP1-X1a). Pure assembler that turns the CURRENT
 * scope's task projections (current columns only) into a factual one-line-per
 * -task index. Replaces the narrative daily log as the task-state carrier so
 * that NO imperative ("请继续…") can ride into a later turn's context: every
 * line is a fixed `ref | status | hint` schema, derived from structured
 * fields, never free-form model prose.
 *
 * Scope isolation (the "他谱系不泄漏" guarantee) is enforced upstream by the
 * SQL `listByScope(scopeId)` filter; this builder only ever sees entries that
 * already belong to one scope.
 */

export interface TaskIndexEntry {
  taskId: string
  title: string | null
  status: string
  blockedReason: string | null
  /** Factual continuation hint derived from continuation_ref; never imperative. */
  continuationHint: string | null
  /** ISO timestamp; used to decide "今日已完结". */
  updatedAt: string
  /** EP2-X1b — structured blocker category from continuation_ref.blockerType. */
  blockerCategory: string | null
  /** EP2-X1b — factual criteria progress ("判据满足 2/3" / "判据 3 项"), from Q1 columns. */
  criteriaProgress: string | null
  /** EP2-X1b — interaction_state === check_in_pending (待裁决). */
  pendingAdjudication: boolean
}

export interface TaskIndexStore {
  listByScope(scopeId: string): TaskProjectionRecord[]
}

const FIELD_MAX = 60

/** Collapse to a single safe line cell: no newlines, no `|` separator clashes. */
function cell(value: string | null | undefined): string {
  if (!value) return '—'
  const flattened = String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flattened) return '—'
  return flattened.length > FIELD_MAX ? `${flattened.slice(0, FIELD_MAX)}…` : flattened
}

/** Derive a factual continuation hint from a parsed continuation_ref object. */
function continuationHintFromRef(ref: unknown): string | null {
  if (!ref || typeof ref !== 'object') return null
  const record = ref as Record<string, unknown>
  const blockerType = typeof record.blockerType === 'string' ? record.blockerType.trim() : ''
  if (blockerType) return `阻塞类型:${blockerType}`
  return '可继续'
}

/** EP2-X1b — factual criteria progress from the Q1 quality columns. The
 *  latest checkin (Q4a writer) may carry satisfied/total counts; before any
 *  checkin exists, the criteria item count alone is the honest fact. */
function criteriaProgressOf(record: TaskProjectionRecord): string | null {
  const lastCheckin = Array.isArray(record.checkins) && record.checkins.length > 0
    ? record.checkins[record.checkins.length - 1] as Record<string, unknown>
    : null
  if (lastCheckin && typeof lastCheckin.satisfiedCount === 'number' && typeof lastCheckin.totalCount === 'number') {
    return `判据满足 ${lastCheckin.satisfiedCount}/${lastCheckin.totalCount}`
  }
  const items = record.criteria && Array.isArray((record.criteria as Record<string, unknown>).items)
    ? ((record.criteria as Record<string, unknown>).items as unknown[])
    : null
  if (items && items.length > 0) return `判据 ${items.length} 项`
  return null
}

/** Map a projection record to the index entry (Q1 quality columns included). */
export function toTaskIndexEntry(record: TaskProjectionRecord): TaskIndexEntry {
  const ref = record.continuationRef as Record<string, unknown> | null | undefined
  const blockerType = ref && typeof ref.blockerType === 'string' ? ref.blockerType.trim() : ''
  return {
    taskId: record.taskId,
    title: record.taskTitle ?? null,
    status: record.status,
    blockedReason: record.blockedReason ?? null,
    continuationHint: continuationHintFromRef(record.continuationRef),
    updatedAt: record.updatedAt,
    blockerCategory: blockerType || null,
    criteriaProgress: criteriaProgressOf(record),
    pendingAdjudication: record.interactionState === 'check_in_pending',
  }
}

/** EP2-T2 — malformed-ignored: a ledger row missing its identity facts is
 *  skipped with a metric, never displayed sick and never a crash (07 §1.3). */
function isWellFormedProjectionRow(record: TaskProjectionRecord): boolean {
  return Boolean(record
    && typeof record.taskId === 'string' && record.taskId.trim()
    && typeof record.status === 'string' && record.status.trim()
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)))
}

/** Fetch and map the current scope's entries (scope isolation lives in SQL). */
export function selectScopeTaskIndexEntries(
  store: TaskIndexStore,
  scopeId: string,
): TaskIndexEntry[] {
  const out: TaskIndexEntry[] = []
  for (const record of store.listByScope(scopeId)) {
    if (!isWellFormedProjectionRow(record)) {
      logAgentMetric('ledger_malformed', {
        scopeId,
        taskId: (record as { taskId?: unknown } | null)?.taskId ?? null,
        consumer: 'daily_task_index',
      })
      continue
    }
    out.push(toTaskIndexEntry(record))
  }
  return out
}

function renderLine(entry: TaskIndexEntry): string {
  const statusCell = entry.blockedReason
    ? `${cell(entry.status)}:${cell(entry.blockedReason)}`
    : cell(entry.status)
  // EP2-X1b — enhancement cells append ONLY when present so legacy entries
  // render byte-identical to X1a (零回归).
  const extras: string[] = []
  if (entry.blockerCategory) extras.push(`类别:${cell(entry.blockerCategory)}`)
  if (entry.criteriaProgress) extras.push(cell(entry.criteriaProgress))
  if (entry.pendingAdjudication) extras.push('待裁决')
  const tail = extras.length > 0 ? ` | ${extras.join(' | ')}` : ''
  return `- [task:${entry.taskId}] ${cell(entry.title)} | ${statusCell} | ${cell(entry.continuationHint)}${tail}`
}

/**
 * Build the daily task index. Returns '' when the scope has no tasks worth
 * surfacing (empty day → empty section). Non-terminal tasks are the active
 * work queue; terminal tasks completed *today* are harvest leads.
 */
export function buildDailyTaskIndex(
  entries: ReadonlyArray<TaskIndexEntry>,
  opts: { now: Date },
): string {
  const today = opts.now.toISOString().slice(0, 10)
  const active: TaskIndexEntry[] = []
  const harvested: TaskIndexEntry[] = []
  for (const entry of entries) {
    if (isSkillChildRunTerminalStatus(entry.status)) {
      if (entry.updatedAt.slice(0, 10) === today) harvested.push(entry)
    } else {
      active.push(entry)
    }
  }
  if (active.length === 0 && harvested.length === 0) return ''

  const lines: string[] = [`# 今日任务索引（自动生成，${today}）`]
  if (active.length > 0) {
    lines.push('', '## 进行中 / 待处理', ...active.map(renderLine))
  }
  if (harvested.length > 0) {
    lines.push('', '## 今日已完结', ...harvested.map(renderLine))
  }
  return lines.join('\n')
}
