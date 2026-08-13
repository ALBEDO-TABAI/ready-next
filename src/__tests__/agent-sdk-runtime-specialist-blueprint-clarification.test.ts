import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRegisteredToolNames,
  resolveToolInputSchemaForExecution,
} from '../main/modules/agent-control/tools-runtime/tool-registry'

test('default Codex registry cannot admit retired specialist mutation tools', () => {
  const registered = getRegisteredToolNames()
  for (const name of [
    'propose_specialist_blueprint',
    'confirm_specialist_blueprint',
    'rename_specialist_agent',
  ]) {
    assert.equal(registered.has(name), false)
    assert.equal(resolveToolInputSchemaForExecution(name), null)
  }
  assert.equal(registered.has('ask_user_questions'), true)
  assert.equal(registered.has('declare_completion_criteria'), true)
})
