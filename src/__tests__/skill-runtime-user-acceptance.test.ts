import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildContinuationStateFromProjection, selectContinuationProjection } from '../main/modules/agent-control/contracts/continuation-state'
import { DetachedSkillTaskTracker, type DetachedSkillTaskRecord } from '../main/modules/agent-control/detached-skill-task-tracker'
import { createSkillBudgetLeaseState, evaluateSkillBudgetLease } from '../main/modules/agent-control/skills/skill-budget-lease-controller'
import { scoreSkillProgress } from '../main/modules/agent-control/progress-scorer'
import { scoreSkillWaste } from '../main/modules/agent-control/waste-scorer'
import { SkillTaskSupervisor, type SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'
import { SkillTaskRunRepository, type SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { buildTaskCardViewModel, deriveTaskCardRuntimeState, type TaskCardRunLike } from '../renderer/modules/agent/taskCardViewModel'
import { filterSkillPrimitivesBySession } from '../main/modules/tools/skill-tool-session-gate'

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get<T = unknown>(...params: unknown[]): T | undefined
    all<T = unknown>(...params: unknown[]): T[]
  }
  close(): void
}

type SqliteCtor = new (path: string) => SqliteDatabase

const require = createRequire(import.meta.url)
let sqliteUnavailableReason: string | null = null
const Database = ((() => {
  try {
    const mod = require('node:sqlite') as { DatabaseSync: SqliteCtor }
    return mod.DatabaseSync
  } catch (error) {
    sqliteUnavailableReason = error instanceof Error ? error.message : String(error)
    return null
  }
})())

function getDatabaseCtor(): SqliteCtor {
  if (!Database) {
    throw new Error(sqliteUnavailableReason || 'node:sqlite is unavailable')
  }
  return Database
}

function testWithSqlite(
  name: string,
  fn: (t: TestContext) => void | Promise<void>,
): void {
  if (!Database) {
    test(name, { skip: `[ABI-SKIP][sqlite_runtime_error] ${name}: ${sqliteUnavailableReason}; covered by npm run verify:native` }, () => {})
    return
  }
  test(name, fn)
}

const NOW = '2026-04-28T02:00:00.000Z'
const SESSION_ID = 'scope-acceptance'
const SKILL_ID = 'video-expert-analyzer'
const ACTION = 'video_expert_pipeline'

interface AcceptanceFixture {
  root: string
  dbPath: string
  db: SqliteDatabase
  skillRuns: SkillTaskRunRepository
  projections: TaskProjectionRepository
  detachedStoragePath: string
  outputDir: string
  taskRunId: string
  detachedTaskId: string
  runStatePath: string
  sceneScoresPath: string
  deliveryReportPath: string
  metrics: Array<Record<string, unknown>>
}

function setupSchema(db: SqliteDatabase): void {
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
    CREATE INDEX idx_skill_task_runs_session_status_updated
      ON skill_task_runs(session_id, status, updated_at DESC);
    CREATE INDEX idx_skill_task_runs_detached_task_id
      ON skill_task_runs(detached_task_id);

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
      budget_warning_level TEXT,
      recovery_history_json TEXT,
      degradation_reason TEXT,
      blocked_reason TEXT,
      resumable_actions_json TEXT,
      continuation_ref_json TEXT,
      progress_json TEXT,
      recent_artifacts_json TEXT,
      criteria_json TEXT,
      checkins_json TEXT,
      proof_refs_json TEXT,
      learning_refs_json TEXT,
      model_criteria_json TEXT,
      expected_outputs_json TEXT,
      owner_agent_id TEXT,
      packet_role TEXT,
      context_refs_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_task_projections_scope_updated
      ON task_projections(scope_id, updated_at DESC);
  `)
}

function createFixture(): AcceptanceFixture {
  const root = mkdtempSync(join(tmpdir(), 'ready-skill-runtime-acceptance-'))
  const dbPath = join(root, 'acceptance.sqlite')
  const Db = getDatabaseCtor()
  const db = new Db(dbPath)
  setupSchema(db)
  const dbAccessor = { getRawDb: () => db }
  const outputDir = join(root, 'vea-output')
  mkdirSync(outputDir, { recursive: true })
  const fixture: AcceptanceFixture = {
    root,
    dbPath,
    db,
    skillRuns: new SkillTaskRunRepository(dbAccessor),
    projections: new TaskProjectionRepository(dbAccessor),
    detachedStoragePath: join(root, 'detached-tasks.json'),
    outputDir,
    taskRunId: 'str-acceptance',
    detachedTaskId: 'dst-acceptance',
    runStatePath: join(outputDir, 'run_state.json'),
    sceneScoresPath: join(outputDir, 'scene_scores.json'),
    deliveryReportPath: join(outputDir, 'delivery_report.json'),
    metrics: [],
  }
  writeRunArtifacts(fixture, { status: 'running', stage: 'prepare', completedScenes: 0, totalScenes: 120 })
  writeDetachedStorage(fixture, 'running')
  fixture.skillRuns.create(makeSkillRun(fixture, 'running'))
  fixture.projections.create(makeProjection(fixture, 'blocked', {
    blockerType: 'background_running',
    blockedReason: '技能任务仍在后台运行',
  }))
  return fixture
}

function closeFixture(fixture: AcceptanceFixture): void {
  fixture.db.close()
  rmSync(fixture.root, { recursive: true, force: true })
}

function writeRunArtifacts(
  fixture: AcceptanceFixture,
  params: { status: string; stage: string; completedScenes: number; totalScenes: number; deliveryComplete?: boolean },
): void {
  writeFileSync(fixture.runStatePath, JSON.stringify({
    schema_version: 'vea-vnext',
    task_id: fixture.detachedTaskId,
    status: params.status,
    current_stage: params.stage,
    completed_scenes: params.completedScenes,
    total_scenes: params.totalScenes,
    coverage_ratio: params.totalScenes > 0 ? params.completedScenes / params.totalScenes : 0,
    active_output_dir: fixture.outputDir,
    updated_at: NOW,
  }, null, 2), 'utf8')
  writeFileSync(fixture.sceneScoresPath, JSON.stringify({
    scenes: Array.from({ length: params.completedScenes }, (_, index) => ({ scene: index + 1, score: 0.7 })),
  }), 'utf8')
  writeFileSync(join(fixture.outputDir, `activity-${params.completedScenes}.txt`), String(params.completedScenes), 'utf8')
  if (params.deliveryComplete) {
    writeFileSync(fixture.deliveryReportPath, JSON.stringify({
      status: 'completed',
      missing_outputs: [],
      missing_screenshot_scenes: [],
      missing_sample_scenes: [],
      blocked_batches: [],
      incomplete_scene_numbers: [],
      required_outputs: {
        scene_scores: { ok: true },
        storyboard_md: { ok: true },
      },
      verification: { passed: true },
    }, null, 2), 'utf8')
  }
}

function writeDetachedStorage(fixture: AcceptanceFixture, status: DetachedSkillTaskRecord['status']): void {
  const finishedAt = status === 'done' || status === 'failed' || status === 'cancelled' ? NOW : null
  writeFileSync(fixture.detachedStoragePath, JSON.stringify({
    tasks: [{
      id: fixture.detachedTaskId,
      scopeId: SESSION_ID,
      sessionId: SESSION_ID,
      agent: 'butler',
      skillId: SKILL_ID,
      action: ACTION,
      params: { outputDir: fixture.outputDir },
      status,
      outputDir: fixture.outputDir,
      runStatePath: fixture.runStatePath,
      sceneScoresPath: fixture.sceneScoresPath,
      deliveryReportPath: fixture.deliveryReportPath,
      error: null,
      startedAt: NOW,
      updatedAt: NOW,
      finishedAt,
    }],
  }, null, 2), 'utf8')
}

function makeSkillRun(fixture: AcceptanceFixture, status: SkillTaskRunRecord['status']): SkillTaskRunRecord {
  const blocked = status === 'blocked'
  const done = status === 'done'
  return {
    id: fixture.taskRunId,
    scopeId: SESSION_ID,
    sessionId: SESSION_ID,
    agent: 'butler',
    runId: 'run-acceptance',
    skillId: SKILL_ID,
    skillName: 'Video Expert Analyzer',
    action: ACTION,
    toolName: 'skill_video_expert_pipeline',
    runKind: 'typed_action',
    status,
    interactionState: blocked ? 'suspended' : 'running',
    goalText: '分析长视频',
    resourceRefs: [],
    params: { outputDir: fixture.outputDir },
    steps: [{
      id: 'skill_video_expert_pipeline#1',
      title: '视频分析',
      status: done ? 'done' : blocked ? 'blocked' : 'running',
      updatedAt: NOW,
    }],
    currentStepId: 'skill_video_expert_pipeline#1',
    artifacts: [],
    outputDir: fixture.outputDir,
    runStatePath: fixture.runStatePath,
    sceneScoresPath: fixture.sceneScoresPath,
    deliveryReportPath: fixture.deliveryReportPath,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: fixture.detachedTaskId,
    resumePayload: {
      taskRunId: fixture.taskRunId,
      detachedTaskId: fixture.detachedTaskId,
      skillId: SKILL_ID,
      action: ACTION,
      outputDir: fixture.outputDir,
      runStatePath: fixture.runStatePath,
    },
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    finishedAt: done ? NOW : null,
  }
}

function makeProjection(
  fixture: AcceptanceFixture,
  status: TaskProjectionRecord['status'],
  options: { blockerType?: string; blockedReason?: string | null; pauseReason?: string | null } = {},
): TaskProjectionRecord {
  const blocked = status === 'blocked'
  const done = status === 'done'
  return {
    taskId: fixture.taskRunId,
    scopeId: SESSION_ID,
    runId: 'run-acceptance',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: done ? '视频分析已完成' : options.blockedReason || '视频分析仍在运行',
    status,
    interactionState: blocked ? 'suspended' : 'running',
    steps: [{
      id: 'skill_video_expert_pipeline#1',
      title: '视频分析',
      description: '视频分析',
      status: done ? 'done' : blocked ? 'blocked' : 'running',
      updatedAt: NOW,
    }],
    currentStepId: 'skill_video_expert_pipeline#1',
    budget: null,
    budgetUsagePercent: blocked ? 100 : null,
    budgetWarningLevel: blocked ? 'exhausted' : null,
    recoveryHistory: [],
    degradationReason: options.pauseReason || null,
    blockedReason: blocked ? options.blockedReason || '等待继续' : null,
    resumableActions: done ? ['open_artifact'] : ['continue', 'retry', 'cancel'],
    continuationRef: blocked ? {
      taskId: fixture.taskRunId,
      stepId: 'skill_video_expert_pipeline#1',
      blockerType: options.blockerType || 'background_running',
      pauseReason: options.pauseReason || null,
      taskRunId: fixture.taskRunId,
      detachedTaskId: fixture.detachedTaskId,
      skillId: SKILL_ID,
      action: ACTION,
      outputDir: fixture.outputDir,
      runStatePath: fixture.runStatePath,
    } : null,
    recentArtifacts: done ? [{
      id: 'report',
      module: 'skill',
      kind: 'artifact',
      label: 'delivery_report.json',
      path: fixture.deliveryReportPath,
      createdAt: NOW,
    }] : [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function updateRunAndProjection(
  fixture: AcceptanceFixture,
  runStatus: SkillTaskRunRecord['status'],
  projectionStatus: TaskProjectionRecord['status'],
  options: { blockerType?: string; blockedReason?: string | null; pauseReason?: string | null } = {},
): void {
  // Stage 6 L1: status writes go through updateRowSync (acceptance harness path).
  fixture.skillRuns.updateRowSync(fixture.taskRunId, makeSkillRun(fixture, runStatus))
  fixture.projections.update(fixture.taskRunId, makeProjection(fixture, projectionStatus, options))
}

function createSupervisor(fixture: AcceptanceFixture, detachedOverride?: DetachedSkillTaskRecord[]): SkillTaskSupervisor {
  return new SkillTaskSupervisor({
    now: () => Date.parse(NOW),
    getTaskRun: (taskRunId) => fixture.skillRuns.get(taskRunId),
    findTaskRunByDetachedTaskId: (detachedTaskId) => fixture.skillRuns.findByDetachedTaskId(detachedTaskId),
    listActiveTaskRuns: (sessionId, limit) => fixture.skillRuns.listActiveBySession(sessionId, limit),
    findLatestRecoverableTaskRun: (params) => fixture.skillRuns.findLatestRecoverable(params),
    listDetachedTasks: () => detachedOverride || readDetachedTasks(fixture),
    getDetachedTask: (taskId) => (detachedOverride || readDetachedTasks(fixture)).find((item) => item.id === taskId) || null,
    readProjection: () => fixture.projections.get(fixture.taskRunId),
  })
}

function readDetachedTasks(fixture: AcceptanceFixture): DetachedSkillTaskRecord[] {
  const parsed = JSON.parse(readFileSync(fixture.detachedStoragePath, 'utf8')) as { tasks?: DetachedSkillTaskRecord[] }
  return parsed.tasks || []
}

function viewRunFromProjection(projection: TaskProjectionRecord): TaskCardRunLike {
  return {
    scopeId: projection.scopeId,
    taskId: projection.taskId,
    phase: projection.status === 'done' ? 'done' : 'checkpoint',
    status: projection.status,
    title: '视频分析',
    taskTitle: projection.taskTitle,
    taskSummary: projection.taskSummary,
    steps: projection.steps.map((step) => ({
      id: step.id,
      title: step.title || step.id,
      status: step.status === 'error' ? 'error' : step.status,
      detail: step.detail || null,
      updatedAt: step.updatedAt || projection.updatedAt,
      childTasks: step.childTasks,
    })),
    currentStepId: projection.currentStepId,
    waitingFor: projection.status === 'blocked' ? 'background' : 'none',
    resumableActions: projection.resumableActions,
    recentArtifacts: projection.recentArtifacts,
    taskContinuation: projection.continuationRef,
    interactionState: projection.interactionState,
    budgetUsagePercent: projection.budgetUsagePercent,
    budgetWarningLevel: projection.budgetWarningLevel,
    degradationReason: projection.degradationReason,
    blockedReason: projection.blockedReason,
    updatedAt: projection.updatedAt,
  }
}

function assertAcceptanceEvidence(fixture: AcceptanceFixture, options: { expectDone: boolean }): void {
  const taskRun = fixture.skillRuns.get(fixture.taskRunId)
  const projection = fixture.projections.get(fixture.taskRunId)
  const detached = readDetachedTasks(fixture).find((item) => item.id === fixture.detachedTaskId)
  const runState = JSON.parse(readFileSync(fixture.runStatePath, 'utf8')) as Record<string, unknown>
  assert.ok(taskRun)
  assert.ok(projection)
  assert.ok(detached)

  assert.equal(taskRun.detachedTaskId, fixture.detachedTaskId)
  assert.equal(taskRun.runStatePath, fixture.runStatePath)
  assert.equal(taskRun.outputDir, fixture.outputDir)
  assert.equal(detached.runStatePath, fixture.runStatePath)
  assert.equal(detached.outputDir, fixture.outputDir)
  assert.equal(runState.task_id, fixture.detachedTaskId)

  if (projection.continuationRef) {
    assert.equal(projection.continuationRef.taskRunId, fixture.taskRunId)
    assert.equal(projection.continuationRef.detachedTaskId, fixture.detachedTaskId)
    assert.equal(projection.continuationRef.runStatePath, fixture.runStatePath)
    assert.equal(projection.continuationRef.outputDir, fixture.outputDir)
  }

  const runtimeState = deriveTaskCardRuntimeState(viewRunFromProjection(projection))
  const viewModel = buildTaskCardViewModel(viewRunFromProjection(projection), undefined)
  // Internal-style "技能执行 · …" titles are intentionally rewritten by
  // formatTaskTitleForUser → '正在处理任务' (the canonical user-facing label).
  // The taskTitle stored on the projection is preserved (assert above on
  // taskRun.detachedTaskId etc.); only the user-visible title is normalised.
  assert.equal(viewModel.title, '正在处理任务')

  const runStateDone = ['completed', 'success', 'done'].includes(String(runState.status || '').toLowerCase())
  if (options.expectDone) {
    assert.equal(runStateDone, true)
    assert.equal(taskRun.status, 'done')
    assert.equal(projection.status, 'done')
    assert.equal(runtimeState.visualState, 'done')
  } else {
    assert.equal(runStateDone, false)
    assert.notEqual(taskRun.status, 'done')
    assert.notEqual(projection.status, 'done')
    assert.notEqual(runtimeState.visualState, 'done')
  }

  assert.ok(fixture.metrics.some((metric) =>
    metric.taskRunId === fixture.taskRunId
      && metric.detachedTaskId === fixture.detachedTaskId
      && metric.runStatePath === fixture.runStatePath,
  ))
}

testWithSqlite('Phase 6 accepts a healthy long skill task only after delivery_report and supervisor close', () => {
  const fixture = createFixture()
  try {
    const supervisor = createSupervisor(fixture)
    let lease = createSkillBudgetLeaseState({ iteration: 0 })
    let previous: SkillTaskSupervisorSnapshot | null = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })

    for (let iteration = 1; iteration <= 140; iteration += 1) {
      if (iteration % 5 !== 0) continue
      writeRunArtifacts(fixture, {
        status: 'running',
        stage: iteration < 90 ? 'score_batches' : 'finalize',
        completedScenes: iteration,
        totalScenes: 140,
      })
      const current = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
      const progress = scoreSkillProgress({
        previousFingerprint: lease.lastFingerprint,
        previousSnapshot: previous,
        currentSnapshot: current,
        executedTools: [{ name: 'skill_video_expert_pipeline', result: { text: '', data: { runStatePath: fixture.runStatePath, currentStage: current.progress.currentStage } } }],
      })
      const waste = scoreSkillWaste({
        executedTools: [{ name: 'skill_inspect_run_state', result: { text: '', data: { runStatePath: fixture.runStatePath } } }],
        currentFingerprint: current.progressFingerprint,
        previousFingerprint: lease.lastFingerprint,
      })
      if (iteration >= lease.currentLeaseEndIteration - 1) {
        const decision = evaluateSkillBudgetLease({ state: lease, iteration, progress, waste, snapshot: current })
        lease = decision.state
        fixture.metrics.push({
          metric: 'skill_budget_lease_decision',
          decision: decision.decision,
          taskRunId: fixture.taskRunId,
          detachedTaskId: fixture.detachedTaskId,
          runStatePath: fixture.runStatePath,
        })
      }
      previous = current
    }

    const beforeDelivery = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
    assert.equal(beforeDelivery.closeAllowed, false)
    assert.notEqual(beforeDelivery.status, 'done')

    writeRunArtifacts(fixture, {
      status: 'completed',
      stage: 'completed',
      completedScenes: 140,
      totalScenes: 140,
      deliveryComplete: true,
    })
    writeDetachedStorage(fixture, 'done')
    updateRunAndProjection(fixture, 'done', 'done')
    fixture.metrics.push({
      metric: 'skill_task_completed',
      taskRunId: fixture.taskRunId,
      detachedTaskId: fixture.detachedTaskId,
      runStatePath: fixture.runStatePath,
    })

    const completed = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
    // Phase 7 — supervisor public surface uses `completed` (not `done`).
    assert.equal(completed.status, 'completed')
    assert.equal(completed.closeAllowed, true)
    assertAcceptanceEvidence(fixture, { expectDone: true })
  } finally {
    closeFixture(fixture)
  }
})

testWithSqlite('Phase 6 pauses a stalled long skill loop without losing resume handles', () => {
  const fixture = createFixture()
  try {
    const supervisor = createSupervisor(fixture)
    let lease = createSkillBudgetLeaseState({ iteration: 0 })
    const snapshot = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
    lease.lastFingerprint = snapshot.progressFingerprint

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const progress = scoreSkillProgress({
        previousFingerprint: lease.lastFingerprint,
        previousSnapshot: snapshot,
        currentSnapshot: snapshot,
      })
      const waste = scoreSkillWaste({
        executedTools: [{ name: 'skill_inspect_run_state', result: { text: '', data: { runStatePath: fixture.runStatePath } } }],
        currentFingerprint: snapshot.progressFingerprint,
        previousFingerprint: snapshot.progressFingerprint,
      })
      const decision = evaluateSkillBudgetLease({
        state: lease,
        iteration: lease.currentLeaseEndIteration,
        progress,
        waste,
        snapshot,
      })
      lease = decision.state
      fixture.metrics.push({
        metric: 'skill_budget_lease_decision',
        decision: decision.decision,
        reason: decision.reason,
        taskRunId: fixture.taskRunId,
        detachedTaskId: fixture.detachedTaskId,
        runStatePath: fixture.runStatePath,
      })
    }

    assert.equal(lease.decision, 'pause')
    updateRunAndProjection(fixture, 'blocked', 'blocked', {
      blockerType: 'budget_paused',
      pauseReason: 'budget_exhausted',
      blockedReason: '本轮预算已用完，技能任务已暂停，可继续执行',
    })
    assertAcceptanceEvidence(fixture, { expectDone: false })
    const projection = fixture.projections.get(fixture.taskRunId)!
    assert.equal(projection.continuationRef?.pauseReason, 'budget_exhausted')
    assert.equal(projection.continuationRef?.taskRunId, fixture.taskRunId)
    assert.equal(projection.continuationRef?.detachedTaskId, fixture.detachedTaskId)
  } finally {
    closeFixture(fixture)
  }
})

testWithSqlite('Phase 6 hands off live detached work to background instead of marking the parent done', () => {
  const fixture = createFixture()
  try {
    const supervisor = createSupervisor(fixture)
    const snapshot = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
    const decision = evaluateSkillBudgetLease({
      state: createSkillBudgetLeaseState({ iteration: 0 }),
      iteration: 20,
      progress: { score: 0, reasons: [], fingerprint: snapshot.progressFingerprint, fingerprintChanged: false, milestoneChanged: false },
      waste: { score: 0, reasons: [], repeatedUnchangedObservation: false, repeatedRecoverableError: false },
      snapshot,
    })
    assert.equal(decision.decision, 'handoff_background')
    updateRunAndProjection(fixture, 'blocked', 'blocked', {
      blockerType: 'background_running',
      blockedReason: '技能任务仍在后台运行',
    })
    fixture.metrics.push({
      metric: 'skill_budget_lease_decision',
      decision: decision.decision,
      taskRunId: fixture.taskRunId,
      detachedTaskId: fixture.detachedTaskId,
      runStatePath: fixture.runStatePath,
    })

    const runtimeState = deriveTaskCardRuntimeState(viewRunFromProjection(fixture.projections.get(fixture.taskRunId)!))
    assert.equal(runtimeState.visualState, 'background_running')
    assertAcceptanceEvidence(fixture, { expectDone: false })
  } finally {
    closeFixture(fixture)
  }
})

testWithSqlite('Phase 6 restart recovery keeps the same detached task identity and continuation anchor', () => {
  const fixture = createFixture()
  try {
    updateRunAndProjection(fixture, 'blocked', 'blocked', {
      blockerType: 'background_running',
      blockedReason: 'Ready 重启前后台任务仍在运行',
    })
    writeDetachedStorage(fixture, 'running')
    fixture.db.close()

    const Db = getDatabaseCtor()
    const restartedDb = new Db(fixture.dbPath)
    fixture.db = restartedDb
    fixture.skillRuns = new SkillTaskRunRepository({ getRawDb: () => restartedDb })
    fixture.projections = new TaskProjectionRepository({ getRawDb: () => restartedDb })
    const tracker = new DetachedSkillTaskTracker({
      storagePath: fixture.detachedStoragePath,
      runSkill: async () => ({ success: false, status: 'blocked', error: 'not used in acceptance restart test' } as any),
    })
    const supervisor = createSupervisor(fixture, tracker.list({ scopeId: SESSION_ID }))
    const snapshot = supervisor.inspectLatestSkillTask({ sessionId: SESSION_ID, skillId: SKILL_ID })
    const projection = selectContinuationProjection({
      projections: fixture.projections.listByScope(SESSION_ID),
      userText: '继续',
    })
    assert.ok(projection)
    const continuation = buildContinuationStateFromProjection(projection)

    assert.equal(snapshot.taskRunId, fixture.taskRunId)
    assert.equal(snapshot.detachedTaskId, fixture.detachedTaskId)
    assert.equal(continuation.continuationRef?.taskRunId, fixture.taskRunId)
    assert.equal(continuation.continuationRef?.detachedTaskId, fixture.detachedTaskId)
    assert.equal(continuation.continuationRef?.runStatePath, fixture.runStatePath)
    fixture.metrics.push({
      metric: 'skill_restart_recovered',
      taskRunId: fixture.taskRunId,
      detachedTaskId: fixture.detachedTaskId,
      runStatePath: fixture.runStatePath,
    })
    assertAcceptanceEvidence(fixture, { expectDone: false })
  } finally {
    closeFixture(fixture)
  }
})

testWithSqlite('Phase 6 normal chat does not expose skill primitives or resume stale VEA work', () => {
  const fixture = createFixture()
  try {
    const beforeRuns = fixture.db.prepare('SELECT COUNT(*) AS count FROM skill_task_runs').get<{ count: number }>()!.count
    const projections = fixture.projections.listByScope(SESSION_ID)
    let detachedJsonReads = 0
    const selected = selectContinuationProjection({
      projections,
      userText: '帮我换个标题',
    })
    if (selected) {
      detachedJsonReads += 1
      readDetachedTasks(fixture)
    }
    const exposed = filterSkillPrimitivesBySession(
      [{ name: 'skill_run_shell' }, { name: 'skill_read_artifact' }, { name: 'skill_inspect_run_state' }],
      SESSION_ID,
      () => false,
      () => false,
      () => false,
    )
    const afterRuns = fixture.db.prepare('SELECT COUNT(*) AS count FROM skill_task_runs').get<{ count: number }>()!.count

    assert.equal(selected, null)
    assert.equal(detachedJsonReads, 0)
    assert.deepEqual(exposed, [])
    assert.equal(afterRuns, beforeRuns)
  } finally {
    closeFixture(fixture)
  }
})
