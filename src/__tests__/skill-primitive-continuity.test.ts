import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRememberPrimitiveOutcomeForContinuity } from '../main/modules/tools/skills-tools'

test('monitor-only primitive success without durable handle is not remembered as skill completion', () => {
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: false,
  }), false)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_inspect_run_state',
    status: 'done',
    hasDurableHandle: false,
  }), false)
})

test('primitive blocked/error or durable handles remain resumable continuity', () => {
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'blocked',
    hasDurableHandle: false,
  }), true)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_run_shell',
    status: 'done',
    hasDurableHandle: true,
  }), true)
  assert.equal(shouldRememberPrimitiveOutcomeForContinuity({
    toolName: 'skill_write_artifact',
    status: 'done',
    hasDurableHandle: false,
  }), true)
})
