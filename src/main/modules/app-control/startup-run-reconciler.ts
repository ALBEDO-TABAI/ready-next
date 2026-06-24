import type { DatabaseConnection } from '../database'
import { getDatabase } from '../database'
import { canResumeAsUserPoint } from '../agent-control/contracts/resume-handle'
import { logAgentMetric } from '../agent-control/metrics'
import { isRunMetaTerminalStatus } from '../../../shared/run-meta-terminal-status'
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
  run_status: string | null
  terminal_reason: string | null
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

// B3 — a running browser task with no usable checkpoint is paused (not silently
// cancelled) with a rerun marker so it stays resumable from the original request
// (content-task-runner.canResumeTask honors `resumeKind:'rerun_from_request'`).
function resultWithRerunMarker(raw: string | null): string {
  const result = parseJsonRecord(raw) || {}
  return JSON.stringify({ ...result, resumeKind: 'rerun_from_request', restartReason: 'restart' })
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

function terminalProjectionTarget(row: TaskProjectionStartupRow): {
  status: 'completed' | 'failed' | 'killed'
  actions: string[]
  degradationReason: string | null
  blockedReason: string | null
} | null {
  if (!isRunMetaTerminalStatus(row.run_status)) return null
  const reason = typeof row.terminal_reason === 'string' ? row.terminal_reason : ''
  if (row.run_status === 'done' || row.run_status === 'completed' || reason === 'done') {
    return {
      status: 'completed',
      actions: [],
      degradationReason: null,
      blockedReason: null,
    }
  }
  if (row.run_status === 'cancelled' || row.run_status === 'killed' || reason.startsWith('cancelled_')) {
    return {
      status: 'killed',
      actions: ['none'],
      degradationReason: reason || row.run_status,
      blockedReason: '任务已停止。',
    }
  }
  if (reason === 'blocked_config') {
    return {
      status: 'failed',
      actions: [],
      degradationReason: reason,
      blockedReason: '当前模型或配置不支持这次请求，请切换模型、修复设置或移除不支持的附件后重新发送。',
    }
  }
  if (reason === 'blocked_external') {
    return {
      status: 'failed',
      actions: ['none'],
      degradationReason: reason,
      blockedReason: '这次请求已中断，Ready 已恢复；请重新发送。',
    }
  }
  return {
    status: 'failed',
    actions: ['none'],
    degradationReason: reason || row.run_status,
    blockedReason: '任务已结束，但没有可续跑句柄；请重新发送。',
  }
}

function reconcileTaskProjections(db: StartupRunReconcilerDb, nowIso: string): number {
  const rows = db.prepare(`
    SELECT
      p.task_id,
      p.continuation_ref_json,
      rm.status AS run_status,
      rm.terminal_reason
    FROM task_projections p
    LEFT JOIN run_meta rm ON rm.run_id = p.run_id
    WHERE p.status IN ('queued', 'running', 'blocked', 'budget_paused')
    ORDER BY p.updated_at ASC
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
  const terminal = db.prepare(`
    UPDATE task_projections
    SET
      status = ?,
      interaction_state = 'suspended',
      waiting_for = 'none',
      resumable_actions_json = ?,
      degradation_reason = ?,
      blocked_reason = ?,
      updated_at = ?
    WHERE task_id = ?
  `)

  let count = 0
  for (const row of rows) {
    const continuationRef = parseJsonRecord(row.continuation_ref_json)
    // fs-presence check: a handle whose run_state file vanished over restart
    // must NOT be advertised as recoverable (review batch-1 finding).
    if (canResumeAsUserPoint(continuationRef)) {
      count += changed(recoverable.run(JSON.stringify(['continue', 'cancel']), nowIso, row.task_id))
      continue
    }
    const terminalTarget = terminalProjectionTarget(row)
    if (terminalTarget) {
      count += changed(terminal.run(
        terminalTarget.status,
        JSON.stringify(terminalTarget.actions),
        terminalTarget.degradationReason,
        terminalTarget.blockedReason,
        nowIso,
        row.task_id,
      ))
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
  // B3 — no usable checkpoint: pause + rerun marker instead of a silent cancel,
  // so the task stays resumable as a rerun from the original request (its
  // payload_json survives the restart).
  const pauseRerun = db.prepare(`
    UPDATE browser_tasks
    SET
      status = 'paused',
      current_label = NULL,
      error = 'main_process_restarted',
      result_json = ?,
      updated_at = ?,
      finished_at = NULL
    WHERE id = ?
  `)

  let count = 0
  for (const row of rows) {
    if (validBrowserCheckpoint(row.checkpoint_json)) {
      count += changed(pause.run('main_process_restarted', nowIso, row.id))
      continue
    }
    count += changed(pauseRerun.run(resultWithRerunMarker(row.result_json), nowIso, row.id))
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
