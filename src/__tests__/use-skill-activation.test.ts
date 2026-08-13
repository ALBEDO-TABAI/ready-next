/**
 * P2-2 — `use_skill` 模型侧激活工具。
 * 母合同 2026-07-06 §4 T4：新增 use_skill = 模型侧显式激活事件，走与 mention 同一条 hint→selected 授权通道。
 *
 * 三面验收：
 *   1. dispatch —— 合法 id 返回 capped doc + same-run pending 标记；非法 id → 结构化 unknown_skill（不冒泡）；缺 skill_id → input_validation。
 *   2. 曝光矩阵（真实 executor）—— mode:'none'+目录非空 → 有 use_skill；none+目录空 → 无；selected → 无（防递归激活）。
 *   3. 激活链 —— use_skill 返回后，同一 request 立即刷新 authorization；SDK 下一模型迭代动态看见选中技能工具。
 *   4. 持久续跑 —— 同一 hint 仍让后续 continuation 解析为 selected。
 *   5. 安全红线 —— use_skill 无 `skill_` 前缀，mode:'none' 轮除它以外无任何 skill_* 原语（由 skill-tool-gating 既有测试守护，这里补一条断言）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import type { AIModelConfig } from '../shared/ai-providers'
import { AgentSdkRuntime } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  AgentSdkToolExecutor,
  isToolEnabledForCurrentAuthorization,
} from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { createEmptyActiveFrameContext } from '../main/modules/agent-control/tools-runtime/tool-runtime'
import {
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  clearLastReferenceSkill,
  getLastReferenceSkill,
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { executeUseSkill } from '../main/modules/tools/builtins/use-skill'
import { USE_SKILL_TOOL_NAMES } from '../main/modules/tools/use-skill-tool-defs'
import { readReferenceSkillDocCapped, REFERENCE_SKILL_INLINE_CAP_CHARS } from '../main/modules/skills-runtime/reference-skill-doc'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

test.before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
test.after(() => __setScopeContextEpochDatabaseForTests(null))
test.beforeEach(() => _resetLastReferenceSkillHintsForTests())
test.afterEach(() => _resetLastReferenceSkillHintsForTests())

test('use-skill-activation declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'use-skill-activation transitive sqlite guard')
})

const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

const PPT_ROOT = join(process.cwd(), 'assets', 'embedded-skills', 'ready-human-touch-ppt')

function fakeSkills() {
  return [
    { id: 'ready-human-touch-ppt', name: '网页 PPT · 双风格', description: '双风格网页 PPT', managedPath: PPT_ROOT },
    { id: 'deep-research', name: 'Deep Research', description: '研究方法论', managedPath: join(process.cwd(), 'assets', 'embedded-skills', 'deep-research') },
  ]
}

// ─── 1. dispatch ────────────────────────────────────────────────────────────

test('use_skill dispatch: valid id returns capped methodology + armed marker and arms the reference hint', async () => {
  const armed: Array<{ sessionId?: string; id: string; name: string }> = []
  const output = await executeUseSkill(
    { skill_id: 'ready-human-touch-ppt' },
    {
      sessionId: 'scope-use-skill-dispatch',
      listSkills: fakeSkills,
      readSkillDoc: readReferenceSkillDocCapped,
      rememberReferenceSkill: (sessionId, info) => { armed.push({ sessionId, ...info }) },
    },
  )
  const data = (output as { data?: Record<string, unknown> }).data || {}
  assert.equal(data.skill_id, 'ready-human-touch-ppt')
  assert.equal(data.activation, 'pending_same_run_refresh')
  assert.ok(typeof output.text === 'string' && output.text.length > 0, 'methodology text must reach the model')
  assert.ok(output.text.length <= REFERENCE_SKILL_INLINE_CAP_CHARS + 500, 'doc must be capped (+ short header)')
  assert.match(output.text, /立即继续当前任务/)
  assert.doesNotMatch(output.text, /本轮先按方法论给出计划/)
  assert.deepEqual(armed, [{ sessionId: 'scope-use-skill-dispatch', id: 'ready-human-touch-ppt', name: '网页 PPT · 双风格' }])
})

test('use_skill dispatch: unknown id → structured unknown_skill error (does not throw an infra error)', async () => {
  await assert.rejects(
    () => executeUseSkill(
      { skill_id: 'no-such-skill' },
      { sessionId: 's', listSkills: fakeSkills, readSkillDoc: readReferenceSkillDocCapped, rememberReferenceSkill: () => {} },
    ),
    (err: unknown) => (err as { errorKind?: string }).errorKind === 'unknown_skill',
  )
})

test('use_skill dispatch: missing/blank skill_id → input_validation', async () => {
  await assert.rejects(
    () => executeUseSkill(
      { skill_id: '   ' },
      { sessionId: 's', listSkills: fakeSkills, readSkillDoc: readReferenceSkillDocCapped, rememberReferenceSkill: () => {} },
    ),
    (err: unknown) => (err as { errorKind?: string }).errorKind === 'input_validation',
  )
})

test('use_skill dispatch tells the model to invoke declared local binaries directly', async () => {
  const output = await executeUseSkill(
    { skill_id: 'lark-im' },
    {
      sessionId: 'scope-use-skill-lark-bin',
      listSkills: () => [{
        id: 'lark-im',
        name: 'Lark IM',
        requiredBins: ['lark-cli'],
      }],
      readSkillDoc: () => null,
      rememberReferenceSkill: () => undefined,
    },
  )
  assert.match(output.text, /lark-cli/)
  assert.match(output.text, /不要先套 bash\/sh/)
  assert.deepEqual(output.data?.declaredBins, ['lark-cli'])
})

test('use_skill tool name has no skill_ prefix (must survive filterToolsByAuthorization in mode:none)', () => {
  assert.deepEqual(USE_SKILL_TOOL_NAMES, ['use_skill'])
  assert.ok(!USE_SKILL_TOOL_NAMES[0].startsWith('skill_'))
})

// ─── 2. exposure matrix (real executor) ──────────────────────────────────────

function makeRuntime() {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: () => [],
      buildPreferredSkillToolNames: () => [],
    } as never,
  })
}

function surfaceNames(params: {
  authorization: SkillToolAuthorization
  skillCatalogAvailable?: boolean
}): string[] {
  const runtime = makeRuntime()
  const executor = (runtime as unknown as {
    toolExecutor: { listDefaultToolDefinitionsForTurn: (p: Record<string, unknown>) => Array<{ name: string }> }
  }).toolExecutor
  return executor.listDefaultToolDefinitionsForTurn({
    message: '打个招呼',
    sessionId: 'scope-use-skill-exposure',
    scopeId: 'scope-use-skill-exposure',
    config: BASE_CONFIG,
    browserHostAvailable: true,
    feishuConnected: false,
    authorization: params.authorization,
    skillCatalogAvailable: params.skillCatalogAvailable,
  }).map((d) => d.name)
}

const NONE_AUTH: SkillToolAuthorization = { mode: 'none', reason: 'no_skill_signal' }
const SELECTED_AUTH: SkillToolAuthorization = buildSelectedSkillToolAuthorization({
  skillId: 'ready-human-touch-ppt',
  allowedTypedActions: [],
  allowedPrimitives: ['skill_read_artifact'],
  source: 'explicit',
  reason: 'test',
})

test('use_skill exposure: mode:none + catalog non-empty → use_skill present', () => {
  assert.ok(surfaceNames({ authorization: NONE_AUTH, skillCatalogAvailable: true }).includes('use_skill'))
})

test('use_skill exposure: mode:none + catalog empty → use_skill absent', () => {
  assert.ok(!surfaceNames({ authorization: NONE_AUTH, skillCatalogAvailable: false }).includes('use_skill'))
})

test('use_skill exposure: mode:none + flag absent (legacy callers) → use_skill absent (zero perturbation)', () => {
  assert.ok(!surfaceNames({ authorization: NONE_AUTH }).includes('use_skill'))
})

test('use_skill exposure: mode:selected → use_skill absent (no recursive activation)', () => {
  assert.ok(!surfaceNames({ authorization: SELECTED_AUTH, skillCatalogAvailable: true }).includes('use_skill'))
})

test('use_skill exposure: mode:none + catalog → NO skill_ primitive leaks besides use_skill', () => {
  const names = surfaceNames({ authorization: NONE_AUTH, skillCatalogAvailable: true })
  const leaked = names.filter((n) => n.startsWith('skill_'))
  assert.deepEqual(leaked, [], `mode:none must expose no skill_* primitives; leaked=${leaked.join(',')}`)
})

// ─── 3. activation chain ─────────────────────────────────────────────────────

test('use_skill refreshes authorization and enables the selected skill tool in the same SDK run', async () => {
  const armed: string[] = []
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'ready-human-touch-ppt',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_write_artifact'],
    source: 'active_task',
    reason: 'use_skill_same_run',
  })
  const skillDefinition = {
    name: 'skill_write_artifact',
    description: '写入技能产物',
    groupId: 'skills',
    domain: 'skills',
    schema: { type: 'object', properties: {} },
  }
  const useSkillDefinition = {
    name: 'use_skill',
    description: '激活技能',
    groupId: 'skill_activation',
    domain: 'system',
    schema: {
      type: 'object',
      properties: { skill_id: { type: 'string' } },
      required: ['skill_id'],
    },
  }
  const executor = new AgentSdkToolExecutor({
    executeToolCall: async () => executeUseSkill(
      { skill_id: 'ready-human-touch-ppt' },
      {
        sessionId: 'scope-use-skill-same-run',
        listSkills: fakeSkills,
        readSkillDoc: readReferenceSkillDocCapped,
        rememberReferenceSkill: (_sessionId, info) => armed.push(info.id),
      },
    ),
    sessionManager: { get: () => null },
    browserController: null,
    sidecarManager: null,
    runtime: null,
    runCleanupRegistry: null,
    compactCapturedSession: async () => ({ status: 'not_found', message: 'unused' }),
    resolveMapPlaceAmbiguityIfNeeded: async () => false,
  } as never)
  const runtimeContext: ToolBridgeRuntimeContext = {
    agentName: 'Ready',
    runId: 'run-use-skill-same-run',
    taskId: 'task-use-skill-same-run',
    sessionId: 'scope-use-skill-same-run',
    signal: new AbortController().signal,
    canPublishScopeRunEvent: () => true,
    allowedToolNames: ['use_skill'],
    definitionByName: new Map(),
    authorization: NONE_AUTH,
    activeFrame: createEmptyActiveFrameContext(),
    emitOutput: () => undefined,
    emitToolAction: () => undefined,
    recordToolResult: () => undefined,
    runHandle: {} as never,
    taskBudgetRuntime: null,
  }
  runtimeContext.activateSkillForCurrentRun = (skillId) => {
    if (skillId !== 'ready-human-touch-ppt') return null
    runtimeContext.authorization = selected
    runtimeContext.allowedToolNames.push(skillDefinition.name)
    runtimeContext.definitionByName.set(skillDefinition.name, skillDefinition as never)
    return [skillDefinition as never]
  }

  const latentTool = executor.buildSdkTool(skillDefinition as never, runtimeContext) as unknown as {
    isEnabled: (context?: unknown) => Promise<boolean>
  }
  assert.equal(await latentTool.isEnabled(), false, 'skill tool starts hidden')
  const output = await executor.executeReadyToolDefinition(
    useSkillDefinition as never,
    { skill_id: 'ready-human-touch-ppt' },
    runtimeContext,
  )
  assert.equal(output.data?.activation, 'active_same_run')
  assert.equal(runtimeContext.authorization.mode, 'selected')
  assert.equal(await latentTool.isEnabled(), true, 'next model iteration sees selected skill tool')
  assert.equal(isToolEnabledForCurrentAuthorization('skill_write_artifact', runtimeContext.authorization), true)
  assert.deepEqual(armed, ['ready-human-touch-ppt'])
})

test('use_skill activation hint remains available to a later continuation turn', async () => {
  const sessionId = 'scope-use-skill-activation'
  clearLastReferenceSkill(sessionId)
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('ready-human-touch-ppt')
          ? [{ id: 'ready-human-touch-ppt', name: '网页 PPT · 双风格', managedPath: PPT_ROOT }]
          : [],
      buildPreferredSkillToolNames: () => [],
      getCurrentReferenceSkillHint: (sid?: string) => {
        const hint = getLastReferenceSkill(sid)
        return hint ? { id: hint.id, name: hint.name } : null
      },
    } as never,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string, sessionId?: string, messageVisibilityEpoch?: number,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean, skillHintRelevantForTurn?: boolean,
    ) => SkillToolAuthorization
  }
  try {
    // Simulate use_skill arming the reference hint (the handler calls rememberReferenceSkill).
    await executeUseSkill(
      { skill_id: 'ready-human-touch-ppt' },
      {
        sessionId,
        listSkills: fakeSkills,
        readSkillDoc: readReferenceSkillDocCapped,
        rememberReferenceSkill: rememberLastReferenceSkill,
      },
    )
    // Next turn: no explicit mention in text, but the hint is relevant (continuation) → selected.
    const nextAuth = privateRuntime.resolveSkillAuthorizationForTurn('继续', sessionId, 0, undefined, false, true)
    assert.equal(nextAuth.mode, 'selected', 'armed hint must resolve to selected on the next hint-relevant turn')
    assert.equal(nextAuth.mode === 'selected' ? nextAuth.skillId : null, 'ready-human-touch-ppt')
  } finally {
    clearLastReferenceSkill(sessionId)
  }
})

test('use_skill same-run refresh exposes a declared local CLI without a consent toggle', () => {
  const larkSkill = {
    id: 'lark-im',
    name: 'Lark IM',
    description: 'Search Lark messages',
    managedPath: '/tmp/lark-im',
    requiredBins: ['lark-cli'],
  }
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: BASE_CONFIG, reason: 'present' }),
    domainAdapters: [],
    skillContextOrchestrator: {
      findExplicitlyRequestedSkills: (text: string) =>
        text.includes('lark-im') ? [larkSkill] : [],
      buildPreferredSkillToolNames: () => [],
      getCurrentReferenceSkillHint: () => ({ id: 'lark-im', name: 'Lark IM' }),
    } as never,
  })
  const privateRuntime = runtime as unknown as {
    resolveSkillAuthorizationForTurn: (
      message: string, sessionId?: string, messageVisibilityEpoch?: number,
      requestEnvelope?: unknown,
      forceLocalSendImIntent?: boolean, skillHintRelevantForTurn?: boolean,
    ) => SkillToolAuthorization
  }

  const authorization = privateRuntime.resolveSkillAuthorizationForTurn(
    '继续查询',
    'scope-lark-cli-same-run',
    0,
    undefined,
    false,
    true,
  )
  assert.equal(authorization.mode, 'selected')
  assert.equal(
    authorization.mode === 'selected'
      ? authorization.allowedPrimitives.has('skill_run_shell')
      : false,
    true,
  )
})

// ─── shared doc reader ───────────────────────────────────────────────────────

test('readReferenceSkillDocCapped reads SKILL.md and caps at 12000 chars', () => {
  const doc = readReferenceSkillDocCapped(PPT_ROOT)
  assert.ok(doc && doc.text.length > 0, 'must read the ppt SKILL.md')
  assert.ok((doc?.text.length ?? 0) <= REFERENCE_SKILL_INLINE_CAP_CHARS)
  assert.equal(readReferenceSkillDocCapped('/no/such/path'), null)
})
