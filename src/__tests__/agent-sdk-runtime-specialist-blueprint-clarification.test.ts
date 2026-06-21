import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import type { AgentRegistryRecord } from '../main/modules/repositories/agent-registry-repository'
import {
  executeProposeSpecialistBlueprint,
  type ProposeSpecialistBlueprintArgs,
} from '../main/modules/tools/builtins/propose-specialist-blueprint'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('agent sdk specialist clarification loop declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent sdk specialist clarification loop transitive sqlite load')
})

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    ...deps,
  })
}

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    groupId: 'agent_interaction',
    domain: 'agent_interaction',
    kind: 'write',
    concurrency: 'serial',
    interruptBehavior: 'none',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: false },
    description: name,
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function makeRegistry(rows = new Map<string, AgentRegistryRecord>()) {
  return {
    rows,
    get: (id: string) => rows.get(id) ?? null,
    list: () => [...rows.values()],
  }
}

function blueprintArgs(overrides: Partial<ProposeSpecialistBlueprintArgs> = {}): ProposeSpecialistBlueprintArgs {
  return {
    specialist_id: 'visual-researcher',
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
    user_request_verbatim: '我想要一个视觉研究类型的专项 agent',
    ...overrides,
  }
}

function toolCall(tool: string, args: Record<string, unknown>): string {
  return [
    ':::tool_call',
    JSON.stringify({ tool, args }),
    ':::',
  ].join('\n')
}

test('agent sdk runtime can continue from specialist blueprint clarification to ask_user_questions and re-propose', async () => {
  const blueprintStore = new SpecialistBlueprintStore()
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  let runCount = 0
  const runtime = createRuntime({
    listToolDefinitions: () => [
      createToolDefinition('propose_specialist_blueprint'),
      createToolDefinition('ask_user_questions'),
    ],
    executeToolCall: async (toolName, args, context) => {
      calls.push({ toolName, args })
      if (toolName === 'propose_specialist_blueprint') {
        return executeProposeSpecialistBlueprint(args as ProposeSpecialistBlueprintArgs, {
          blueprintStore,
          registry: makeRegistry(),
          sessionId: 'session-specialist-loop',
          runId: 'run-specialist-loop',
          sourceMessageId: context.sourceMessageId ?? null,
          sourceMessageUnavailableReason: context.sourceMessageUnavailableReason ?? null,
          currentUserText: '我想要一个视觉研究类型的专项 agent',
        })
      }
      if (toolName === 'ask_user_questions') {
        assert.ok(Array.isArray(args.questions))
        assert.deepEqual((args.questions as Array<{ id: string }>).map((question) => question.id), [
          'nonGoals',
          'recurringTasks',
          'requiredInputs',
        ])
        return createToolExecutionOutput('用户回答了 3/3 个问题。', {
          shape: 'json',
          data: {
            answers: [
              { id: 'nonGoals', answer: '不外发文件；不替代主 agent 做最终决策' },
              { id: 'recurringTasks', answer: '整理视觉参考；比较风格方向' },
              { id: 'requiredInputs', answer: '目标主题；参考来源或约束' },
            ],
          },
        })
      }
      throw new Error(`unexpected tool: ${toolName}`)
    },
    runAgent: async ({ input, onTextDelta }) => {
      runCount += 1
      const inputText = String(input)
      if (runCount === 1) {
        const call = toolCall('propose_specialist_blueprint', blueprintArgs({
          non_goals: [],
          recurring_tasks: [],
          required_inputs: [],
          expected_outputs: [],
        }))
        onTextDelta(call)
        return { finalText: call }
      }
      if (runCount === 2) {
        assert.match(inputText, /ask_user_questions/)
        assert.match(inputText, /propose_specialist_blueprint/)
        const call = toolCall('ask_user_questions', {
          questions: [
            { id: 'nonGoals', question: '这个专项 agent 明确不该做哪些事？', kind: 'free_text', required: true },
            { id: 'recurringTasks', question: '它会反复处理哪几类任务？', kind: 'free_text', required: true },
            { id: 'requiredInputs', question: '它开始工作前通常需要哪些输入？', kind: 'free_text', required: true },
          ],
        })
        onTextDelta(call)
        return { finalText: call }
      }
      if (runCount === 3) {
        assert.match(inputText, /用户回答了 3\/3 个问题/)
        const call = toolCall('propose_specialist_blueprint', blueprintArgs())
        onTextDelta(call)
        return { finalText: call }
      }
      throw new Error(`unexpected extra model turn: ${runCount}`)
    },
  })
  runtime.newSession('butler::scope-specialist-loop', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-specialist-loop',
    '我想要一个视觉研究类型的专项 agent',
    'run-specialist-loop',
    {
      publicSessionId: 'scope-specialist-loop',
      taskId: 'task-specialist-loop',
      sourceMessageId: 'message-specialist-loop',
    },
  )

  assert.equal(result.success, true)
  assert.equal(runCount, 3)
  assert.deepEqual(calls.map((call) => call.toolName), [
    'propose_specialist_blueprint',
    'ask_user_questions',
    'propose_specialist_blueprint',
  ])
  assert.deepEqual(result.usedTools, [
    'propose_specialist_blueprint',
    'ask_user_questions',
    'propose_specialist_blueprint',
  ])
  assert.equal(blueprintStore.get('bp-visual-researcher')?.status, 'staged')
  assert.equal(blueprintStore.get('bp-visual-researcher')?.provenance.sourceMessageId, 'message-specialist-loop')
  assert.equal(blueprintStore.get('bp-visual-researcher')?.provenance.sourceMessageUnavailableReason, null)
})

test('agent sdk runtime does not trust requestEnvelope message ids as source provenance', async () => {
  const runtime = createRuntime({
    listToolDefinitions: () => [
      createToolDefinition('propose_specialist_blueprint'),
    ],
    executeToolCall: async (toolName, _args, context) => {
      assert.equal(toolName, 'propose_specialist_blueprint')
      assert.equal(context.sourceMessageId, null)
      assert.equal(context.sourceMessageUnavailableReason, 'request_envelope_missing_message_id')
      return createToolExecutionOutput('ok', { shape: 'json', data: { ok: true } })
    },
    runAgent: async ({ onTextDelta }) => {
      const call = toolCall('propose_specialist_blueprint', blueprintArgs())
      onTextDelta(call)
      return { finalText: call }
    },
  })
  runtime.newSession('butler::scope-spoofed-envelope', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-spoofed-envelope',
    '我想要一个视觉研究类型的专项 agent',
    'run-spoofed-envelope',
    {
      publicSessionId: 'scope-spoofed-envelope',
      taskId: 'task-spoofed-envelope',
      requestEnvelope: {
        sourceMessageId: 'spoofed-message-id',
      },
    },
  )

  assert.equal(result.success, true)
})
