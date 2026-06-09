import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import type { MigrationDatabase } from '../main/modules/migrations'
import { runMigrations } from '../main/modules/migrations'
import { SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'
import { reconcileStartupRunsOnStartup } from '../main/modules/app-control/startup-run-reconciler'

interface TestStatement {
  run(...params: unknown[]): { changes?: number }
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface TestDb {
  exec(sql: string): void
  prepare(sql: string): TestStatement
  close(): void
}

type SqliteCtor = new (path: string) => TestDb

async function openDb(): Promise<TestDb> {
  const Sqlite = (await import('better-sqlite3')).default as SqliteCtor
  const db = new Sqlite(':memory:')
  runMigrations(db as unknown as MigrationDatabase)
  return db
}

function seedRunMeta(db: TestDb): void {
  db.prepare(`
    INSERT INTO run_meta (
      run_id, task_id, scope_id, agent_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('run-stale', 'task-run-meta', 'scope-a', 'agent-a', 'working', 1000, 1000)
}

function seedTaskProjection(
  db: TestDb,
  input: {
    taskId: string
    runId: string
    status: string
    continuationRef: Record<string, unknown> | null
  },
): void {
  db.prepare(`
    INSERT INTO task_projections (
      task_id, scope_id, run_id, parent_task_id, parent_step_id, task_type, module,
      task_title, task_summary, status, interaction_state, waiting_for, steps_json,
      current_step_id, budget_json, budget_usage_percent, budget_warning_level,
      recovery_history_json, degradation_reason, blocked_reason, resumable_actions_json,
      continuation_ref_json, progress_json, recent_artifacts_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.taskId,
    'scope-a',
    input.runId,
    null,
    null,
    'skill',
    'skill',
    null,
    null,
    input.status,
    'running',
    'none',
    '[]',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    '["continue"]',
    input.continuationRef ? JSON.stringify(input.continuationRef) : null,
    null,
    null,
    '2026-06-10T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
  )
}

function seedBrowserTask(
  db: TestDb,
  input: {
    id: string
    status: string
    checkpoint: Record<string, unknown> | null
  },
): void {
  db.prepare(`
    INSERT INTO browser_tasks (
      id, kind, status, payload_json, checkpoint_json, result_json,
      progress_total, progress_completed, progress_failed, current_label, error,
      created_at, started_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    'note_collect',
    input.status,
    '{}',
    input.checkpoint ? JSON.stringify(input.checkpoint) : null,
    null,
    2,
    1,
    0,
    'collecting',
    null,
    '2026-06-10T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
    null,
  )
}

function seedSkillRun(
  db: TestDb,
  input: {
    id: string
    outputDir: string | null
    runStatePath: string | null
  },
): void {
  db.prepare(`
    INSERT INTO skill_task_runs (
      id, scope_id, session_id, agent, run_id, skill_id, skill_name, action, tool_name,
      run_kind, status, interaction_state, goal_text, resource_refs_json, params_json,
      steps_json, current_step_id, artifacts_json, output_dir, run_state_path,
      scene_scores_path, delivery_report_path, failure_kind, failure_detail, job_id,
      detached_task_id, resume_payload_json, created_at, started_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    'scope-a',
    'scope-a',
    'butler',
    null,
    'skill-a',
    'Skill A',
    'run',
    null,
    'detached',
    'running',
    'running',
    null,
    '[]',
    null,
    '[]',
    null,
    '[]',
    input.outputDir,
    input.runStatePath,
    null,
    null,
    null,
    null,
    null,
    null,
    input.outputDir && input.runStatePath
      ? JSON.stringify({
          childRun: {
            childRunId: input.id,
            status: 'running',
            outputDir: input.outputDir,
            runStatePath: input.runStatePath,
          },
        })
      : null,
    '2026-06-10T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
    '2026-06-10T00:00:00.000Z',
    null,
  )
}

test('startup run reconciler closes stale run, projection, browser, and skill rows', async (t) => {
  if (skipIfSqliteUnavailable(t, 'startup run reconciler')) return
  const db = await openDb()
  const metrics: Array<{ name: string; payload: Record<string, unknown> }> = []
  try {
    seedRunMeta(db)
    seedTaskProjection(db, {
      taskId: 'projection-resumable',
      runId: 'run-projection-resumable',
      status: 'running',
      continuationRef: { childRunId: 'child-run-a' },
    })
    seedTaskProjection(db, {
      taskId: 'projection-stale',
      runId: 'run-projection-stale',
      status: 'blocked',
      continuationRef: { taskRunId: 'legacy-only', skillId: 'skill-a' },
    })
    seedTaskProjection(db, {
      taskId: 'projection-completed',
      runId: 'run-projection-completed',
      status: 'completed',
      continuationRef: null,
    })
    seedBrowserTask(db, {
      id: 'browser-with-checkpoint',
      status: 'running',
      checkpoint: {
        taskId: 'browser-with-checkpoint',
        stage: 'note_collect_round',
        cursor: '1',
        partialResults: { cursor: 1, outputs: [] },
      },
    })
    seedBrowserTask(db, {
      id: 'browser-without-checkpoint',
      status: 'running',
      checkpoint: null,
    })
    seedBrowserTask(db, {
      id: 'browser-completed',
      status: 'completed',
      checkpoint: null,
    })
    seedSkillRun(db, {
      id: 'skill-with-handle',
      outputDir: '/tmp/ready-s1-5-skill-with-handle',
      runStatePath: '/tmp/ready-s1-5-skill-with-handle/run_state.json',
    })
    seedSkillRun(db, {
      id: 'skill-without-handle',
      outputDir: null,
      runStatePath: null,
    })

    const result = reconcileStartupRunsOnStartup({
      db,
      now: new Date('2026-06-10T01:00:00.000Z'),
      skillTaskRunRepository: new SkillTaskRunRepository({ getRawDb: () => db as never }),
      logMetric: (name, payload) => metrics.push({ name, payload }),
    })

    assert.deepEqual(result.reconcileCount, {
      runMeta: 1,
      taskProjections: 2,
      browserTasks: 2,
      skillRuns: 2,
    })

    const runMeta = db.prepare('SELECT status, initiator, terminal_reason FROM run_meta WHERE run_id = ?')
      .get<{ status: string; initiator: string; terminal_reason: string }>('run-stale')!
    assert.deepEqual(runMeta, {
      status: 'interrupted',
      initiator: 'process_exit',
      terminal_reason: 'main_process_restarted',
    })

    const resumableProjection = db.prepare(`
      SELECT status, interaction_state, waiting_for, resumable_actions_json
      FROM task_projections WHERE task_id = ?
    `).get<{
      status: string
      interaction_state: string
      waiting_for: string
      resumable_actions_json: string
    }>('projection-resumable')!
    assert.equal(resumableProjection.status, 'recoverable_paused')
    assert.equal(resumableProjection.interaction_state, 'suspended')
    assert.equal(resumableProjection.waiting_for, 'background')
    assert.deepEqual(JSON.parse(resumableProjection.resumable_actions_json), ['continue', 'cancel'])

    const staleProjection = db.prepare(`
      SELECT status, interaction_state, waiting_for, degradation_reason, resumable_actions_json
      FROM task_projections WHERE task_id = ?
    `).get<{
      status: string
      interaction_state: string
      waiting_for: string
      degradation_reason: string
      resumable_actions_json: string
    }>('projection-stale')!
    assert.equal(staleProjection.status, 'interrupted')
    assert.equal(staleProjection.interaction_state, 'suspended')
    assert.equal(staleProjection.waiting_for, 'none')
    assert.equal(staleProjection.degradation_reason, 'main_process_restarted')
    assert.deepEqual(JSON.parse(staleProjection.resumable_actions_json), ['none'])

    const pausedBrowser = db.prepare('SELECT status, error, finished_at FROM browser_tasks WHERE id = ?')
      .get<{ status: string; error: string | null; finished_at: string | null }>('browser-with-checkpoint')!
    assert.equal(pausedBrowser.status, 'paused')
    assert.equal(pausedBrowser.finished_at, null)

    const cancelledBrowser = db.prepare('SELECT status, error, result_json, finished_at FROM browser_tasks WHERE id = ?')
      .get<{ status: string; error: string | null; result_json: string | null; finished_at: string | null }>('browser-without-checkpoint')!
    assert.equal(cancelledBrowser.status, 'cancelled')
    assert.equal(cancelledBrowser.error, 'restart')
    assert.equal(JSON.parse(cancelledBrowser.result_json || '{}').cancelReason, 'restart')
    assert.ok(cancelledBrowser.finished_at)

    const skillWithHandle = db.prepare('SELECT status, interaction_state, failure_kind FROM skill_task_runs WHERE id = ?')
      .get<{ status: string; interaction_state: string; failure_kind: string | null }>('skill-with-handle')!
    assert.equal(skillWithHandle.status, 'blocked')
    assert.equal(skillWithHandle.interaction_state, 'suspended')
    assert.equal(skillWithHandle.failure_kind, 'process_restarted')

    const skillWithoutHandle = db.prepare('SELECT status, failure_kind FROM skill_task_runs WHERE id = ?')
      .get<{ status: string; failure_kind: string | null }>('skill-without-handle')!
    assert.equal(skillWithoutHandle.status, 'failed')
    assert.equal(skillWithoutHandle.failure_kind, 'stale_running_without_handle')

    assert.equal(metrics.length, 1)
    assert.equal(metrics[0].name, 'startup_run_reconciler.reconciled')
    assert.deepEqual(metrics[0].payload.reconcileCount, result.reconcileCount)
  } finally {
    db.close()
  }
})
