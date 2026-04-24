/**
 * B plan Phase 0 — P0-T3: verifies that buildSkillExecutionMissingOutput
 * branches its text based on `lastReferenceSkill`. When the session recently
 * loaded a reference (advisory) skill, the returned error MUST steer the LLM
 * away from submit_* / restart / cancel and back to the methodology itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSkillExecutionMissingOutput } from '../main/modules/tools/skill-execution-missing'

test('reference hint replaces the generic skill_get_state advice when no active execution exists', () => {
  const output = buildSkillExecutionMissingOutput({
    executionId: 'new',
    operation: 'submit_input',
    activeExecution: null,
    lastReferenceSkill: { id: 'novel_writer_system', name: 'Novel Writer System' },
  })

  assert.equal(output.shape, 'json')
  // New directed text
  assert.match(output.text, /reference 技能「Novel Writer System」/)
  assert.match(output.text, /不要再调用 skill_submit_\*/)
  // Old generic text MUST NOT surface on this path
  assert.ok(
    !/当前会话没有任何活跃的 skill execution/.test(output.text),
    'generic fallback should not appear when reference hint is present',
  )
  assert.ok(!/skill_get_state/.test(output.text))
  assert.equal(output.data?.referenceHint && typeof output.data.referenceHint === 'object', true)
  const hint = output.data?.referenceHint as { id: string; name: string }
  assert.equal(hint.id, 'novel_writer_system')
  assert.equal(hint.name, 'Novel Writer System')
})

test('reference hint falls back to id when name is empty', () => {
  const output = buildSkillExecutionMissingOutput({
    executionId: 'ghost',
    operation: 'submit_confirmation',
    activeExecution: null,
    lastReferenceSkill: { id: 'my-skill-id', name: '' },
  })

  assert.match(output.text, /「my-skill-id」/)
})

test('without reference hint the generic skill_get_state advice is preserved (baseline)', () => {
  const output = buildSkillExecutionMissingOutput({
    executionId: 'exec-stale',
    operation: 'submit_agent_result',
    activeExecution: null,
  })

  assert.match(output.text, /当前会话没有任何活跃的 skill execution/)
  assert.match(output.text, /skill_get_state/)
  assert.equal(output.data?.referenceHint, null)
})

test('active execution wins over a reference hint (active workflow continues to be surfaced)', () => {
  const output = buildSkillExecutionMissingOutput({
    executionId: 'exec-ghost',
    operation: 'submit_input',
    activeExecution: {
      id: 'exec-active',
      skillId: 'video-copy-analyzer',
      entryAction: 'video_copy_analyze',
      sessionId: 'session-1',
      source: 'embedded',
      status: 'blocked',
      startedAt: '2026-04-23T00:00:00Z',
      updatedAt: '2026-04-23T00:00:00Z',
      finishedAt: null,
      currentStepId: 'prepare_input',
      compiledSkill: { id: 'video-copy-analyzer' } as any,
      blocker: null,
      lastFrame: null,
      errors: [],
      stepOutputs: {},
      confirmations: {},
      inputs: {},
      steps: [],
      artifacts: [],
    } as any,
    lastReferenceSkill: { id: 'novel_writer_system', name: 'Novel Writer System' },
  })

  // Active-execution branch wins; do not surface the reference-skill advisory
  // in the text (to avoid confusing the LLM with two contradictory hints).
  assert.match(output.text, /活跃 execution：exec-active/)
  assert.ok(
    !/reference 技能「Novel Writer System」/.test(output.text),
    'reference text must not appear when an active execution exists',
  )
  // But we still capture the hint in structured `data` for observability.
  const hint = output.data?.referenceHint as { id: string; name: string } | null
  assert.ok(hint && hint.id === 'novel_writer_system')
})
