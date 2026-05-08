/**
 * Stage Q (Stage 11) — Migration 033 schema CHECK + backfill contract.
 *
 * Plan §3.5 / contract C5+C12. Verifies:
 *   1. Migration 033 adds the CHECK constraint to `skill_task_runs`.
 *   2. Existing violator rows (run_kind='primitive' AND
 *      tool_name='skill_lifecycle') are backfilled to satisfy the CHECK
 *      with the right tool_name fallback chain (action / cleanup
 *      sentinel) and status='cancelled' + failure_kind tag.
 *   3. `task_projections` cleanup runs alongside (stale projections
 *      with no durable handle → resumable_actions=['none'] +
 *      degradation_reason).
 *   4. Inserting a fresh violator row after migration triggers
 *      SQLITE_CONSTRAINT.
 *
 * Uses better-sqlite3 in-memory DB. Skip-helper required because
 * direct better-sqlite3 import touches the Stage 5 SQLite gate.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface MigrationDb {
  exec(sql: string): void
  prepare<T = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
    get<R = unknown>(...params: unknown[]): R | undefined
  }
}

async function buildInMemoryDb(): Promise<MigrationDb> {
  // Dynamic import so the static C3 SQLite gate detects the call.
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

async function runMigrationsThrough033(db: MigrationDb): Promise<void> {
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

function nowIso(): string {
  return '2026-05-08T00:00:00.000Z'
}

function insertSkillTaskRunRow(
  db: MigrationDb,
  overrides: Partial<{
    id: string
    skill_id: string
    action: string
    tool_name: string
    run_kind: string
    status: string
    interaction_state: string
    session_id: string
  }> = {},
): void {
  const row = {
    id: overrides.id || `str-${Math.random().toString(36).slice(2, 10)}`,
    scope_id: 'scope-q-migration',
    session_id: overrides.session_id || 'scope-q-migration',
    agent: 'butler',
    run_id: null,
    skill_id: overrides.skill_id || 'humanizer-zh',
    skill_name: 'Humanizer',
    action: overrides.action ?? 'skill_write_artifact',
    tool_name: overrides.tool_name ?? 'skill_lifecycle',
    run_kind: overrides.run_kind || 'primitive',
    status: overrides.status || 'blocked',
    interaction_state: overrides.interaction_state || 'awaiting_clarification',
    goal_text: null,
    resource_refs_json: '[]',
    params_json: null,
    steps_json: '[]',
    current_step_id: null,
    artifacts_json: '[]',
    output_dir: null,
    run_state_path: null,
    scene_scores_path: null,
    delivery_report_path: null,
    failure_kind: null,
    failure_detail: null,
    job_id: null,
    detached_task_id: null,
    resume_payload_json: null,
    created_at: nowIso(),
    started_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null,
  }
  db.prepare(`
    INSERT INTO skill_task_runs (
      id, scope_id, session_id, agent, run_id, skill_id, skill_name, action, tool_name,
      run_kind, status, interaction_state, goal_text, resource_refs_json, params_json,
      steps_json, current_step_id, artifacts_json, output_dir, run_state_path, scene_scores_path,
      delivery_report_path, failure_kind, failure_detail, job_id, detached_task_id,
      resume_payload_json, created_at, started_at, updated_at, finished_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `).run(
    row.id, row.scope_id, row.session_id, row.agent, row.run_id, row.skill_id, row.skill_name,
    row.action, row.tool_name, row.run_kind, row.status, row.interaction_state, row.goal_text,
    row.resource_refs_json, row.params_json, row.steps_json, row.current_step_id, row.artifacts_json,
    row.output_dir, row.run_state_path, row.scene_scores_path, row.delivery_report_path,
    row.failure_kind, row.failure_detail, row.job_id, row.detached_task_id, row.resume_payload_json,
    row.created_at, row.started_at, row.updated_at, row.finished_at,
  )
}

test('Q.3b: migration 033 adds CHECK and rejects future violator inserts', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 CHECK enforcement')) return
  const db = await buildInMemoryDb()
  await runMigrationsThrough033(db)
  // Sanity: the migration applied.
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_task_runs'")
    .get<{ sql: string }>()
  assert.ok(row?.sql)
  assert.match(row!.sql, /CHECK\s*\(\s*NOT\s*\(\s*run_kind\s*=\s*'primitive'\s+AND\s+tool_name\s*=\s*'skill_lifecycle'/i)
  // Now try to insert a violator → should throw.
  let threw = false
  try {
    insertSkillTaskRunRow(db, {
      run_kind: 'primitive',
      tool_name: 'skill_lifecycle',
    })
  } catch (error) {
    threw = true
    assert.match(String(error), /CHECK constraint failed/i)
  }
  assert.ok(threw, 'expected SQLITE_CONSTRAINT on inserting a violator row')
})

// Direct pre-033 schema fixture, mirrors migration 031 exactly. Use this
// for backfill tests so we can populate violator rows BEFORE 033 runs.
async function buildPre033DbAndApply033(): Promise<MigrationDb> {
  const db = await buildInMemoryDb()
  // Replicate migration 031's `skill_task_runs` DDL (no CHECK).
  db.exec(`
    CREATE TABLE skill_task_runs (
      id TEXT PRIMARY KEY,
      scope_id TEXT,
      session_id TEXT,
      agent TEXT,
      run_id TEXT,
      skill_id TEXT NOT NULL,
      skill_name TEXT,
      action TEXT NOT NULL,
      tool_name TEXT,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      interaction_state TEXT NOT NULL,
      goal_text TEXT,
      resource_refs_json TEXT,
      params_json TEXT,
      steps_json TEXT NOT NULL DEFAULT '[]',
      current_step_id TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      output_dir TEXT,
      run_state_path TEXT,
      scene_scores_path TEXT,
      delivery_report_path TEXT,
      failure_kind TEXT,
      failure_detail TEXT,
      job_id TEXT,
      detached_task_id TEXT,
      resume_payload_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE task_projections (
      task_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      parent_task_id TEXT,
      parent_step_id TEXT,
      task_type TEXT NOT NULL,
      module TEXT NOT NULL,
      task_title TEXT,
      task_summary TEXT,
      status TEXT NOT NULL,
      interaction_state TEXT NOT NULL,
      waiting_for TEXT,
      steps_json TEXT NOT NULL,
      current_step_id TEXT,
      budget_json TEXT,
      budget_usage_percent INTEGER,
      recovery_history_json TEXT,
      blocked_reason TEXT,
      resumable_actions_json TEXT,
      continuation_ref_json TEXT,
      recent_artifacts_json TEXT,
      degradation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `)
  // Stage Q (Stage 11) — Codex round 1 ❌#5 fix: mark migrations 001-032
  // as already applied using their REAL names from the migrations array.
  // Earlier draft used `${padded}_pre_q_marker` which `runMigrations`
  // doesn't recognize, so 001-032 would re-run on top of the manually-
  // built schema and fail (CREATE TABLE IF NOT EXISTS still works, but
  // ALTER TABLE ... ADD COLUMN would clash on already-existing columns).
  const { __getMigrationNamesForTests } = await import('../main/modules/migrations')
  const allNames = __getMigrationNamesForTests()
  // We want only 033 to be unapplied. Mark every other name as applied.
  for (const name of allNames) {
    if (name === '033_skill_task_runs_invariant_check') continue
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, nowIso())
  }
  return db
}

test('Q.3b: violator with valid action → tool_name backfilled to action', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 backfill action')) return
  const db = await buildPre033DbAndApply033()
  insertSkillTaskRunRow(db, {
    id: 'str-violator-1',
    run_kind: 'primitive',
    tool_name: 'skill_lifecycle',
    action: 'skill_write_artifact',
    status: 'blocked',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{
    tool_name: string; status: string; failure_kind: string; run_kind: string
  }>('str-violator-1')
  assert.ok(row, 'row preserved after migration')
  assert.equal(row!.tool_name, 'skill_write_artifact', 'tool_name backfilled from action')
  assert.equal(row!.status, 'cancelled', 'status set to cancelled')
  assert.equal(row!.failure_kind, 'stage_q_invariant_cleanup')
  assert.equal(row!.run_kind, 'primitive', 'run_kind preserved')
})

test('Q.3b: violator with empty action → tool_name=skill_unknown_primitive_cleanup', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 backfill empty action')) return
  const db = await buildPre033DbAndApply033()
  // Empty action would violate the NOT NULL column on skill_task_runs;
  // use trim-empty to test the trim() = '' branch in the CASE.
  insertSkillTaskRunRow(db, {
    id: 'str-violator-2',
    run_kind: 'primitive',
    tool_name: 'skill_lifecycle',
    action: '   ',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{ tool_name: string }>('str-violator-2')
  assert.equal(row?.tool_name, 'skill_unknown_primitive_cleanup')
})

test("Q.3b: violator with action='skill_lifecycle' → tool_name=skill_unknown_primitive_cleanup", async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 backfill action=skill_lifecycle')) return
  const db = await buildPre033DbAndApply033()
  insertSkillTaskRunRow(db, {
    id: 'str-violator-3',
    run_kind: 'primitive',
    tool_name: 'skill_lifecycle',
    action: 'skill_lifecycle',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{ tool_name: string }>('str-violator-3')
  assert.equal(row?.tool_name, 'skill_unknown_primitive_cleanup')
})

test('Q.3b: violator with action that does not match skill_* prefix → cleanup sentinel', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 backfill non-skill action')) return
  const db = await buildPre033DbAndApply033()
  insertSkillTaskRunRow(db, {
    id: 'str-violator-4',
    run_kind: 'primitive',
    tool_name: 'skill_lifecycle',
    action: 'not-a-primitive',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{ tool_name: string }>('str-violator-4')
  assert.equal(row?.tool_name, 'skill_unknown_primitive_cleanup')
})

test('Q.3b: non-violator rows are unchanged', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 non-violators preserved')) return
  const db = await buildPre033DbAndApply033()
  insertSkillTaskRunRow(db, {
    id: 'str-clean-1',
    run_kind: 'typed_action',
    tool_name: 'skill_humanizer-zh_pipeline',
    action: 'pipeline',
    status: 'running',
  })
  insertSkillTaskRunRow(db, {
    id: 'str-clean-2',
    run_kind: 'primitive',
    tool_name: 'skill_run_shell',
    action: 'skill_run_shell',
    status: 'done',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const r1 = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{
    tool_name: string; status: string; failure_kind: string | null
  }>('str-clean-1')
  const r2 = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{
    tool_name: string; status: string; failure_kind: string | null
  }>('str-clean-2')
  assert.equal(r1?.tool_name, 'skill_humanizer-zh_pipeline')
  assert.equal(r1?.status, 'running')
  assert.equal(r1?.failure_kind, null)
  assert.equal(r2?.tool_name, 'skill_run_shell')
  assert.equal(r2?.status, 'done')
})

test('Q.3b: stale task_projections (no durable handle) cleaned to resumable_actions=["none"]', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 task_projections cleanup')) return
  const db = await buildPre033DbAndApply033()
  // Insert a violator-shaped projection: status=blocked, no durable handle.
  db.prepare(`
    INSERT INTO task_projections (
      task_id, scope_id, run_id, task_type, module, status, interaction_state,
      steps_json, resumable_actions_json, continuation_ref_json,
      created_at, updated_at
    ) VALUES (
      'skill:scope-q:humanizer-zh', 'scope-q', 'run-1', 'skill', 'skill', 'blocked',
      'suspended', '[]', '["continue","retry","cancel"]',
      '{"taskRunId":"str-old","skillId":"humanizer-zh"}',
      ?, ?
    )
  `).run(nowIso(), nowIso())
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM task_projections WHERE task_id = ?').get<{
    resumable_actions_json: string
    degradation_reason: string
  }>('skill:scope-q:humanizer-zh')
  assert.equal(row?.resumable_actions_json, '["none"]')
  // Only one cleanup marker exists post-Codex round 2 fix: the legacy
  // 2-colon key branch was dropped, so the marker is uniformly
  // `stage_q_invariant_cleanup`.
  assert.equal(row?.degradation_reason, 'stage_q_invariant_cleanup')
})

test('Q.3b: legacy `skill:S:K` key with durable handle is NOT cleaned', async (t) => {
  // Codex round 1 ❌#6 — branch (b) "blanket-clean 2-colon keys" was
  // dropped because the production writer `buildLongSkillRunningProjection`
  // still emits 2-colon keys for legitimate live tasks. Pin that those
  // rows are preserved.
  if (skipIfSqliteUnavailable(t, 'migration-033 legacy key with handle preserved')) return
  const db = await buildPre033DbAndApply033()
  db.prepare(`
    INSERT INTO task_projections (
      task_id, scope_id, run_id, task_type, module, status, interaction_state,
      steps_json, resumable_actions_json, continuation_ref_json,
      created_at, updated_at
    ) VALUES (
      'skill:scope-r:humanizer-zh', 'scope-r', 'run-2', 'skill', 'skill', 'running',
      'running', '[]', '["cancel"]',
      '{"outputDir":"/tmp/x","runStatePath":"/tmp/x/run_state.json"}',
      ?, ?
    )
  `).run(nowIso(), nowIso())
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM task_projections WHERE task_id = ?').get<{
    resumable_actions_json: string
    degradation_reason: string | null
    status: string
  }>('skill:scope-r:humanizer-zh')
  // Legacy key + has durable handle + status='running' → not blocked,
  // not stale, not cleaned.
  assert.equal(row?.resumable_actions_json, '["cancel"]')
  assert.equal(row?.degradation_reason, null)
  assert.equal(row?.status, 'running')
})

test('Q.3b: typed_action + tool_name=skill_lifecycle row is NOT a violator (CHECK only forbids primitive)', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-033 typed_action+lifecycle preserved')) return
  const db = await buildPre033DbAndApply033()
  // typed_action+skill_lifecycle is the legitimate lifecycle row shape
  // (see skill-task-tracker.ts:425-426 createRunFromLifecycleEvent).
  // CHECK only forbids `primitive + skill_lifecycle`, so this row must
  // pass through unchanged.
  insertSkillTaskRunRow(db, {
    id: 'str-typed-lifecycle',
    run_kind: 'typed_action',
    tool_name: 'skill_lifecycle',
    action: 'video_expert_pipeline',
    status: 'running',
  })
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  const row = db.prepare('SELECT * FROM skill_task_runs WHERE id = ?').get<{
    tool_name: string; status: string; failure_kind: string | null; run_kind: string
  }>('str-typed-lifecycle')
  assert.equal(row?.tool_name, 'skill_lifecycle')
  assert.equal(row?.run_kind, 'typed_action')
  assert.equal(row?.status, 'running')
  assert.equal(row?.failure_kind, null)
})
