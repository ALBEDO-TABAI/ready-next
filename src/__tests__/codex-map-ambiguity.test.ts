import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { isAllowedProductAction } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('map_plan_route surface also exposes ask_user_questions and does not use the old helper contract', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(
      ['map_plan_route', 'ask_user_questions'],
      ['map_plan_route'],
    ),
    authorizationId: 'map-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('map_plan_route'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('ask_user_questions'))
  assert.equal(isAllowedProductAction('map_plan_route', 'renderer:present-file'), true)
  assert.equal(isAllowedProductAction('present_file', 'renderer:present-file'), true)
  assert.equal(isAllowedProductAction('web_clip_url', 'renderer:present-file'), true)
})
