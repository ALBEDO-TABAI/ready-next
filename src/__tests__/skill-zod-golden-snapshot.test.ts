/**
 * Golden snapshot — locks the LLM-facing Anthropic/OpenAI tool JSONSchema for
 * the 6 skill execution-control tools. Committed BEFORE the Zod-driven param
 * derivation change so there is a byte-for-byte regression net.
 *
 * Pure — imports only skill-execution-tool-defs.ts which has no electron deps.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTION_TOOL_DEFS,
  toAnthropicTool,
  toOpenAITool,
} from '../main/modules/tools/skill-execution-tool-defs'

// P0-T2 (B plan Phase 0): 5 of the 6 control tools now prefix their
// description with an ONLY-call guard to stop LLMs from fabricating an
// executionId like "new". `skill_get_state` is read-only and unchanged.
const EXECUTION_CONTROL_ONLY_PREFIX =
  'ONLY call this if a previous skill_* tool returned an explicit executionId. Never fabricate an id like "new" or "0". '

const EXPECTED_ANTHROPIC_TOOLS: Record<string, unknown> = {
  skill_get_state: {
    name: 'skill_get_state',
    description: '读取当前 skill execution 状态、当前 blocker、已完成步骤和最近产物。若不提供 executionId，会优先读取当前会话最近的活跃 execution。',
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: '可选，execution ID' },
        skillId: { type: 'string', description: '可选，限定 skill ID' },
      },
      required: [],
    },
  },
  skill_submit_input: {
    name: 'skill_submit_input',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}向一个被 need_input 阻塞的 execution 提交输入并继续推进。`,
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'execution ID' },
        inputs: { type: 'object', description: '输入对象，例如 {"forceSubtitleMode":"funasr"}', additionalProperties: true },
      },
      required: ['executionId', 'inputs'],
    },
  },
  skill_submit_confirmation: {
    name: 'skill_submit_confirmation',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}提交 confirmation 结果并继续执行 skill workflow。`,
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'execution ID' },
        stepId: { type: 'string', description: '当前 confirmation step ID' },
        confirmed: { type: 'boolean', description: '是否确认继续' },
      },
      required: ['executionId', 'stepId', 'confirmed'],
    },
  },
  skill_submit_agent_result: {
    name: 'skill_submit_agent_result',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}向 need_agent_result 阶段提交 Claude 生成的正文和结构化输出，并继续推进 workflow。`,
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'execution ID' },
        stepId: { type: 'string', description: '当前 agent_task step ID' },
        textContent: { type: 'string', description: '生成的正文内容' },
        outputs: { type: 'object', description: '可选结构化 outputs 对象', additionalProperties: true },
      },
      required: ['executionId', 'stepId'],
    },
  },
  skill_restart_from_step: {
    name: 'skill_restart_from_step',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}从指定 step 重新开始 skill execution，并删除该步及后续步骤的状态与产物。`,
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'execution ID' },
        stepId: { type: 'string', description: '要重跑的 step ID' },
        inputs: { type: 'object', description: '可选，覆盖输入对象', additionalProperties: true },
      },
      required: ['executionId', 'stepId'],
    },
  },
  skill_cancel_execution: {
    name: 'skill_cancel_execution',
    description: `${EXECUTION_CONTROL_ONLY_PREFIX}取消一个正在进行的 skill execution。`,
    input_schema: {
      type: 'object',
      properties: {
        executionId: { type: 'string', description: 'execution ID' },
      },
      required: ['executionId'],
    },
  },
}

test('EXECUTION_TOOL_DEFS covers exactly the 6 control tool names', () => {
  const names = EXECUTION_TOOL_DEFS.map((def) => def.name).sort()
  assert.deepEqual(names, [
    'skill_cancel_execution',
    'skill_get_state',
    'skill_restart_from_step',
    'skill_submit_agent_result',
    'skill_submit_confirmation',
    'skill_submit_input',
  ])
})

test('toAnthropicTool produces the locked LLM-facing Anthropic schema for all 6 control tools', () => {
  for (const def of EXECUTION_TOOL_DEFS) {
    const actual = toAnthropicTool(def)
    const expected = EXPECTED_ANTHROPIC_TOOLS[def.name]
    assert.deepEqual(
      actual,
      expected,
      `${def.name} Anthropic schema drifted — expected ${JSON.stringify(expected, null, 2)}\n  got ${JSON.stringify(actual, null, 2)}`,
    )
  }
})

test('toOpenAITool wraps the same shape under { type: function, function: { name, description, parameters } }', () => {
  for (const def of EXECUTION_TOOL_DEFS) {
    const anthropic = EXPECTED_ANTHROPIC_TOOLS[def.name] as {
      name: string
      description: string
      input_schema: Record<string, unknown>
    }
    const openaiExpected = {
      type: 'function',
      function: {
        name: anthropic.name,
        description: anthropic.description,
        parameters: anthropic.input_schema,
      },
    }
    const actual = toOpenAITool(def)
    assert.deepEqual(
      actual,
      openaiExpected,
      `${def.name} OpenAI schema drifted — expected ${JSON.stringify(openaiExpected, null, 2)}\n  got ${JSON.stringify(actual, null, 2)}`,
    )
  }
})

// Patch A3 — the OpenAI snapshot already covers description byte-equality via
// deepEqual above, but we add an explicit substring check so a future
// "helpful" refactor that drops the ONLY prefix from the OpenAI wire format
// (while leaving Anthropic intact) would fail loudly here rather than hiding
// in diffing noise.
test('toOpenAITool preserves ONLY-call prefix on the 5 gated tools (OpenAI wire)', () => {
  const gated = [
    'skill_submit_input',
    'skill_submit_confirmation',
    'skill_submit_agent_result',
    'skill_restart_from_step',
    'skill_cancel_execution',
  ]
  for (const name of gated) {
    const def = EXECUTION_TOOL_DEFS.find((d) => d.name === name)
    assert.ok(def, `expected ${name} in EXECUTION_TOOL_DEFS`)
    const openai = toOpenAITool(def!) as { function: { description: string } }
    assert.ok(
      openai.function.description.startsWith(EXECUTION_CONTROL_ONLY_PREFIX),
      `${name} OpenAI description is missing the ONLY-call prefix: ${openai.function.description.slice(0, 80)}…`,
    )
  }
  // Read-only tool must NOT carry the prefix.
  const getStateDef = EXECUTION_TOOL_DEFS.find((d) => d.name === 'skill_get_state')!
  const getStateOpenai = toOpenAITool(getStateDef) as { function: { description: string } }
  assert.ok(
    !getStateOpenai.function.description.startsWith(EXECUTION_CONTROL_ONLY_PREFIX),
    'skill_get_state must remain unprefixed — it is a safe read',
  )
})
