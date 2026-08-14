import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('registry and composed allow-set never expose file_emergence tools', () => {
  const definitions = defaultToolRegistry.listToolDefinitions()
  assert.equal(definitions.some((definition) => definition.name.startsWith('file_emergence_')), false)
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(['file_search', 'file_locate']),
    authorizationId: 'emergence-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  assert.equal(
    composed.readyTurnToolAuthorization.allowedToolNames.some((name) => name.startsWith('file_emergence_')),
    false,
  )
})
