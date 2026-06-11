import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { isSkillChildRunTerminalStatus } from '../../../../shared/skill-child-run-status'

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

/** Map a projection record to the minimal index entry (current columns only). */
export function toTaskIndexEntry(record: TaskProjectionRecord): TaskIndexEntry {
  return {
    taskId: record.taskId,
    title: record.taskTitle ?? null,
    status: record.status,
    blockedReason: record.blockedReason ?? null,
    continuationHint: continuationHintFromRef(record.continuationRef),
    updatedAt: record.updatedAt,
  }
}

/** Fetch and map the current scope's entries (scope isolation lives in SQL). */
export function selectScopeTaskIndexEntries(
  store: TaskIndexStore,
  scopeId: string,
): TaskIndexEntry[] {
  return store.listByScope(scopeId).map(toTaskIndexEntry)
}

function renderLine(entry: TaskIndexEntry): string {
  const statusCell = entry.blockedReason
    ? `${cell(entry.status)}:${cell(entry.blockedReason)}`
    : cell(entry.status)
  return `- [task:${entry.taskId}] ${cell(entry.title)} | ${statusCell} | ${cell(entry.continuationHint)}`
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
