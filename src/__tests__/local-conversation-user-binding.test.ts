import type { ChatConversationRecord, ConversationSourceKind } from '../main/modules/database/records'
import type { DatabaseConnection, DatabaseStatement } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import test from 'node:test'

import { ChatStore } from '../main/modules/database/chat-store'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('local conversation user binding declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'local-conversation-user-binding transitive sqlite load')
})

class FakeConversationConnection implements DatabaseConnection {
  readonly conversations = new Map<string, ChatConversationRecord>()

  exec(sql: string): void {
    throw new Error(`Unexpected exec SQL: ${sql}`)
  }

  close(): void {}

  prepare(sql: string): DatabaseStatement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const conversations = this.conversations
    return {
      run(...params: unknown[]) {
        if (normalized.startsWith('INSERT INTO session_recall_metadata')) return { changes: 1 }
        if (!normalized.startsWith('INSERT INTO chat_conversations')) {
          throw new Error(`Unexpected run SQL: ${normalized}`)
        }
        const [
          id, agent, activeAgentId, handoffGeneration, userId, title,
          parentConversationId, lineageRootId, resumeTitle, sourceKind,
          sourceId, threadKey, metaJson, createdAt, updatedAt,
        ] = params
        conversations.set(String(id), {
          id: String(id),
          agent: String(agent),
          active_agent_id: String(activeAgentId),
          handoff_generation: Number(handoffGeneration),
          user_id: typeof userId === 'string' ? userId : null,
          title: String(title),
          parent_conversation_id: typeof parentConversationId === 'string' ? parentConversationId : null,
          lineage_root_id: String(lineageRootId),
          resume_title: String(resumeTitle),
          source_kind: sourceKind as ConversationSourceKind,
          source_id: String(sourceId),
          thread_key: String(threadKey),
          meta_json: String(metaJson),
          created_at: String(createdAt),
          updated_at: String(updatedAt),
        })
        return { changes: 1 }
      },
      get<T = unknown>(...params: unknown[]): T | undefined {
        if (normalized === 'SELECT * FROM chat_conversations WHERE id = ? LIMIT 1') {
          return conversations.get(String(params[0])) as T | undefined
        }
        if (normalized.startsWith('SELECT * FROM chat_conversations WHERE source_kind = ?')) {
          const [sourceKind, sourceId, threadKey, agent] = params
          return [...conversations.values()].find((row) => (
            row.source_kind === sourceKind
            && row.source_id === sourceId
            && row.thread_key === threadKey
            && row.agent === agent
          )) as T | undefined
        }
        if (normalized.startsWith('SELECT preview_text')) return undefined
        throw new Error(`Unexpected get SQL: ${normalized}`)
      },
      all<T = unknown>(): T[] {
        return []
      },
    }
  }
}

function createManager(): { manager: { chat: ChatStore }; connection: FakeConversationConnection } {
  const connection = new FakeConversationConnection()
  const manager = { chat: new ChatStore(() => connection) }
  return { manager, connection }
}

test('legacy chat:createConversation explicitly binds new local conversations to default-user', () => {
  const { manager, connection } = createManager()

  manager.chat.createConversation('conv-new-local', 'butler', '新会话')

  assert.equal(connection.conversations.get('conv-new-local')?.user_id, 'default-user')
})

test('upserting without userId preserves an existing binding and leaves a new remote scope unbound', () => {
  const { manager, connection } = createManager()
  const localPayload = {
    id: 'conv-existing-local',
    agent: 'butler',
    title: '本地会话',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: 'conv-existing-local',
    meta: {},
  }

  manager.chat.upsertConversationScope({ ...localPayload, userId: 'default-user' })
  manager.chat.upsertConversationScope({ ...localPayload, title: '更新标题' })
  manager.chat.upsertConversationScope({
    id: 'conv-remote',
    agent: 'butler',
    title: '远程会话',
    sourceKind: 'channel',
    sourceId: 'feishu',
    threadKey: 'thread-remote',
    meta: {},
  })

  assert.equal(connection.conversations.get('conv-existing-local')?.user_id, 'default-user')
  assert.equal(connection.conversations.get('conv-remote')?.user_id, null)
})
