/**
 * Stage C C3+C4 + Stage D D2/D4/D6/D7 — Delta (Wave 2) framePatch emission.
 *
 * Verifies that the three inline detached handlers in `skills-tools.ts`
 * (`skill_inspect_detached`, `skill_cancel_detached`, `skill_start_detached`)
 * each emit a non-null `framePatch` carrying the contract-derived
 * `runContract` slot, output paths, and discovered handles. These patches
 * are read by Beta's `applyTurnFramePatch` at the end of every batch so the
 * next iteration's frame and the next turn's contract loader see the
 * tracker's truth without re-inspecting.
 *
 * Acceptance criterion 4: each handler emits a non-null `framePatch`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildTypedActionContextModifier, executeSkillTool } from '../main/modules/tools/skills-tools'
import { registerDetachedSkillTaskTracker } from '../main/modules/agent-control/detached-skill-task-tracker'
import type { SkillRunContract } from '../main/modules/agent-control/contracts/run-contracts'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

const SESSION_ID = 'scope-delta-detached'
const SKILL_ID = 'video-expert-analyzer'

function makeTracker(record: {
  id: string
  scopeId: string | null
  sessionId: string | null
  skillId: string
  action: string
  params: Record<string, unknown>
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  startedAt: string
  updatedAt: string
  error?: string | null
}) {
  return {
    inspect: (taskId: string) => (taskId === record.id ? { ...record } : null),
    cancel: (taskId: string) => {
      if (taskId !== record.id) return null
      return { ...record, status: 'cancelled' as const, updatedAt: '2026-04-29T02:00:00.000Z' }
    },
    start: (request: Record<string, unknown>) => ({
      ...record,
      action: typeof request.action === 'string' ? request.action : record.action,
      params: (typeof request.params === 'object' && request.params !== null)
        ? request.params as Record<string, unknown>
        : record.params,
      startedAt: '2026-04-29T01:55:00.000Z',
      updatedAt: '2026-04-29T01:55:00.000Z',
      status: 'running' as const,
    }),
    list: () => [record],
    findLatestForScope: () => null,
    waitForTask: async () => null,
  } as any
}

test('Delta D4: skill_inspect_detached emits framePatch with runContract carrying handles + paths', async () => {
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill(SESSION_ID, { id: SKILL_ID, name: 'Video Expert Analyzer' })
  const tracker = makeTracker({
    id: 'dst-inspect-1',
    scopeId: SESSION_ID,
    sessionId: SESSION_ID,
    skillId: SKILL_ID,
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/video.mp4' },
    status: 'running',
    outputDir: '/tmp/vea-delta-inspect/output',
    runStatePath: '/tmp/vea-delta-inspect/output/run_state.json',
    sceneScoresPath: '/tmp/vea-delta-inspect/output/scene_scores.json',
    deliveryReportPath: null,
    startedAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:30:00.000Z',
  })
  registerDetachedSkillTaskTracker(tracker)
  try {
    const result = await executeSkillTool(
      'skill_inspect_detached',
      { taskId: 'dst-inspect-1' },
      SESSION_ID,
    )
    assert.notEqual(typeof result, 'string', 'expected ToolExecutionOutput shape, not bare string')
    if (typeof result === 'string') return // type guard
    assert.ok(result.framePatch, 'D4 regression: skill_inspect_detached did not emit framePatch')
    const contract = result.framePatch?.runContract
    assert.ok(contract, 'D4 regression: framePatch.runContract is null')
    assert.equal(contract?.skillId, SKILL_ID)
    assert.equal(contract?.detachedTaskId, 'dst-inspect-1')
    assert.equal(contract?.outputDir, '/tmp/vea-delta-inspect/output')
    assert.equal(contract?.runStatePath, '/tmp/vea-delta-inspect/output/run_state.json')
    assert.equal(contract?.artifactPaths?.sceneScoresPath, '/tmp/vea-delta-inspect/output/scene_scores.json')
    assert.equal(contract?.action, 'video_expert_pipeline')
  } finally {
    _resetLastReferenceSkillHintsForTests()
  }
})

test('Delta D7: skill_cancel_detached emits terminal framePatch (livenessHint != running, status updates)', async () => {
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill(SESSION_ID, { id: SKILL_ID, name: 'Video Expert Analyzer' })
  const tracker = makeTracker({
    id: 'dst-cancel-1',
    scopeId: SESSION_ID,
    sessionId: SESSION_ID,
    skillId: SKILL_ID,
    action: 'video_expert_pipeline',
    params: { url: 'https://example.com/video.mp4' },
    status: 'running',
    outputDir: '/tmp/vea-delta-cancel/output',
    runStatePath: '/tmp/vea-delta-cancel/output/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    startedAt: '2026-04-29T01:00:00.000Z',
    updatedAt: '2026-04-29T01:30:00.000Z',
  })
  registerDetachedSkillTaskTracker(tracker)
  try {
    const result = await executeSkillTool(
      'skill_cancel_detached',
      { taskId: 'dst-cancel-1' },
      SESSION_ID,
    )
    assert.notEqual(typeof result, 'string', 'expected ToolExecutionOutput shape')
    if (typeof result === 'string') return
    assert.ok(result.framePatch, 'D7 regression: skill_cancel_detached did not emit framePatch')
    // After cancel, the next-frame liveness must NOT be `running_process` so
    // the projection / capsule do not keep showing the task as live.
    assert.notEqual(result.framePatch?.livenessHint, 'running_process')
    // skillStatusUpdates carries the cancellation so the frame's skill
    // slice's status flips off `running`.
    assert.equal(result.framePatch?.skillStatusUpdates?.status, 'cancelled')
    const contract = result.framePatch?.runContract
    assert.ok(contract, 'D7 regression: framePatch.runContract is null')
    assert.equal(contract?.detachedTaskId, 'dst-cancel-1')
  } finally {
    _resetLastReferenceSkillHintsForTests()
  }
})

/**
 * Delta D6 — `skill_start_detached` framePatch emission.
 *
 * The success path of `start_detached` calls `tracker.start(...)` and emits
 * a framePatch carrying the new detached handles, paths inferred from the
 * spawn params, and `livenessHint: 'running_process'`. Verifying this in
 * isolation requires the runtime manager to know the skill's manifest so
 * the action validation (`findSkillToolByNameForExecution`) resolves
 * before the tracker call. Under `tsx --test` the runtime manager is
 * unavailable (sqlite/electron deps fail to load), so this case is
 * covered by source-level inspection: the implementation in
 * `skills-tools.ts` lines ~1278–1340 wraps the success-path tracker
 * record in `attachContractFramePatch` with `livenessHint: 'running_process'`
 * and `activeArtifactRoots: [record.outputDir]`. End-to-end coverage
 * lands in Wave 3 / Wave 4 integration tests.
 */
/**
 * Delta C3+C4 — typed-action wrapper framePatch + resume payload completeness.
 *
 * The typed-action branch at the end of `executeSkillTool` (after the
 * primitives branch returns) calls `getManager().runSkill(...)` and on the
 * result must (a) emit `framePatch.runContract` carrying the validated
 * `actionInput`, `originalInput`, `sourceUrl`, output paths, handles,
 * status, liveness, and (b) call `rememberSkillRun` with a
 * `resumePayload` that includes `originalInput`, action-specific paths
 * (`sceneScoresPath` / `deliveryReportPath`), and the source URL.
 *
 * `getManager().runSkill(...)` requires the runtime manager which is not
 * available under `tsx --test`. We verify the contract via source-level
 * inspection of the typed-action wrapper region — Wave 4 integration
 * tests will exercise the full path.
 */
test('Delta C3+C4: source-level proof — typed-action wrapper emits framePatch.runContract + complete resumePayload', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: typed-action wrapper requires runtime-manager integration that has no isolated node-test harness
  const source = readFileSync(
    new URL('../main/modules/tools/skills-tools.ts', import.meta.url),
    'utf-8',
  )

  // The typed-action branch must call buildContractFramePatch with the
  // action's contract and pass the runStatus-derived liveness hint.
  // (We rely on a single-region grep — the helper functions and other
  // branches above do not call `loadSkillRunContract` outside their
  // respective branches.)
  assert.match(
    source,
    /const contract = loadSkillRunContract\(\{[\s\S]+?actionInput: args[\s\S]+?\}\)/,
    'C3 regression: typed-action wrapper must call loadSkillRunContract with actionInput=args (validated typed input).',
  )
  assert.match(
    source,
    /buildContractFramePatch\(\{[\s\S]+?contract,[\s\S]+?livenessHint: livenessHintForContract/,
    'C3 regression: typed-action wrapper must call buildContractFramePatch with the loaded contract + liveness.',
  )

  // resumePayload completeness — must carry sceneScoresPath / deliveryReportPath / originalInput.
  assert.match(
    source,
    /resumePayload: buildContinuityResumePayload\(\{[\s\S]+?sceneScoresPath,[\s\S]+?deliveryReportPath,[\s\S]+?originalInput: args/,
    'C4 regression: rememberSkillRun resumePayload must include sceneScoresPath, deliveryReportPath, originalInput=args so the next turn can rebuild the action input.',
  )

  // The action and toolName must also be carried so the next turn picks
  // the correct typed action wrapper to force.
  assert.match(
    source,
    /resumePayload: buildContinuityResumePayload\(\{[\s\S]+?action: tool\.action[\s\S]+?toolName,/,
    'C4 regression: resumePayload must include action + toolName for FrameAction reconstruction.',
  )
})

test('Delta D6: source-level proof — start_detached success path emits framePatch via attachContractFramePatch', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: start_detached framePatch success branch depends on runtime manager manifest resolution
  const source = readFileSync(
    new URL('../main/modules/tools/skills-tools.ts', import.meta.url),
    'utf-8',
  )
  // The success branch must invoke attachContractFramePatch and pass
  // livenessHint: 'running_process' so the next-frame liveness reflects
  // the freshly-spawned detached worker.
  const startDetachedRegion = source.split("if (tool.name === 'skill_start_detached')")[1] || ''
  const successBranch = startDetachedRegion.split("if (tool.name === 'skill_run_shell')")[0] || ''
  assert.match(
    successBranch,
    /attachContractFramePatch\([\s\S]+?livenessHint: 'running_process'/,
    'D6 regression: start_detached success branch must emit framePatch with livenessHint=running_process',
  )
  assert.match(
    successBranch,
    /detachedTaskId: record\.id/,
    'D6 regression: start_detached must include detachedTaskId in the supervisor snapshot',
  )
})

/**
 * Phase 3 (skill-child-loop, Team 3) — same-turn live frame visibility.
 *
 * Verifies the runtime-level contract: when tool A in a batch emits a
 * `contextModifier.activeFrame.activeArtifactRoots`, calling
 * `applyContextModifier(context, output)` immediately mutates
 * `context.activeFrame.activeArtifactRoots` so a later tool B in the same
 * batch reads the fresh roots without rebuilding a TurnFrame.
 */
test('Phase 3: applyContextModifier mutates activeFrame.activeArtifactRoots in place (same-turn live update)', async () => {
  const {
    applyContextModifier,
    createEmptyActiveFrameContext,
  } = await import('../main/modules/agent-control/tools-runtime/tool-runtime')
  const { createToolExecutionOutput } = await import('../main/modules/agent-control/tools-runtime/tool-result-types')

  // Initial runtime context with empty active-frame slot — analogous to
  // the cold path the runtime context builder produces when no frame
  // snapshot was passed.
  const context = {
    activeFrame: createEmptyActiveFrameContext(),
  } as any

  // Tool A — VEA typed-action result emits a contextModifier carrying its
  // freshly-produced output directory.
  const toolAResult = createToolExecutionOutput('VEA pipeline kicked off', {
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: ['/tmp/vea-phase3-live/output'],
      },
    },
  })

  applyContextModifier(context, toolAResult)

  // Tool B (a hypothetical follow-up `skill_read_artifact`) reads the
  // same context object — it must observe the new root WITHOUT having
  // rebuilt a TurnFrame.
  assert.deepEqual(
    context.activeFrame.activeArtifactRoots,
    ['/tmp/vea-phase3-live/output'],
    'tool B must see tool A\'s artifact root via the same-turn live activeFrame slot',
  )

  // A second emission unions (de-duplicates by first appearance) — the
  // existing root is preserved, the new one is appended.
  const toolA2Result = createToolExecutionOutput('VEA analyze step closed', {
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: [
          '/tmp/vea-phase3-live/output', // duplicate — must be ignored
          '/tmp/vea-phase3-live/aux',     // new — appended
        ],
      },
    },
  })
  applyContextModifier(context, toolA2Result)
  assert.deepEqual(
    context.activeFrame.activeArtifactRoots,
    ['/tmp/vea-phase3-live/output', '/tmp/vea-phase3-live/aux'],
    'duplicate roots must be ignored; new roots appended in order',
  )

  // Tools that emit no contextModifier are no-ops on the live frame.
  const noopResult = createToolExecutionOutput('plain text result')
  applyContextModifier(context, noopResult)
  assert.deepEqual(
    context.activeFrame.activeArtifactRoots,
    ['/tmp/vea-phase3-live/output', '/tmp/vea-phase3-live/aux'],
    'tools without contextModifier must not mutate the live frame',
  )
})

/**
 * Phase 3 (skill-child-loop, Team T7) — engine-level seeding contract.
 *
 * Before any same-batch `contextModifier` runs, the FIRST tool dispatched in
 * a turn must already see the active `TurnFrame`'s durable signals on its
 * `ToolRuntimeContext.activeFrame`:
 *   - `frame.activeArtifactRoots` → seeded into `activeFrame.activeArtifactRoots`
 *   - `frame.skill?.runContract`  → seeded into `activeFrame.runContract`
 *
 * This protects the dispatch path: today the seed only happens AFTER the
 * first tool ran (because the only writer was `applyContextModifier`). If
 * the model's first call is `skill_read_artifact` against a path under
 * `frame.activeArtifactRoots`, that call must succeed without a prior
 * "discovery" tool.
 */
test('T7: ToolRuntimeContext.activeFrame is seeded from TurnFrame BEFORE any same-batch contextModifier runs', async () => {
  const { buildToolRuntimeContext, buildActiveFrameContextFromTurnFrame } = await import(
    '../main/modules/agent-control/tools-runtime/tool-runtime-context-builder'
  )

  // Construct a minimal TurnFrame fixture mimicking what the resolver
  // produces after a prior turn discovered an artifact root and minted a
  // SkillRunContract carrying a child run id.
  const seededFrame: any = {
    ids: { sessionId: 's-t7', requestId: 'r-t7' },
    mode: 'skill_resume',
    userIntent: 'continue',
    skill: {
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      source: 'reference_hint',
      confidence: 0.9,
      taskRunId: null,
      detachedTaskId: null,
      action: 'video_expert_pipeline',
      runStatePath: null,
      outputDir: null,
      artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
      status: null,
      staleBlockerReason: null,
      runContract: {
        skillId: 'video-expert-analyzer',
        skillName: 'Video Expert Analyzer',
        toolName: 'skill_video_expert_pipeline',
        action: 'video_expert_pipeline',
        actionInput: null,
        originalInput: null,
        sourceUrl: null,
        taskRunId: null,
        detachedTaskId: null,
        jobId: null,
        outputDir: null,
        runStatePath: null,
        artifactRoots: [],
        artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
        status: 'running',
        liveness: 'running_process',
        progress: {
          stage: null,
          totalUnits: null,
          completedUnits: null,
          coverageRatio: null,
          fingerprint: null,
        },
        blocker: { reason: null, stale: false },
        projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
        forceLoopGuard: {
          lastForceToolName: null,
          lastForceInputDigest: null,
          lastForceToolDispatchedAt: null,
          consecutiveForceCount: 0,
        },
        updatedAt: '2026-04-30T01:00:00.000Z',
        childRunId: 'vt7seed00',
      },
    },
    liveness: 'running_process',
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    steering: {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: null,
    },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: ['/tmp/seed-root'],
    configValidation: null,
    terminalReason: null,
  }

  // Helper sanity — derived snapshot exposes the seed signals.
  const seedSnapshot = buildActiveFrameContextFromTurnFrame(seededFrame)
  assert.deepEqual(seedSnapshot.activeArtifactRoots, ['/tmp/seed-root'])
  assert.equal(seedSnapshot.runContract?.childRunId, 'vt7seed00')
  assert.deepEqual(seedSnapshot.discoveredHandles, [])

  // The engine's call site builds the runtime context with the snapshot —
  // we inline that here so the assertion mirrors the dispatcher's view of
  // the FIRST tool's `ToolRuntimeContext` BEFORE any contextModifier ran.
  const ctx = buildToolRuntimeContext({
    browserController: null,
    sidecarManager: null,
    runtime: null,
    emitToolAction: () => {},
    abortSignal: new AbortController().signal,
    activeFrame: buildActiveFrameContextFromTurnFrame(seededFrame),
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })

  assert.deepEqual(
    ctx.activeFrame.activeArtifactRoots,
    ['/tmp/seed-root'],
    'T7 regression: first tool must see seeded /tmp/seed-root before any contextModifier runs',
  )
  assert.equal(
    ctx.activeFrame.runContract?.childRunId,
    'vt7seed00',
    'T7 regression: first tool must see seeded runContract.childRunId before any contextModifier runs',
  )
})

test('T7: same-batch contextModifier from tool-A unions onto the seeded roots so tool-B sees BOTH', async () => {
  const { applyContextModifier } = await import(
    '../main/modules/agent-control/tools-runtime/tool-runtime'
  )
  const { buildToolRuntimeContext, buildActiveFrameContextFromTurnFrame } = await import(
    '../main/modules/agent-control/tools-runtime/tool-runtime-context-builder'
  )
  const { createToolExecutionOutput } = await import(
    '../main/modules/agent-control/tools-runtime/tool-result-types'
  )

  const seededFrame: any = {
    ids: { sessionId: 's-t7', requestId: 'r-t7' },
    mode: 'skill_resume',
    userIntent: 'continue',
    skill: {
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      source: 'reference_hint',
      confidence: 0.9,
      taskRunId: null,
      detachedTaskId: null,
      action: 'video_expert_pipeline',
      runStatePath: null,
      outputDir: null,
      artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
      status: null,
      staleBlockerReason: null,
      runContract: {
        skillId: 'video-expert-analyzer',
        skillName: 'Video Expert Analyzer',
        toolName: 'skill_video_expert_pipeline',
        action: 'video_expert_pipeline',
        actionInput: null,
        originalInput: null,
        sourceUrl: null,
        taskRunId: null,
        detachedTaskId: null,
        jobId: null,
        outputDir: null,
        runStatePath: null,
        artifactRoots: [],
        artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
        status: 'running',
        liveness: 'running_process',
        progress: {
          stage: null,
          totalUnits: null,
          completedUnits: null,
          coverageRatio: null,
          fingerprint: null,
        },
        blocker: { reason: null, stale: false },
        projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
        forceLoopGuard: {
          lastForceToolName: null,
          lastForceInputDigest: null,
          lastForceToolDispatchedAt: null,
          consecutiveForceCount: 0,
        },
        updatedAt: '2026-04-30T01:00:00.000Z',
        childRunId: 'vt7seed00',
      },
    },
    liveness: 'running_process',
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    steering: {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: null,
    },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: ['/tmp/seed-root'],
    configValidation: null,
    terminalReason: null,
  }

  // Engine-style runtime context with the seed in place.
  const ctx = buildToolRuntimeContext({
    browserController: null,
    sidecarManager: null,
    runtime: null,
    emitToolAction: () => {},
    abortSignal: new AbortController().signal,
    activeFrame: buildActiveFrameContextFromTurnFrame(seededFrame),
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })

  // Pre-condition: only the seed is visible before any contextModifier ran.
  assert.deepEqual(ctx.activeFrame.activeArtifactRoots, ['/tmp/seed-root'])
  assert.equal(ctx.activeFrame.runContract?.childRunId, 'vt7seed00')

  // Tool-A in the same batch (e.g. VEA pipeline) discovers an additional
  // artifact root and emits a contextModifier carrying it.
  const toolAResult = createToolExecutionOutput('tool-A discovered fresh output', {
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: ['/tmp/discovered-root'],
      },
    },
  })
  applyContextModifier(ctx, toolAResult)

  // Tool-B in the same batch (e.g. skill_read_artifact) must now see BOTH
  // the seed AND the freshly-discovered root, in seed-first order.
  assert.deepEqual(
    ctx.activeFrame.activeArtifactRoots,
    ['/tmp/seed-root', '/tmp/discovered-root'],
    'T7 regression: tool-B must see BOTH /tmp/seed-root (seeded) AND /tmp/discovered-root (same-batch contextModifier)',
  )
  // The seeded runContract is preserved (tool-A did not override it).
  assert.equal(
    ctx.activeFrame.runContract?.childRunId,
    'vt7seed00',
    'T7 regression: tool-A omitting runContract must not erase the seeded contract',
  )
})

test('Stage M (M5a-typed-gate): typed-action wrapper emits contextModifier whenever outputDir is set (no VEA-name allowlist)', () => {
  const contract: SkillRunContract = {
    skillId: 'lets-go-rss',
    skillName: 'lets-go-rss',
    toolName: 'skill_rss_status',
    action: 'rss_status',
    actionInput: {},
    originalInput: {},
    sourceUrl: null,
    taskRunId: 'task-stage-m',
    detachedTaskId: null,
    jobId: null,
    outputDir: '/tmp/stage-m-rss-output',
    runStatePath: '/tmp/stage-m-rss-output/run_state.json',
    artifactRoots: ['/tmp/stage-m-rss-output'],
    artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
    status: 'running',
    liveness: 'running_process',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    blocker: { reason: null, stale: false },
    projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: '2026-05-06T00:00:00.000Z',
  }

  const contextModifier = buildTypedActionContextModifier({
    outputDir: contract.outputDir,
    contract,
  })

  assert.deepEqual(
    contextModifier?.activeFrame?.activeArtifactRoots,
    ['/tmp/stage-m-rss-output'],
    'Stage M: typed-action wrapper must emit contextModifier.activeArtifactRoots whenever outputDir is set.',
  )
  assert.equal(
    contextModifier?.activeFrame?.runContract,
    contract,
    'Stage M: typed-action wrapper must carry the full contract in contextModifier, even for non-VEA skills.',
  )
})
