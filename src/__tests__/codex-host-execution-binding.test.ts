import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexHostExecutionBinding } from '../main/modules/agent-control/codex-runtime/codex-host-execution-binding'
import { assertTaskExecutionBinding } from '../main/modules/agent-control/task-projection/task-agent-binding'

test('Codex admission freezes only the neutral host identity', () => {
  const binding = createCodexHostExecutionBinding({
    runId: 'run-1',
    ownerAgentIdAtStart: 'scope-owner-1',
  })

  assert.equal(assertTaskExecutionBinding(binding), binding)
  assert.equal(binding.kind, 'ephemeral')
  assert.equal(binding.ephemeralRole, 'codex_host')
  assert.equal(binding.requestedAgentId, null)
  assert.equal(binding.effectiveAgentId, null)
  assert.equal(binding.executionMaterialHash, 'codex_host_identity:v1')
})
