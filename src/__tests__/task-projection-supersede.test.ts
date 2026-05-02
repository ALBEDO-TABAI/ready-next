import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
} from '../main/modules/agent-control/session-continuity'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection-sync'
import type {
  TaskProjectionRecord,
  TaskProjectionStore,
} from '../main/modules/agent-control/run-contracts'
import type {
  ScopeRunEventPayload,
  ScopeRunSummary,
} from '../main/modules/agent-control/types'

const TEST_STORAGE_PATH = join(tmpdir(), 'ready-task-projection-supersede-continuity.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_STORAGE_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  rmSync(TEST_STORAGE_PATH, { force: true })
})

interface SiblingArgs {
  scopeId: string
  skillId: string | null
  outputDir: string | null
  runStatePath: string | null
}

function createInMemoryStore(initial?: TaskProjectionRecord[]): {
  store: TaskProjectionStore
  records: Map<string, TaskProjectionRecord>
  siblingCalls: SiblingArgs[]
} {
  const records = new Map<string, TaskProjectionRecord>()
  for (const record of initial || []) records.set(record.taskId, record)
  const siblingCalls: SiblingArgs[] = []
  const store: TaskProjectionStore = {
    create(record) {
      records.set(record.taskId, record)
    },
    update(taskId, patch) {
      const previous = records.get(taskId)
      if (!previous) return
      records.set(taskId, {
        ...previous,
        ...patch,
      })
    },
    get(taskId) {
      return records.get(taskId) || null
    },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
    findByArtifactSiblings(args) {
      siblingCalls.push(args)
      const { scopeId, outputDir, runStatePath } = args
      if (!outputDir && !runStatePath) return []
      const normalizedOutputDir = outputDir ? outputDir.replace(/[\\/]+$/, '') : null
      return Array.from(records.values()).filter((record) => {
        if (record.scopeId !== scopeId) return false
        if (record.module !== 'system') return false
        if (record.taskType !== 'short_task') return false
        if (record.taskId.startsWith('skill:')) return false
        if (record.status === 'cancelled' || record.status === 'done') return false
        for (const artifact of record.recentArtifacts || []) {
          const path = typeof artifact?.path === 'string' ? artifact.path : ''
          if (runStatePath && path === runStatePath) return true
          const meta = artifact?.meta as Record<string, unknown> | undefined
          const metaOutputDir = typeof meta?.outputDir === 'string' ? meta.outputDir : null
          if (
            normalizedOutputDir
            && metaOutputDir
            && metaOutputDir.replace(/[\\/]+$/, '') === normalizedOutputDir
          ) return true
          if (
            normalizedOutputDir
            && path
            && (path === normalizedOutputDir
              || path.startsWith(`${normalizedOutputDir}/`)
              || path.startsWith(`${normalizedOutputDir}\\`))
          ) return true
        }
        return false
      })
    },
  }
  return { store, records, siblingCalls }
}

function buildSkillSummary(): ScopeRunSummary {
  return {
    scopeId: 'scope-supersede',
    agent: 'butler',
    title: '会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-supersede',
    phase: 'takeover',
    taskTitle: 'VEA 后台任务',
    taskSummary: '后台仍在跑',
    taskType: 'short_task',
    interactionState: 'suspended',
    waitingFor: 'background',
    blockedReason: '后台任务待续跑',
    resumableActions: ['continue', 'cancel'],
    steps: [],
    currentStepId: null,
    taskContinuation: {
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      detachedTaskId: 'dst-x',
      runStatePath: '/tmp/4qkyxm4jppc/run_state.json',
      outputDir: '/tmp/4qkyxm4jppc',
    },
    recentArtifacts: [
      {
        id: 'run-state',
        module: 'skill',
        kind: 'json',
        label: 'run_state.json',
        path: '/tmp/4qkyxm4jppc/run_state.json',
        createdAt: '2026-04-29T05:00:00.000Z',
        meta: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          detachedTaskId: 'dst-x',
          outputKey: 'runStatePath',
          outputDir: '/tmp/4qkyxm4jppc',
        },
      },
    ],
    taskId: 'system-fresh',
    taskProjectionId: 'run-fresh',
    updatedAt: '2026-04-29T05:00:00.000Z',
  }
}

function buildSkillPayload(): ScopeRunEventPayload {
  return {
    type: 'updated',
    scopeId: 'scope-supersede',
    agent: 'butler',
    runId: 'run-fresh',
    taskId: 'system-fresh',
    phase: 'takeover',
    module: 'system',
    timestamp: '2026-04-29T05:00:00.000Z',
  }
}

function buildLegacyRecord(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-61615c03-f09b-4393-b9ba-8c8863e7e7d9',
    scopeId: 'scope-supersede',
    runId: 'req-1777439706074-cpvytw',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'system',
    taskTitle: '旧短任务',
    taskSummary: '旧短任务投影',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'background',
    steps: [],
    currentStepId: null,
    budget: null,
    blockedReason: '本轮预算已用完',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskRunId: 'str-8b9029f0',
      detachedTaskId: 'dst-a330f559',
      skillId: 'video-expert-analyzer',
    },
    recentArtifacts: [
      {
        id: 'run-state',
        module: 'skill',
        kind: 'json',
        label: 'run_state.json',
        path: '/tmp/4qkyxm4jppc/run_state.json',
        createdAt: '2026-04-29T04:50:00.000Z',
        meta: {
          outputDir: '/tmp/4qkyxm4jppc',
        },
      },
    ],
    createdAt: '2026-04-29T04:50:00.000Z',
    updatedAt: '2026-04-29T04:50:00.000Z',
    ...overrides,
  }
}

test('legacy system short_task sibling is superseded when skill-keyed row commits', async () => {
  const legacy = buildLegacyRecord()
  const { store, records } = createInMemoryStore([legacy])

  const result = await syncTaskProjection(store, buildSkillSummary(), buildSkillPayload())

  assert.equal(result?.taskId, 'skill:detached:dst-x')

  const superseded = records.get(legacy.taskId)
  assert.ok(superseded)
  assert.equal(superseded?.status, 'cancelled')
  assert.equal(superseded?.interactionState, 'suspended')
  assert.equal(superseded?.waitingFor, 'none')
  assert.equal(superseded?.blockedReason, null)
  assert.equal(superseded?.continuationRef?.taskId, 'skill:detached:dst-x')
  assert.equal(superseded?.continuationRef?.blockerType, 'superseded')
  assert.equal(superseded?.updatedAt, '2026-04-29T05:00:00.000Z')
})

test('legacy sibling already in terminal state is not modified', async () => {
  const legacy = buildLegacyRecord({
    status: 'done',
    interactionState: 'suspended',
    waitingFor: 'none',
    blockedReason: null,
  })
  const { store, records } = createInMemoryStore([legacy])
  const snapshotBefore = records.get(legacy.taskId)
  const snapshotBeforeUpdatedAt = snapshotBefore?.updatedAt

  await syncTaskProjection(store, buildSkillSummary(), buildSkillPayload())

  const after = records.get(legacy.taskId)
  assert.equal(after?.status, 'done')
  assert.equal(after?.continuationRef?.blockerType, undefined)
  // updatedAt remains untouched because supersede skipped this row.
  assert.equal(after?.updatedAt, snapshotBeforeUpdatedAt)
})

test('commit succeeds when supersede update throws (race recovery)', async () => {
  const legacy = buildLegacyRecord()
  const { store, records } = createInMemoryStore([legacy])

  const originalUpdate = store.update.bind(store)
  let nextUpdateThrows = false
  let thrownCount = 0
  store.update = (taskId, patch) => {
    if (taskId === legacy.taskId && nextUpdateThrows) {
      thrownCount += 1
      throw new Error('simulated race: concurrent delete')
    }
    return originalUpdate(taskId, patch)
  }

  // Wait until after the commit + parent sync to throw on supersede update.
  // Easiest: throw any update that targets the legacy row.
  nextUpdateThrows = true

  const warnSpy = console.warn
  const captured: unknown[][] = []
  console.warn = (...args: unknown[]) => { captured.push(args) }
  try {
    const result = await syncTaskProjection(store, buildSkillSummary(), buildSkillPayload())
    assert.equal(result?.taskId, 'skill:detached:dst-x')
    assert.ok(records.get('skill:detached:dst-x'))
    assert.ok(thrownCount >= 1, 'expected supersede update to throw at least once')
    assert.ok(
      captured.some((args) => String(args[0]).includes('supersede update failed')),
      'expected console.warn to be invoked for supersede race recovery',
    )
  } finally {
    console.warn = warnSpy
  }
})

test('non-skill keyed commit does not call findByArtifactSiblings', async () => {
  const legacy = buildLegacyRecord()
  const { store, siblingCalls } = createInMemoryStore([legacy])

  const summary: ScopeRunSummary = {
    ...buildSkillSummary(),
    taskContinuation: null,
    recentArtifacts: [],
    taskId: 'task-not-skill',
  }
  const payload: ScopeRunEventPayload = {
    ...buildSkillPayload(),
    taskId: 'task-not-skill',
    runId: 'run-not-skill',
  }
  const result = await syncTaskProjection(store, summary, payload)
  assert.equal(result?.taskId, 'task-not-skill')
  assert.equal(siblingCalls.length, 0)
})

test('Stage F4: cross-skill non-supersede — overlapping output paths but different skillId do not supersede', async () => {
  // Sibling row carries an explicit `meta.skillId = "skill-other"` and
  // overlaps the same outputDir as the incoming `video-expert-analyzer`
  // commit. The repository helper must NOT return the cross-skill row
  // as a supersede candidate.
  const crossSkillSibling = buildLegacyRecord({
    taskId: 'task-other-skill-row',
    runId: 'req-other-skill',
    recentArtifacts: [
      {
        id: 'run-state',
        module: 'skill',
        kind: 'json',
        label: 'run_state.json',
        path: '/tmp/4qkyxm4jppc/run_state.json',
        createdAt: '2026-04-29T04:50:00.000Z',
        meta: {
          // Different skill — must NOT be superseded by the incoming
          // video-expert-analyzer commit even though the path overlaps.
          skillId: 'skill-other',
          outputDir: '/tmp/4qkyxm4jppc',
        },
      },
    ],
  })
  const { store, records, siblingCalls } = createInMemoryStore([crossSkillSibling])

  // The in-memory test store mirrors the real repository's filter logic so
  // the same skillId-aware filtering is exercised here. The synchronous
  // in-memory variant returns a plain array, so cast accordingly.
  const originalFindByArtifactSiblings = store.findByArtifactSiblings!.bind(store)
  store.findByArtifactSiblings = (args) => {
    const candidates = originalFindByArtifactSiblings(args) as TaskProjectionRecord[]
    if (!args.skillId) return candidates
    // Reject candidates whose recordedSkillId differs from args.skillId.
    return candidates.filter((record: TaskProjectionRecord) => {
      let recordedSkillId: string | null = null
      for (const artifact of record.recentArtifacts || []) {
        const meta = artifact?.meta as Record<string, unknown> | undefined
        const sid = typeof meta?.skillId === 'string' ? meta.skillId.trim() : ''
        if (sid) { recordedSkillId = sid; break }
      }
      return !recordedSkillId || recordedSkillId === args.skillId
    })
  }

  const result = await syncTaskProjection(store, buildSkillSummary(), buildSkillPayload())
  assert.equal(result?.taskId, 'skill:detached:dst-x')

  // Sibling lookup ran with the correct skillId
  assert.equal(siblingCalls.length, 1)
  assert.equal(siblingCalls[0]!.skillId, 'video-expert-analyzer')

  // Cross-skill row must remain in its original (running) state — not
  // marked as superseded.
  const after = records.get('task-other-skill-row')
  assert.ok(after)
  assert.equal(after?.status, 'running')
  assert.equal(after?.continuationRef?.blockerType, undefined)
})

test('Phase 7: child-run identity primary key prevents cross-skill outputDir merge', async () => {
  // Source plan §8 Scenario H — two different skills share one outputDir.
  // Phase 7 makes the projection primary key `skill-child:<childRunId>`
  // when the contract carries one. Two child runs that happen to share
  // outputDir get DIFFERENT projection task IDs, so the second commit
  // cannot supersede or merge with the first.
  const { store, records } = createInMemoryStore()

  // First commit: VEA child run. Synthesize a frameSnapshot with a
  // childRunId on the contract (Phase 7 wiring).
  const veaChildRunId = 'va1b2c3d4'
  const veaSummary = buildSkillSummary()
  const veaPayload = buildSkillPayload()
  const veaProjectionTruth = {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'video-expert-analyzer',
        skillName: 'VEA',
        source: 'tool',
        detachedTaskId: null,
        runStatePath: '/tmp/shared-output/run_state.json',
        outputDir: '/tmp/shared-output',
        action: 'video_expert_pipeline',
        staleBlockerReason: null,
        runContract: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          toolName: null,
          actionInput: null,
          originalInput: null,
          sourceUrl: null,
          taskRunId: null,
          detachedTaskId: null,
          jobId: null,
          outputDir: '/tmp/shared-output',
          runStatePath: '/tmp/shared-output/run_state.json',
          artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
          status: 'running' as const,
          liveness: 'running_process' as const,
          progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null },
          blocker: { reason: null, stale: false },
          projectionIdentity: { stableKey: null },
          childRunId: veaChildRunId,
        },
      },
    },
  }
  const veaResult = await syncTaskProjection(store, veaSummary, veaPayload, veaProjectionTruth)
  assert.equal(veaResult?.taskId, `skill-child:${veaChildRunId}`,
    'Phase 7 — VEA commit must use skill-child:<childRunId> as primary key')

  // Second commit: a different skill that adopted the SAME outputDir.
  // Different childRunId → different projection identity → no merge.
  const otherChildRunId = 'sxyz98765'
  const otherSummary = {
    ...buildSkillSummary(),
    taskContinuation: {
      skillId: 'skill-other',
      action: 'something_else',
      detachedTaskId: 'dst-other',
      runStatePath: '/tmp/shared-output/run_state.json',
      outputDir: '/tmp/shared-output',
    },
  }
  const otherProjectionTruth = {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'skill-other',
        skillName: 'Other Skill',
        source: 'tool',
        detachedTaskId: null,
        runStatePath: '/tmp/shared-output/run_state.json',
        outputDir: '/tmp/shared-output',
        action: 'something_else',
        staleBlockerReason: null,
        runContract: {
          skillId: 'skill-other',
          action: 'something_else',
          toolName: null,
          actionInput: null,
          originalInput: null,
          sourceUrl: null,
          taskRunId: null,
          detachedTaskId: null,
          jobId: null,
          outputDir: '/tmp/shared-output',
          runStatePath: '/tmp/shared-output/run_state.json',
          artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
          status: 'running' as const,
          liveness: 'running_process' as const,
          progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null },
          blocker: { reason: null, stale: false },
          projectionIdentity: { stableKey: null },
          childRunId: otherChildRunId,
        },
      },
    },
  }
  const otherResult = await syncTaskProjection(store, otherSummary, buildSkillPayload(), otherProjectionTruth)
  assert.equal(otherResult?.taskId, `skill-child:${otherChildRunId}`,
    'Phase 7 — second skill on same outputDir must NOT alias to the VEA row')

  // Both rows coexist; the VEA row was not superseded.
  const veaRow = records.get(`skill-child:${veaChildRunId}`)
  const otherRow = records.get(`skill-child:${otherChildRunId}`)
  assert.ok(veaRow, 'VEA child-run row must persist')
  assert.ok(otherRow, 'second skill child-run row must persist independently')
  assert.notEqual(veaRow?.taskId, otherRow?.taskId, 'two child runs must have distinct projection ids')
})

test('Phase 7: legacy row with no skillId remains adoptable by a same-skill child run', async () => {
  // Source plan §8 Scenario H part 2 — a legacy short-task row with NO
  // recorded skillId on its artifacts (pre-skill-keyed scheme) must still
  // be adoptable / superseded by a freshly-committed skill row.
  const legacy = buildLegacyRecord({
    recentArtifacts: [
      {
        id: 'run-state',
        module: 'skill',
        kind: 'json',
        label: 'run_state.json',
        path: '/tmp/4qkyxm4jppc/run_state.json',
        createdAt: '2026-04-29T04:50:00.000Z',
        // No `meta.skillId` — pre-Phase-3 row.
        meta: {
          outputDir: '/tmp/4qkyxm4jppc',
        },
      },
    ],
  })
  const { store, records } = createInMemoryStore([legacy])

  // The in-memory test store mirrors the repository's filter: skill-aware
  // filtering, but legacy rows without recordedSkillId remain matchable.
  const originalFindByArtifactSiblings = store.findByArtifactSiblings!.bind(store)
  store.findByArtifactSiblings = (args) => {
    const candidates = originalFindByArtifactSiblings(args) as TaskProjectionRecord[]
    if (!args.skillId) return candidates
    return candidates.filter((record: TaskProjectionRecord) => {
      let recordedSkillId: string | null = null
      for (const artifact of record.recentArtifacts || []) {
        const meta = artifact?.meta as Record<string, unknown> | undefined
        const sid = typeof meta?.skillId === 'string' ? meta.skillId.trim() : ''
        if (sid) { recordedSkillId = sid; break }
      }
      return !recordedSkillId || recordedSkillId === args.skillId
    })
  }

  const result = await syncTaskProjection(store, buildSkillSummary(), buildSkillPayload())
  // The fresh commit picks the detachedTaskId-keyed projection identity
  // (Phase 7 child-run identity isn't on this commit's contract).
  assert.equal(result?.taskId, 'skill:detached:dst-x')

  // The legacy row was superseded — adoption succeeded.
  const after = records.get(legacy.taskId)
  assert.equal(after?.status, 'cancelled')
  assert.equal(after?.continuationRef?.blockerType, 'superseded')
})
