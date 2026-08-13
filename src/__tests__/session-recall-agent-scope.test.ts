import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { SessionRecallService, type SessionRecallDatabaseAdapter } from '../main/modules/agent-control/session/session-recall-service'
import { executeSessionRecallTool } from '../main/modules/tools/session-recall-tools'
import type { ToolContext } from '../main/modules/tools/tool-executor'
import {
  DatabaseManager,
  type ChatConversationRecord,
  type ConversationSourceKind,
  type DatabaseConnection,
  type DatabaseStatement,
} from '../main/modules/database'

interface MetadataRow {
  conversation_id: string
  lineage_root_id: string
  resume_title: string
  title: string
  source_kind: ConversationSourceKind
  source_id: string
  thread_key: string
  user_id: string | null
  agent: string | null
  channel_key: string
  preview_text: string | null
  latest_task_title: string | null
  latest_task_summary: string | null
  attachment_names_json: string
  updated_at: string
}

interface MessageMatchRow {
  conversation_id: string
  excerpt: string
}

class FakeSessionRecallDb implements SessionRecallDatabaseAdapter {
  vectorRows = new Map<string, { content_hash: string; vector_json: string; vector_version: string; updated_at: string }>()

  constructor(
    private readonly conversations: ChatConversationRecord[],
    private readonly metadataRows: MetadataRow[],
    private readonly messageRows: Array<{ query: string; row: MessageMatchRow }>,
  ) {}

  getRawDb() {
    const conversations = this.conversations
    const metadataRows = this.metadataRows
    const messageRows = this.messageRows
    const vectorRows = this.vectorRows

    return {
      prepare: (sql: string) => ({
        all<T = unknown>(...params: unknown[]): T[] {
          if (sql.includes('FROM chat_messages_fts')) {
            const query = String(params[0] || '').replace(/"/g, '').toLowerCase()
            return messageRows
              .filter((item) => item.query.toLowerCase().includes(query))
              .map((item) => item.row) as T[]
          }
          if (sql.includes('FROM session_recall_attachment_index') && sql.includes('SELECT DISTINCT conversation_id')) {
            return [] as T[]
          }
          if (sql.includes('FROM session_recall_metadata') && sql.includes('WHERE title LIKE')) {
            const likeQuery = String(params[0] || '').replaceAll('%', '').toLowerCase()
            return metadataRows.filter((row) => (
              row.title.toLowerCase().includes(likeQuery) ||
              row.resume_title.toLowerCase().includes(likeQuery) ||
              String(row.latest_task_title || '').toLowerCase().includes(likeQuery) ||
              String(row.latest_task_summary || '').toLowerCase().includes(likeQuery)
            )) as T[]
          }
          if (sql.includes('FROM session_recall_metadata') && sql.includes('WHERE conversation_id IN')) {
            const ids = new Set(params.map((item) => String(item)))
            return metadataRows.filter((row) => ids.has(row.conversation_id)) as T[]
          }
          if (sql.includes('FROM session_recall_metadata') && sql.includes('ORDER BY updated_at DESC')) {
            return [...metadataRows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as T[]
          }
          if (sql.includes('FROM chat_conversations') && sql.includes('ORDER BY updated_at DESC')) {
            return [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as T[]
          }
          return [] as T[]
        },
        get<T = unknown>(...params: unknown[]): T | undefined {
          if (sql.includes('FROM task_projections')) return undefined
          if (sql.includes('FROM session_recall_metadata') && sql.includes('WHERE conversation_id = ?')) {
            return metadataRows.find((row) => row.conversation_id === params[0]) as T | undefined
          }
          if (sql.includes('FROM session_recall_vectors') && sql.includes('WHERE conversation_id = ?')) {
            const row = vectorRows.get(String(params[0] || ''))
            return row ? ({ conversation_id: String(params[0] || ''), ...row } as T) : undefined
          }
          return undefined
        },
        run(...params: unknown[]) {
          if (sql.includes('INTO session_recall_vectors')) {
            vectorRows.set(String(params[0] || ''), {
              content_hash: String(params[1] || ''),
              vector_version: String(params[2] || ''),
              vector_json: String(params[3] || ''),
              updated_at: String(params[4] || ''),
            })
          }
          return { changes: 1 }
        },
      }),
    }
  }

  getConversationScope(id: string): ChatConversationRecord | null {
    return this.conversations.find((row) => row.id === id) || null
  }

  updateConversationScopeMeta(id: string, meta: Record<string, unknown>): ChatConversationRecord | null {
    const conversation = this.conversations.find((row) => row.id === id)
    if (!conversation) return null
    conversation.meta_json = JSON.stringify(meta)
    return conversation
  }
}

class FakeDatabaseManagerConnection implements DatabaseConnection {
  readonly conversations = new Map<string, ChatConversationRecord>()
  readonly metadataWrites: unknown[][] = []
  inTransaction = false

  exec(sql: string): void {
    if (sql === 'BEGIN IMMEDIATE') {
      this.inTransaction = true
      return
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.inTransaction = false
      return
    }
    throw new Error(`Unexpected exec SQL: ${sql}`)
  }

  close(): void {}

  prepare(sql: string): DatabaseStatement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const conversations = this.conversations
    const metadataWrites = this.metadataWrites

    return {
      run(...params: unknown[]) {
        if (normalized.startsWith('INSERT INTO chat_conversations')) {
          const [
            id,
            agent,
            activeAgentId,
            handoffGeneration,
            userId,
            title,
            parentConversationId,
            lineageRootId,
            resumeTitle,
            sourceKind,
            sourceId,
            threadKey,
            metaJson,
            createdAt,
            updatedAt,
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
        }
        if (normalized.startsWith('INSERT INTO session_recall_metadata')) {
          metadataWrites.push(params)
          return { changes: 1 }
        }
        if (
          normalized.startsWith('INSERT INTO chat_messages') ||
          normalized.startsWith('DELETE FROM chat_messages_fts') ||
          normalized.startsWith('INSERT INTO chat_messages_fts') ||
          normalized.startsWith('DELETE FROM session_recall_attachment_index')
        ) {
          return { changes: 1 }
        }
        if (
          normalized === 'UPDATE chat_conversations SET updated_at = ? WHERE id = ?' ||
          normalized === 'UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND closed_at IS NULL'
        ) {
          const conversation = conversations.get(String(params[1]))
          if (conversation) conversation.updated_at = String(params[0])
          return { changes: conversation ? 1 : 0 }
        }
        if (normalized.startsWith('UPDATE chat_conversations SET active_agent_id = ?')) {
          const conversation = conversations.get(String(params[3]))
          if (conversation) {
            conversation.active_agent_id = String(params[0])
            conversation.handoff_generation = Number(params[1])
            conversation.updated_at = String(params[2])
          }
          return { changes: conversation ? 1 : 0 }
        }
        throw new Error(`Unexpected run SQL: ${normalized}`)
      },
      get<T = unknown>(...params: unknown[]): T | undefined {
        if (normalized === 'SELECT closed_at, message_visibility_epoch FROM chat_conversations WHERE id = ? LIMIT 1') {
          return (conversations.has(String(params[0]))
            ? { closed_at: null, message_visibility_epoch: 0 }
            : undefined) as T | undefined
        }
        if (normalized === 'SELECT message_visibility_epoch FROM chat_messages WHERE id = ? LIMIT 1') {
          return undefined
        }
        if (normalized.startsWith('SELECT 1 AS visible FROM chat_messages message')) {
          return { visible: 1 } as T
        }
        if (normalized === 'SELECT id FROM chat_conversations WHERE id = ? AND closed_at IS NOT NULL LIMIT 1') {
          return undefined
        }
        if (
          normalized === 'SELECT * FROM chat_conversations WHERE id = ? LIMIT 1' ||
          normalized === 'SELECT * FROM chat_conversations WHERE id = ? AND closed_at IS NULL LIMIT 1'
        ) {
          return conversations.get(String(params[0])) as T | undefined
        }
        if (normalized.startsWith('SELECT * FROM chat_conversations WHERE source_kind = ?')) {
          const [sourceKind, sourceId, threadKey, agent] = params
          return [...conversations.values()].find((row) => (
            row.source_kind === sourceKind &&
            row.source_id === sourceId &&
            row.thread_key === threadKey &&
            row.agent === agent
          )) as T | undefined
        }
        if (normalized.startsWith('SELECT preview_text, latest_task_title, latest_task_summary FROM session_recall_metadata')) {
          return undefined
        }
        throw new Error(`Unexpected get SQL: ${normalized}`)
      },
      all<T = unknown>(): T[] {
        if (normalized.startsWith('SELECT DISTINCT name FROM session_recall_attachment_index')) {
          return [] as T[]
        }
        throw new Error(`Unexpected all SQL: ${normalized}`)
      },
    }
  }
}

test('session_search injects current scope agent into model-visible recall queries', async () => {
  const captured: Array<{ agent?: string }> = []
  const rows = [
    { conversationId: 'conv-alpha', agent: 'alpha', title: 'alpha only' },
    { conversationId: 'conv-beta', agent: 'beta', title: 'beta only' },
  ]
  const context = {
    scope: {
      id: 'scope-alpha',
      agent: 'alpha',
      title: 'Alpha',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'thread-alpha',
      meta: {},
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
    runtime: {
      searchSessionRecall: (payload: { agent?: string }) => {
        captured.push(payload)
        return rows.filter((row) => row.agent === payload.agent)
      },
      listRecentSessions: (payload: { agent?: string }) => {
        captured.push(payload)
        return rows.filter((row) => row.agent === payload.agent)
      },
    },
  } as unknown as ToolContext

  const output = JSON.parse(await executeSessionRecallTool('session_search', { query: 'only' }, context))

  assert.equal(captured[0]?.agent, 'alpha')
  assert.equal(output.success, true)
  assert.equal(output.count, 1)
  assert.equal(output.sessions[0].conversationId, 'conv-alpha')
})

function createConversation(id: string, agent: string): ChatConversationRecord {
  return {
    id,
    agent,
    user_id: 'user-1',
    title: id,
    parent_conversation_id: null,
    lineage_root_id: id,
    resume_title: id,
    source_kind: 'local',
    source_id: 'app',
    thread_key: id,
    meta_json: '{}',
    created_at: '2026-06-20T09:00:00.000Z',
    updated_at: '2026-06-20T09:00:00.000Z',
  }
}

function createMetadata(conversationId: string, agent: string | null): MetadataRow {
  return {
    conversation_id: conversationId,
    lineage_root_id: conversationId,
    resume_title: conversationId,
    title: `${conversationId} 品牌 logo`,
    source_kind: 'local',
    source_id: 'app',
    thread_key: conversationId,
    user_id: 'user-1',
    agent,
    channel_key: 'local:app',
    preview_text: `${conversationId} 的品牌 logo 方向`,
    latest_task_title: null,
    latest_task_summary: `${conversationId} 已完成品牌 logo 风格提案`,
    attachment_names_json: '[]',
    updated_at: '2026-06-20T09:00:00.000Z',
  }
}

test('session recall search and automatic recall filter by agent when supplied', () => {
  const db = new FakeSessionRecallDb(
    [
      createConversation('conv-alpha', 'alpha'),
      createConversation('conv-beta', 'beta'),
    ],
    [
      createMetadata('conv-alpha', 'alpha'),
      createMetadata('conv-beta', 'beta'),
    ],
    [
      { query: 'logo', row: { conversation_id: 'conv-alpha', excerpt: 'alpha logo' } },
      { query: 'logo', row: { conversation_id: 'conv-beta', excerpt: 'beta logo' } },
    ],
  )
  const service = new SessionRecallService(db)

  const alphaHits = service.searchSessionRecall({
    query: 'logo',
    channelKey: 'local:app',
    userId: 'user-1',
    agent: 'alpha',
    limit: 10,
  })
  assert.deepEqual(alphaHits.map((hit) => hit.conversationId), ['conv-alpha'])

  const capsules = service.getAutomaticRecallCapsules({
    query: 'logo',
    channelKey: 'local:app',
    userId: 'user-1',
    agent: 'alpha',
    limit: 2,
  })
  assert.deepEqual(capsules.map((capsule) => capsule.conversationId), ['conv-alpha'])
})

test('session recall without agent filter keeps broad manual search behavior', () => {
  const service = new SessionRecallService(new FakeSessionRecallDb(
    [
      createConversation('conv-alpha', 'alpha'),
      createConversation('conv-beta', 'beta'),
    ],
    [
      createMetadata('conv-alpha', 'alpha'),
      createMetadata('conv-beta', 'beta'),
    ],
    [],
  ))

  const recent = service.listRecentSessions({
    channelKey: 'local:app',
    userId: 'user-1',
    limit: 10,
  })

  assert.deepEqual(new Set(recent.map((hit) => hit.conversationId)), new Set(['conv-alpha', 'conv-beta']))
})

test('session recall NULL agent rows do not match agent-filtered requests', () => {
  const service = new SessionRecallService(new FakeSessionRecallDb(
    [
      createConversation('conv-alpha', 'alpha'),
      createConversation('conv-orphan', 'alpha'),
    ],
    [
      createMetadata('conv-alpha', 'alpha'),
      createMetadata('conv-orphan', null),
    ],
    [],
  ))

  const filtered = service.listRecentSessions({
    channelKey: 'local:app',
    userId: 'user-1',
    agent: 'alpha',
    limit: 10,
  })

  assert.deepEqual(filtered.map((hit) => hit.conversationId), ['conv-alpha'])
})

test('runtime automatic recall passes scope.agent into SessionRecallService', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- hard runtime wiring contract: full AgentControlRuntime construction requires Electron and app DB wiring.
  const runtime = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/runtime-core/runtime.ts'), 'utf8')
  const autoRecallCall = runtime.match(/getAutoSessionRecallCapsules:\s*\(\{ scope, userText \}\) =>[\s\S]*?this\.sessionRecallService\.getAutomaticRecallCapsules\(\{[\s\S]*?\}\)/)

  assert.ok(autoRecallCall, 'automatic recall runtime call should be found')
  assert.match(autoRecallCall[0], /agent:\s*scope\.agent/)
})

test('DatabaseManager recall metadata write persists conversation.agent', () => {
  const connection = new FakeDatabaseManagerConnection()
  const manager = Object.create(DatabaseManager.prototype) as DatabaseManager
  ;(manager as unknown as { db: DatabaseConnection }).db = connection

  manager.upsertConversationScope({
    id: 'conv-alpha',
    agent: 'alpha',
    userId: 'user-1',
    title: 'Alpha conversation',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'conv-alpha',
    meta: {},
  })

  manager.addChatMessage(
    'msg-alpha',
    'conv-alpha',
    'assistant',
    'latest assistant turn',
    '2026-06-20T09:01:00.000Z',
  )

  assert.equal(connection.metadataWrites.length, 2)
  const [initialWrite, messageWrite] = connection.metadataWrites
  assert.equal(initialWrite[0], 'conv-alpha')
  assert.equal(initialWrite[8], 'alpha')
  assert.equal(initialWrite[9], 'local:app')
  assert.equal(messageWrite[0], 'conv-alpha')
  assert.equal(messageWrite[8], 'alpha')
  assert.equal(messageWrite[9], 'local:app')
  assert.equal(messageWrite[10], 'latest assistant turn')
})

test('reusing a conversation never resets its persisted active agent or handoff generation', () => {
  const connection = new FakeDatabaseManagerConnection()
  const manager = Object.create(DatabaseManager.prototype) as DatabaseManager
  ;(manager as unknown as { db: DatabaseConnection }).db = connection
  const payload = {
    id: 'conv-handoff', agent: 'butler', title: '会话', sourceKind: 'local' as const,
    sourceId: 'app', threadKey: 'conv-handoff', meta: {},
  }
  manager.upsertConversationScope(payload)
  manager.updateConversationAgentState('conv-handoff', 'copywriter', 4)
  const reused = manager.upsertConversationScope({ ...payload, activeAgentId: 'butler', title: '更新标题' })
  assert.equal(reused.mode, 'reused')
  assert.equal(reused.row.active_agent_id, 'copywriter')
  assert.equal(reused.row.handoff_generation, 4)
})
