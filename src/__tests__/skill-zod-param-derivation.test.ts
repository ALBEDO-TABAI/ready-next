/**
 * Verifies zodObjectToParamList reproduces the exact hand-rolled
 * SkillParamDefinition[] currently declared in EXECUTION_TOOL_DEFS, for each
 * of the 6 control tools. When Step 5 rewires params := derivation(schema),
 * this test + the golden-snapshot test together guarantee byte-identical
 * LLM-facing output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import {
  SKILL_CONTROL_SCHEMAS,
  type SkillControlToolName,
} from '../main/modules/tools/schemas/skill-control-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import { EXECUTION_TOOL_DEFS } from '../main/modules/tools/skill-execution-tool-defs'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

function findDef(name: SkillControlToolName): { params: SkillParamDefinition[] } {
  const def = EXECUTION_TOOL_DEFS.find((entry) => entry.name === name)
  assert.ok(def, `missing EXECUTION_TOOL_DEFS entry for ${name}`)
  return def as { params: SkillParamDefinition[] }
}

test('zodObjectToParamList matches skill_get_state legacy params', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_get_state)
  assert.deepEqual(derived, findDef('skill_get_state').params)
})

test('zodObjectToParamList matches skill_submit_input legacy params', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_input)
  assert.deepEqual(derived, findDef('skill_submit_input').params)
})

test('zodObjectToParamList matches skill_submit_confirmation legacy params (union collapses to boolean)', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_confirmation)
  assert.deepEqual(derived, findDef('skill_submit_confirmation').params)
})

test('zodObjectToParamList matches skill_submit_agent_result legacy params', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_submit_agent_result)
  assert.deepEqual(derived, findDef('skill_submit_agent_result').params)
})

test('zodObjectToParamList matches skill_restart_from_step legacy params', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_restart_from_step)
  assert.deepEqual(derived, findDef('skill_restart_from_step').params)
})

test('zodObjectToParamList matches skill_cancel_execution legacy params', () => {
  const derived = zodObjectToParamList(SKILL_CONTROL_SCHEMAS.skill_cancel_execution)
  assert.deepEqual(derived, findDef('skill_cancel_execution').params)
})

test('zodObjectToParamList fails loud when a field lacks .describe()', () => {
  const badSchema = z.object({
    missingDescription: z.string(),
  })
  assert.throws(
    () => zodObjectToParamList(badSchema),
    /missing \.describe\(\)/,
  )
})
