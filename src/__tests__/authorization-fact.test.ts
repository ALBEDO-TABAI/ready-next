/**
 * EP2-I-auth — acceptance red lines (approved design 05 §3.4.6):
 * 1 vague requests yield zero facts; 2 third-party content cannot mint
 * permissions (closed write surface gate); 3 M3 hit → confirmation-free
 * allow with admission untouched, expired/cross-scope/category-mismatch
 * degrade to confirm; 4 M1 never consults; 5 negation revokes the whole
 * category; 6 write-surface gate green.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

import {
  detectVerbatimGrants,
  recordVerbatimGrant,
  recordConfirmationGrant,
  consumeAuthorizationFact,
  revokeAuthorizationsForCategories,
  authCategoriesForNegationFamilies,
  canonicalObjectId,
  __clearAuthorizationFactsForTests,
} from '../main/modules/agent-control/safety/authorization-fact-store'
import { resolveConfirmationGate } from '../main/modules/agent-control/safety/action-confirmation-policy'

test('red line 1: vague requests yield zero grants; explicit naming yields canonicalizable grants', () => {
  assert.deepEqual(detectVerbatimGrants('帮我处理一下这些文件'), [])
  assert.deepEqual(detectVerbatimGrants('把那些都弄好'), [])
  const grants = detectVerbatimGrants('登录我的小红书账号，然后上传 报告.pdf')
  assert.deepEqual(grants, [
    { actionCategory: 'login', objectRef: '小红书' },
    { actionCategory: 'upload', objectRef: '报告.pdf' },
  ])
  // uncanonicalizable object → dropped before storage
  __clearAuthorizationFactsForTests()
  assert.equal(recordVerbatimGrant({ scopeId: 's1', actionCategory: 'upload', objectRef: '那个文件', verbatim: 'x' }), null)
  assert.equal(canonicalObjectId('upload', '那个文件'), null)
})

test('red line 3: M3 hit allows without confirmation; no fact / expired / cross-scope stay confirm', () => {
  __clearAuthorizationFactsForTests()
  const args = { channel_id: 'primary', chat_id: 'oc_team', content: { text: 'hi' }, msg_type: 'text' }

  // no fact → confirm (M3 degrades to the card)
  const before = resolveConfirmationGate('feishu_message_send', args, { scopeId: 'scope-a' })
  assert.equal(before.mode, 'M3')
  assert.equal(before.action, 'confirm')

  // recorded fact for the same object+category+scope → allow
  recordVerbatimGrant({ scopeId: 'scope-a', actionCategory: 'send_external', objectRef: 'oc_team', verbatim: '发给 oc_team' })
  const hit = resolveConfirmationGate('feishu_message_send', args, { scopeId: 'scope-a' })
  assert.equal(hit.action, 'allow')
  assert.equal(hit.mode, 'M3')

  // different object → confirm (object-level, not category blanket)
  const otherObject = resolveConfirmationGate('feishu_message_send', { ...args, chat_id: 'oc_other' }, { scopeId: 'scope-a' })
  assert.equal(otherObject.action, 'confirm')

  // cross-scope → confirm
  const crossScope = resolveConfirmationGate('feishu_message_send', args, { scopeId: 'scope-b' })
  assert.equal(crossScope.action, 'confirm')

  // expired → confirm
  __clearAuthorizationFactsForTests()
  recordVerbatimGrant({ scopeId: 'scope-a', actionCategory: 'send_external', objectRef: 'oc_team', verbatim: 'x', ttlMs: -1 })
  const expired = resolveConfirmationGate('feishu_message_send', args, { scopeId: 'scope-a' })
  assert.equal(expired.action, 'confirm')
})

test('red line 4: M1 never consults the store — facts cannot unlock manual-only actions', () => {
  __clearAuthorizationFactsForTests()
  // clicking a final payment confirmation is M1 territory regardless of grants
  recordVerbatimGrant({ scopeId: 'scope-a', actionCategory: 'login', objectRef: 'xiaohongshu.com', verbatim: 'x' })
  const decision = resolveConfirmationGate('browser_click', { selector: '#pay', text: '确认支付 999 元' }, { scopeId: 'scope-a' })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('red line 5: negation revokes the whole category; consumption returns to confirm', () => {
  __clearAuthorizationFactsForTests()
  recordVerbatimGrant({ scopeId: 'scope-a', actionCategory: 'send_external', objectRef: 'oc_team', verbatim: 'x' })
  assert.equal(consumeAuthorizationFact({ scopeId: 'scope-a', actionCategory: 'send_external', objectRef: 'oc_team' }), true)
  const categories = authCategoriesForNegationFamilies(['external_send', 'collection'])
  assert.deepEqual(categories.sort(), ['collect_risky_site', 'send_external'])
  assert.equal(revokeAuthorizationsForCategories('scope-a', categories), 1)
  assert.equal(consumeAuthorizationFact({ scopeId: 'scope-a', actionCategory: 'send_external', objectRef: 'oc_team' }), false)
})

test('confirmation grants (write entry 2) carry frozen-call evidence and consume identically', () => {
  __clearAuthorizationFactsForTests()
  const fact = recordConfirmationGrant({
    scopeId: 'scope-a', actionCategory: 'upload', objectRef: '/tmp/报告.pdf',
    frozenCallId: 'fc-1', paramsSha256: 'a'.repeat(64),
  })
  assert.ok(fact)
  assert.equal(fact!.source, 'confirmation_card')
  assert.ok(fact!.evidence.startsWith('frozen:fc-1:'))
  assert.equal(consumeAuthorizationFact({ scopeId: 'scope-a', actionCategory: 'upload', objectRef: '/tmp/报告.pdf' }), true)
})

test('red lines 2+6: the closed write-surface gate is green (third-party paths cannot mint permissions)', () => {
  const output = execFileSync('node', ['scripts/check-authorization-fact-writes.cjs'], { encoding: 'utf-8' })
  assert.match(output, /check-authorization-fact-writes: ok/)
})
