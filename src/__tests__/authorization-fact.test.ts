/**
 * EP2-I-auth — acceptance red lines (approved design 05 §3.4.6):
 * 1 vague requests yield zero facts; 2 third-party content cannot mint
 * permissions (closed write surface gate); 3 M3 hit → confirmation-free
 * allow with admission untouched, expired/cross-scope/category-mismatch
 * degrade to confirm; 4 M1 never consults; 5 negation revokes the whole
 * category; 6 write-surface gate green.
 */

import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
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
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import { createFrozenCallAuditDb } from './helpers/frozen-call-audit-db'

beforeEach(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})

afterEach(() => {
  __setScopeContextEpochDatabaseForTests(null)
})

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

test('red line 4: browser destructive actions are no longer unlocked by action-confirmation facts', () => {
  __clearAuthorizationFactsForTests()
  recordVerbatimGrant({ scopeId: 'scope-a', actionCategory: 'login', objectRef: 'xiaohongshu.com', verbatim: 'x' })
  const decision = resolveConfirmationGate('browser_click', { selector: '#pay', text: '确认支付 999 元' }, { scopeId: 'scope-a' })
  assert.equal(decision.mode, 'M4')
  assert.equal(decision.action, 'allow')
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

test('a prior upload fact never waives a later local-file upload confirmation', () => {
  __clearAuthorizationFactsForTests()
  const objectRef = '/tmp/report.pdf'
  recordConfirmationGrant({
    scopeId: 'scope-upload',
    actionCategory: 'upload',
    objectRef,
    frozenCallId: 'fc-upload-1',
    paramsSha256: 'b'.repeat(64),
  })
  const decision = resolveConfirmationGate('feishu_file_upload', {
    channel_id: 'primary',
    file_path: objectRef,
    file_type: 'pdf',
  }, {
    scopeId: 'scope-upload',
    actionAuthorizationMode: 'full',
  })
  assert.equal(decision.mode, 'M2')
  assert.equal(decision.action, 'confirm')
  assert.equal(decision.ruleId, 'm2-upload-file')
  assert.equal(
    consumeAuthorizationFact({ scopeId: 'scope-upload', actionCategory: 'upload', objectRef }),
    true,
    'the M2 upload decision must not consume or trust a stale path-only fact',
  )
})

test('red lines 2+6: the closed write-surface gate is green (third-party paths cannot mint permissions)', () => {
  const output = execFileSync('node', ['scripts/check-authorization-fact-writes.cjs'], { encoding: 'utf-8' })
  assert.match(output, /check-authorization-fact-writes: ok/)
})

test('write entry 2 reachability: the M3 card session option mints the grant; plain confirm mints nothing', async () => {
  __clearAuthorizationFactsForTests()
  const { runFrozenCallConfirmation, FROZEN_CALL_QUESTION_ID, FROZEN_CALL_CONFIRM_OPTION, FROZEN_CALL_SESSION_CONFIRM_OPTION } =
    await import('../main/modules/agent-control/safety/frozen-call-confirmation')
  const { FrozenCallStore } = await import('../main/modules/agent-control/safety/frozen-call-store')
  const { getAskUserQuestionsStore } = await import('../main/modules/tools/builtins/ask-user-questions-store')

  async function confirmVia(option: string, sessionId: string) {
    const store = new FrozenCallStore(createFrozenCallAuditDb())
    const pending = runFrozenCallConfirmation('feishu_message_send', { chat_id: 'oc_team' }, {
      mode: 'M3', action: 'confirm', ruleId: 'm3-send-external', designRef: 'x', reason: 'r',
    } as never, {
      store,
      sessionId,
      conversationId: sessionId,
      scopeId: 'scope-grant',
      timeoutMs: 5000,
      sessionEffectiveGrant: { actionCategory: 'send_external', objectRef: 'oc_team' },
    } as never)
    // wait until the card registers, then answer
    const askStore = getAskUserQuestionsStore()
    for (let i = 0; i < 50 && !askStore.findPendingForSession(sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const card = askStore.findPendingForSession(sessionId)
    if (!card) throw new Error('confirmation card never registered')
    const options = (card as unknown as { questions: Array<{ options: string[] }> }).questions[0].options
    if (!options.includes(FROZEN_CALL_SESSION_CONFIRM_OPTION)) {
      throw new Error('M3 card must offer the session-effective option')
    }
    askStore.resolve(card.cardId, { answers: [{ id: FROZEN_CALL_QUESTION_ID, answer: option }], answeredAt: Date.now() })
    return pending
  }

  // plain confirm: released, NO grant minted (default 仅此一次)
  const plain = await confirmVia(FROZEN_CALL_CONFIRM_OPTION, 'reach-plain')
  assert.equal(plain.kind, 'released')
  assert.equal(consumeAuthorizationFact({ scopeId: 'scope-grant', actionCategory: 'send_external', objectRef: 'oc_team' }), false)

  // session option: released AND the grant is consumable afterwards
  const session = await confirmVia(FROZEN_CALL_SESSION_CONFIRM_OPTION, 'reach-session')
  assert.equal(session.kind, 'released')
  assert.equal(consumeAuthorizationFact({ scopeId: 'scope-grant', actionCategory: 'send_external', objectRef: 'oc_team' }), true)
})

test('reset epoch rejects old authorization facts and writers while same-epoch stop preserves current facts', () => {
  __clearAuthorizationFactsForTests()
  let epoch = 0
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({
      prepare: () => ({
        get: () => ({ message_visibility_epoch: epoch, closed_at: null }),
      }),
    }) as never,
  })
  try {
    assert.ok(recordVerbatimGrant({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      verbatim: '发给 oc_old',
      messageVisibilityEpoch: 0,
    }))
    epoch = 1
    assert.equal(consumeAuthorizationFact({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      messageVisibilityEpoch: 0,
    }), false)
    assert.equal(consumeAuthorizationFact({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      messageVisibilityEpoch: 1,
    }), false)
    assert.equal(recordVerbatimGrant({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_late',
      verbatim: '发给 oc_late',
      messageVisibilityEpoch: 0,
    }), null)
    assert.ok(recordVerbatimGrant({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_current',
      verbatim: '发给 oc_current',
      messageVisibilityEpoch: 1,
    }))
    assert.equal(consumeAuthorizationFact({
      scopeId: 'scope-auth-epoch',
      actionCategory: 'send_external',
      objectRef: 'oc_current',
      messageVisibilityEpoch: 1,
    }), true)
  } finally {
    __setScopeContextEpochDatabaseForTests(null)
    __clearAuthorizationFactsForTests()
  }
})

test('authorization facts fail closed while durable scope identity is unavailable', () => {
  __clearAuthorizationFactsForTests()
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({
      prepare: () => ({ get: () => undefined }),
    }) as never,
  })
  try {
    assert.ok(recordConfirmationGrant({
      scopeId: 'scope-auth-unavailable',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      frozenCallId: 'frozen-old',
      paramsSha256: 'params-old',
      messageVisibilityEpoch: 0,
    }))

    __setScopeContextEpochDatabaseForTests({
      getRawDb: () => null,
    })
    assert.equal(recordConfirmationGrant({
      scopeId: 'scope-auth-unavailable',
      actionCategory: 'send_external',
      objectRef: 'oc_late',
      frozenCallId: 'frozen-late',
      paramsSha256: 'params-late',
      messageVisibilityEpoch: 0,
    }), null)
    assert.equal(consumeAuthorizationFact({
      scopeId: 'scope-auth-unavailable',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      messageVisibilityEpoch: 1,
    }), false)

    __setScopeContextEpochDatabaseForTests({
      getRawDb: () => {
        throw new Error('database temporarily unavailable')
      },
    })
    assert.equal(recordConfirmationGrant({
      scopeId: 'scope-auth-unavailable',
      actionCategory: 'send_external',
      objectRef: 'oc_throw',
      frozenCallId: 'frozen-throw',
      paramsSha256: 'params-throw',
      messageVisibilityEpoch: 0,
    }), null)
    assert.equal(consumeAuthorizationFact({
      scopeId: 'scope-auth-unavailable',
      actionCategory: 'send_external',
      objectRef: 'oc_old',
      messageVisibilityEpoch: 1,
    }), false)
  } finally {
    __setScopeContextEpochDatabaseForTests(null)
    __clearAuthorizationFactsForTests()
  }
})
