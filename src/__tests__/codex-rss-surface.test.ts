import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('RSS workbench without keywords only adds capture', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(
      ['file_search', 'web_search', 'rss_capture_session', 'rss_select_item', 'rss_add_source', 'rss_analyze_item'],
      ['file_search', 'web_search'],
    ),
    authorizationId: 'rss-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'rss',
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_capture_session'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_select_item'), false)
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_add_source'), false)
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_analyze_item'), false)
})

test('browser idle chat does not open RSS capture', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(['file_search', 'rss_capture_session'], ['file_search']),
    authorizationId: 'browser-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'browser',
  })
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_capture_session'), false)
})

test('rss_item resource is resolved from Main identity, not title text', async () => {
  const resolved = await resolveCodexExplicitResources({
    selections: [{ kind: 'rss_item', id: 'r1', name: '条目', itemId: 'item-9' }],
    resolveSkill: () => null,
    resolveRssItem: (selection) => {
      assert.equal(selection.itemId, 'item-9')
      return {
        name: '真实标题',
        path: 'https://example.com/item',
        text: '用户明确引用的 RSS 条目：item-9',
        digest: 'a'.repeat(64),
      }
    },
  })
  assert.equal(resolved.requestResources[0]?.kind, 'rss_item')
  assert.equal(resolved.input.some((entry) => entry.type === 'text' && entry.text.includes('item-9')), true)
})
