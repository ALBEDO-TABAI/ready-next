/**
 * Shape tests for the 6 skill control tool schemas (Phase 2 pilot).
 * Pure — no electron, no skills-tools.ts import.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_CONTROL_SCHEMAS,
  SkillCancelExecutionSchema,
  SkillGetStateSchema,
  SkillRestartFromStepSchema,
  SkillSubmitAgentResultSchema,
  SkillSubmitConfirmationSchema,
  SkillSubmitInputSchema,
} from '../main/modules/tools/schemas/skill-control-schemas'

test('SKILL_CONTROL_SCHEMAS registers exactly the 6 control tool names', () => {
  assert.deepEqual(
    Object.keys(SKILL_CONTROL_SCHEMAS).sort(),
    [
      'skill_cancel_execution',
      'skill_get_state',
      'skill_restart_from_step',
      'skill_submit_agent_result',
      'skill_submit_confirmation',
      'skill_submit_input',
    ],
  )
})

test('SkillGetStateSchema treats both fields as optional (empty args OK)', () => {
  const ok = SkillGetStateSchema.safeParse({})
  assert.equal(ok.success, true)
  assert.deepEqual(ok.success ? ok.data : null, {})

  const withBoth = SkillGetStateSchema.safeParse({ executionId: 'e-1', skillId: 'my-skill' })
  assert.equal(withBoth.success, true)
})

test('SkillGetStateSchema rejects empty-string executionId because min(1) after trim', () => {
  // optional but when present must satisfy min(1) after trim
  const empty = SkillGetStateSchema.safeParse({ executionId: '' })
  assert.equal(empty.success, false)
  const whitespace = SkillGetStateSchema.safeParse({ executionId: '   ' })
  assert.equal(whitespace.success, false)
})

test('SkillSubmitInputSchema requires a non-empty executionId', () => {
  const empty = SkillSubmitInputSchema.safeParse({ executionId: '', inputs: {} })
  assert.equal(empty.success, false)

  const missing = SkillSubmitInputSchema.safeParse({ inputs: {} })
  assert.equal(missing.success, false)

  const trimmed = SkillSubmitInputSchema.safeParse({ executionId: '  e-abc  ', inputs: {} })
  assert.equal(trimmed.success, true)
  assert.equal(trimmed.success ? trimmed.data.executionId : null, 'e-abc')
})

test('SkillSubmitInputSchema rejects non-object inputs but accepts empty and populated', () => {
  const nonObject = SkillSubmitInputSchema.safeParse({ executionId: 'e-1', inputs: 'not-an-object' })
  assert.equal(nonObject.success, false)

  const empty = SkillSubmitInputSchema.safeParse({ executionId: 'e-1', inputs: {} })
  assert.equal(empty.success, true)

  const populated = SkillSubmitInputSchema.safeParse({ executionId: 'e-1', inputs: { forceSubtitleMode: 'funasr' } })
  assert.equal(populated.success, true)
})

test('SkillSubmitConfirmationSchema.confirmed accepts all lenient variants matching asBoolean', () => {
  const legalValues: Array<[unknown, boolean]> = [
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    [1, true],
    [0, false],
  ]
  for (const [input, expected] of legalValues) {
    const result = SkillSubmitConfirmationSchema.safeParse({
      executionId: 'e-1',
      stepId: 'step-1',
      confirmed: input,
    })
    assert.equal(result.success, true, `confirmed=${JSON.stringify(input)} should parse`)
    if (result.success) {
      assert.equal(result.data.confirmed, expected, `confirmed=${JSON.stringify(input)} should coerce to ${expected}`)
    }
  }
})

test('SkillSubmitConfirmationSchema.confirmed rejects ambiguous non-boolean strings', () => {
  const ambiguous = SkillSubmitConfirmationSchema.safeParse({
    executionId: 'e-1',
    stepId: 'step-1',
    confirmed: 'yes',
  })
  assert.equal(ambiguous.success, false)
})

test('SkillSubmitAgentResultSchema treats textContent and outputs as optional', () => {
  const minimal = SkillSubmitAgentResultSchema.safeParse({ executionId: 'e-1', stepId: 'step-1' })
  assert.equal(minimal.success, true)

  const full = SkillSubmitAgentResultSchema.safeParse({
    executionId: 'e-1',
    stepId: 'step-1',
    textContent: 'generated body',
    outputs: { summary: 'done' },
  })
  assert.equal(full.success, true)
})

test('SkillRestartFromStepSchema treats inputs as optional and keeps stepId required', () => {
  const missingStep = SkillRestartFromStepSchema.safeParse({ executionId: 'e-1' })
  assert.equal(missingStep.success, false)

  const ok = SkillRestartFromStepSchema.safeParse({ executionId: 'e-1', stepId: 'step-1' })
  assert.equal(ok.success, true)
})

test('SkillCancelExecutionSchema requires executionId', () => {
  const missing = SkillCancelExecutionSchema.safeParse({})
  assert.equal(missing.success, false)

  const ok = SkillCancelExecutionSchema.safeParse({ executionId: 'e-1' })
  assert.equal(ok.success, true)
})

test('unknown keys are silently stripped (default Zod behavior, not strict)', () => {
  const result = SkillSubmitInputSchema.safeParse({
    executionId: 'e-1',
    inputs: {},
    bogusExtra: 'should be dropped',
  })
  assert.equal(result.success, true)
  if (result.success) {
    assert.equal('bogusExtra' in result.data, false)
  }
})
