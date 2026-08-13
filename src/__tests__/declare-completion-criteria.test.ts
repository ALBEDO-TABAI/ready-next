import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECLARE_CRITERIA_MAX_ITEMS,
  executeDeclareCompletionCriteria,
} from '../main/modules/tools/builtins/declare-completion-criteria'
import { appendModelCriteria } from '../main/modules/agent-control/quality/criteria-templates'
import { __setMetricSinkForTests } from '../main/modules/agent-control/metrics'
import { AGENT_INTERACTION_TOOL_NAMES, getAgentInteractionAnthropicTools, getAgentInteractionOpenAITools } from '../main/modules/tools/agent-interaction-tool-defs'
import { filterSelectedSkillToolSurface } from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('declare-completion-criteria declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'declare-completion-criteria transitive sqlite guard')
})

// D4 合同（2026-07-05-p3-backlog-closeout §1.2）：校验矩阵 / 整组替换 /
// 漂移账本 / 模板不可覆盖 / 双协议曝光面。

function makeDeps() {
  const writes: Array<{ taskId: string; modelCriteria: string[]; expectedOutputs: string[] }> = []
  return {
    writes,
    deps: {
      taskId: 'task-d4',
      sessionId: 'scope-d4',
      updateTaskCompletionDeclaration: (taskId: string, patch: { modelCriteria: string[]; expectedOutputs: string[] }) => {
        writes.push({ taskId, ...patch })
      },
    },
  }
}

test('合法声明写入 projection 并发 model_criteria_declared 账本', async () => {
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => { events.push(event as unknown as Record<string, unknown>) })
  try {
    const { writes, deps } = makeDeps()
    const output = await executeDeclareCompletionCriteria(
      {
        criteria: ['  产物文件已写入并回报绝对路径 ', '三个来源交叉验证过'],
        expected_outputs: ['/Users/user/V/描述.md', '/Users/user/V/深读.md'],
      },
      deps,
    )
    assert.equal(output.data?.ok, true)
    assert.deepEqual(writes, [{
      taskId: 'task-d4',
      modelCriteria: ['产物文件已写入并回报绝对路径', '三个来源交叉验证过'],
      expectedOutputs: ['/Users/user/V/描述.md', '/Users/user/V/深读.md'],
    }])
    const declared = events.filter((event) => event.metric === 'model_criteria_declared')
    assert.equal(declared.length, 1)
    assert.equal(declared[0].count, 2)
    assert.equal(declared[0].taskId, 'task-d4')
    const outputs = events.filter((event) => event.metric === 'expected_outputs_declared')
    assert.equal(outputs.length, 1)
    assert.equal(outputs[0].count, 2)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('校验矩阵：空数组 / 超条数 / 空白条目 / 超长条目 / 无任务上下文', async () => {
  const { writes, deps } = makeDeps()
  assert.equal((await executeDeclareCompletionCriteria({ criteria: [] }, deps)).data?.errorKind, 'input_validation')
  assert.equal(
    (await executeDeclareCompletionCriteria({ criteria: Array.from({ length: DECLARE_CRITERIA_MAX_ITEMS + 1 }, (_, i) => `条目 ${i}`) }, deps)).data?.errorKind,
    'input_validation',
  )
  assert.equal((await executeDeclareCompletionCriteria({ criteria: ['合法', '   '] }, deps)).data?.errorKind, 'input_validation')
  assert.equal((await executeDeclareCompletionCriteria({ criteria: ['长'.repeat(121)] }, deps)).data?.errorKind, 'input_validation')
  assert.equal((await executeDeclareCompletionCriteria({ criteria: ['合法'], expected_outputs: ['x'.repeat(201)] }, deps)).data?.errorKind, 'input_validation')
  assert.equal((await executeDeclareCompletionCriteria({ criteria: ['合法'], expected_outputs: ['/Users/user/V/'] }, deps)).data?.errorKind, 'input_validation')
  assert.equal(writes.length, 0, '校验失败绝不落库')

  const noTask = await executeDeclareCompletionCriteria(
    { criteria: ['合法标准'] },
    { taskId: null, updateTaskCompletionDeclaration: () => { throw new Error('must not write') } },
  )
  assert.equal(noTask.data?.errorKind, 'task_context_missing')
})

test('expected_outputs 空数组与省略字段等价', async () => {
  const { writes, deps } = makeDeps()
  const result = await executeDeclareCompletionCriteria({ criteria: ['合法'], expected_outputs: [] }, deps)
  assert.deepEqual(result.data?.expectedOutputs, [])
  assert.deepEqual(writes, [{ taskId: 'task-d4', modelCriteria: ['合法'], expectedOutputs: [] }])
})

test('重复声明是整组替换（幂等语义由写侧承载）', async () => {
  const { writes, deps } = makeDeps()
  await executeDeclareCompletionCriteria({ criteria: ['第一版标准'] }, deps)
  await executeDeclareCompletionCriteria({ criteria: ['第二版标准 A', '第二版标准 B'] }, deps)
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1], {
    taskId: 'task-d4',
    modelCriteria: ['第二版标准 A', '第二版标准 B'],
    expectedOutputs: [],
  })
})

test('appendModelCriteria 合流：m 命名空间追加、模板项不可覆盖', () => {
  const template = [
    { id: 's1', kind: 'artifact' as const, text: '模板标准', source: 'template' as const },
  ]
  const merged = appendModelCriteria(template, [{ text: '模型补充标准' }, { text: '' }])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].id, 's1')
  assert.equal(merged[0].text, '模板标准', '模板项原样保留')
  assert.equal(merged[1].id, 'm1')
  assert.equal(merged[1].source, 'model')
  assert.equal(merged[1].text, '模型补充标准')
})

test('declare_completion_criteria 在 agent_interaction 双协议曝光面注册', () => {
  assert.ok(AGENT_INTERACTION_TOOL_NAMES.includes('declare_completion_criteria'))
  const anthropicTools = getAgentInteractionAnthropicTools()
  const openaiTools = getAgentInteractionOpenAITools()
  const anthropicNames = anthropicTools.map((tool) => tool.name)
  const openaiNames = openaiTools.map((tool) => (tool.function as { name?: string })?.name)
  assert.ok(anthropicNames.includes('declare_completion_criteria'))
  assert.ok(openaiNames.includes('declare_completion_criteria'))
  const schemas = [
    anthropicTools.find((tool) => tool.name === 'declare_completion_criteria')?.input_schema,
    openaiTools.find((tool) => (
      (tool.function as { name?: string }).name === 'declare_completion_criteria'
    ))?.function.parameters,
  ]
  for (const schema of schemas) {
    const properties = (schema as {
      properties?: Record<string, {
        minItems?: number
        maxItems?: number
        items?: { type?: string; minLength?: number; maxLength?: number }
      }>
    } | undefined)?.properties
    const expectedOutputs = properties?.expected_outputs
    assert.ok(expectedOutputs)
    assert.equal(expectedOutputs.minItems, undefined)
    assert.equal(expectedOutputs.maxItems, 8)
    assert.equal(expectedOutputs.items?.type, 'string')
    assert.equal(expectedOutputs.items?.minLength, 1)
    assert.equal(expectedOutputs.items?.maxLength, 200)
  }
  const description = getAgentInteractionAnthropicTools()
    .find((tool) => tool.name === 'declare_completion_criteria')?.description || ''
  assert.match(description, /单次实时查询、简单搜索/)
})

test('skill-selected 轮保留独立的 declare_completion_criteria 工具面', () => {
  const definitions = [
    { name: 'skill_read_artifact', groupId: 'skills', domain: 'skill' },
    { name: 'declare_completion_criteria', groupId: 'agent_interaction', domain: 'agent' },
    { name: 'ask_user_questions', groupId: 'agent_interaction', domain: 'agent' },
  ] as never
  const filtered = filterSelectedSkillToolSurface(definitions, ['skill_read_artifact'])
  assert.deepEqual(filtered.map((definition) => definition.name), [
    'skill_read_artifact',
    'declare_completion_criteria',
  ])
})
