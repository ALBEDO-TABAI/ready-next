import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildAgentSystemStudioSnapshot } from '../main/modules/agent-control/agents/specialist-studio-read-model'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import {
  executeProposeSpecialistBlueprint,
  proposeSpecialistBlueprintSchema,
  type ProposeSpecialistBlueprintArgs,
} from '../main/modules/tools/builtins/propose-specialist-blueprint'
import { serializeToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
} from '../main/modules/agent-control/tools-runtime/tool-registry'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import {
  getAgentInteractionAnthropicTools,
  getAgentInteractionOpenAITools,
} from '../main/modules/tools/agent-interaction-tool-defs'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('propose-specialist-blueprint-tool declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'propose-specialist-blueprint-tool transitive sqlite load')
})

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function makeRegistry(rows = new Map<string, AgentRegistryRecord>()) {
  return {
    rows,
    get: (id: string) => rows.get(id) ?? null,
    list: () => [...rows.values()],
  }
}

type JsonSchemaObject = {
  properties?: Record<string, unknown>
  required?: string[]
  maxItems?: number
}

function backendRequiredTopLevelKeys(): string[] {
  const result = proposeSpecialistBlueprintSchema.safeParse({})
  if (result.success) {
    assert.fail('empty propose_specialist_blueprint args must not satisfy backend schema')
  }
  return [...new Set(result.error.issues
    .filter((issue) => issue.path.length === 1)
    .map((issue) => String(issue.path[0])))]
    .sort()
}

function getAnthropicProposeSpecialistBlueprintSchema(): JsonSchemaObject {
  const tool = getAgentInteractionAnthropicTools()
    .find((candidate) => candidate.name === 'propose_specialist_blueprint')
  assert.ok(tool, 'Anthropic propose_specialist_blueprint tool must be registered')
  return tool.input_schema as JsonSchemaObject
}

function getOpenAIProposeSpecialistBlueprintSchema(): JsonSchemaObject {
  const tool = getAgentInteractionOpenAITools()
    .find((candidate) => {
      const fn = candidate.function as { name?: string } | undefined
      return fn?.name === 'propose_specialist_blueprint'
    })
  assert.ok(tool, 'OpenAI propose_specialist_blueprint tool must be registered')
  const fn = tool.function as { parameters?: JsonSchemaObject } | undefined
  return fn?.parameters as JsonSchemaObject
}

function getProposeSpecialistBlueprintDescriptions(): string[] {
  const anthropicTool = getAgentInteractionAnthropicTools()
    .find((candidate) => candidate.name === 'propose_specialist_blueprint')
  assert.ok(anthropicTool, 'Anthropic propose_specialist_blueprint tool must be registered')
  const openAITool = getAgentInteractionOpenAITools()
    .find((candidate) => {
      const fn = candidate.function as { name?: string } | undefined
      return fn?.name === 'propose_specialist_blueprint'
    })
  assert.ok(openAITool, 'OpenAI propose_specialist_blueprint tool must be registered')
  const openAIFunction = openAITool.function as { description?: string } | undefined
  return [
    String(anthropicTool.description || ''),
    String(openAIFunction?.description || ''),
  ]
}

function args(overrides: Partial<ProposeSpecialistBlueprintArgs> = {}): ProposeSpecialistBlueprintArgs {
  return {
    specialist_id: 'Visual Researcher',
    display_name: '视觉研究专项 Agent',
    charter: '负责为视觉创作任务整理参考、提炼风格边界，并输出带引用的研究结论。',
    intended_domain: '视觉参考研究',
    role_persona: '以视觉研究员的姿态工作，先界定风格问题，再整理证据和判断边界。',
    non_goals: ['不直接外发文件', '不替代主 agent 做最终决策'],
    recurring_tasks: ['整理视觉参考', '比较风格方向'],
    required_inputs: ['目标主题', '参考来源或约束'],
    expected_outputs: ['参考清单', '风格边界建议'],
    suitable_task_examples: ['整理一组参考图并提炼风格方向'],
    unsuitable_task_examples: ['直接代表用户发布内容或外发文件'],
    main_vs_specialist_split: '主 agent 负责理解用户目标和最终取舍，视觉研究专项 agent 负责重复性的参考整理与风格判断。',
    routing_triggers: ['视觉研究', '参考整理'],
    seed_rules_text: '# 视觉研究专项 Agent\n- 保留来源引用。\n- 先收敛范围再输出。',
    knowledge_seeds: [{ title: '引用要求', body: '所有参考结论都要保留来源。', evidence_refs: ['user:0'] }],
    tool_boundaries: {
      browser: { mode: 'confirm', notes: '需要浏览网页采集参考时先说明目标和来源范围。' },
      write: { mode: 'confirm', notes: '写入文件或长期资产前必须确认路径、内容和用途。' },
      external_send: { mode: 'deny', notes: '不代表用户外发消息、上传文件或联系第三方。' },
      long_memory: { mode: 'confirm', notes: '长期记忆只记录用户确认过的稳定偏好、规则和证据。' },
    },
    tool_safety_notes: '外发、下载和浏览器写操作必须等待用户确认。',
    memory_profile_policy: '只使用当前任务资料和用户确认的长期偏好，不把临时猜测写入用户画像。',
    lifecycle_notes: '当触发词失效、职责重叠或长期不用时，需要用户确认后更新、合并或退休。',
    user_request_verbatim: '我要一个视觉研究类型的专项 agent',
    ...overrides,
  }
}

test('propose_specialist_blueprint schema is registered for dispatch validation', () => {
  const schema = resolveToolInputSchemaForExecution('propose_specialist_blueprint')
  assert.strictEqual(schema, proposeSpecialistBlueprintSchema)
  assert.equal(schema?.safeParse(args()).success, true)
  assert.equal(schema?.safeParse({}).success, false)
})

test('propose_specialist_blueprint executes in agent_interaction domain', () => {
  const tag = getToolResourceTag('propose_specialist_blueprint')
  assert.deepEqual(tag, { domain: 'agent_interaction', accessMode: 'interactive' })

  const definition = defaultToolRegistry.getToolDefinitionForExecution('propose_specialist_blueprint')
  assert.equal(definition?.groupId, 'agent_interaction')
  assert.equal(definition?.domain, 'agent_interaction')
  assert.notEqual(definition?.domain, 'system')
})

test('model-visible propose_specialist_blueprint schemas expose backend-required fields', () => {
  const requiredKeys = backendRequiredTopLevelKeys()
  const schemas = [
    getAnthropicProposeSpecialistBlueprintSchema(),
    getOpenAIProposeSpecialistBlueprintSchema(),
  ]

  for (const schema of schemas) {
    assert.deepEqual([...(schema.required || [])].sort(), requiredKeys)
    for (const key of requiredKeys) {
      assert.ok(schema.properties?.[key], `model-visible schema must expose ${key}`)
    }
    assert.ok(schema.properties?.knowledge_seeds, 'optional knowledge_seeds should remain model-visible')
    assert.equal(schema.required?.includes('knowledge_seeds'), false)
    const routingTriggers = schema.properties?.routing_triggers as JsonSchemaObject | undefined
    assert.equal(routingTriggers?.maxItems, 8, 'model-visible routing_triggers must mirror backend maxItems')

    const toolBoundaries = schema.properties?.tool_boundaries as JsonSchemaObject | undefined
    assert.ok(toolBoundaries?.properties, 'tool_boundaries must expose nested boundaries')
    assert.deepEqual([...(toolBoundaries.required || [])].sort(), [
      'browser',
      'external_send',
      'long_memory',
      'write',
    ])
    for (const key of ['browser', 'write', 'external_send', 'long_memory']) {
      const boundary = toolBoundaries.properties[key] as JsonSchemaObject | undefined
      assert.deepEqual(boundary?.required, ['mode', 'notes'])
    }
  }
})

test('model-visible specialist blueprint tool requires professional interview for type-label requests', () => {
  for (const description of getProposeSpecialistBlueprintDescriptions()) {
    assert.match(description, /专业访谈纪律/)
    assert.match(description, /只给出类型名/)
    assert.match(description, /先调用 ask_user_questions/)
    assert.match(description, /最多三问/)
    assert.match(description, /长期服务的工作对象\/场景/)
    assert.match(description, /一次做好怎样算完成/)
    assert.match(description, /最重要的输出样式/)
    assert.match(description, /主 agent 保留什么判断/)
    assert.match(description, /适合或不适合交给它/)
    assert.match(description, /初始知识\/证据来源/)
    assert.match(description, /浏览器\/写入\/外发\/长期记忆/)
    assert.match(description, /workScope、boundaryExamples、inputsKnowledgeTools/)
    assert.match(description, /不要把它们合成一道大作文题/)
    assert.match(description, /P8g-9c foundation pack/)
    assert.match(description, /charter、RULES、FOUNDATION、role persona、memory\/profile policy、tool boundaries、routing triggers 和 lifecycle/)
    assert.match(description, /原始 user_request_verbatim/)
  }
})

test('executeProposeSpecialistBlueprint stores a staged blueprint without creating or activating an agent', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    sessionId: 'session-blueprint',
    runId: 'run-blueprint',
    currentUserText: '我要一个视觉研究类型的专项 agent',
    now: () => new Date('2026-06-19T00:00:00.000Z'),
  })

  assert.equal(output.data?.status, 'staged')
  assert.equal(output.data?.createdAgent, false)
  assert.equal(output.data?.routingActivated, false)

  const stored = store.get('bp-visual-researcher')
  assert.ok(stored)
  assert.equal(stored?.specialistId, 'visual-researcher')
  assert.equal(stored?.routingActivateOnCreate, false)
  assert.equal(stored?.source, 'conversation')
  assert.equal(stored?.userRequestVerbatim, '我要一个视觉研究类型的专项 agent')
  assert.equal(stored?.provenance.sourceSessionId, 'session-blueprint')
  assert.equal(stored?.provenance.sourceMessageId, null)
  assert.equal(stored?.provenance.sourceMessageUnavailableReason, 'message_id_unavailable')
  assert.equal(stored?.provenance.createdAt, '2026-06-19T00:00:00.000Z')
})

test('executeProposeSpecialistBlueprint clamps overlong model lists instead of rejecting the draft', async () => {
  const store = new SpecialistBlueprintStore()
  const routingTriggers = [
    '视觉研究',
    '参考整理',
    '风格方向',
    '参考图',
    '素材归纳',
    '视觉对标',
    '灵感板',
    '构图参考',
    '色彩参考',
    '版式参考',
  ]

  const output = await executeProposeSpecialistBlueprint(args({ routing_triggers: routingTriggers }), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'staged')
  const stored = store.get('bp-visual-researcher')
  assert.deepEqual(stored?.routingTriggers, routingTriggers.slice(0, 8))
})

test('executeProposeSpecialistBlueprint returns a professional interview contract for broad type-label gaps', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args({
    non_goals: [],
    recurring_tasks: [],
    required_inputs: [],
    expected_outputs: [],
  }), {
    blueprintStore: store,
    registry: makeRegistry(),
    sessionId: 'session-blueprint',
    runId: 'run-blueprint',
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'needs_clarification')
  assert.equal(output.interactionHint, 'awaiting_clarification')
  const clarification = output.data?.clarification as {
    nextTool?: string
    afterAnswerTool?: string
    contractKind?: string
    version?: string
    questions?: Array<{ id: string; question: string }>
    askUserQuestionsArgs?: { questions?: Array<{ id: string }> }
  }
  assert.equal(clarification.nextTool, 'ask_user_questions')
  assert.equal(clarification.afterAnswerTool, 'propose_specialist_blueprint')
  assert.equal(clarification.contractKind, 'professional_interview')
  assert.equal(clarification.version, 'p8g-9b.v1')
  assert.deepEqual(clarification.questions?.map((question) => question.id), [
    'workScope',
    'boundaryExamples',
    'inputsKnowledgeTools',
  ])

  const modelVisible = serializeToolExecutionOutput(output)
  assert.match(modelVisible, /ask_user_questions/)
  assert.match(modelVisible, /propose_specialist_blueprint/)
  assert.match(modelVisible, /专业访谈/)
  const jsonLine = modelVisible.split('\n').find((line) => line.trim().startsWith('{"questions"'))
  assert.ok(jsonLine)
  assert.deepEqual(JSON.parse(jsonLine).questions.map((question: { id: string }) => question.id), [
    'workScope',
    'boundaryExamples',
    'inputsKnowledgeTools',
  ])
})

test('executeProposeSpecialistBlueprint turns semantic blocks into clarification instead of staged create', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    sessionId: 'session-blueprint',
    runId: 'run-blueprint',
    currentUserText: '我要一个视觉研究类型的专项 agent',
    runSemanticFoundationJudge: async () => ({
      issues: [{
        id: 'scope_too_generic',
        message: '职责范围仍然过泛。',
      }],
    }),
  })

  assert.equal(output.data?.status, 'needs_clarification')
  assert.equal(output.interactionHint, 'awaiting_clarification')
  assert.deepEqual((output.data?.verdict as { kind: string; missing: string[] }).missing, ['scope_too_generic'])
  const stored = store.get('bp-visual-researcher')
  assert.equal(stored?.status, 'needs_clarification')
  assert.equal(stored?.semanticReview?.status, 'blocked')
  assert.equal((output.data?.clarification as { questions?: Array<{ id: string }> }).questions?.[0]?.id, 'charter')
})

test('executeProposeSpecialistBlueprint stores unavailable semantic review without treating it as pass', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'staged')
  const stored = store.get('bp-visual-researcher')
  assert.equal(stored?.semanticReview?.status, 'unavailable')
  assert.equal(stored?.semanticReview?.source, 'not_available')
})

test('executeProposeSpecialistBlueprint persists real source message provenance when provided', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    sourceMessageId: 'message-source-1',
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'staged')
  const stored = store.get('bp-visual-researcher')
  assert.equal(stored?.provenance.sourceMessageId, 'message-source-1')
  assert.equal(stored?.provenance.sourceMessageUnavailableReason, null)
})

test('executeProposeSpecialistBlueprint carries production judge unavailable reason', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
    semanticFoundationJudgeUnavailableReason: 'production_judge_not_configured',
  })

  assert.equal(output.data?.status, 'staged')
  assert.equal(store.get('bp-visual-researcher')?.semanticReview?.status, 'unavailable')
  assert.equal(store.get('bp-visual-researcher')?.semanticReview?.unavailableReason, 'production_judge_not_configured')
})

test('executeProposeSpecialistBlueprint records source-message unavailable reason when id is absent', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
    sourceMessageUnavailableReason: 'request_envelope_missing_message_id',
  })

  assert.equal(output.data?.status, 'staged')
  const stored = store.get('bp-visual-researcher')
  assert.equal(stored?.provenance.sourceMessageId, null)
  assert.equal(stored?.provenance.sourceMessageUnavailableReason, 'request_envelope_missing_message_id')
})

test('executeProposeSpecialistBlueprint lets a clarified re-proposal overwrite an unconfirmed draft as staged', async () => {
  const store = new SpecialistBlueprintStore()
  const deps = {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
  }

  const first = await executeProposeSpecialistBlueprint(args({
    non_goals: [],
    recurring_tasks: [],
    required_inputs: [],
    expected_outputs: [],
  }), deps)
  assert.equal(first.data?.status, 'needs_clarification')
  assert.equal(store.get('bp-visual-researcher')?.status, 'needs_clarification')

  const second = await executeProposeSpecialistBlueprint(args(), deps)
  assert.equal(second.data?.status, 'staged')
  const stored = store.get('bp-visual-researcher')
  assert.equal(stored?.status, 'staged')
  assert.equal(stored?.admissionVerdict.kind, 'admit')
  assert.equal(stored?.clarificationAnswers.length, 0)
})

test('executeProposeSpecialistBlueprint rejects overwriting a confirmed blueprint', async () => {
  const store = new SpecialistBlueprintStore()
  const deps = {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
  }

  const first = await executeProposeSpecialistBlueprint(args(), deps)
  assert.equal(first.data?.status, 'staged')
  store.patch('bp-visual-researcher', { status: 'confirmed' })

  const second = await executeProposeSpecialistBlueprint(args(), deps)
  assert.equal(second.text, '专项 agent 蓝图未保存：已确认的蓝图不能被对话工具覆盖。')
  assert.equal(second.data?.errorKind, SPECIALIST_BLUEPRINT_ERROR_KINDS.confirmedBlueprintImmutable.code)
  assert.equal(second.data?.blueprintId, 'bp-visual-researcher')
  assert.equal(store.get('bp-visual-researcher')?.status, 'confirmed')
})

test('executeProposeSpecialistBlueprint accepts natural soft creation phrasing', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args({
    user_request_verbatim: '我想要一个视觉研究类型的专项 agent',
  }), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我想要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'staged')
  assert.equal(output.data?.verdict && (output.data.verdict as { kind?: string }).kind, 'admit')
})

test('executeProposeSpecialistBlueprint rejects rewritten user_request_verbatim without storing', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args({
    user_request_verbatim: '用户想创建一个视觉研究 agent',
  }), {
    blueprintStore: store,
    registry: makeRegistry(),
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.errorKind, 'verbatim_mismatch')
  assert.equal(store.list().length, 0)
})

test('executeProposeSpecialistBlueprint rejects missing current user text without storing', async () => {
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args(), {
    blueprintStore: store,
    registry: makeRegistry(),
  })

  assert.equal(output.data?.errorKind, 'verbatim_source_unavailable')
  assert.equal(store.list().length, 0)
})

test('tool-executor dispatches propose_specialist_blueprint before ask_user_questions fallback', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const branchIndex = source.indexOf("toolName === 'propose_specialist_blueprint'")
  const fallbackIndex = source.indexOf('return executeAskUserQuestions', branchIndex)
  assert.ok(branchIndex > -1, 'tool-executor must branch on propose_specialist_blueprint')
  assert.ok(fallbackIndex > -1, 'tool-executor must keep ask_user_questions fallback')
  assert.ok(branchIndex < fallbackIndex, 'propose_specialist_blueprint must not fall through to ask_user_questions')
  assert.match(source, /executeProposeSpecialistBlueprint\([\s\S]*blueprintStore:\s*getSpecialistBlueprintStore\(\)/)
  assert.match(source, /resolveSpecialistFoundationSemanticJudge\(\)/)
  assert.doesNotMatch(source, /sourceMessageId:\s*null/)
  assert.match(source, /sourceMessageUnavailableReason/)
})

test('shared blueprint store output is visible to Studio snapshot', async () => {
  const slug = `visual-researcher-dispatch-${Date.now()}`
  const store = new SpecialistBlueprintStore()
  const output = await executeProposeSpecialistBlueprint(args({
    specialist_id: slug,
    user_request_verbatim: '我要一个视觉研究类型的专项 agent',
  }), {
    blueprintStore: store,
    registry: makeRegistry(),
    sessionId: 'session-dispatch-blueprint',
    runId: 'run-dispatch-blueprint',
    currentUserText: '我要一个视觉研究类型的专项 agent',
  })

  assert.equal(output.data?.status, 'staged')
  const stored = store.get(`bp-${slug}`)
  assert.ok(stored)

  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-studio-blueprint-'))
  try {
    const snapshot = buildAgentSystemStudioSnapshot({
      agents: [],
      store: new BeliefCardStore({ memoryRoot: root }),
      listOwnedTasks: () => [],
      stagedBlueprints: store.list(['staged']),
      now: new Date('2026-06-19T00:00:00.000Z'),
    })
    assert.ok(snapshot.stagedBlueprints.some((blueprint) => blueprint.blueprintId === `bp-${slug}`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
