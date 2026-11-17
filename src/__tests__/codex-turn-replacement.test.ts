import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import {
  currentTurnReadyAdditionalContext,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  buildCodexReplacedTurnContext,
  markCodexTurnReplacedInOpenTransaction,
  resolveCodexTurnReplacementTarget,
} from '../main/modules/agent-control/codex-runtime/codex-turn-replacement'
import { parseSendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

describe('replacing the latest turn', () => {
  it('hides the edited message and everything after it, and nothing before it', async (t) => {
    if (skipIfSqliteUnavailable(t, 'codex-turn-replacement: marking')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null
    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }
    try {
      const rawDb = db.getRawDb()
      assert.ok(rawDb)
      db.chat.createConversation('scope-1', 'butler', 'replace')
      db.chat.createConversation('scope-2', 'butler', 'other')
      db.chat.addChatMessage('u1', 'scope-1', 'user', '第一问', '2026-11-17T01:00:00.000Z')
      db.chat.addChatMessage('a1', 'scope-1', 'assistant', '第一答', '2026-11-17T01:00:05.000Z')
      db.chat.addChatMessage('u2', 'scope-1', 'user', '明天广州天气怎么样', '2026-11-17T01:01:00.000Z')
      db.chat.addChatMessage('card2', 'scope-1', 'agent_card', '卡片', '2026-11-17T01:01:02.000Z')
      db.chat.addChatMessage('a2', 'scope-1', 'assistant', '本轮未能完成。', '2026-11-17T01:01:05.000Z')
      db.chat.addChatMessage('other', 'scope-2', 'user', '别的会话', '2026-11-17T01:02:00.000Z')

      // Only the latest message of its own conversation can be replaced.
      assert.equal(resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-1', userMessageId: 'u1' }), null)
      assert.equal(resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-1', userMessageId: 'a2' }), null)
      assert.equal(resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-2', userMessageId: 'u2' }), null)
      const target = resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-1', userMessageId: 'u2' })
      assert.deepEqual(target, { originUserMessageId: 'u2', timestamp: '2026-11-17T01:01:00.000Z' })

      markCodexTurnReplacedInOpenTransaction(rawDb, { scopeId: 'scope-1', target: target!, replacingRunId: 'run-3' })
      db.chat.addChatMessage('u3', 'scope-1', 'user', '后天广州天气怎么样', '2026-11-17T01:03:00.000Z')

      assert.deepEqual(db.chat.getChatMessages('scope-1').map((row) => row.id), ['u1', 'a1', 'u3'])
      assert.deepEqual(db.chat.getChatMessages('scope-2').map((row) => row.id), ['other'])
      // The rows stay stored for the run records that point at them; only their search text goes.
      assert.deepEqual(
        rawDb.prepare('SELECT id, replaced_by_run_id AS run FROM chat_messages WHERE replaced_by_run_id IS NOT NULL ORDER BY id')
          .all<{ id: string; run: string }>(),
        [{ id: 'a2', run: 'run-3' }, { id: 'card2', run: 'run-3' }, { id: 'u2', run: 'run-3' }],
      )
      assert.deepEqual(
        rawDb.prepare('SELECT message_id FROM chat_messages_fts WHERE conversation_id = ? ORDER BY message_id')
          .all<{ message_id: string }>('scope-1').map((row) => row.message_id),
        ['a1', 'u1', 'u3'],
      )
      // A replaced message cannot be replaced again; the replacement is now the latest.
      assert.equal(resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-1', userMessageId: 'u2' }), null)
      assert.ok(resolveCodexTurnReplacementTarget(rawDb, { scopeId: 'scope-1', userMessageId: 'u3' }))
    } finally {
      db?.close()
    }
  })
})

test('the send request carries the replaced message by id only', () => {
  const base = {
    scopeId: 'scope-1', requestId: 'req-1', expectedMessageVisibilityEpoch: 0, message: '后天呢',
    userMessage: {
      id: 'u3', content: '后天呢', timestamp: '2026-11-17T01:03:00.000Z', meta: {},
      attachmentConfirmation: { selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 },
    },
  }
  assert.deepEqual(
    parseSendScopedRequest({ ...base, replaceLatestTurn: { userMessageId: 'u2' } }).replaceLatestTurn,
    { userMessageId: 'u2' },
  )
  assert.throws(() => parseSendScopedRequest({ ...base, replaceLatestTurn: { userMessageId: '' } }))
  assert.throws(() => parseSendScopedRequest({ ...base, replaceLatestTurn: { userMessageId: 'u2', runId: 'x' } }))
})

test('the withdrawn-turn notice is this run\'s context only, bound into the gateway digest', () => {
  const notice = (readyRunId = 'run-3', extra: Record<string, unknown> = {}) => ({
    type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-replaced-turn>${JSON.stringify({
        ...buildCodexReplacedTurnContext({ readyRunId, replacedOriginUserMessageId: 'u2' }), ...extra,
      })}</ready-replaced-turn>` }],
  })
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }
  const answer = { type: 'message', role: 'assistant', content: [] }
  const expected = buildCodexReplacedTurnContext({ readyRunId: 'run-3', replacedOriginUserMessageId: 'u2' })

  const current = currentTurnReadyAdditionalContext([notice(), user], [], 'run-3')
  assert.deepEqual(current.replacedTurn, expected)
  assert.equal(
    digestReadyAdditionalContext(current),
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null, replacedTurn: expected }),
  )
  assert.notEqual(
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null, replacedTurn: expected }),
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null }),
  )
  assert.equal(
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null, replacedTurn: null }),
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null }),
    'a run that replaced nothing keeps its digest',
  )
  assert.equal(currentTurnReadyAdditionalContext([notice('run-2'), user, answer, user], [], 'run-3').replacedTurn, null,
    'an earlier turn\'s notice is history')
  assert.equal(
    instructionTranscriptDigest('base', [notice('run-2'), user, answer, notice(), user]),
    instructionTranscriptDigest('base', [user, answer, user]),
  )
  for (const items of [
    [notice('run-2'), user],
    [notice(), notice(), user],
    [notice('run-3', { injected: true }), user],
    [{ ...notice(), role: 'user' }, user],
  ]) assert.throws(() => currentTurnReadyAdditionalContext(items, [], 'run-3'), /gateway_replaced_turn_context_invalid/)
})
