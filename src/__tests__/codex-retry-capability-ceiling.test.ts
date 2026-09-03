import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { resolveCodexRetryAuthorizationCeiling } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { buildExplicitNoSkillAuthorization, buildSelectedSkillToolAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { buildReadyTurnToolAuthorization } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { createCodexToolFixture } from './utils/codex-tool-fixture'

function fixtures() {
  const tools = createCodexToolFixture(['ready_read', 'ready_write'])
  const none = buildExplicitNoSkillAuthorization('no_skill_signal')
  const sourceAuthorization = buildReadyTurnToolAuthorization({
    authorizationId: 'source-auth', authorization: none,
    toolSurface: tools.readyToolSurface, allowedToolNames: ['ready_read'],
  })
  const currentAuthorization = buildReadyTurnToolAuthorization({
    authorizationId: 'current-auth', authorization: none,
    toolSurface: tools.readyToolSurface, allowedToolNames: ['ready_read', 'ready_write'],
  })
  return {
    none,
    source: {
      readyToolSurface: tools.readyToolSurface,
      readyTurnToolAuthorization: sourceAuthorization,
    } as PreparedCodexProductRun,
    current: {
      readyToolSurface: tools.readyToolSurface,
      readyTurnToolAuthorization: currentAuthorization,
    },
  }
}

test('retry execution authorization can only stay equal or shrink', () => {
  const value = fixtures()
  const result = resolveCodexRetryAuthorizationCeiling({
    source: value.source, current: value.current, currentSkillAuthorization: value.none,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.snapshot.readyTurnToolAuthorization.allowedToolNames, ['ready_read'])
  }
})

test('retry refuses source skill, current skill, and definition drift', () => {
  const value = fixtures()
  const selected = buildSelectedSkillToolAuthorization({
    skillId: 'fixture', allowedTypedActions: [], allowedPrimitives: [],
    source: 'explicit', reason: 'fixture',
  })
  const sourceSkill = {
    ...value.source,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'source-selected', authorization: selected,
      toolSurface: value.source.readyToolSurface,
    }),
  } as PreparedCodexProductRun
  assert.deepEqual(resolveCodexRetryAuthorizationCeiling({
    source: sourceSkill, current: value.current, currentSkillAuthorization: value.none,
  }), { ok: false, code: 'source_skill_requires_restatement' })
  assert.deepEqual(resolveCodexRetryAuthorizationCeiling({
    source: value.source, current: value.current, currentSkillAuthorization: selected,
  }), { ok: false, code: 'current_skill_requires_restatement' })
  const drifted = createCodexToolFixture(['ready_read'])
  assert.deepEqual(resolveCodexRetryAuthorizationCeiling({
    source: value.source,
    current: drifted,
    currentSkillAuthorization: value.none,
  }), { ok: false, code: 'tool_surface_requires_restatement' })
})
