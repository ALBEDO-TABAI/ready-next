import assert from 'node:assert/strict'
import test from 'node:test'

import { DatabaseManager } from '../main/modules/database'
import { closeCodexConversationScopeInOpenTransaction } from '../main/modules/agent-control/codex-runtime/codex-conversation-scope-closure'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { SessionRecallService } from '../main/modules/agent-control/session/session-recall-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function createScopeStore(database: DatabaseManager): ConversationScopeStore {
  return new ConversationScopeStore({
    db: database,
    emitConversationEvent() {},
    mapChannelRow(row) {
      return {
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: JSON.parse(row.config_json) as Record<string, unknown>,
        lastError: row.last_error,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },
    getScopedRemoteThreadKey(channelId, remoteThread, agent) {
      return `${channelId}:${remoteThread}:${agent}`
    },
    getRemoteChannelSessionSettingKey(channelId, remoteThread, agent) {
      return `channel:${channelId}:${remoteThread}:${agent}`
    },
    restoreReferenceHintFromScope() {},
    persistReferenceHintToScope() {},
    resolveConversationAgentId: (agent) => agent,
    readAliasGeneration: () => null,
  })
}

function closeScope(database: DatabaseManager, scopeId: string, closedAt: string): string {
  const db = database.getRawDb()
  assert.ok(db)
  const closeEvidenceDigest = digestCanonicalJson({ scopeId, closedAt })
  db.exec('BEGIN IMMEDIATE')
  try {
    closeCodexConversationScopeInOpenTransaction(db, {
      scopeId,
      closedAt,
      closeEvidenceDigest,
    })
    db.exec('COMMIT')
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  }
  return closeEvidenceDigest
}

test('closed scope is absent from cold hydration, history, recall, and late writes', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex closed conversation scope')) return
  const database = new DatabaseManager(true)
  try {
    const store = createScopeStore(database)
    const scope = store.createLocalScope('butler', 'scope-closed-local')
    database.addChatMessage(
      'message-closed-local',
      scope.id,
      'user',
      '只属于已关闭会话的雅典关键词',
      '2026-08-12T01:00:00.000Z',
    )
    const recall = new SessionRecallService(database)
    assert.deepEqual(
      recall.searchSessionRecall({ query: '雅典关键词' }).map((hit) => hit.conversationId),
      [scope.id],
    )

    const closedAt = '2026-08-12T01:01:00.000Z'
    const closeEvidenceDigest = closeScope(database, scope.id, closedAt)
    const coldStore = createScopeStore(database)
    assert.deepEqual(coldStore.listConversationScopes('butler'), [])
    assert.equal(coldStore.getConversationScope(scope.id), null)
    assert.throws(
      () => coldStore.getConversationScopeMessages(scope.id),
      /conversation_scope_closed_or_missing/,
    )
    assert.deepEqual(database.getChatMessages(scope.id), [])
    assert.deepEqual(database.getConversations('butler'), [])
    assert.deepEqual(recall.searchSessionRecall({ query: '雅典关键词' }), [])
    assert.deepEqual(recall.listRecentSessions({ agent: 'butler' }), [])
    assert.equal(recall.getSessionRecallCapsule({ conversationId: scope.id }), null)
    assert.equal(database.getChatMessageById('message-closed-local'), null)
    assert.equal(database.updateChatMessageMeta('message-closed-local', { late: true }), false)
    assert.throws(
      () => database.addChatMessage(
        'message-late-local', scope.id, 'assistant', '晚到写入', '2026-08-12T01:02:00.000Z',
      ),
      /Conversation scope closed/,
    )
    assert.throws(
      () => database.upsertConversationScope({
        id: scope.id,
        agent: 'butler',
        title: '不应复活',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: scope.id,
      }),
      /Conversation scope closed/,
    )

    const db = database.getRawDb()
    assert.ok(db)
    assert.throws(() => db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
      VALUES ('message-raw-late', ?, 'assistant', '原始晚到写入', ?, '{}')
    `).run(scope.id, '2026-08-12T01:03:00.000Z'),
    /chat_message_(?:closed_scope|visibility_epoch_mismatch)/)
    assert.throws(() => db.prepare(`
      UPDATE chat_conversations SET title = '原始复活' WHERE id = ?
    `).run(scope.id), /chat_conversation_close_immutable/)
    assert.throws(() => db.prepare(`
      DELETE FROM chat_messages WHERE id = 'message-closed-local'
    `).run(), /chat_message_closed_scope/)
    assert.throws(() => db.prepare(`
      DELETE FROM chat_conversations WHERE id = ?
    `).run(scope.id), /chat_conversation_closed_delete/)
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = ?
    `).get(scope.id), {
      closed_at: closedAt,
      closed_reason: 'closed',
      close_evidence_digest: closeEvidenceDigest,
    })
  } finally {
    database.close()
  }
})

test('closed remote thread creates a new scope without exposing the old messages', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex closed remote conversation scope')) return
  const database = new DatabaseManager(true)
  try {
    const store = createScopeStore(database)
    database.upsertAgentChannel({
      id: 'channel-1',
      type: 'local-debug',
      name: 'Closed scope test channel',
      enabled: true,
      configJson: '{}',
    })
    const first = store.ensureChannelScope('channel-1', 'remote-thread-1', 'butler', 'Alice')
    database.upsertAgentChannelThread({
      channelId: 'channel-1',
      remoteThread: 'remote-thread-1',
      sessionId: first.id,
      conversationId: first.id,
    })
    database.addChatMessage(
      'message-remote-old',
      first.id,
      'user',
      '旧远程会话内容',
      '2026-08-12T02:00:00.000Z',
    )
    closeScope(database, first.id, '2026-08-12T02:01:00.000Z')

    const second = store.ensureChannelScope('channel-1', 'remote-thread-1', 'butler', 'Alice')
    database.upsertAgentChannelThread({
      channelId: 'channel-1',
      remoteThread: 'remote-thread-1',
      sessionId: second.id,
      conversationId: second.id,
    })
    assert.notEqual(second.id, first.id)
    assert.equal(second.sourceId, first.sourceId)
    assert.equal(second.threadKey, first.threadKey)
    assert.throws(
      () => store.getConversationScopeMessages(first.id),
      /conversation_scope_closed_or_missing/,
    )
    assert.deepEqual(store.getConversationScopeMessages(second.id), [])

    database.addChatMessage(
      'message-remote-new',
      second.id,
      'user',
      '新远程会话内容',
      '2026-08-12T02:02:00.000Z',
    )
    assert.deepEqual(
      store.getConversationScopeMessages(second.id).map((message) => message.id),
      ['message-remote-new'],
    )
    assert.deepEqual(
      store.listConversationScopes('butler').map((scope) => scope.id),
      [second.id],
    )
    assert.equal(database.getAgentChannelThreadBySession(first.id), null)
    assert.equal(database.getAgentChannelThreadBySession(second.id)?.conversation_id, second.id)

    const db = database.getRawDb()
    assert.ok(db)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?
    `).get<{ count: number }>(first.id)?.count, 1)
  } finally {
    database.close()
  }
})
