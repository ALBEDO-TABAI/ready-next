import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseActionAuthorizationMode,
  readActionAuthorizationModeFromEnvelope,
} from '../shared/action-authorization-mode'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { ConversationScopeStore } from '../main/modules/agent-control/runtime-core/conversation-scope-store'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('action authorization mode parser defaults closed', () => {
  assert.equal(parseActionAuthorizationMode('ask'), 'ask')
  assert.equal(parseActionAuthorizationMode('auto'), 'auto')
  assert.equal(parseActionAuthorizationMode('full'), 'full')
  assert.equal(parseActionAuthorizationMode('invalid'), 'ask')
  assert.equal(readActionAuthorizationModeFromEnvelope(null), 'ask')
  assert.equal(readActionAuthorizationModeFromEnvelope({ actionAuthorizationMode: 'full' }), 'full')
  assert.equal(readActionAuthorizationModeFromEnvelope({ actionAuthorizationMode: true }), 'ask')
})

test('conversation authorization mode persists in scope metadata without replacing adjacent metadata', async (t) => {
  if (skipIfSqliteUnavailable(t, 'conversation action authorization mode persistence')) return
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
    db.createConversation('scope-action-mode', 'butler', 'Action mode')
    db.updateConversationScopeMeta('scope-action-mode', { sourceLabel: '应用内', adjacent: 'keep' })
    const events: string[] = []
    const store = new ConversationScopeStore({
      db,
      emitConversationEvent: (event) => events.push(event.type),
      mapChannelRow() { throw new Error('unexpected_channel_mapping') },
      getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
      getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
      restoreReferenceHintFromScope() {},
      persistReferenceHintToScope() {},
      resolveConversationAgentId: (agentId) => agentId,
      readAliasGeneration: () => null,
    })

    const updated = store.setActionAuthorizationMode('scope-action-mode', 'auto', 0)
    assert.equal(updated.meta.actionAuthorizationMode, 'auto')
    assert.equal(updated.meta.adjacent, 'keep')
    assert.deepEqual(events, ['scope_updated'])

    const reopened = new ConversationScopeStore({
      db,
      emitConversationEvent() {},
      mapChannelRow() { throw new Error('unexpected_channel_mapping') },
      getScopedRemoteThreadKey() { throw new Error('unexpected_remote_scope') },
      getRemoteChannelSessionSettingKey() { throw new Error('unexpected_remote_scope') },
      restoreReferenceHintFromScope() {},
      persistReferenceHintToScope() {},
      resolveConversationAgentId: (agentId) => agentId,
      readAliasGeneration: () => null,
    })
    assert.equal(
      reopened.getConversationScope('scope-action-mode')?.meta.actionAuthorizationMode,
      'auto',
    )
    db.getRawDb()?.prepare(`
      UPDATE chat_conversations
         SET message_visibility_epoch = message_visibility_epoch + 1
       WHERE id = ?
    `).run('scope-action-mode')
    assert.throws(
      () => store.setActionAuthorizationMode('scope-action-mode', 'full', 0),
      /action_authorization_scope_identity_changed/,
    )
    assert.equal(
      reopened.getConversationScope('scope-action-mode')?.meta.actionAuthorizationMode,
      'auto',
    )
    assert.throws(
      () => store.setActionAuthorizationMode('scope-action-mode', 'invalid' as never, 1),
      /action_authorization_mode_invalid/,
    )
    db.upsertConversationScope({
      id: 'scope-channel-action-mode',
      agent: 'butler',
      activeAgentId: 'butler',
      title: 'Remote',
      sourceKind: 'channel',
      sourceId: 'channel-1',
      threadKey: 'remote-thread-1',
      meta: {},
    })
    assert.throws(
      () => store.setActionAuthorizationMode('scope-channel-action-mode', 'full', 0),
      /action_authorization_mode_local_scope_required/,
    )
  } finally {
    db?.close()
  }
})
