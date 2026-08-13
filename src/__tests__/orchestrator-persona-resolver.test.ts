import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createCodexHostExecutionBinding } from '../main/modules/agent-control/codex-runtime/codex-host-execution-binding'

const repoRoot = resolve(import.meta.dirname, '../..')

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

test('the live Codex composition cannot reinstall the retired persona resolver', () => {
  const liveSources = readFileSync(resolve(
    repoRoot,
    'src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts',
  ), 'utf8')

  assert.doesNotMatch(liveSources, /setPersonaResolver|AgentExecutionProfileResolver/)
  assert.doesNotMatch(liveSources, /executionProfileResolver\s*\.\s*resolve/)
})
