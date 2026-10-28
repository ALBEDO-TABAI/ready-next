import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexHostExecutionBinding } from '../main/modules/agent-control/codex-runtime/codex-host-execution-binding'

test('Codex admission uses a neutral host identity instead of an archived persona profile', () => {
  const binding = createCodexHostExecutionBinding({
    runId: 'run-1',
    ownerAgentIdAtStart: 'scope-owner-1',
  })

  assert.equal(binding.ephemeralRole, 'codex_host')
  assert.equal(binding.requestedAgentId, null)
  assert.equal(binding.effectiveAgentId, null)
  assert.equal(binding.executionMaterialHash, 'codex_host_identity:v1')
})
