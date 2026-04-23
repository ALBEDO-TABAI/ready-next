import { describe, it } from 'node:test'
import assert from 'node:assert'

import { buildSkillExecutionMissingOutput } from '../main/modules/tools/skill-execution-missing'
import type { SkillExecutionDetail } from '../shared/skill-execution-types'

function makeActiveExecution(overrides: Partial<SkillExecutionDetail> = {}): SkillExecutionDetail {
  const now = new Date().toISOString()
  return {
    id: 'exec-active',
    skillId: 'video-copy-analyzer',
    entryAction: 'video_copy_analyze',
    sessionId: 'session-1',
    source: 'embedded',
    status: 'blocked',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    currentStepId: 'prepare_input',
    compiledSkill: { id: 'video-copy-analyzer' } as SkillExecutionDetail['compiledSkill'],
    blocker: null,
    lastFrame: null,
    errors: [],
    stepOutputs: {},
    confirmations: {},
    inputs: {},
    steps: [],
    artifacts: [],
    ...overrides,
  }
}

describe('buildSkillExecutionMissingOutput', () => {
  it('surfaces the active execution when the coordinator reports the id as missing', () => {
    const output = buildSkillExecutionMissingOutput({
      executionId: 'exec-ghost',
      operation: 'submit_input',
      activeExecution: makeActiveExecution(),
      originalMessage: 'Execution not found: exec-ghost',
    })

    assert.strictEqual(output.shape, 'json')
    assert.match(output.text, /Skill execution exec-ghost not found/)
    assert.match(output.text, /活跃 execution：exec-active/)
    assert.match(output.text, /skill=video-copy-analyzer/)
    assert.match(output.text, /status=blocked/)
    assert.match(output.text, /step=prepare_input/)
    assert.match(output.text, /skill_submit_input/)
    assert.deepStrictEqual(output.data, {
      errorKind: 'skill_execution_missing',
      operation: 'submit_input',
      executionId: 'exec-ghost',
      activeExecutionId: 'exec-active',
      activeSkillId: 'video-copy-analyzer',
      activeStatus: 'blocked',
      originalMessage: 'Execution not found: exec-ghost',
      referenceHint: null,
    })
  })

  it('guides the agent to skill_get_state when nothing is active in this session', () => {
    const output = buildSkillExecutionMissingOutput({
      executionId: 'exec-stale',
      operation: 'submit_agent_result',
      activeExecution: null,
    })

    assert.strictEqual(output.shape, 'json')
    assert.match(output.text, /当前会话没有任何活跃的 skill execution/)
    assert.match(output.text, /skill_get_state/)
    assert.strictEqual(output.data?.errorKind, 'skill_execution_missing')
    assert.strictEqual(output.data?.activeExecutionId, null)
    assert.strictEqual(output.data?.operation, 'submit_agent_result')
  })

  it('falls back to a placeholder when the agent omits the executionId entirely', () => {
    const output = buildSkillExecutionMissingOutput({
      executionId: '',
      operation: 'restart_from_step',
      activeExecution: null,
    })

    assert.match(output.text, /\(missing id\) not found/)
    assert.strictEqual(output.data?.executionId, null)
  })
})
