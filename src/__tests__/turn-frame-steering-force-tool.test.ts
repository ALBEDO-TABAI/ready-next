/**
 * Stage 7 — `selectSteeringMode` / `buildTurnFrameSteering` decision matrix.
 *
 * Steering modes drive how the turn engine resolves the next iteration's
 * action:
 *   - `force_tool`  — frame is recoverable, typed action resolved → engine
 *                     synthesizes a tool batch and skips the model call.
 *   - `checkpoint`  — terminal failure or budget-exhausted-with-live-worker
 *                     → engine ends the turn and returns to the user.
 *   - `ask_model`   — default; preserves preferred-tool steering as before.
 *
 * `recentForceToolDispatched=true` always falls back to `ask_model` so we
 * cannot infinite-loop on the same forced tool.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildFrameAction,
  buildTurnFrameSteering,
  computeForceInputDigest,
  deriveForcedActionInput,
  selectSteeringMode,
  validateForcedActionInput,
} from '../main/modules/agent-control/turn-frame-steering'
import { createSystemReminderRegistry, type ReminderTopic } from '../main/modules/agent-control/system-reminder-registry'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import type { TurnFrame, TurnFrameLiveness } from '../main/modules/agent-control/turn-frame'
import type { SkillRunContract } from '../main/modules/agent-control/run-contracts'

function composeReminder(topic: ReminderTopic, priority: number, text: string): string | null {
  const registry = createSystemReminderRegistry()
  registry.register({ topic, priority, text })
  return registry.compose()
}

/**
 * Stage E test fixture — mints a `SkillRunContract` populated with the
 * fields a force_tool dispatch needs (sourceUrl, paths, handles). Used by
 * the new E2 assertions that exercise contract-derived input synthesis.
 */
function makeContract(overrides?: Partial<SkillRunContract>): SkillRunContract {
  return {
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    action: 'video_expert_pipeline',
    actionInput: null,
    originalInput: null,
    sourceUrl: 'https://example.com/video.mp4',
    taskRunId: 'str-vea',
    detachedTaskId: 'dst-vea',
    jobId: null,
    outputDir: '/tmp/vea-output',
    runStatePath: '/tmp/vea-output/run_state.json',
    artifactRoots: ['/tmp/vea-output'],
    artifactPaths: {
      sceneScoresPath: '/tmp/vea-output/scene_scores.json',
      deliveryReportPath: '/tmp/vea-output/delivery_report.json',
    },
    status: 'recoverable_paused',
    liveness: 'recoverable_paused',
    progress: {
      stage: 'score_batches',
      totalUnits: 97,
      completedUnits: 0,
      coverageRatio: 0,
      fingerprint: 'score_batches:0/97',
    },
    blocker: { reason: null, stale: false },
    projectionIdentity: { stableKey: 'projection-stable-key', supersedesProjectionIds: [] },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: '2026-04-29T01:00:00.000Z',
    ...overrides,
  }
}

function makeFrame(overrides?: Partial<TurnFrame>): TurnFrame {
  // Stage E: `makeFrame` now ships a contract by default so input synthesis
  // produces a dispatch-ready `url` for VEA pipeline. Tests that need to
  // exercise the missing-inputs path explicitly null out `runContract`.
  return {
    ids: { sessionId: 'scope-vea', requestId: 'req-1' },
    mode: 'skill_resume',
    userIntent: 'continue',
    skill: {
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      source: 'supervisor',
      confidence: 80,
      taskRunId: 'str-vea',
      detachedTaskId: 'dst-vea',
      action: 'video_expert_pipeline',
      runStatePath: '/tmp/vea-output/run_state.json',
      outputDir: '/tmp/vea-output',
      artifactPaths: {
        sceneScoresPath: '/tmp/vea-output/scene_scores.json',
        deliveryReportPath: '/tmp/vea-output/delivery_report.json',
      },
      status: 'recoverable_paused',
      staleBlockerReason: null,
      runContract: makeContract(),
    },
    liveness: 'recoverable_paused',
    progress: { stage: 'score_batches', totalUnits: 97, completedUnits: 0, coverageRatio: 0, fingerprint: 'fp' },
    steering: { mode: 'ask_model', requiredToolName: null, preferredToolNames: [], systemReminder: null, action: null },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: [],
    configValidation: null,
    terminalReason: null,
    ...overrides,
  }
}

test('selectSteeringMode: skill_resume + recoverable_paused + typed action → force_tool', () => {
  const frame = makeFrame()
  assert.equal(selectSteeringMode(frame), 'force_tool')
})

test('buildTurnFrameSteering: force_tool sets requiredToolName to typed action', () => {
  const frame = makeFrame()
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'force_tool')
  assert.equal(steering.requiredToolName, 'skill_video_expert_pipeline')
  assert.ok(steering.preferredToolNames.includes('skill_video_expert_pipeline'))
  const expectedReminder = [
    '系统补充：本轮 TurnFrame 已锁定 force_tool 模式，必须直接调用 typed skill action skill_video_expert_pipeline 推进任务。',
    '不要再用 skill_inspect_run_state / skill_read_artifact / skill_run_shell 做诊断；不要先解释、再决定下一步——直接发起 typed action 调用。',
    'outputDir=/tmp/vea-output runStatePath=/tmp/vea-output/run_state.json',
  ].join('\n')
  assert.equal(
    steering.systemReminder,
    composeReminder('force-tool-locked', 80, expectedReminder),
  )
})

test('buildTurnFrameSteering: fresh skill start does not expose diagnostic primitives before launch', () => {
  const frame = makeFrame({
    mode: 'skill_start',
    userIntent: 'start',
    liveness: 'unknown',
    skill: {
      ...makeFrame().skill!,
      source: 'explicit',
      status: 'unknown',
      runContract: makeContract({
        status: 'unknown',
        liveness: 'unknown',
        sourceUrl: 'https://example.com/new-video.mp4',
      }),
    },
  })
  const steering = buildTurnFrameSteering(frame)

  assert.equal(steering.mode, 'ask_model')
  assert.ok(steering.preferredToolNames.includes('skill_video_expert_pipeline'))
  assert.ok(steering.preferredToolNames.includes('skill_ask_user'))
  assert.ok(!steering.preferredToolNames.includes('skill_inspect_run_state'))
  assert.ok(!steering.preferredToolNames.includes('skill_read_artifact'))
  assert.ok(!steering.preferredToolNames.includes('skill_start_detached'))
})

test('selectSteeringMode: skill_repair + ready_to_resume → force_tool', () => {
  const frame = makeFrame({
    mode: 'skill_repair',
    liveness: 'ready_to_resume',
    userIntent: 'repair_config',
  })
  assert.equal(selectSteeringMode(frame), 'force_tool')
})

test('selectSteeringMode: budget exhausted + running_process → checkpoint', () => {
  const frame = makeFrame({
    liveness: 'running_process',
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: true },
  })
  assert.equal(selectSteeringMode(frame), 'checkpoint')
})

test('buildTurnFrameSteering: checkpoint clears requiredToolName/preferredToolNames', () => {
  const frame = makeFrame({
    liveness: 'running_process',
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: true },
  })
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'checkpoint')
  assert.equal(steering.requiredToolName, null)
  assert.deepEqual(steering.preferredToolNames, [])
  assert.match(steering.systemReminder || '', /checkpoint/)
})

test('selectSteeringMode: failed liveness with skill present → checkpoint', () => {
  const frame = makeFrame({ liveness: 'failed' })
  assert.equal(selectSteeringMode(frame), 'checkpoint')
})

test('selectSteeringMode: blocked liveness + complete typed resume input → force_tool', () => {
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    toolName: 'skill_video_expert_ai_analyze',
    sourceUrl: null,
  })
  const frame = makeFrame({
    liveness: 'blocked',
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      runContract: contract,
    },
  })
  assert.equal(selectSteeringMode(frame), 'force_tool')
})

test('buildTurnFrameSteering: blocked VEA score-batch resume force-dispatches ai_analyze', () => {
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    toolName: 'skill_video_expert_ai_analyze',
    sourceUrl: null,
  })
  const frame = makeFrame({
    liveness: 'blocked',
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      runContract: contract,
    },
  })

  const steering = buildTurnFrameSteering(frame)

  assert.equal(steering.mode, 'force_tool')
  assert.equal(steering.requiredToolName, 'skill_video_expert_ai_analyze')
  assert.equal(steering.action?.mode, 'force_tool')
  assert.equal(steering.action?.toolName, 'skill_video_expert_ai_analyze')
  assert.equal(
    (steering.action?.input as Record<string, unknown>)?.sceneScoresPath,
    '/tmp/vea-output/scene_scores.json',
  )
})

test('buildTurnFrameSteering: VEA ai_analyze derives outputDir only from a real trusted scene_scores path', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-steering-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    toolName: 'skill_video_expert_ai_analyze',
    sourceUrl: null,
    outputDir: null,
    runStatePath: null,
    artifactRoots: [],
    artifactPaths: { sceneScoresPath, deliveryReportPath: null },
  })
  const frame = makeFrame({
    liveness: 'blocked',
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      outputDir: null,
      runStatePath: null,
      artifactPaths: { sceneScoresPath, deliveryReportPath: null },
      runContract: contract,
    },
  })

  const steering = buildTurnFrameSteering(frame)

  assert.equal(steering.mode, 'force_tool')
  assert.equal(steering.action?.mode, 'force_tool')
  assert.equal(steering.action?.toolName, 'skill_video_expert_ai_analyze')
  assert.equal((steering.action?.input as Record<string, unknown>)?.sceneScoresPath, sceneScoresPath)
  assert.equal((steering.action?.input as Record<string, unknown>)?.outputDir, outputDir)
})

test('buildTurnFrameSteering: VEA ai_analyze checkpoints when scene_scores path has no trusted output handle', () => {
  const sceneScoresPath = '/etc/ready-cowork-malicious/scene_scores.json'
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    toolName: 'skill_video_expert_ai_analyze',
    sourceUrl: null,
    outputDir: null,
    runStatePath: null,
    artifactRoots: [],
    artifactPaths: { sceneScoresPath, deliveryReportPath: null },
  })
  const frame = makeFrame({
    liveness: 'blocked',
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      outputDir: null,
      runStatePath: null,
      artifactPaths: { sceneScoresPath, deliveryReportPath: null },
      runContract: contract,
    },
  })

  const steering = buildTurnFrameSteering(frame)

  assert.equal(steering.mode, 'checkpoint')
  assert.equal(steering.requiredToolName, null)
  assert.equal(steering.action?.mode, 'checkpoint')
  assert.equal(steering.action?.reason, 'missing_continuation_handle')
})

test('selectSteeringMode: recent_progress liveness → ask_model (work may already be progressing)', () => {
  const frame = makeFrame({ liveness: 'recent_progress' })
  assert.equal(selectSteeringMode(frame), 'ask_model')
})

test('selectSteeringMode: no skill slice → ask_model', () => {
  const frame = makeFrame({ skill: null, mode: 'general' })
  assert.equal(selectSteeringMode(frame), 'ask_model')
})

test('selectSteeringMode: recentForceToolDispatched=true downgrades force_tool to ask_model', () => {
  const frame = makeFrame()
  // First call returns force_tool.
  assert.equal(selectSteeringMode(frame), 'force_tool')
  // Caller signals that the immediately preceding iteration already
  // force-dispatched the same typed action — fall back to ask_model so we
  // cannot loop on the same forced tool.
  assert.equal(
    selectSteeringMode(frame, { recentForceToolDispatched: true }),
    'ask_model',
  )
})

test('buildTurnFrameSteering: recentForceToolDispatched still preserves preferredToolNames', () => {
  const frame = makeFrame()
  const steering = buildTurnFrameSteering(frame, { recentForceToolDispatched: true })
  assert.equal(steering.mode, 'ask_model')
  // ask_model retains the typed action in preferredToolNames so the model
  // still sees the recommended next step. This keeps the model nudged
  // toward the typed action even when we cannot force it.
  assert.ok(steering.preferredToolNames.includes('skill_video_expert_pipeline'))
  const expectedReminder = [
    '系统补充：当前 TurnFrame 已确认本轮是 skill continuation，优先调用 typed skill action skill_video_expert_pipeline 推进任务。',
    'skill_run_shell 只用于必要诊断；不要用 shell 反复读取同一份 run_state 或脚本目录来替代 typed skill action。',
    'outputDir=/tmp/vea-output runStatePath=/tmp/vea-output/run_state.json',
  ].join('\n')
  assert.equal(
    steering.systemReminder,
    composeReminder('typed-action-preferred', 30, expectedReminder),
  )
})

test('selectSteeringMode: force_tool requires resolvable typed action — falls back when action unresolvable', () => {
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      skillId: 'no-default-skill',
      action: null,
    },
    mode: 'skill_resume',
    liveness: 'recoverable_paused',
  })
  // Without a default resume action AND no explicit action, we cannot
  // resolve a typed tool name, so we fall back to ask_model.
  assert.equal(selectSteeringMode(frame), 'ask_model')
})

test('buildTurnFrameSteering blocks unknown action-derived tool names and emits a metric', () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const contract = makeContract({
      action: 'score_batches',
      toolName: null,
      sourceUrl: null,
    } as Partial<SkillRunContract>)
    const frame = makeFrame({
      skill: {
        ...makeFrame().skill!,
        action: 'score_batches',
        runContract: contract,
      },
    })

    const steering = buildTurnFrameSteering(frame)

    assert.equal(steering.mode, 'ask_model')
    assert.equal(steering.requiredToolName, null)
    assert.ok(!steering.preferredToolNames.includes('skill_video_expert_analyzer_score_batches'))
    const blocked = metrics.find((event) => event.metric === 'preferred_tool_name_synthesis_blocked')
    assert.ok(blocked, 'expected preferred_tool_name_synthesis_blocked metric')
    assert.equal(blocked.skillId, 'video-expert-analyzer')
    assert.equal(blocked.action, 'score_batches')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('buildTurnFrameSteering keeps inspect primitives when a resume frame has no typed action yet', () => {
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      action: null,
      artifactPaths: {
        sceneScoresPath: null,
        deliveryReportPath: null,
      },
      runContract: null,
    },
  })

  const steering = buildTurnFrameSteering(frame)

  assert.equal(steering.mode, 'ask_model')
  assert.equal(steering.requiredToolName, null)
  assert.ok(steering.preferredToolNames.includes('skill_inspect_run_state'))
  assert.ok(!steering.preferredToolNames.includes('skill_video_expert_pipeline'))
  assert.ok(!steering.preferredToolNames.includes('skill_video_expert_ai_analyze'))
})

test('buildTurnFrameSteering keeps real manifest actions in preferredToolNames', () => {
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    toolName: 'skill_video_expert_ai_analyze',
    sourceUrl: null,
  })
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      runContract: contract,
    },
  })

  const steering = buildTurnFrameSteering(frame, { recentForceToolDispatched: true })

  assert.equal(steering.mode, 'ask_model')
  assert.ok(steering.preferredToolNames.includes('skill_video_expert_ai_analyze'))
})

test('selectSteeringMode: failed liveness short-circuits even with typed action available', () => {
  const frame = makeFrame({ liveness: 'failed' })
  // Once terminal, no typed action gets forced. Checkpoint and let the user
  // decide.
  assert.equal(selectSteeringMode(frame), 'checkpoint')
})

const NON_FORCE_LIVENESS_STATES: TurnFrameLiveness[] = [
  'unknown',
  'recent_progress',
  'running_process',
  'done',
]

for (const liveness of NON_FORCE_LIVENESS_STATES) {
  test(`selectSteeringMode: liveness=${liveness} does not produce force_tool`, () => {
    const frame = makeFrame({ liveness })
    assert.notEqual(selectSteeringMode(frame), 'force_tool')
  })
}

// ─── Stage E2: contract-derived input synthesis ──────────────────────────

test('E2: deriveForcedActionInput pulls url from contract.sourceUrl for video_expert_pipeline', () => {
  const frame = makeFrame()
  const contract = frame.skill!.runContract!
  const input = deriveForcedActionInput({
    toolName: 'skill_video_expert_pipeline',
    contract,
    frame,
  })
  assert.equal(input.url, 'https://example.com/video.mp4')
  assert.equal(input.outputDir, '/tmp/vea-output')
})

test('E2: deriveForcedActionInput pulls sceneScoresPath from contract.artifactPaths for video_expert_ai_analyze', () => {
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    sourceUrl: null,
  })
  const frame = makeFrame({
    skill: { ...makeFrame().skill!, action: 'video_expert_ai_analyze', runContract: contract },
  })
  const input = deriveForcedActionInput({
    toolName: 'skill_video_expert_ai_analyze',
    contract,
    frame,
  })
  assert.equal(input.sceneScoresPath, '/tmp/vea-output/scene_scores.json')
  assert.equal(input.outputDir, '/tmp/vea-output')
})

test('E2: validateForcedActionInput surfaces missing url for video_expert_pipeline when contract lacks sourceUrl', () => {
  const contract = makeContract({ sourceUrl: null, originalInput: null, actionInput: null })
  const frame = makeFrame({
    skill: { ...makeFrame().skill!, runContract: contract },
  })
  const input = deriveForcedActionInput({
    toolName: 'skill_video_expert_pipeline',
    contract,
    frame,
  })
  const validated = validateForcedActionInput('skill_video_expert_pipeline', input)
  assert.equal(validated.ok, false)
  if (!validated.ok) {
    assert.deepEqual(validated.missingInputs, ['url'])
  }
})

test('E2: validateForcedActionInput surfaces missing sceneScoresPath for video_expert_ai_analyze', () => {
  const contract = makeContract({
    action: 'video_expert_ai_analyze',
    artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
    sourceUrl: null,
  })
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_ai_analyze',
      runContract: contract,
      artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
    },
  })
  const input = deriveForcedActionInput({
    toolName: 'skill_video_expert_ai_analyze',
    contract,
    frame,
  })
  const validated = validateForcedActionInput('skill_video_expert_ai_analyze', input)
  assert.equal(validated.ok, false)
  if (!validated.ok) {
    assert.deepEqual(validated.missingInputs, ['sceneScoresPath'])
  }
})

test('E2: computeForceInputDigest is deterministic regardless of property order', () => {
  const a = { url: 'https://example.com/v.mp4', outputDir: '/tmp/x' }
  const b = { outputDir: '/tmp/x', url: 'https://example.com/v.mp4' }
  assert.equal(computeForceInputDigest(a), computeForceInputDigest(b))
})

test('E2: computeForceInputDigest distinguishes different inputs', () => {
  const a = { url: 'https://example.com/v.mp4' }
  const b = { url: 'https://example.com/other.mp4' }
  assert.notEqual(computeForceInputDigest(a), computeForceInputDigest(b))
})

test('E2: computeForceInputDigest distinguishes null from {}', () => {
  assert.notEqual(computeForceInputDigest(null), computeForceInputDigest({}))
})

test('E2: buildFrameAction returns force_tool action with input + digest when contract is complete', () => {
  const frame = makeFrame()
  const action = buildFrameAction({
    frame,
    decidedMode: 'force_tool',
    toolName: 'skill_video_expert_pipeline',
  })
  assert.ok(action, 'expected non-null FrameAction')
  assert.equal(action!.mode, 'force_tool')
  assert.equal(action!.toolName, 'skill_video_expert_pipeline')
  assert.equal((action!.input as Record<string, unknown>)?.url, 'https://example.com/video.mp4')
  assert.ok(typeof action!.inputDigest === 'string' && action!.inputDigest.length === 16)
  assert.deepEqual(action!.missingInputs, [])
})

test('E2: buildFrameAction downgrades to checkpoint with missingInputs when contract lacks url', () => {
  const contract = makeContract({ sourceUrl: null, originalInput: null, actionInput: null })
  const frame = makeFrame({
    skill: { ...makeFrame().skill!, runContract: contract },
  })
  const action = buildFrameAction({
    frame,
    decidedMode: 'force_tool',
    toolName: 'skill_video_expert_pipeline',
  })
  assert.ok(action, 'expected non-null FrameAction')
  assert.equal(action!.mode, 'checkpoint')
  assert.equal(action!.toolName, 'skill_video_expert_pipeline')
  assert.deepEqual(action!.missingInputs, ['url'])
  assert.match(action!.reason, /missing_url/)
})

test('E2: buildTurnFrameSteering populates steering.action with FrameAction when force_tool', () => {
  const frame = makeFrame()
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'force_tool')
  assert.ok(steering.action, 'expected steering.action to be populated')
  assert.equal(steering.action!.mode, 'force_tool')
  assert.equal(steering.action!.toolName, 'skill_video_expert_pipeline')
  assert.equal(
    (steering.action!.input as Record<string, unknown>)?.url,
    'https://example.com/video.mp4',
  )
  assert.ok(typeof steering.action!.inputDigest === 'string' && steering.action!.inputDigest.length === 16)
})

test('E2: buildTurnFrameSteering downgrades to checkpoint when contract lacks required url', () => {
  const contract = makeContract({ sourceUrl: null, originalInput: null, actionInput: null })
  const frame = makeFrame({
    skill: { ...makeFrame().skill!, runContract: contract },
  })
  const steering = buildTurnFrameSteering(frame)
  // Engine reads steering.mode for dispatch eligibility; downgrade flips it
  // from force_tool → checkpoint so dispatch never sees `{}`.
  assert.equal(steering.mode, 'checkpoint')
  assert.ok(steering.action, 'expected steering.action to be populated')
  assert.equal(steering.action!.mode, 'checkpoint')
  assert.deepEqual(steering.action!.missingInputs, ['url'])
  assert.match(steering.action!.reason, /missing_url/)
  const expectedReminder = [
    '系统补充：本轮 TurnFrame 想强制调用 skill_video_expert_pipeline，但运行契约里缺少必需输入（缺少必需字段：url）。',
    '请先补齐必要参数（例如 url / sceneScoresPath / outputDir），或调用 skill_inspect_run_state / skill_read_artifact 探查产出，再重新尝试。',
    'outputDir=/tmp/vea-output runStatePath=/tmp/vea-output/run_state.json',
  ].join('\n')
  assert.equal(
    steering.systemReminder,
    composeReminder('force-tool-missing', 90, expectedReminder),
  )
})

test('E2: buildTurnFrameSteering preserves contract.actionInput when provided (Wave 2 happy path)', () => {
  const contract = makeContract({
    actionInput: { url: 'https://wave2.example/movie.mp4', outputDir: '/tmp/wave2' },
    sourceUrl: null,
  })
  const frame = makeFrame({
    skill: { ...makeFrame().skill!, runContract: contract },
  })
  const steering = buildTurnFrameSteering(frame)
  assert.equal(steering.mode, 'force_tool')
  assert.equal(
    (steering.action!.input as Record<string, unknown>)?.url,
    'https://wave2.example/movie.mp4',
  )
  // outputDir came from actionInput, not contract.outputDir directly.
  assert.equal((steering.action!.input as Record<string, unknown>)?.outputDir, '/tmp/wave2')
})
