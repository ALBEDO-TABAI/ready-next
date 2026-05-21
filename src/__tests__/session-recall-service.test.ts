import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionRecallService, type SessionRecallDatabaseAdapter } from '../main/modules/agent-control/session/session-recall-service'
import type { ChatConversationRecord, ConversationSourceKind } from '../main/modules/database'

interface MetadataRow {
  conversation_id: string
  lineage_root_id: string
  resume_title: string
  title: string
  source_kind: ConversationSourceKind
  source_id: string
  thread_key: string
  user_id: string | null
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
    private readonly attachmentRows: Array<{ conversation_id: string; name: string }>,
  ) {}

  getRawDb() {
    const conversations = this.conversations
    const metadataRows = this.metadataRows
    const messageRows = this.messageRows
    const attachmentRows = this.attachmentRows
    const vectorRows = this.vectorRows

    return {
      prepare: (sql: string) => {
        return {
          all<T = unknown>(...params: unknown[]): T[] {
            if (sql.includes('FROM chat_messages_fts')) {
              const query = String(params[0] || '').replace(/"/g, '').toLowerCase()
              return messageRows
                .filter((item) => item.query.toLowerCase().includes(query))
                .map((item) => item.row) as T[]
            }
            if (sql.includes('FROM session_recall_attachment_index') && sql.includes('SELECT DISTINCT conversation_id')) {
              const likeQuery = String(params[0] || '').replaceAll('%', '').toLowerCase()
              return attachmentRows
                .filter((item) => item.name.toLowerCase().includes(likeQuery))
                .map((item) => ({ conversation_id: item.conversation_id })) as T[]
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
            if (sql.includes('FROM session_recall_metadata') && sql.includes('ORDER BY updated_at DESC') && (sql.includes('LIMIT 80') || sql.includes('LIMIT 240'))) {
              return [...metadataRows].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as T[]
            }
            if (sql.includes('FROM chat_conversations') && sql.includes('ORDER BY updated_at DESC')) {
              return [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) as T[]
            }
            return [] as T[]
          },
          get<T = unknown>(...params: unknown[]): T | undefined {
            if (sql.includes('FROM session_recall_metadata') && sql.includes('WHERE conversation_id = ?')) {
              return metadataRows.find((row) => row.conversation_id === params[0]) as T | undefined
            }
            if (sql.includes('FROM session_recall_metadata') && sql.includes('WHERE resume_title = ?')) {
              return [...metadataRows]
                .filter((row) => row.resume_title === params[0])
                .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] as T | undefined
            }
            if (sql.includes('FROM session_recall_vectors') && sql.includes('WHERE conversation_id = ?')) {
              const row = vectorRows.get(String(params[0] || ''))
              if (!row) return undefined
              return {
                conversation_id: String(params[0] || ''),
                ...row,
              } as T
            }
            return undefined
          },
          run(...params: unknown[]) {
            if (sql.includes('INTO session_recall_vectors')) {
              const conversationId = String(params[0] || '')
              vectorRows.set(conversationId, {
                content_hash: String(params[1] || ''),
                vector_version: String(params[2] || ''),
                vector_json: String(params[3] || ''),
                updated_at: String(params[4] || ''),
              })
              return { changes: 1 }
            }
            return { changes: 0 }
          },
        }
      },
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

function createConversation(params: {
  id: string
  title: string
  sourceKind?: ConversationSourceKind
  sourceId?: string
  threadKey?: string
  parentConversationId?: string | null
  lineageRootId?: string | null
  resumeTitle?: string | null
  meta?: Record<string, unknown>
  updatedAt?: string
}): ChatConversationRecord {
  return {
    id: params.id,
    agent: 'butler',
    user_id: null,
    title: params.title,
    parent_conversation_id: params.parentConversationId ?? null,
    lineage_root_id: params.lineageRootId || params.id,
    resume_title: params.resumeTitle || params.title,
    source_kind: params.sourceKind || 'local',
    source_id: params.sourceId || 'app',
    thread_key: params.threadKey || params.id,
    meta_json: JSON.stringify(params.meta || {}),
    created_at: '2026-04-12T09:00:00.000Z',
    updated_at: params.updatedAt || '2026-04-12T09:00:00.000Z',
  }
}

function createMetadata(params: Partial<MetadataRow> & Pick<MetadataRow, 'conversation_id' | 'title'>): MetadataRow {
  const sourceKind = params.source_kind || 'local'
  const sourceId = params.source_id || 'app'
  return {
    conversation_id: params.conversation_id,
    lineage_root_id: params.lineage_root_id || params.conversation_id,
    resume_title: params.resume_title || params.title,
    title: params.title,
    source_kind: sourceKind,
    source_id: sourceId,
    thread_key: params.thread_key || params.conversation_id,
    user_id: params.user_id ?? null,
    channel_key: params.channel_key || `${sourceKind}:${sourceKind === 'local' ? 'app' : sourceId}`,
    preview_text: params.preview_text ?? null,
    latest_task_title: params.latest_task_title ?? null,
    latest_task_summary: params.latest_task_summary ?? null,
    attachment_names_json: params.attachment_names_json || '[]',
    updated_at: params.updated_at || '2026-04-12T09:00:00.000Z',
  }
}

test('SessionRecallService groups same-lineage matches and excludes current lineage from search', () => {
  const conversations = [
    createConversation({ id: 'conv-root-a', title: '品牌共创', lineageRootId: 'conv-root-a', resumeTitle: '品牌共创' }),
    createConversation({
      id: 'conv-child-a',
      title: '品牌共创 #2',
      parentConversationId: 'conv-root-a',
      lineageRootId: 'conv-root-a',
      resumeTitle: '品牌共创',
    }),
    createConversation({ id: 'conv-b', title: '海报素材整理', lineageRootId: 'conv-b', resumeTitle: '海报素材整理' }),
  ]
  const metadata = [
    createMetadata({
      conversation_id: 'conv-root-a',
      title: '品牌共创',
      lineage_root_id: 'conv-root-a',
      resume_title: '品牌共创',
      preview_text: '先整理 logo 方向和品牌语气',
      updated_at: '2026-04-12T10:00:00.000Z',
    }),
    createMetadata({
      conversation_id: 'conv-child-a',
      title: '品牌共创 #2',
      lineage_root_id: 'conv-root-a',
      resume_title: '品牌共创',
      preview_text: '已经补了一版 logo 风格提案',
      latest_task_title: '品牌提案',
      latest_task_summary: '已完成 logo 风格提案',
      updated_at: '2026-04-12T11:00:00.000Z',
    }),
    createMetadata({
      conversation_id: 'conv-b',
      title: '海报素材整理',
      lineage_root_id: 'conv-b',
      resume_title: '海报素材整理',
      preview_text: '这里有一份旧海报素材清单，里面也提到了 logo 参考板。',
      attachment_names_json: JSON.stringify(['brand-logo-board.png']),
      updated_at: '2026-04-12T12:00:00.000Z',
    }),
  ]
  const db = new FakeSessionRecallDb(
    conversations,
    metadata,
    [
      { query: 'logo', row: { conversation_id: 'conv-child-a', excerpt: '已经补了一版 [logo] 风格提案' } },
      { query: 'logo', row: { conversation_id: 'conv-b', excerpt: '旧海报素材清单里提到了 [logo] 参考板' } },
    ],
    [
      { conversation_id: 'conv-b', name: 'brand-logo-board.png' },
    ],
  )
  const service = new SessionRecallService(db)

  const hits = service.searchSessionRecall({
    query: 'logo',
    currentScopeId: 'conv-root-a',
    limit: 10,
  })

  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.conversationId, 'conv-b')
  assert.deepEqual(hits[0]?.matchedBy, ['message', 'attachment', 'semantic'])
  assert.match(hits[0]?.hitExcerpt || '', /logo/i)
})

test('SessionRecallService returns grouped recent sessions and builds recall capsules from metadata', () => {
  const db = new FakeSessionRecallDb(
    [
      createConversation({ id: 'conv-root-a', title: '品牌共创', lineageRootId: 'conv-root-a', resumeTitle: '品牌共创' }),
      createConversation({
        id: 'conv-child-a',
        title: '品牌共创 #2',
        parentConversationId: 'conv-root-a',
        lineageRootId: 'conv-root-a',
        resumeTitle: '品牌共创',
      }),
      createConversation({
        id: 'conv-c',
        title: '直播封面草稿',
        sourceKind: 'channel',
        sourceId: 'channel-feishu-default',
        threadKey: 'om_001',
        lineageRootId: 'conv-c',
        resumeTitle: '直播封面草稿',
      }),
    ],
    [
      createMetadata({
        conversation_id: 'conv-child-a',
        title: '品牌共创 #2',
        lineage_root_id: 'conv-root-a',
        resume_title: '品牌共创',
        preview_text: '这轮已经把品牌方向收紧为更克制的现代风格。',
        latest_task_title: '品牌提案',
        latest_task_summary: '已完成品牌方向和 logo 风格提案',
        attachment_names_json: JSON.stringify(['brand-board.pdf']),
        updated_at: '2026-04-12T11:05:00.000Z',
      }),
      createMetadata({
        conversation_id: 'conv-c',
        title: '直播封面草稿',
        lineage_root_id: 'conv-c',
        resume_title: '直播封面草稿',
        source_kind: 'channel',
        source_id: 'channel-feishu-default',
        thread_key: 'om_001',
        channel_key: 'channel:channel-feishu-default',
        preview_text: '这条线程在讨论直播封面上的标题文案。',
        updated_at: '2026-04-12T12:00:00.000Z',
      }),
    ],
    [],
    [],
  )
  const service = new SessionRecallService(db)

  const recent = service.listRecentSessions({ limit: 10 })
  assert.equal(recent.length, 2)
  assert.equal(recent[0]?.conversationId, 'conv-c')
  assert.equal(recent[1]?.conversationId, 'conv-child-a')

  const capsule = service.getSessionRecallCapsule({ conversationId: 'conv-child-a' })
  assert.ok(capsule)
  assert.equal(capsule?.conversationId, 'conv-child-a')
  assert.equal(capsule?.lineageRootId, 'conv-root-a')
  assert.match(capsule?.summary || '', /品牌方向/)
  assert.match(capsule?.summary || '', /logo 风格提案/)
  assert.deepEqual(capsule?.attachmentNames, ['brand-board.pdf'])
})

test('SessionRecallService shows conversations even when recall metadata is missing', () => {
  const db = new FakeSessionRecallDb(
    [
      createConversation({
        id: 'conv-indexed',
        title: '已有索引',
        lineageRootId: 'conv-indexed',
        resumeTitle: '已有索引',
        updatedAt: '2026-04-12T11:00:00.000Z',
      }),
      createConversation({
        id: 'conv-unindexed',
        title: '刚刚产生的会话',
        lineageRootId: 'conv-unindexed',
        resumeTitle: '刚刚产生的会话',
        updatedAt: '2026-04-12T12:00:00.000Z',
      }),
    ],
    [
      createMetadata({
        conversation_id: 'conv-indexed',
        title: '已有索引',
        lineage_root_id: 'conv-indexed',
        resume_title: '已有索引',
        preview_text: '这条已有召回索引。',
        updated_at: '2026-04-12T11:00:00.000Z',
      }),
    ],
    [],
    [],
  )
  const service = new SessionRecallService(db)

  const recent = service.listRecentSessions({ limit: 10 })
  assert.equal(recent[0]?.conversationId, 'conv-unindexed')
  assert.equal(recent[0]?.title, '刚刚产生的会话')

  const search = service.searchSessionRecall({ query: '刚刚产生', limit: 10 })
  assert.equal(search[0]?.conversationId, 'conv-unindexed')
  assert.equal(service.getSessionRecallCapsule({ conversationId: 'conv-unindexed' })?.title, '刚刚产生的会话')
})

test('SessionRecallService listRecentSessions falls back to soft-exclude when current lineage is the only one', () => {
  // Regression for "历史对话" popover showing empty when DB has a single conv
  // and the user is currently in it. The strict lineage exclusion in
  // matchesFilters filtered the only metadata row out → popover空无一物.
  // listRecentSessions should retry without the lineage exclusion in that
  // case and surface the row with matchedBy=['recent_self_lineage'].
  const conversations = [
    createConversation({ id: 'conv-solo', title: '唯一会话', lineageRootId: 'conv-solo', resumeTitle: '唯一会话' }),
  ]
  const metadata = [
    createMetadata({
      conversation_id: 'conv-solo',
      title: '唯一会话',
      lineage_root_id: 'conv-solo',
      resume_title: '唯一会话',
      preview_text: '只有这一条历史，且用户正在它里面。',
      updated_at: '2026-04-12T13:00:00.000Z',
    }),
  ]
  const db = new FakeSessionRecallDb(conversations, metadata, [], [])
  const service = new SessionRecallService(db)

  const recent = service.listRecentSessions({ currentScopeId: 'conv-solo', limit: 10 })
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.conversationId, 'conv-solo')
  assert.deepEqual(recent[0]?.matchedBy, ['recent_self_lineage'])
})

test('SessionRecallService listRecentSessions keeps hard-excluding current lineage when others exist', () => {
  // When other lineages are available, the lineage exclusion still applies —
  // soft-exclude is only the empty-result fallback.
  const conversations = [
    createConversation({ id: 'conv-current', title: '正在用', lineageRootId: 'conv-current', resumeTitle: '正在用' }),
    createConversation({ id: 'conv-other', title: '另一条', lineageRootId: 'conv-other', resumeTitle: '另一条' }),
  ]
  const metadata = [
    createMetadata({
      conversation_id: 'conv-current',
      title: '正在用',
      lineage_root_id: 'conv-current',
      resume_title: '正在用',
      preview_text: '当前 scope，不应进入 recent 列表。',
      updated_at: '2026-04-12T14:00:00.000Z',
    }),
    createMetadata({
      conversation_id: 'conv-other',
      title: '另一条',
      lineage_root_id: 'conv-other',
      resume_title: '另一条',
      preview_text: '另一条历史，应进入 recent 列表。',
      updated_at: '2026-04-12T13:00:00.000Z',
    }),
  ]
  const db = new FakeSessionRecallDb(conversations, metadata, [], [])
  const service = new SessionRecallService(db)

  const recent = service.listRecentSessions({ currentScopeId: 'conv-current', limit: 10 })
  assert.equal(recent.length, 1)
  assert.equal(recent[0]?.conversationId, 'conv-other')
  assert.deepEqual(recent[0]?.matchedBy, ['recent'])
})

test('SessionRecallService can attach, list, detach, and resume recall contexts', () => {
  const conversations = [
    createConversation({ id: 'scope-current', title: '当前会话', lineageRootId: 'scope-current', resumeTitle: '当前会话' }),
    createConversation({ id: 'conv-old', title: '旧会话', lineageRootId: 'conv-old', resumeTitle: '项目复盘' }),
    createConversation({
      id: 'conv-old-2',
      title: '旧会话 #2',
      parentConversationId: 'conv-old',
      lineageRootId: 'conv-old',
      resumeTitle: '项目复盘',
    }),
  ]
  const db = new FakeSessionRecallDb(
    conversations,
    [
      createMetadata({
        conversation_id: 'conv-old-2',
        title: '旧会话 #2',
        lineage_root_id: 'conv-old',
        resume_title: '项目复盘',
        preview_text: '这是上一轮项目复盘的关键结论。',
        updated_at: '2026-04-12T12:00:00.000Z',
      }),
    ],
    [],
    [],
  )
  const service = new SessionRecallService(db)

  const attach = service.attachSessionRecallContext({
    currentScopeId: 'scope-current',
    conversationId: 'conv-old-2',
  })

  assert.equal(attach.scope.id, 'scope-current')
  assert.equal(attach.capsule.conversationId, 'conv-old-2')

  const attached = service.listAttachedSessionRecallContexts('scope-current')
  assert.equal(attached.length, 1)
  assert.equal(attached[0]?.conversationId, 'conv-old-2')

  const resumed = service.resumeSessionCandidate({ resumeTitle: '项目复盘' })
  assert.equal(resumed?.conversationId, 'conv-old-2')

  const detached = service.detachSessionRecallContext({
    currentScopeId: 'scope-current',
    conversationId: 'conv-old-2',
  })
  assert.equal(detached.scope.id, 'scope-current')
  assert.equal(service.listAttachedSessionRecallContexts('scope-current').length, 0)
})

test('SessionRecallService persists local vectors and adds semantic matches into recall results', () => {
  const db = new FakeSessionRecallDb(
    [
      createConversation({ id: 'conv-brand', title: '品牌共创', lineageRootId: 'conv-brand', resumeTitle: '品牌共创' }),
      createConversation({ id: 'conv-calendar', title: '日程整理', lineageRootId: 'conv-calendar', resumeTitle: '日程整理' }),
    ],
    [
      createMetadata({
        conversation_id: 'conv-brand',
        title: '品牌共创',
        preview_text: '这一轮把品牌视觉方向收紧成更克制的现代感表达。',
        latest_task_summary: '已确认品牌方向和整体风格',
        updated_at: '2026-04-12T10:00:00.000Z',
      }),
      createMetadata({
        conversation_id: 'conv-calendar',
        title: '日程整理',
        preview_text: '这里主要在处理会议和排期。',
        latest_task_summary: '已完成排期整理',
        updated_at: '2026-04-12T09:00:00.000Z',
      }),
    ],
    [],
    [],
  )
  const service = new SessionRecallService(db)

  const hits = service.searchSessionRecall({
    query: '品牌风格方向',
    limit: 5,
  })

  assert.ok(db.vectorRows.has('conv-brand'))
  assert.ok(hits.some((item) => item.conversationId === 'conv-brand' && item.matchedBy.includes('semantic')))
})

test('SessionRecallService selects only top high-signal automatic recall capsules', () => {
  const db = new FakeSessionRecallDb(
    [
      createConversation({ id: 'scope-current', title: '当前会话', lineageRootId: 'scope-current', resumeTitle: '当前会话' }),
      createConversation({ id: 'conv-brand', title: '品牌共创', lineageRootId: 'conv-brand', resumeTitle: '品牌共创' }),
      createConversation({ id: 'conv-weak', title: '日程整理', lineageRootId: 'conv-weak', resumeTitle: '日程整理' }),
    ],
    [
      createMetadata({
        conversation_id: 'conv-brand',
        title: '品牌共创',
        preview_text: '上次已经确定品牌方向要更克制，并保留 logo 风格线索。',
        latest_task_summary: '已完成品牌方向和 logo 风格提案',
        updated_at: '2026-04-12T10:00:00.000Z',
      }),
      createMetadata({
        conversation_id: 'conv-weak',
        title: '日程整理',
        preview_text: '这里主要是会议和排期。',
        latest_task_summary: '已完成排期整理',
        updated_at: '2026-04-12T09:00:00.000Z',
      }),
    ],
    [],
    [],
  )
  const service = new SessionRecallService(db)

  const capsules = service.getAutomaticRecallCapsules({
    query: '继续做品牌方向和 logo 风格',
    currentScopeId: 'scope-current',
    channelKey: 'local:app',
    limit: 2,
  })

  assert.equal(capsules.length, 1)
  assert.equal(capsules[0]?.conversationId, 'conv-brand')
})
