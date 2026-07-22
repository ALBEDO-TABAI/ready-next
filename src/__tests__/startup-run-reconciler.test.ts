import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

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

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(name: string): string {
  const root = join(tmpdir(), `ready-startup-run-reconciler-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

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

function seedTerminalRunMeta(
  db: TestDb,
  input: {
    runId: string
    taskId: string
    status: string
    terminalReason: string
  },
): void {
  db.prepare(`
    INSERT INTO run_meta (
      run_id, task_id, scope_id, agent_id, status, created_at, updated_at,
      terminal_reason, initiator, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.taskId,
    'scope-a',
    'agent-a',
    input.status,
    1000,
    2000,
    input.terminalReason,
    'error',
    60000,
  )
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
    const skillOutputDir = createRoot('startup-skill-handle')
    const skillRunStatePath = join(skillOutputDir, 'run_state.json')
    writeJson(skillRunStatePath, { status: 'running' })
    seedSkillRun(db, {
      id: 'skill-with-handle',
      outputDir: skillOutputDir,
      runStatePath: skillRunStatePath,
    })
    seedSkillRun(db, {
      id: 'skill-without-handle',
      outputDir: null,
      runStatePath: null,
    })

    const result = await reconcileStartupRunsOnStartup({
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

    // B3 — a running browser task WITHOUT a usable checkpoint is now PAUSED with
    // a rerun marker (resumable from the original request), not silently cancelled.
    const rerunBrowser = db.prepare('SELECT status, error, result_json, finished_at FROM browser_tasks WHERE id = ?')
      .get<{ status: string; error: string | null; result_json: string | null; finished_at: string | null }>('browser-without-checkpoint')!
    assert.equal(rerunBrowser.status, 'paused', 'no-checkpoint browser task pauses, not cancels')
    assert.equal(rerunBrowser.error, 'main_process_restarted')
    assert.equal(JSON.parse(rerunBrowser.result_json || '{}').resumeKind, 'rerun_from_request')
    assert.equal(rerunBrowser.finished_at, null, 'a resumable pause is not finished')

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

test('startup expires a pending browser confirmation and keeps the checkpoint reissuable', async (t) => {
  if (skipIfSqliteUnavailable(t, 'startup browser confirmation expiration')) return
  const db = await openDb()
  try {
    seedTaskProjection(db, {
      taskId: 'projection-browser-confirmation',
      runId: 'run-browser-confirmation',
      status: 'recoverable_paused',
      continuationRef: {
        kind: 'browser_checkpoint',
        checkpointId: 'checkpoint-browser-confirmation',
        browserTaskId: 'browser-task-confirmation',
        suspensionReason: 'browser_power_confirmation',
        suspensionRequest: {
          version: 1,
          kind: 'browser_power_confirmation',
          requestId: 'browser-confirmation-1',
          wakeKind: 'browser_power_confirmation',
          toolName: 'browser_eval',
          effects: ['page_mutation'],
          actionIntent: { objectRef: 'page', inputHash: 'input-hash' },
          target: {
            scopeId: 'scope-a',
            ownerRunId: 'run-browser-confirmation',
            browserTaskId: 'browser-task-confirmation',
            tabId: 'tab-1',
            documentKeyHash: 'document-key-hash',
            origin: 'https://example.com',
            targetDigest: 'target-digest',
          },
          purpose: '更新页面',
        },
      },
    })
    db.prepare(
      `UPDATE task_projections
          SET module = 'browser', interaction_state = 'suspended', waiting_for = 'confirmation',
              blocked_reason = 'browser_power_confirmation_checkpoint',
              resumable_actions_json = '["continue","cancel"]'
        WHERE task_id = 'projection-browser-confirmation'`,
    ).run()

    const first = await reconcileStartupRunsOnStartup({
      db,
      now: new Date('2026-07-22T10:00:00.000Z'),
      skillTaskRunRepository: new SkillTaskRunRepository({ getRawDb: () => db as never }),
      logMetric: () => undefined,
    })
    const projection = db.prepare(
      `SELECT waiting_for, blocked_reason, degradation_reason, resumable_actions_json,
              continuation_ref_json, revision
         FROM task_projections WHERE task_id = ?`,
    ).get<{
      waiting_for: string
      blocked_reason: string
      degradation_reason: string
      resumable_actions_json: string
      continuation_ref_json: string
      revision: number
    }>('projection-browser-confirmation')!
    const continuation = JSON.parse(projection.continuation_ref_json) as Record<string, unknown>
    assert.equal(first.reconcileCount.taskProjections, 1)
    assert.equal(projection.waiting_for, 'none')
    assert.equal(projection.blocked_reason, 'browser_confirmation_expired_checkpoint')
    assert.equal(projection.degradation_reason, 'browser_confirmation_expired_on_restart_or_resend')
    assert.deepEqual(JSON.parse(projection.resumable_actions_json), ['continue', 'cancel'])
    assert.equal(continuation.suspensionRequest, undefined)
    assert.equal(continuation.checkpointId, 'checkpoint-browser-confirmation')
    assert.equal(projection.revision, 1)

    const second = await reconcileStartupRunsOnStartup({
      db,
      now: new Date('2026-07-22T10:01:00.000Z'),
      skillTaskRunRepository: new SkillTaskRunRepository({ getRawDb: () => db as never }),
      logMetric: () => undefined,
    })
    assert.equal(second.reconcileCount.taskProjections, 0)
  } finally {
    db.close()
  }
})

test('startup run reconciler preserves terminal run reasons instead of rewriting them as restart interruptions', async (t) => {
  if (skipIfSqliteUnavailable(t, 'startup run reconciler terminal projection repair')) return
  const db = await openDb()
  try {
    seedTerminalRunMeta(db, {
      runId: 'run-infra-timeout',
      taskId: 'projection-infra-timeout',
      status: 'error',
      terminalReason: 'blocked_external',
    })
    seedTerminalRunMeta(db, {
      runId: 'run-blocked-config',
      taskId: 'projection-blocked-config',
      status: 'error',
      terminalReason: 'blocked_config',
    })
    seedTaskProjection(db, {
      taskId: 'projection-infra-timeout',
      runId: 'run-infra-timeout',
      status: 'blocked',
      continuationRef: null,
    })
    seedTaskProjection(db, {
      taskId: 'projection-blocked-config',
      runId: 'run-blocked-config',
      status: 'blocked',
      continuationRef: null,
    })

    const result = await reconcileStartupRunsOnStartup({
      db,
      now: new Date('2026-06-10T01:00:00.000Z'),
      skillTaskRunRepository: new SkillTaskRunRepository({ getRawDb: () => db as never }),
      logMetric: () => undefined,
    })

    assert.equal(result.reconcileCount.runMeta, 0)
    assert.equal(result.reconcileCount.taskProjections, 2)

    const timeoutProjection = db.prepare(`
      SELECT status, interaction_state, waiting_for, degradation_reason, blocked_reason, resumable_actions_json
      FROM task_projections WHERE task_id = ?
    `).get<{
      status: string
      interaction_state: string
      waiting_for: string
      degradation_reason: string | null
      blocked_reason: string | null
      resumable_actions_json: string
    }>('projection-infra-timeout')!
    assert.equal(timeoutProjection.status, 'failed')
    assert.equal(timeoutProjection.interaction_state, 'suspended')
    assert.equal(timeoutProjection.waiting_for, 'none')
    assert.equal(timeoutProjection.degradation_reason, 'blocked_external')
    assert.equal(timeoutProjection.blocked_reason, '这次请求已中断，Ready 已恢复；请重新发送。')
    assert.deepEqual(JSON.parse(timeoutProjection.resumable_actions_json), ['none'])

    const configProjection = db.prepare(`
      SELECT status, interaction_state, waiting_for, degradation_reason, blocked_reason, resumable_actions_json
      FROM task_projections WHERE task_id = ?
    `).get<{
      status: string
      interaction_state: string
      waiting_for: string
      degradation_reason: string | null
      blocked_reason: string | null
      resumable_actions_json: string
    }>('projection-blocked-config')!
    assert.equal(configProjection.status, 'failed')
    assert.equal(configProjection.interaction_state, 'suspended')
    assert.equal(configProjection.waiting_for, 'none')
    assert.equal(configProjection.degradation_reason, 'blocked_config')
    assert.match(configProjection.blocked_reason || '', /当前模型或配置不支持/)
    assert.deepEqual(JSON.parse(configProjection.resumable_actions_json), [])
  } finally {
    db.close()
  }
})
