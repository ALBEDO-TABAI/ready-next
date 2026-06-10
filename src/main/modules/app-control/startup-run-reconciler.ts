import type { DatabaseConnection } from '../database'
import { getDatabase } from '../database'
import { canResumeWithFs } from '../agent-control/contracts/resume-handle'
import { logAgentMetric } from '../agent-control/metrics'
import {
  SkillTaskRunRepository,
  type SkillTaskRunStartupReconciliationResult,
} from '../repositories/skill-task-run-repository'

interface StartupRunReconcilerDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get<T = unknown>(...params: unknown[]): T | undefined
    all<T = unknown>(...params: unknown[]): T[]
  }
}

export interface StartupRunReconcileCount {
  runMeta: number
  taskProjections: number
  browserTasks: number
  skillRuns: number
}

export interface StartupRunReconcileResult {
  reconcileCount: StartupRunReconcileCount
  skillRuns: SkillTaskRunStartupReconciliationResult
}

export interface StartupRunReconcilerOptions {
  db?: StartupRunReconcilerDb | null
  now?: Date
  skillTaskRunRepository?: Pick<SkillTaskRunRepository, 'reconcileRunningRowsOnStartup'>
  skillStaleAfterMs?: number
  logMetric?: (name: string, payload: Record<string, unknown>) => void
}

interface TaskProjectionStartupRow {
  task_id: string
  continuation_ref_json: string | null
}

interface BrowserTaskStartupRow {
  id: string
  checkpoint_json: string | null
  result_json: string | null
}

function changed(result: unknown): number {
  const value = (result as { changes?: unknown } | null)?.changes
  return typeof value === 'number' ? value : 0
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function validBrowserCheckpoint(raw: string | null): boolean {
  const checkpoint = parseJsonRecord(raw)
  if (!checkpoint) return false
  const stage = typeof checkpoint.stage === 'string' ? checkpoint.stage.trim() : ''
  if (!stage) return false
  return checkpoint.partialResults !== undefined
    || checkpoint.cursor !== undefined
    || checkpoint.lastSeenFingerprint !== undefined
}

function resultWithCancelReason(raw: string | null): string {
  const result = parseJsonRecord(raw) || {}
  return JSON.stringify({ ...result, cancelReason: 'restart' })
}

function reconcileRunMeta(db: StartupRunReconcilerDb, nowMs: number): number {
  return changed(db.prepare(`
    UPDATE run_meta
    SET
      status = 'interrupted',
      initiator = 'process_exit',
      terminal_reason = 'main_process_restarted',
      updated_at = ?
    WHERE status = 'working'
  `).run(nowMs))
}

function reconcileTaskProjections(db: StartupRunReconcilerDb, nowIso: string): number {
  const rows = db.prepare(`
    SELECT task_id, continuation_ref_json
    FROM task_projections
    WHERE status IN ('queued', 'running', 'blocked', 'budget_paused')
    ORDER BY updated_at ASC
  `).all<TaskProjectionStartupRow>()

  const recoverable = db.prepare(`
    UPDATE task_projections
    SET
      status = 'recoverable_paused',
      interaction_state = 'suspended',
      waiting_for = 'background',
      resumable_actions_json = ?,
      degradation_reason = NULL,
      blocked_reason = NULL,
      updated_at = ?
    WHERE task_id = ?
  `)
  const interrupted = db.prepare(`
    UPDATE task_projections
    SET
      status = 'interrupted',
      interaction_state = 'suspended',
      waiting_for = 'none',
      resumable_actions_json = ?,
      degradation_reason = 'main_process_restarted',
      blocked_reason = ?,
      updated_at = ?
    WHERE task_id = ?
  `)

  let count = 0
  for (const row of rows) {
    const continuationRef = parseJsonRecord(row.continuation_ref_json)
    // fs-presence check: a handle whose run_state file vanished over restart
    // must NOT be advertised as recoverable (review batch-1 finding).
    if (canResumeWithFs(continuationRef)) {
      count += changed(recoverable.run(JSON.stringify(['continue', 'cancel']), nowIso, row.task_id))
      continue
    }
    count += changed(interrupted.run(
      JSON.stringify(['none']),
      'Ready restarted before this task saved a continuation handle.',
      nowIso,
      row.task_id,
    ))
  }
  return count
}

function reconcileBrowserTasks(db: StartupRunReconcilerDb, nowIso: string): number {
  const rows = db.prepare(`
    SELECT id, checkpoint_json, result_json
    FROM browser_tasks
    WHERE status = 'running'
    ORDER BY updated_at ASC
  `).all<BrowserTaskStartupRow>()

  const pause = db.prepare(`
    UPDATE browser_tasks
    SET
      status = 'paused',
      current_label = NULL,
      error = ?,
      updated_at = ?,
      finished_at = NULL
    WHERE id = ?
  `)
  const cancel = db.prepare(`
    UPDATE browser_tasks
    SET
      status = 'cancelled',
      current_label = NULL,
      error = 'restart',
      result_json = ?,
      updated_at = ?,
      finished_at = ?
    WHERE id = ?
  `)

  let count = 0
  for (const row of rows) {
    if (validBrowserCheckpoint(row.checkpoint_json)) {
      count += changed(pause.run('main_process_restarted', nowIso, row.id))
      continue
    }
    count += changed(cancel.run(resultWithCancelReason(row.result_json), nowIso, nowIso, row.id))
  }
  return count
}

function reconcileSkillRuns(
  repository: Pick<SkillTaskRunRepository, 'reconcileRunningRowsOnStartup'>,
  now: Date,
  staleAfterMs: number | undefined,
): { count: number; result: SkillTaskRunStartupReconciliationResult } {
  const result = repository.reconcileRunningRowsOnStartup({ now, staleAfterMs })
  return {
    count: result.recoverablePaused + result.failedWithoutHandle,
    result,
  }
}

export function reconcileStartupRunsOnStartup(
  options: StartupRunReconcilerOptions = {},
): StartupRunReconcileResult {
  const now = options.now || new Date()
  const db = options.db || getDatabase().getRawDb()
  if (!db) throw new Error('Database not available')

  const skillTaskRunRepository = options.skillTaskRunRepository
    || new SkillTaskRunRepository({ getRawDb: () => db as DatabaseConnection })
  const runMeta = reconcileRunMeta(db, now.getTime())
  const taskProjections = reconcileTaskProjections(db, now.toISOString())
  const browserTasks = reconcileBrowserTasks(db, now.toISOString())
  const skillRuns = reconcileSkillRuns(skillTaskRunRepository, now, options.skillStaleAfterMs)
  const reconcileCount: StartupRunReconcileCount = {
    runMeta,
    taskProjections,
    browserTasks,
    skillRuns: skillRuns.count,
  }

  const emitMetric = options.logMetric || logAgentMetric
  emitMetric('startup_run_reconciler.reconciled', {
    reconcileCount,
    skillRunDetails: skillRuns.result,
  })

  return {
    reconcileCount,
    skillRuns: skillRuns.result,
  }
}
