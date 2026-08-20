/**
 * Golden snapshot — locks the LLM-facing Anthropic/OpenAI tool JSONSchema
 * for the current skill primitives (skill_ask_user / skill_run_shell /
 * artifact / config / detached-run / context compact tools). Replaces the B Phase 0
 * 6-control-tool snapshot after Phase 4 PR2 retired the state machine.
 *
 * Pure — imports only skill-tool-types + skill-primitives/tool-defs, no
 * electron deps.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { toAnthropicTool, toOpenAITool } from '../main/modules/tools/skill-tool-types'
import { PRIMITIVE_TOOL_DEFS } from '../main/modules/tools/skill-primitives/tool-defs'

test('PRIMITIVE_TOOL_DEFS covers exactly the primitive names with kind=primitive', () => {
  const names = PRIMITIVE_TOOL_DEFS.map((def) => def.name).sort()
  assert.deepEqual(names, [
    'skill_ask_user',
    'skill_cancel_detached',
    'skill_compact_context',
    'skill_export_artifact',
    'skill_inspect_detached',
    'skill_inspect_run_state',
    'skill_patch_config',
    'skill_read_artifact',
    'skill_run_shell',
    'skill_start_detached',
    'skill_write_artifact',
  ])
  for (const def of PRIMITIVE_TOOL_DEFS) {
    assert.equal(
      def.kind,
      'primitive',
      `${def.name}.kind should be 'primitive' post-Phase 4 PR2 (was 'execution_control')`,
    )
  }
})

test('toAnthropicTool produces { name, description, input_schema: { type, properties, required } } for each primitive', () => {
  for (const def of PRIMITIVE_TOOL_DEFS) {
    const actual = toAnthropicTool(def) as {
      name: string
      description: string
      input_schema: {
        type: 'object'
        properties: Record<string, unknown>
        required: string[]
      }
    }
    assert.equal(actual.name, def.name)
    assert.equal(actual.description, def.description)
    assert.equal(actual.input_schema.type, 'object')
    assert.ok(actual.input_schema.properties && typeof actual.input_schema.properties === 'object')
    assert.ok(Array.isArray(actual.input_schema.required))
    // Required param names must be a subset of declared properties.
    for (const reqName of actual.input_schema.required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(actual.input_schema.properties, reqName),
        `${def.name}: required param "${reqName}" missing from input_schema.properties`,
      )
    }
  }
})

test('toOpenAITool wraps the Anthropic shape under { type: function, function: { name, description, parameters } }', () => {
  for (const def of PRIMITIVE_TOOL_DEFS) {
    const anthropic = toAnthropicTool(def) as {
      name: string
      description: string
      input_schema: Record<string, unknown>
    }
    const actual = toOpenAITool(def) as {
      type: string
      function: { name: string; description: string; parameters: Record<string, unknown> }
    }
    assert.equal(actual.type, 'function')
    assert.equal(actual.function.name, anthropic.name)
    assert.equal(actual.function.description, anthropic.description)
    assert.deepEqual(actual.function.parameters, anthropic.input_schema)
  }
})

test('skill_run_shell advertises command as required + sandboxing intent in description', () => {
  const def = PRIMITIVE_TOOL_DEFS.find((d) => d.name === 'skill_run_shell')
  assert.ok(def, 'skill_run_shell must be in PRIMITIVE_TOOL_DEFS')
  const anthropic = toAnthropicTool(def!) as {
    description: string
    input_schema: { required: string[] }
  }
  assert.ok(anthropic.input_schema.required.includes('command'))
  // Allowlist and sandbox intent must survive description refactors; missing
  // these substrings historically correlated with the LLM forgetting to
  // short-circuit on disallowed bins.
  assert.match(anthropic.description, /技能沙箱内/)
  assert.match(anthropic.description, /白名单/)
})

test('skill_write_artifact advertises relativePath + content as required + reserved-file intent', () => {
  const def = PRIMITIVE_TOOL_DEFS.find((d) => d.name === 'skill_write_artifact')
  assert.ok(def, 'skill_write_artifact must be in PRIMITIVE_TOOL_DEFS')
  const anthropic = toAnthropicTool(def!) as {
    description: string
    input_schema: { required: string[] }
  }
  assert.ok(anthropic.input_schema.required.includes('relativePath'))
  assert.ok(anthropic.input_schema.required.includes('content'))
  assert.match(anthropic.description, /相对文件路径/)
  assert.match(anthropic.description, /expectedVersion=empty/)
})

test('skill_ask_user advertises question as required + suspend-semantics in description', () => {
  const def = PRIMITIVE_TOOL_DEFS.find((d) => d.name === 'skill_ask_user')
  assert.ok(def, 'skill_ask_user must be in PRIMITIVE_TOOL_DEFS')
  const anthropic = toAnthropicTool(def!) as {
    description: string
    input_schema: { required: string[] }
  }
  assert.ok(anthropic.input_schema.required.includes('question'))
  assert.match(anthropic.description, /暂停当前 skill/)
  assert.match(anthropic.description, /ask_user_questions/)
  assert.match(anthropic.description, /多个问题/)
})
