/**
 * Stage Q (Stage 11) — Selected-skill primitive fence behavior test.
 *
 * Audit §F-1 / Plan §3.2 contract C3: when a primitive call is dispatched
 * for a skill whose `executionMode==='advisory'` OR which has any action
 * with `runtime:'reference'`, `recordPrimitiveOutcome` must NOT write a
 * SkillTaskRun row and `rememberSkillRun` must not record the run.
 *
 * Tests directly exercise `shouldRememberPrimitiveOutcomeForContinuity`
 * (Q.2 belt-and-braces) plus the recordPrimitiveOutcome fence indirectly
 * via `executeSkillTool` with a fake skills runtime.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  executeSkillTool,
  shouldRememberPrimitiveOutcomeForContinuity,
} from '../main/modules/tools/skills-tools'
import { __setMetricSinkForTests, logAgentMetric, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { snapshotTurnFeatureFlags } from '../main/modules/agent-control/runtime-core/turn-feature-flags'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
  type SkillState,
} from '../main/modules/skills-runtime/runtime-manager'
import {
  clearSkillTaskProjection,
  readSkillTaskProjection,
  registerSkillTaskRunRepository,
} from '../main/modules/agent-control/skills/skill-task-tracker'
import type { SkillTaskRunRecord, SkillTaskRunRepository } from '../main/modules/repositories/skill-task-run-repository'
import { buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

const COMPLETE_HFP_SPACE_DESIGN_PROPOSAL = [
  '# hfpTM 空间设计提案：洞穴风',
  '## 1. 方案名称',
  '洞穴风温和试用门店',
  '## 2. 一句话空间命题',
  '让用户在温暖石穴般的空间里看清产品、试到质地、完成低压咨询。',
  '## 3. 用户真实场景',
  '换季用户进店确认产品是否适合自己。',
  '## 4. 设计目标与优先级',
  '优先保证产品可见、试用顺畅、咨询低压。',
  '## 5. 核心空间概念',
  '自然洞穴结构与温暖晨光结合，中央石桌承担展示与试用。',
  '## 6. 空间动线与用户动作',
  '入口识别、主品观看、质地试用、顾问咨询、带走说明卡。',
  '## 7. 七组单品表及组合内容',
  '家具、灯具、陈列、试用道具、植物、镜头、快速模板七组齐全。',
  '## 8. 设计风格',
  'Natural Warmth 与 Organic Modernism。',
  '## 9. 色彩搭配',
  '暖石灰、蛋壳白、浅木、炭黑、亲密红、青苔绿。',
  '## 10. 材质 / 纹理搭配',
  '暖灰仿石洞壁、打磨石桌、哑光亚克力信息牌。',
  '## 11. 光线 / 灯光类型',
  '天顶漏光、壁龛柔光、石桌局部补光共同保证产品可读。',
  '## 12. 信息与文案导视',
  '用短句说明适合谁、怎么试、怎么选。',
  '## 13. 空间描述（客户可读版）',
  '用户走进晨光照亮的温和石穴，在中央石桌试用产品并完成选择。',
  '## 14. 风险与退回标准',
  '产品不可读、光线过暗、青苔过多、石桌不可维护时必须退回。',
  '## 15. 供应商 / 设计师执行要点',
  '控制石材清洁、灯光色温、壁龛尺度、动线宽度与试用耗材收纳。',
].join('\n\n')

// ---------------------------------------------------------------------------
// Belt-and-braces continuity gate (pure function — no runtime needed).
// ---------------------------------------------------------------------------

test('shouldRememberPrimitiveOutcomeForContinuity: isReferenceOrAdvisory=true blocks all', () => {
  // Even cases that would otherwise be recorded (blocked/error/durable
  // handle/etc) are skipped when the skill is reference/advisory.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true,
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'error',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true,
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: true,
    isReferenceOrAdvisory: true,
  }), false)
})

test('shouldRememberPrimitiveOutcomeForContinuity: isReferenceOrAdvisory=false preserves prior behavior', () => {
  // Without the flag (or false), behavior matches the existing
  // skill-primitive-continuity.test.ts assertions exactly. This test
  // pins back-compat: the new optional parameter does NOT change
  // outcomes for non-reference skills.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), false) // monitor-only success without handle still rejected

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)
})

test('shouldRememberPrimitiveOutcomeForContinuity: omitting isReferenceOrAdvisory defaults to false', () => {
  // Pre-Stage-Q callers don't pass the new flag. Default must be false
  // so behavior is unchanged.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
  }), true)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
  }), false)
})

// ---------------------------------------------------------------------------
// Hybrid skill regression — Stage Q implementation plan §3.2 contract.
// ---------------------------------------------------------------------------

test('hybrid skill (reference action + python typed_action): primitive call from any context fenced', () => {
  // Stage Q plan §3.2 documents that hybrid skills (e.g. lets-go-rss)
  // are not misjudged because:
  //   (a) Their reference actions (e.g. read_skill) trigger primitive
  //       calls that SHOULD be fenced — pin that.
  //   (b) Their typed_action paths (python actions) NEVER reach
  //       `executeSkillTool('skill_run_shell', ...)` etc — they go
  //       through `runSkill` directly. So the per-skill (rather than
  //       per-action) fence does not误伤 them.
  //
  // This test pins (a) — when a hybrid skill is selected and a primitive
  // is invoked, the gate returns false (i.e. fence active).
  //
  // Note: the actual `executeSkillTool`-level fence is exercised in
  // `skill-primitive-continuity.test.ts:89` style tests; here we test
  // the contract gate (`shouldRememberPrimitiveOutcomeForContinuity`)
  // because it carries the same `isReferenceOrAdvisory` predicate.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
    isReferenceOrAdvisory: true, // hybrid skill marked as such by hoist
  }), false)

  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: true,
    isReferenceOrAdvisory: true, // any status × any handle still fenced
  }), false)
})

test('non-reference skill: primitive call NOT fenced (regression for non-reference path)', () => {
  // Pin that the fence is selectively applied. A skill whose
  // `executionMode==='direct'` AND has zero `runtime:'reference'` actions
  // produces `isReferenceOrAdvisory=false`, and primitive continuity
  // continues to be recorded normally.
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'blocked',
    hasDurableHandle: false,
    isReferenceOrAdvisory: false,
  }), true)
})

// ---------------------------------------------------------------------------
// Stage Q implementation plan §3.2 — feature flag snapshot integration.
// ---------------------------------------------------------------------------

test('snapshotTurnFeatureFlags: referencePrimitiveLifecycleFence default enabled', () => {
  const flags = snapshotTurnFeatureFlags({})
  assert.equal(flags.referencePrimitiveLifecycleFence, true)
})

test("snapshotTurnFeatureFlags: READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE='0' disables fence", () => {
  const flags = snapshotTurnFeatureFlags({
    READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: '0',
  })
  assert.equal(flags.referencePrimitiveLifecycleFence, false)
})

test('snapshotTurnFeatureFlags: skillTaskRunInvariantEnforced default enabled', () => {
  const flags = snapshotTurnFeatureFlags({})
  assert.equal(flags.skillTaskRunInvariantEnforced, true)
})

test("snapshotTurnFeatureFlags: READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0' disables enforcement", () => {
  const flags = snapshotTurnFeatureFlags({
    READY_SKILL_TASK_RUN_INVARIANT_ENFORCED: '0',
  })
  assert.equal(flags.skillTaskRunInvariantEnforced, false)
})

test('snapshotTurnFeatureFlags: false/off/empty all disable, anything else enables', () => {
  // Per turn-feature-flags.ts isFlagEnabled() helper contract.
  for (const off of ['0', 'false', 'off', 'OFF', 'False']) {
    assert.equal(
      snapshotTurnFeatureFlags({ READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: off }).referencePrimitiveLifecycleFence,
      false,
      `expected '${off}' to disable fence`,
    )
  }
  for (const on of ['1', 'true', 'on', 'yes', 'enabled']) {
    assert.equal(
      snapshotTurnFeatureFlags({ READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: on }).referencePrimitiveLifecycleFence,
      true,
      `expected '${on}' to enable fence`,
    )
  }
})

// ---------------------------------------------------------------------------
// Metric-sink integration: prove the fence emits the expected metric when
// triggered via a real recordPrimitiveOutcome path. We can't easily mock
// the SkillsRuntimeManager singleton from a test, so we exercise the
// equivalent path: hand-craft a turnFeatureFlags + skillKind context and
// drive `recordPrimitiveOutcome` indirectly through executeSkillTool's
// authorization gate. Even a bare invocation that fails authorization will
// not emit the fence metric (the fence is at recordPrimitiveOutcome time,
// after authorization). So we make this a contract observation: the
// metric sink wiring works AT ALL, and would catch a regression if the
// fence went silent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real e2e integration: drive `executeSkillTool` with a synthetic
// SkillsRuntimeManager that returns a reference-runtime skill. Verify the
// fence prevents SkillTaskRunRepository.create from being called and emits
// the expected metric.
// ---------------------------------------------------------------------------

function makeReferenceSkillManager(skillId: string): SkillsRuntimeManager {
  const fakeSkill = {
    id: skillId,
    name: skillId,
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    actions: [
      { id: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  return {
    listSkills: () => [fakeSkill],
  } as unknown as SkillsRuntimeManager
}

function makeRecordingRepository(): {
  repo: SkillTaskRunRepository
  createCalls: SkillTaskRunRecord[]
  updateCalls: Array<{ id: string; patch: Partial<SkillTaskRunRecord> }>
} {
  const createCalls: SkillTaskRunRecord[] = []
  const updateCalls: Array<{ id: string; patch: Partial<SkillTaskRunRecord> }> = []
  const repo = {
    create: (record: SkillTaskRunRecord) => { createCalls.push(record) },
    update: (id: string, patch: Partial<SkillTaskRunRecord>) => { updateCalls.push({ id, patch }) },
    updateRowSync: (id: string, patch: Partial<SkillTaskRunRecord>) => { updateCalls.push({ id, patch }) },
    get: () => null,
    findByDetachedTaskId: () => null,
    findLatestRecoverable: () => null,
    listActiveBySession: () => [],
    listByScope: () => [],
  } as unknown as SkillTaskRunRepository
  return { repo, createCalls, updateCalls }
}

test('e2e fence: reference skill primitive call does NOT write SkillTaskRun + emits skipped metric', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  __setSkillsRuntimeManagerForTests(makeReferenceSkillManager('humanizer-zh'))
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  try {
    let result: unknown = null
    try {
      result = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: 'note.txt', content: 'hello' },
      'session-q-e2e',
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'humanizer-zh',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )
    } catch {
      // The fake runtime manager doesn't implement getRuntimeInfo() etc.
      // that `executeWriteArtifact` needs. The fence runs BEFORE the
      // actual write, so the throw happens after we've already captured
      // whether DB writes were skipped. Catch and ignore.
    }
    void result
    // The call may throw (fake runtime missing methods) or succeed.
    // We only care that:
    // (a) NO SkillTaskRun row was created (fence active)
    // (b) the skipped metric was emitted at least once
    assert.equal(createCalls.length, 0, `expected 0 SkillTaskRun.create calls, got ${createCalls.length}`)
    const skipped = events.filter((e) => e.metric === 'reference_primitive_lifecycle_skipped')
    assert.ok(skipped.length >= 1, `expected reference_primitive_lifecycle_skipped metric, got events: ${JSON.stringify(events.map(e => e.metric))}`)
    assert.equal(skipped[0].skillId, 'humanizer-zh')
    assert.equal(skipped[0].toolName, 'skill_write_artifact')
  } finally {
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    __setMetricSinkForTests(null)
  }
})

test('e2e fence: reference skill primitive still updates visible task projection only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ref-projection-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })

  const skillId = 'humanizer-zh'
  const sessionId = 'session-q-projection'
  const fakeSkill = {
    id: skillId,
    name: 'Humanizer Zh',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  try {
    const writeResult = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: '方案.md', content: 'hello' },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )

    assert.equal(createCalls.length, 0, 'reference primitive must not create SkillTaskRun rows')
    const projection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(projection?.status, 'completed')
    assert.equal(projection?.taskTitle, '正在使用Humanizer Zh')
    assert.equal(projection?.taskSummary, '方案草稿已写入，正在准备保存')
    assert.equal(projection?.steps.at(-1)?.title, '写入方案草稿')
    assert.equal(projection?.steps.at(-1)?.status, 'done')
    assert.equal(projection?.recentArtifacts.at(-1)?.label, '方案.md')
    assert.match(String(projection?.recentArtifacts.at(-1)?.path || ''), /方案\.md$/)
    assert.deepEqual((writeResult as { projectionPatch?: unknown }).projectionPatch, projection)

    const readResult = await executeSkillTool(
      'skill_read_artifact',
      { relativePath: '方案.md' },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_read_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )
    const readText = typeof readResult === 'string'
      ? readResult
      : String((readResult as { text?: unknown }).text || '')
    assert.match(readText, /hello/)
    const readProjection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(readProjection?.taskSummary, '正在根据参考内容整理方案')
    assert.equal(readProjection?.steps.at(-1)?.title, '读取技能参考')

    const targetRoot = join(root, 'target-folder')
    mkdirSync(targetRoot, { recursive: true })
    const targetPath = join(targetRoot, '方案.md')
    const exportResult = await executeSkillTool(
      'skill_export_artifact',
      { relativePath: '方案.md', targetPath },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_export_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        requestEnvelope: {
          environmentHints: {
            workspaceRoots: [root],
          },
        },
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )

    assert.equal(createCalls.length, 0, 'reference export primitive must not create SkillTaskRun rows')
    assert.equal(existsSync(targetPath), true)
    assert.equal(readFileSync(targetPath, 'utf-8'), 'hello')
    const exportedProjection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(exportedProjection?.status, 'completed')
    assert.equal(exportedProjection?.taskTitle, '文档已保存')
    assert.equal(exportedProjection?.taskSummary, '已保存到目标文件夹')
    assert.equal(exportedProjection?.steps.at(-1)?.title, '保存到目标文件夹')
    assert.equal(exportedProjection?.recentArtifacts.at(-1)?.path, realpathSync(targetPath))
    assert.deepEqual((exportResult as { projectionPatch?: unknown }).projectionPatch, exportedProjection)
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('reference skill write auto-exports when the turn says 存到 and names an authorized target folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ref-auto-export-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  const wrongRoot = join(root, 'lib-a')
  const targetRoot = join(root, 'hfp空间方案')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })
  mkdirSync(wrongRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })

  const skillId = 'hfp-space-design'
  const sessionId = 'session-q-auto-export'
  const fakeSkill = {
    id: skillId,
    name: 'hfp-space-design',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  try {
    const targetPath = join(targetRoot, 'ready-hfp-regression-洞穴风-20260625-105830.md')
    const result = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: '草稿.md', content: COMPLETE_HFP_SPACE_DESIGN_PROPOSAL },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        currentUserText: '@[hfp-space-design]生成一版洞穴风方案，存到@[hfp空间方案]，文件名 ready-hfp-regression-洞穴风-20260625-105830.md',
        requestEnvelope: {
          primaryInstruction: '@[hfp-space-design]生成一版洞穴风方案，存到@[hfp空间方案]，文件名 ready-hfp-regression-洞穴风-20260625-105830.md',
          resources: [
            {
              kind: 'folder_reference',
              name: 'hfp空间方案',
              path: targetRoot,
            },
          ],
          environmentHints: {
            workspaceRoots: [wrongRoot],
          },
        },
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )

    assert.equal(createCalls.length, 0, 'reference auto-export must not create SkillTaskRun rows')
    assert.equal(existsSync(targetPath), true)
    assert.equal(existsSync(join(wrongRoot, 'ready-hfp-regression-洞穴风-20260625-105830.md')), false)
    assert.equal(readFileSync(targetPath, 'utf-8'), COMPLETE_HFP_SPACE_DESIGN_PROPOSAL)
    const projection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(projection?.status, 'completed')
    assert.equal(projection?.taskTitle, '文档已保存')
    assert.equal(projection?.taskSummary, '已保存到目标文件夹')
    assert.equal(projection?.steps.at(-1)?.title, '保存到目标文件夹')
    assert.equal(projection?.recentArtifacts.at(-1)?.path, realpathSync(targetPath))
    assert.deepEqual((result as { projectionPatch?: unknown }).projectionPatch, projection)
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('reference skill auto-export prefers current artifact filename over stale envelope filename', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-ref-auto-export-stale-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  const targetRoot = join(root, 'hfp空间方案')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })

  const skillId = 'hfp-space-design'
  const sessionId = 'session-q-auto-export-stale'
  const fakeSkill = {
    id: skillId,
    name: 'hfp-space-design',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  try {
    const currentName = 'ready-hfp-regression-岩洞晨光-20260625-162503.md'
    const staleName = 'ready-hfp-regression-岩洞晨光-20260625-133205.md'
    const currentTarget = join(targetRoot, currentName)
    const staleTarget = join(targetRoot, staleName)

    await executeSkillTool(
      'skill_write_artifact',
      { relativePath: join('hfp空间方案', currentName), content: COMPLETE_HFP_SPACE_DESIGN_PROPOSAL },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        currentUserText: '@[hfp-space-design]直接生成一版完整方案，输出到@[hfp空间方案]',
        requestEnvelope: {
          primaryInstruction: `@[hfp-space-design]上一轮方案，输出到@[hfp空间方案]，文件名 ${staleName}`,
          resources: [
            {
              kind: 'folder_reference',
              name: 'hfp空间方案',
              path: targetRoot,
            },
          ],
          environmentHints: {
            workspaceRoots: [root],
          },
        },
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )

    assert.equal(existsSync(currentTarget), true)
    assert.equal(existsSync(staleTarget), false)
    assert.equal(readFileSync(currentTarget, 'utf-8'), COMPLETE_HFP_SPACE_DESIGN_PROPOSAL)
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('hfp-space-design auto-export keeps incomplete drafts recoverable without exporting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-hfp-incomplete-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  const targetRoot = join(root, 'hfp空间方案')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })

  const skillId = 'hfp-space-design'
  const sessionId = 'session-q-hfp-incomplete'
  const fakeSkill = {
    id: skillId,
    name: 'hfp-space-design',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  try {
    const targetPath = join(targetRoot, 'ready-hfp-regression-半截.md')
    const output = await executeSkillTool(
      'skill_write_artifact',
      {
        relativePath: '半截.md',
        content: [
          '# hfpTM 空间设计提案：半截',
          '## 1. 方案名称',
          '半截方案',
          '## 2. 一句话空间命题',
          '还没有写完。',
          '## 3. 用户真实场景',
          '只写到第三节。',
        ].join('\n\n'),
      },
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId,
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        currentUserText: '@[hfp-space-design]生成一版洞穴风完整门店设计方案，输出到@[hfp空间方案]，文件名 ready-hfp-regression-半截.md',
        requestEnvelope: {
          primaryInstruction: '@[hfp-space-design]生成一版洞穴风完整门店设计方案，输出到@[hfp空间方案]，文件名 ready-hfp-regression-半截.md',
          resources: [
            {
              kind: 'folder_reference',
              name: 'hfp空间方案',
              path: targetRoot,
            },
          ],
          environmentHints: {
            workspaceRoots: [root],
          },
        },
        turnFeatureFlags: snapshotTurnFeatureFlags({}),
      },
    )

    assert.equal(existsSync(targetPath), false)
    assert.equal(existsSync(join(outputsRoot, skillId, '半截.md')), true)
    assert.equal((output.data?.autoExport as { status?: string } | undefined)?.status, 'needs_append')
    const projection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(projection?.status, 'running')
    assert.equal(projection?.blockedReason, null)
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('hfp-space-design auto-export can append missing tail sections before delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-hfp-append-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  const targetRoot = join(root, 'hfp空间方案')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })

  const skillId = 'hfp-space-design'
  const sessionId = 'session-q-hfp-append'
  const fakeSkill = {
    id: skillId,
    name: 'hfp-space-design',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  const requestEnvelope = {
    primaryInstruction: '@[hfp-space-design]生成一版洞穴风完整门店设计方案，输出到@[hfp空间方案]，文件名 ready-hfp-regression-补齐.md',
    resources: [
      {
        kind: 'folder_reference',
        name: 'hfp空间方案',
        path: targetRoot,
      },
    ],
    environmentHints: {
      workspaceRoots: [root],
    },
  }
  const context = {
    authorization: buildSelectedSkillToolAuthorization({
      skillId,
      allowedTypedActions: [],
      allowedPrimitives: ['skill_write_artifact'],
      source: 'explicit',
      reason: 'test_setup',
    }),
    currentUserText: requestEnvelope.primaryInstruction,
    requestEnvelope,
    turnFeatureFlags: snapshotTurnFeatureFlags({}),
  }

  try {
    const targetPath = join(targetRoot, 'ready-hfp-regression-补齐.md')
    const withoutTail = COMPLETE_HFP_SPACE_DESIGN_PROPOSAL.replace(
      /\n## 15\. 供应商 \/ 设计师执行要点[\s\S]*$/,
      '',
    )
    const draftOutput = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: '补齐.md', content: withoutTail },
      sessionId,
      undefined,
      undefined,
      undefined,
      context,
    )
    assert.equal((draftOutput.data?.autoExport as { status?: string } | undefined)?.status, 'needs_append')
    assert.equal(existsSync(targetPath), false)

    await executeSkillTool(
      'skill_write_artifact',
      {
        relativePath: '补齐.md',
        mode: 'append',
        content: COMPLETE_HFP_SPACE_DESIGN_PROPOSAL.slice(withoutTail.length),
      },
      sessionId,
      undefined,
      undefined,
      undefined,
      context,
    )

    assert.equal(existsSync(targetPath), true)
    assert.equal(readFileSync(targetPath, 'utf-8'), COMPLETE_HFP_SPACE_DESIGN_PROPOSAL)
    const projection = readSkillTaskProjection({ sessionId, skillId })
    assert.equal(projection?.status, 'completed')
    assert.equal(projection?.taskTitle, '文档已保存')
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('hfp-space-design auto-export preserves a more complete draft from shorter overwrite retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-hfp-preserve-'))
  const managedPath = join(root, 'skill')
  const outputsRoot = join(root, 'outputs')
  const targetRoot = join(root, 'hfp空间方案')
  mkdirSync(managedPath, { recursive: true })
  mkdirSync(outputsRoot, { recursive: true })
  mkdirSync(targetRoot, { recursive: true })

  const skillId = 'hfp-space-design'
  const sessionId = 'session-q-hfp-preserve'
  const fakeSkill = {
    id: skillId,
    name: 'hfp-space-design',
    description: '',
    version: '0.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    runtime: 'reference',
    managedPath,
    actions: [
      { name: 'read_skill', runtime: 'reference' },
    ],
    executionMode: 'advisory',
  } as unknown as SkillState
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [fakeSkill],
    getRuntimeInfo: () => ({
      runtimeRoot: root,
      skillsRoot: join(root, 'skills'),
      customSkillsRoot: join(root, 'custom-skills'),
      outputsRoot,
      venvRoot: join(root, 'venv'),
    }),
  } as unknown as SkillsRuntimeManager)
  const { repo } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  clearSkillTaskProjection(sessionId)

  const requestEnvelope = {
    primaryInstruction: '@[hfp-space-design]生成一版洞穴风完整门店设计方案，输出到@[hfp空间方案]，文件名 ready-hfp-regression-保留.md',
    resources: [
      {
        kind: 'folder_reference',
        name: 'hfp空间方案',
        path: targetRoot,
      },
    ],
    environmentHints: {
      workspaceRoots: [root],
    },
  }
  const context = {
    authorization: buildSelectedSkillToolAuthorization({
      skillId,
      allowedTypedActions: [],
      allowedPrimitives: ['skill_write_artifact'],
      source: 'explicit',
      reason: 'test_setup',
    }),
    currentUserText: requestEnvelope.primaryInstruction,
    requestEnvelope,
    turnFeatureFlags: snapshotTurnFeatureFlags({}),
  }

  try {
    const artifactPath = join(outputsRoot, skillId, '保留.md')
    const betterDraft = COMPLETE_HFP_SPACE_DESIGN_PROPOSAL.replace(
      /\n## 15\. 供应商 \/ 设计师执行要点[\s\S]*$/,
      '',
    )
    const shorterRetry = [
      '# hfpTM 空间设计提案：短稿',
      '## 1. 方案名称',
      '短稿',
      '## 2. 一句话空间命题',
      '短稿。',
    ].join('\n\n')

    await executeSkillTool(
      'skill_write_artifact',
      { relativePath: '保留.md', content: betterDraft },
      sessionId,
      undefined,
      undefined,
      undefined,
      context,
    )
    const retryOutput = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: '保留.md', content: shorterRetry },
      sessionId,
      undefined,
      undefined,
      undefined,
      context,
    )

    assert.equal(readFileSync(artifactPath, 'utf-8'), betterDraft)
    assert.equal(retryOutput.data?.preservedExistingDraft, true)
    assert.equal((retryOutput.data?.autoExport as { status?: string } | undefined)?.status, 'needs_append')
    assert.equal(existsSync(join(targetRoot, 'ready-hfp-regression-保留.md')), false)
  } finally {
    clearSkillTaskProjection(sessionId)
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('e2e fence DISABLED via flag: reference skill primitive DOES write SkillTaskRun', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  __setSkillsRuntimeManagerForTests(makeReferenceSkillManager('humanizer-zh'))
  const { repo, createCalls } = makeRecordingRepository()
  registerSkillTaskRunRepository(repo)
  try {
    let result: unknown = null
    try {
      result = await executeSkillTool(
      'skill_write_artifact',
      { relativePath: 'note.txt', content: 'hello' },
      'session-q-e2e-flag-off',
      undefined,
      undefined,
      undefined,
      {
        authorization: buildSelectedSkillToolAuthorization({
          skillId: 'humanizer-zh',
          allowedTypedActions: [],
          allowedPrimitives: ['skill_write_artifact'],
          source: 'explicit',
          reason: 'test_setup',
        }),
        turnFeatureFlags: snapshotTurnFeatureFlags({
          READY_REFERENCE_PRIMITIVE_LIFECYCLE_FENCE: '0',
        }),
      },
    )
    } catch {
      // Same as above — fake runtime crashes after recordPrimitive runs.
    }
    void result
    // Flag off → fence does NOT trigger early return.
    // recordPrimitiveOutcome runs normally; create SHOULD be called for
    // primitive runKind. (Even if writeArtifact fails inside the sandbox
    // the running/error event still creates the row.)
    assert.ok(createCalls.length >= 1, `expected >=1 SkillTaskRun.create call, got ${createCalls.length}`)
    const skipped = events.filter((e) => e.metric === 'reference_primitive_lifecycle_skipped')
    const disabled = events.filter((e) => e.metric === 'reference_primitive_lifecycle_fence_disabled')
    assert.equal(skipped.length, 0)
    assert.ok(disabled.length >= 1, `expected reference_primitive_lifecycle_fence_disabled metric, got: ${JSON.stringify(events.map(e => e.metric))}`)
  } finally {
    registerSkillTaskRunRepository(null)
    __setSkillsRuntimeManagerForTests(null)
    __setMetricSinkForTests(null)
  }
})

test('metric sink: fence event payload is well-formed when forwarded by sink', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    // Synthesize the same metric that the fence would emit. This is a
    // belt-and-braces test: it validates the metric name + payload schema
    // is stable, so a future rename of the metric would break this test
    // and force the contract to be updated in lockstep.
    const fakeFenceEmit = (sessionId: string, skillId: string, toolName: string): void => {
      logAgentMetric('reference_primitive_lifecycle_skipped', {
        sessionId,
        scopeId: sessionId,
        skillId,
        toolName,
        status: 'done',
      })
    }
    fakeFenceEmit('session-q-test', 'humanizer-zh', 'skill_write_artifact')
    assert.equal(events.length, 1)
    assert.equal(events[0].metric, 'reference_primitive_lifecycle_skipped')
    assert.equal(events[0].skillId, 'humanizer-zh')
    assert.equal(events[0].toolName, 'skill_write_artifact')
    assert.equal(events[0].sessionId, 'session-q-test')
  } finally {
    __setMetricSinkForTests(null)
  }
})
