import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
  __resetProjectionHandleLegacyOriginThrottleForTests,
  __resetTaskProjectionJsonReadThrottleForTests,
  deriveHandlesWithOrigins,
  reconcileTaskProjections,
} from '../main/modules/agent-control/task-projection/task-projection-reconciler'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/run-contracts'
import type { SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return { events, restore: () => __setMetricSinkForTests(null) }
}

const NOW = '2026-05-04T10:00:00.000Z'
const OLD = '2026-05-04T09:20:00.000Z'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(name: string): string {
  const root = join(tmpdir(), `ready-task-projection-reconciler-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
}

function createStore(records: TaskProjectionRecord[]): {
  store: TaskProjectionStore
  records: Map<string, TaskProjectionRecord>
  updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }>
} {
  const map = new Map(records.map((record) => [record.taskId, record]))
  const updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }> = []
  return {
    records: map,
    updates,
    store: {
      create(record) {
        map.set(record.taskId, record)
      },
      update(taskId, patch) {
        updates.push({ taskId, patch })
        map.set(taskId, {
          ...map.get(taskId)!,
          ...patch,
        })
      },
      get(taskId) {
        return map.get(taskId) || null
      },
      listByScope(scopeId) {
        return Array.from(map.values()).filter((record) => record.scopeId === scopeId)
      },
      listByParentTask(parentTaskId) {
        return Array.from(map.values()).filter((record) => record.parentTaskId === parentTaskId)
      },
    },
  }
}

function baseProjection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: '视频分析',
    taskSummary: '视频分析进行中',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'background',
    steps: [{
      id: 'step-1',
      title: '视频分析',
      status: 'running',
      updatedAt: OLD,
    }],
    currentStepId: 'step-1',
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: ['cancel'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

function writeIncompleteRunState(outputDir: string): string {
  const runStatePath = join(outputDir, 'run_state.json')
  writeJson(runStatePath, {
    status: 'recoverable_paused',
    current_stage: 'score_batches',
    output_dir: outputDir,
  })
  return runStatePath
}

function writeCompletedRun(outputDir: string, options: { includeAudiovisual: boolean }): {
  runStatePath: string
  deliveryReportPath: string
} {
  const runStatePath = join(outputDir, 'run_state.json')
  const deliveryReportPath = join(outputDir, 'delivery_report.json')
  writeJson(runStatePath, {
    status: 'completed',
    current_stage: 'completed',
    output_dir: outputDir,
  })
  writeFileSync(join(outputDir, 'scene_scores.json'), '{"scenes":[]}', 'utf8')
  writeFileSync(join(outputDir, 'video_storyboard.md'), 'storyboard', 'utf8')
  writeFileSync(join(outputDir, 'video_storyboard.pdf'), 'storyboard pdf', 'utf8')
  if (options.includeAudiovisual) {
    writeFileSync(join(outputDir, 'video_audiovisual_analysis.md'), 'audiovisual', 'utf8')
    writeFileSync(join(outputDir, 'video_audiovisual_analysis.pdf'), 'audiovisual pdf', 'utf8')
  }
  writeJson(deliveryReportPath, {
    status: 'completed',
    missing_outputs: [],
    blocked_batches: [],
    incomplete_scene_numbers: [],
    missing_screenshot_scenes: [],
    missing_sample_scenes: [],
    blockers: [],
    last_error: '',
    required_outputs: {
      storyboard_md: { path: join(outputDir, 'video_storyboard.md'), ok: true },
      storyboard_pdf: { path: join(outputDir, 'video_storyboard.pdf'), ok: true },
      ...(options.includeAudiovisual
        ? {
            audiovisual_md: { path: join(outputDir, 'video_audiovisual_analysis.md'), ok: true },
            audiovisual_pdf: { path: join(outputDir, 'video_audiovisual_analysis.pdf'), ok: true },
          }
        : {}),
    },
    verification: { passed: true },
  })
  return { runStatePath, deliveryReportPath }
}

test('reconcileTaskProjections marks stale running projections without durable handles as stale-paused', async () => {
  const { store, records } = createStore([baseProjection()])

  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

  const updated = records.get('task-1')!
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'none')
  assert.equal(updated.degradationReason, 'stale_paused')
  assert.equal(updated.blockedReason, '任务状态已过期，缺少可续跑句柄')
  assert.deepEqual(updated.resumableActions, ['none'])
})

test('reconcileTaskProjections keeps blocked VEA projections resumable when run_state/outputDir exists but output is incomplete', async () => {
  const outputDir = createRoot('blocked')
  const runStatePath = writeIncompleteRunState(outputDir)
  const { store, records } = createStore([
    baseProjection({
      taskId: 'skill:run_state:blocked',
      status: 'blocked',
      continuationRef: {
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        outputDir,
        runStatePath,
      },
    }),
  ])

  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

  const updated = records.get('skill:run_state:blocked')!
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'background')
  assert.ok(updated.resumableActions?.includes('continue'))
  assert.ok(updated.resumableActions?.includes('cancel'))
  assert.equal(updated.blockedReason, '任务产物尚未完成，可从已保存的进度继续')
})

test('reconcileTaskProjections does not mark VEA done when delivery_report lacks audiovisual outputs', async () => {
  const outputDir = createRoot('missing-audiovisual')
  const { runStatePath, deliveryReportPath } = writeCompletedRun(outputDir, { includeAudiovisual: false })
  const { store, records } = createStore([
    baseProjection({
      taskId: 'skill:run_state:missing-audiovisual',
      continuationRef: {
        skillId: 'video-expert-analyzer',
        outputDir,
        runStatePath,
      },
      recentArtifacts: [{
        id: 'delivery',
        module: 'skill',
        kind: 'artifact',
        label: 'delivery_report.json',
        path: deliveryReportPath,
        createdAt: OLD,
        meta: { outputDir, skillId: 'video-expert-analyzer' },
      }],
    }),
  ])

  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

  const updated = records.get('skill:run_state:missing-audiovisual')!
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'background')
  assert.ok(updated.blockedReason?.includes('尚未完成'))
})

test('reconcileTaskProjections marks complete VEA output done and is idempotent', async () => {
  const outputDir = createRoot('done')
  const { runStatePath, deliveryReportPath } = writeCompletedRun(outputDir, { includeAudiovisual: true })
  const { store, records, updates } = createStore([
    baseProjection({
      taskId: 'skill:run_state:done',
      continuationRef: {
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        outputDir,
        runStatePath,
      },
      recentArtifacts: [{
        id: 'run-state',
        module: 'skill',
        kind: 'artifact',
        label: 'run_state.json',
        path: runStatePath,
        createdAt: OLD,
        meta: { outputDir, deliveryReportPath, skillId: 'video-expert-analyzer' },
      }],
    }),
  ])

  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })
  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })
  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: '2026-05-04T10:05:00.000Z' })

  const updated = records.get('skill:run_state:done')!
  assert.equal(updated.status, 'done')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'none')
  assert.deepEqual(updated.resumableActions, ['open_artifact'])
  assert.equal(updates.length, 1)
})

test('reconcileTaskProjections enriches completed child projections with delivery report artifacts', async () => {
  const outputDir = createRoot('done-enrich-artifacts')
  const { runStatePath, deliveryReportPath } = writeCompletedRun(outputDir, { includeAudiovisual: true })
  const { store, records, updates } = createStore([
    baseProjection({
      taskId: 'skill-child:vcr_done_enrich',
      runId: 'vcr_done_enrich',
      status: 'done',
      interactionState: 'suspended',
      waitingFor: 'none',
      resumableActions: ['open_artifact'],
      continuationRef: {
        childRunId: 'vcr_done_enrich',
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        outputDir,
        runStatePath,
      },
      recentArtifacts: [{
        id: 'run-state',
        module: 'skill',
        kind: 'run_state',
        label: 'run_state.json',
        path: runStatePath,
        createdAt: OLD,
        meta: { outputDir, skillId: 'video-expert-analyzer' },
      }],
    }),
  ])

  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })
  await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

  const updated = records.get('skill-child:vcr_done_enrich')!
  assert.equal(updated.status, 'done')
  assert.equal(updated.blockedReason, null)
  assert.ok(updated.recentArtifacts?.some((item) => item.kind === 'delivery_report' && item.path === deliveryReportPath))
  assert.equal(updates.length, 1)
})

test('reconcileTaskProjections restores child-run handles from DB row and event log before checking artifacts', async () => {
  const outputDir = createRoot('db-log-done')
  const { runStatePath } = writeCompletedRun(outputDir, { includeAudiovisual: true })
  const eventLogPath = join(outputDir, '.ready', 'child-runs', 'vcr_db_done.jsonl')
  mkdirSync(join(outputDir, '.ready', 'child-runs'), { recursive: true })
  writeFileSync(eventLogPath, [
    JSON.stringify({
      type: 'started',
      at: OLD,
      childRunId: 'vcr_db_done',
      input: {},
    }),
    JSON.stringify({
      type: 'state_observed',
      at: OLD,
      runStatePath,
      state: {
        outputDir,
        stage: 'completed',
      },
    }),
    '',
  ].join('\n'), 'utf8')

  const taskRun: SkillTaskRunRecord = {
    id: 'vcr_db_done',
    scopeId: 'scope-1',
    sessionId: 'scope-1',
    agent: null,
    runId: null,
    skillId: 'video-expert-analyzer',
    skillName: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    toolName: null,
    runKind: 'child_run',
    status: 'blocked',
    interactionState: 'suspended',
    goalText: null,
    resourceRefs: [],
    params: {},
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: null,
    resumePayload: {
      childRun: {
        childRunId: 'vcr_db_done',
        skillId: 'video-expert-analyzer',
        requestedAction: 'video_expert_pipeline',
        outputDir: '',
        runStatePath: '',
        eventLogPath,
      },
    },
    createdAt: OLD,
    startedAt: OLD,
    updatedAt: OLD,
    finishedAt: null,
  }
  const { store, records } = createStore([
    baseProjection({
      taskId: 'skill-child:vcr_db_done',
      continuationRef: null,
      recentArtifacts: [],
    }),
  ])

  const params = {
    store,
    records: Array.from(records.values()),
    taskRuns: [taskRun],
    now: NOW,
  }
  await reconcileTaskProjections(params)

  const updated = records.get('skill-child:vcr_db_done')!
  assert.equal(updated.status, 'done')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'none')
  assert.equal(updated.continuationRef?.childRunId, 'vcr_db_done')
  assert.equal(updated.continuationRef?.skillId, 'video-expert-analyzer')
  assert.equal(updated.continuationRef?.action, 'video_expert_pipeline')
  assert.equal(updated.continuationRef?.outputDir, outputDir)
  assert.equal(updated.continuationRef?.runStatePath, runStatePath)
})

/**
 * Stage 3 W2 — JSON read failure classification: malformed run_state.json
 * emits `corrupt`, an array delivery_report.json emits `not_object`, and a
 * missing run_state.json stays silent (normal pre-completion state).
 * Reconciler-level behavior is unchanged: callers still see `null` and the
 * projection status drives identically.
 */

test('reconcileTaskProjections emits corrupt metric when run_state.json is malformed', async () => {
  const outputDir = createRoot('w2-corrupt')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, '{not json', 'utf8')
  __resetTaskProjectionJsonReadThrottleForTests()
  const { events, restore } = captureMetrics()
  try {
    const { store, records } = createStore([
      baseProjection({
        taskId: 'skill:run_state:w2-corrupt',
        status: 'blocked',
        continuationRef: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir,
          runStatePath,
        },
      }),
    ])

    await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

    const corrupt = events.filter(
      (e) => e.metric === 'task_projection_json_read_failed' && e.reason === 'corrupt',
    )
    assert.ok(corrupt.length >= 1, 'corrupt run_state.json should emit at least once')
    assert.equal(corrupt[0].pathTag, 'run_state.json')
  } finally {
    restore()
  }
})

test('reconcileTaskProjections emits not_object metric when delivery_report.json is an array', async () => {
  const outputDir = createRoot('w2-not-object')
  const { runStatePath, deliveryReportPath } = writeCompletedRun(outputDir, { includeAudiovisual: true })
  // Overwrite delivery_report.json with a JSON array (parses but is not a plain object).
  writeFileSync(deliveryReportPath, '[1,2,3]', 'utf8')
  __resetTaskProjectionJsonReadThrottleForTests()
  const { events, restore } = captureMetrics()
  try {
    const { store, records } = createStore([
      baseProjection({
        taskId: 'skill:run_state:w2-not-object',
        continuationRef: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir,
          runStatePath,
        },
      }),
    ])

    await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

    const notObject = events.filter(
      (e) => e.metric === 'task_projection_json_read_failed' && e.reason === 'not_object',
    )
    assert.ok(notObject.length >= 1, 'array delivery_report.json should emit at least once')
    assert.equal(notObject[0].pathTag, 'delivery_report.json')
  } finally {
    restore()
  }
})

test('reconcileTaskProjections emits independent corrupt metrics for distinct child-run paths within 60s', async () => {
  const outputDirA = createRoot('w2-corrupt-a')
  const outputDirB = createRoot('w2-corrupt-b')
  const runStatePathA = join(outputDirA, 'run_state.json')
  const runStatePathB = join(outputDirB, 'run_state.json')
  writeFileSync(runStatePathA, '{not json A', 'utf8')
  writeFileSync(runStatePathB, '{not json B', 'utf8')
  __resetTaskProjectionJsonReadThrottleForTests()
  const { events, restore } = captureMetrics()
  try {
    const { store, records } = createStore([
      baseProjection({
        taskId: 'skill:run_state:w2-corrupt-a',
        status: 'blocked',
        continuationRef: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir: outputDirA,
          runStatePath: runStatePathA,
        },
      }),
      baseProjection({
        taskId: 'skill:run_state:w2-corrupt-b',
        status: 'blocked',
        continuationRef: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir: outputDirB,
          runStatePath: runStatePathB,
        },
      }),
    ])

    await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

    const corruptPathTags = new Set(
      events
        .filter((e) => e.metric === 'task_projection_json_read_failed' && e.reason === 'corrupt')
        .map((e) => e.pathTag),
    )
    assert.equal(corruptPathTags.has('run_state.json'), true)
    // Both child-run paths should each emit; the two corrupt run_state.json files
    // share the same pathTag but have distinct full-path throttle keys, so the
    // metric fires once per path within the 60s window.
    const corruptCount = events.filter(
      (e) => e.metric === 'task_projection_json_read_failed' && e.reason === 'corrupt',
    ).length
    assert.ok(corruptCount >= 2, `expected at least 2 corrupt emits across distinct paths, got ${corruptCount}`)
  } finally {
    restore()
  }
})

test('reconcileTaskProjections does not emit metric when run_state.json is missing', async () => {
  const outputDir = createRoot('w2-missing')
  // Note: no run_state.json written; outputDir is empty.
  const runStatePath = join(outputDir, 'run_state.json')
  __resetTaskProjectionJsonReadThrottleForTests()
  const { events, restore } = captureMetrics()
  try {
    const { store, records } = createStore([
      baseProjection({
        taskId: 'skill:run_state:w2-missing',
        status: 'blocked',
        continuationRef: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          outputDir,
          runStatePath,
        },
      }),
    ])

    await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

    const readFailed = events.filter((e) => e.metric === 'task_projection_json_read_failed')
    assert.equal(readFailed.length, 0, 'missing run_state.json must not emit task_projection_json_read_failed')
  } finally {
    restore()
  }
})

/**
 * Stage 3 W3 — handle origin tracking. The 5 byte-identical regression
 * tests above guard behavior; the tests below assert that origins are
 * correctly stamped and that the legacy-origin metric only fires for
 * late fallbacks.
 */

test('deriveHandlesWithOrigins stamps continuation_ref when continuationRef provides outputDir', () => {
  const { handles, origins } = deriveHandlesWithOrigins(
    baseProjection({
      taskId: 'skill:origins:continuation',
      continuationRef: {
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        outputDir: '/tmp/some/output',
        runStatePath: '/tmp/some/output/run_state.json',
      },
    }),
    null,
  )
  assert.equal(handles.outputDir, '/tmp/some/output')
  assert.equal(origins.outputDir, 'continuation_ref')
  assert.equal(origins.runStatePath, 'continuation_ref')
  assert.equal(origins.skillId, 'continuation_ref')
  assert.equal(origins.action, 'continuation_ref')
})

test('deriveHandlesWithOrigins stamps artifact_path when only artifact path provides runStatePath', () => {
  const outputDir = createRoot('w3-artifact-path')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, '{"status":"running"}', 'utf8')
  const { handles, origins } = deriveHandlesWithOrigins(
    baseProjection({
      taskId: 'skill:origins:artifact-path',
      continuationRef: null,
      recentArtifacts: [{
        id: 'run-state',
        module: 'skill',
        kind: 'artifact',
        label: 'run_state.json',
        path: runStatePath,
        createdAt: OLD,
        meta: {},
      }],
    }),
    null,
  )
  assert.equal(handles.runStatePath, runStatePath)
  assert.equal(origins.runStatePath, 'artifact_path')
  assert.equal(origins.outputDir, 'artifact_path')
})

test('deriveHandlesWithOrigins finalizes missing origin for absent fields', () => {
  const { handles, origins } = deriveHandlesWithOrigins(
    baseProjection({
      taskId: 'skill:origins:missing',
      continuationRef: null,
      recentArtifacts: [],
    }),
    null,
  )
  assert.equal(handles.childRunId, null)
  assert.equal(origins.childRunId, 'missing')
  assert.equal(origins.skillId, 'missing')
  assert.equal(origins.taskRunId, 'missing')
  assert.equal(origins.outputDir, 'missing')
})

test('deriveHandlesWithOrigins stamps projection_task_id when only taskId prefix provides childRunId', () => {
  const { handles, origins } = deriveHandlesWithOrigins(
    baseProjection({
      taskId: 'skill-child:vcr_from_taskid',
      continuationRef: null,
      recentArtifacts: [],
    }),
    null,
  )
  assert.equal(handles.childRunId, 'vcr_from_taskid')
  assert.equal(
    origins.childRunId,
    'projection_task_id',
    'taskId-prefix fallback must not be mislabeled as continuation_ref',
  )
})

test('reconcileTaskProjections emits legacy origin metric when artifact_path origin fires', async () => {
  const outputDir = createRoot('w3-legacy-origin-emit')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, '{"status":"running"}', 'utf8')
  __resetProjectionHandleLegacyOriginThrottleForTests()
  __resetTaskProjectionJsonReadThrottleForTests()
  const { events, restore } = captureMetrics()
  try {
    const { store, records } = createStore([
      baseProjection({
        taskId: 'skill:origins:legacy-emit',
        status: 'blocked',
        continuationRef: null,
        recentArtifacts: [{
          id: 'run-state',
          module: 'skill',
          kind: 'artifact',
          label: 'run_state.json',
          path: runStatePath,
          createdAt: OLD,
          meta: {},
        }],
      }),
    ])

    await reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

    const legacy = events.filter((e) => e.metric === 'projection_handle_legacy_origin_used')
    assert.ok(legacy.length >= 1, 'late artifact_path origin must emit legacy metric')
    const fields = legacy.map((e) => e.field)
    assert.ok(fields.includes('runStatePath') || fields.includes('outputDir'))
    for (const event of legacy) {
      assert.equal(event.taskId, 'skill:origins:legacy-emit')
      assert.equal(event.origin, 'artifact_path')
    }
  } finally {
    restore()
  }
})
