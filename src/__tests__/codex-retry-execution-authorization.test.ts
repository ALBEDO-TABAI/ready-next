import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { resolveCodexRetryAuthorizationCeiling } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { buildReadyTurnToolAuthorization } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { createCodexToolFixture } from './utils/codex-tool-fixture'

test('retry never gains a currently available tool absent from its source authorization', () => {
  const tools = createCodexToolFixture(['ready_read', 'ready_write'])
  const none = buildExplicitNoSkillAuthorization('no_skill_signal')
  const source = {
    ...tools,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'source', authorization: none,
      toolSurface: tools.readyToolSurface, allowedToolNames: [],
    }),
  } as PreparedCodexProductRun
  const current = {
    readyToolSurface: tools.readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'current', authorization: none,
      toolSurface: tools.readyToolSurface, allowedToolNames: ['ready_read', 'ready_write'],
    }),
  }
  const result = resolveCodexRetryAuthorizationCeiling({
    source, current, currentSkillAuthorization: none,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.snapshot.readyTurnToolAuthorization.allowedToolNames, [])
})

