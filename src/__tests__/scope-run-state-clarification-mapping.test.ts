/**
 * B Phase 1 PR2 T1-8 — `primitive_ask_user` blocker maps to the
 * `clarification` waitingFor on the renderer side. Exercises the
 * `createTaskPatchFromSkillExecutionDetail` reducer, which is the surface the
 * renderer stores call with their skill-execution payloads.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTaskPatchFromSkillExecutionDetail } from '../renderer/modules/agent/scopeRunState'

test('primitive_ask_user blocker maps to waitingFor: clarification', () => {
  const patch = createTaskPatchFromSkillExecutionDetail({
    id: 'eau-abcdef12',
    skillId: 'novel_writer_system',
    status: 'blocked',
    blocker: { type: 'primitive_ask_user', message: '选一个' },
  })
  assert.equal(patch.waitingFor, 'clarification')
})

test('need_input still maps to input (regression guard)', () => {
  const patch = createTaskPatchFromSkillExecutionDetail({
    id: 'e-aaaaaaaa',
    skillId: 'x',
    status: 'blocked',
    blocker: { type: 'need_input', message: '' },
  })
  assert.equal(patch.waitingFor, 'input')
})

test('no blocker → waitingFor: none', () => {
  const patch = createTaskPatchFromSkillExecutionDetail({
    id: 'e-bbbbbbbb',
    skillId: 'x',
    status: 'running',
    blocker: null,
  })
  assert.equal(patch.waitingFor, 'none')
})
