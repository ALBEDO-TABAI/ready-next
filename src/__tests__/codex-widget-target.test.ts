import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { detectLiveInfoIntent } from '../main/modules/agent-control/live-info-intent'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

const digest = 'a'.repeat(64)

test('widget_target is a structure identity and does not upload widget HTML', async () => {
  const resolved = await resolveCodexExplicitResources({
    selections: [{
      kind: 'widget_target',
      id: 'w1',
      name: '天气卡',
      logicalResourceId: 'ready-current-document:scope:tab',
      tabId: 'tab-1',
      widgetId: 'widget-9',
      currentVersion: `sha256:${digest}`,
      currentDigest: digest,
      policyEpoch: 1,
      incarnationKey: digest,
    }],
    resolveSkill: () => null,
  })
  assert.equal(resolved.requestResources[0]?.kind, 'widget_target')
  assert.equal(resolved.requestResources[0]?.widgetId, 'widget-9')
  assert.equal(JSON.stringify(resolved).includes('<div'), false)
})

test('widget style edit does not look like live-info, latest weather does', () => {
  assert.equal(detectLiveInfoIntent('把这张卡的标题字号调大').needsLiveInfo, false)
  assert.equal(detectLiveInfoIntent('把这张卡更新为今天最新天气').needsLiveInfo, true)
})

test('explicit weather request can keep document update tools and research together', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'document_read_section',
      'document_update_widget',
      'document_list_widgets',
      'document_insert_widget',
      'document_remove_widget',
      'document_replace_exact',
      'document_save_tab',
      'web_search',
      'web_fetch',
    ]),
    authorizationId: 'widget-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    currentDocument: { present: true, allowWrite: true },
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('document_update_widget'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('web_search'))
})
