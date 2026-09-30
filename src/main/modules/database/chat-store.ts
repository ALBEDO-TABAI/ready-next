import type { DatabaseConnection } from './connection'
import type { ConversationSourceKind, ChatConversationRecord, UpsertConversationScopeMode, UpsertConversationScopeResult, ChatMessageRecord, ConversationAttachmentRecord } from './records'
import { performBootSweep, performSessionSweep } from '../ask-user-questions-sweep'

export class ChatStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
  }


  // ===================== Chat History =====================

  createConversation(id: string, agent: string, title: string): void {
    this.upsertConversationScope({
      id,
      agent,
      title,
      sourceKind: 'local',
      sourceId: 'app',
      userId: 'default-user',
      threadKey: id,
      meta: {},
    })
  }

  updateConversationTitle(id: string, title: string): void {
    if (!this.db) return
    const existing = this.getConversationScope(id)
    this.db.prepare(
      'UPDATE chat_conversations SET title = ?, resume_title = ?, updated_at = ? WHERE id = ?'
    ).run(title, title, new Date().toISOString(), id)
    if (existing) this.syncConversationRecallMetadata(id)
  }

  getConversations(agent: string, limit = 50): Array<{ id: string; agent: string; title: string; created_at: string; updated_at: string }> {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT id, agent, title, created_at, updated_at
       FROM chat_conversations
       WHERE agent = ? AND source_kind = 'local'
       ORDER BY updated_at DESC LIMIT ?`
    ).all<{ id: string; agent: string; title: string; created_at: string; updated_at: string }>(agent, limit)
  }

  getConversationScope(id: string): ChatConversationRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM chat_conversations WHERE id = ? LIMIT 1'
    ).get<ChatConversationRecord>(id)
    return row ?? null
  }

  findConversationScope(
    sourceKind: ConversationSourceKind,
    sourceId: string,
    threadKey: string,
    agent: string,
  ): ChatConversationRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      `SELECT * FROM chat_conversations
       WHERE source_kind = ? AND source_id = ? AND thread_key = ? AND agent = ?
       LIMIT 1`
    ).get<ChatConversationRecord>(sourceKind, sourceId, threadKey, agent)
    return row ?? null
  }

  upsertConversationScope(payload: {
    id: string
    agent: string
    activeAgentId?: string
    userId?: string
    title: string
    parentConversationId?: string | null
    lineageRootId?: string | null
    resumeTitle?: string | null
    sourceKind: ConversationSourceKind
    sourceId: string
    threadKey: string
    meta?: Record<string, unknown>
  }): UpsertConversationScopeResult {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing =
      this.getConversationScope(payload.id) ||
      this.findConversationScope(payload.sourceKind, payload.sourceId, payload.threadKey, payload.agent)
    const mode: UpsertConversationScopeMode = existing ? 'reused' : 'inserted'
    const id = existing?.id || payload.id
    const metaJson = JSON.stringify(payload.meta || {})
    this.db.prepare(
      `INSERT INTO chat_conversations (
         id, agent, active_agent_id, handoff_generation, user_id, title, parent_conversation_id, lineage_root_id, resume_title,
         source_kind, source_id, thread_key, meta_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         title = excluded.title,
         parent_conversation_id = excluded.parent_conversation_id,
         lineage_root_id = excluded.lineage_root_id,
         resume_title = excluded.resume_title,
         source_kind = excluded.source_kind,
         source_id = excluded.source_id,
         thread_key = excluded.thread_key,
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`
    ).run(
      id,
      payload.agent,
      existing?.active_agent_id || payload.activeAgentId || payload.agent,
      existing?.handoff_generation ?? 0,
      payload.userId?.trim() || existing?.user_id || null,
      payload.title,
      payload.parentConversationId ?? existing?.parent_conversation_id ?? null,
      payload.lineageRootId || existing?.lineage_root_id || id,
      payload.resumeTitle || existing?.resume_title || payload.title,
      payload.sourceKind,
      payload.sourceId,
      payload.threadKey,
      metaJson,
      existing?.created_at ?? now,
      now,
    )
    this.syncConversationRecallMetadata(id)
    return { row: this.getConversationScope(id)!, mode }
  }

  updateConversationAgentState(
    id: string,
    activeAgentId: string,
    handoffGeneration: number,
  ): ChatConversationRecord {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      'UPDATE chat_conversations SET active_agent_id = ?, handoff_generation = ?, updated_at = ? WHERE id = ?',
    ).run(activeAgentId, handoffGeneration, new Date().toISOString(), id)
    const row = this.getConversationScope(id)
    if (!row) throw new Error(`Conversation not found: ${id}`)
    return row
  }

  listConversationScopes(
    agent?: string,
    limit = 100,
  ): Array<ChatConversationRecord & { last_message_at?: string | null }> {
    if (!this.db) return []
    const sql = agent
      ? `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m WHERE m.conversation_id = c.id
         ) AS last_message_at
         FROM chat_conversations c
         WHERE c.agent = ?
         ORDER BY c.updated_at DESC
         LIMIT ?`
      : `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m WHERE m.conversation_id = c.id
         ) AS last_message_at
         FROM chat_conversations c
         ORDER BY c.updated_at DESC
         LIMIT ?`
    return agent
      ? this.db.prepare(sql).all<ChatConversationRecord & { last_message_at?: string | null }>(agent, limit)
      : this.db.prepare(sql).all<ChatConversationRecord & { last_message_at?: string | null }>(limit)
  }

  deleteConversation(id: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM chat_messages_fts WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM session_recall_attachment_index WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM session_recall_metadata WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
  }

  addChatMessage(
    id: string,
    conversationId: string,
    role: string,
    content: string,
    timestamp: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.db) throw new Error('Database not available')
    const metaJson = JSON.stringify(meta || {})
    this.db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         role = excluded.role,
         content = excluded.content,
         timestamp = excluded.timestamp,
         meta_json = excluded.meta_json`
    ).run(id, conversationId, role, content, timestamp, metaJson)
    this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(id)
    this.db.prepare(
      'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
    ).run(id, conversationId, content || '')
    this.db.prepare(
      'DELETE FROM session_recall_attachment_index WHERE conversation_id = ? AND source_message_id = ?'
    ).run(conversationId, id)
    this.syncConversationRecallAttachments(conversationId, id, timestamp, meta)
    this.syncConversationRecallMetadata(conversationId, {
      previewText: content,
      updatedAt: timestamp,
    })
    // Touch conversation updated_at
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(timestamp, conversationId)
  }

  updateConversationScopeMeta(id: string, meta: Record<string, unknown>): ChatConversationRecord | null {
    if (!this.db) return null
    const existing = this.getConversationScope(id)
    if (!existing) return null
    this.db.prepare('UPDATE chat_conversations SET meta_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta || {}), new Date().toISOString(), id)
    return this.getConversationScope(id)
  }

  updateConversationRecallTaskState(conversationId: string, taskTitle?: string | null, taskSummary?: string | null): void {
    if (!this.db) return
    this.syncConversationRecallMetadata(conversationId, {
      latestTaskTitle: taskTitle ?? null,
      latestTaskSummary: taskSummary ?? null,
    })
  }

  getChatMessages(conversationId: string): ChatMessageRecord[] {
    if (!this.db) return []
    return this.db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all<ChatMessageRecord>(conversationId)
  }

  /**
   * Replace meta_json on an existing chat_messages row. Returns true when a
   * row was updated, false when no row with this id existed.
   *
   * Used by `ask_user_questions` to flip a card from status='pending' to
   * status='submitted' / 'cancelled' / 'timeout' without rewriting role /
   * content / timestamp. Content is also updated optionally so the folded
   * card summary can reflect the user's answers in chat history search
   * (FTS index is replaced when content changes).
   */
  updateChatMessageMeta(
    messageId: string,
    meta: Record<string, unknown>,
    options?: { content?: string },
  ): boolean {
    if (!this.db) return false
    const metaJson = JSON.stringify(meta || {})
    const nextContent = typeof options?.content === 'string' ? options.content : null
    if (nextContent !== null) {
      const info = this.db.prepare(
        'UPDATE chat_messages SET meta_json = ?, content = ? WHERE id = ?'
      ).run(metaJson, nextContent, messageId)
      if ((info as { changes?: number }).changes === 0) return false
      const conversationId = (this.db.prepare(
        'SELECT conversation_id FROM chat_messages WHERE id = ?'
      ).get(messageId) as { conversation_id?: string } | undefined)?.conversation_id || ''
      this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(messageId)
      this.db.prepare(
        'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
      ).run(messageId, conversationId, nextContent)
      return true
    }
    const info = this.db.prepare(
      'UPDATE chat_messages SET meta_json = ? WHERE id = ?'
    ).run(metaJson, messageId)
    return (info as { changes?: number }).changes !== 0
  }

  getChatMessageById(messageId: string): ChatMessageRecord | null {
    if (!this.db) return null
    return this.db.prepare(
      'SELECT * FROM chat_messages WHERE id = ?'
    ).get<ChatMessageRecord>(messageId) ?? null
  }

  /**
   * Find every chat_messages row whose meta_json carries
   * `askUserQuestions.status='pending'`. Used by:
   *   - app boot: sweep to `cancelled (app_restart)` so resurrected rows
   *     never appear in the renderer as永远转圈卡片.
   *   - renderer hydrate (`agent:askUserQuestions:listPending`): show
   *     cards the user hadn't answered yet when the renderer reconnects
   *     mid-flight without restart.
   *
   * Note: `like '%"status":"pending"%'` is a heuristic pre-filter (the
   * exact match is done in JS); we accept a tiny false-positive rate to
   * avoid scanning every chat_messages row. Production volume on the
   * `agent_card` role is small so the filter pays off via the role index.
   */
  listPendingAskUserQuestionsCards(): Array<{
    messageId: string
    conversationId: string
    timestamp: string
    meta: Record<string, unknown>
  }> {
    if (!this.db) return []
    const rows = this.db.prepare(
      "SELECT id, conversation_id, timestamp, meta_json FROM chat_messages WHERE role = 'agent_card' AND meta_json LIKE '%\"status\":\"pending\"%'"
    ).all<{ id: string; conversation_id: string; timestamp: string; meta_json: string | null }>()
    const out: Array<{ messageId: string; conversationId: string; timestamp: string; meta: Record<string, unknown> }> = []
    for (const row of rows) {
      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {}
      } catch {
        continue
      }
      const aug = meta.askUserQuestions
      if (!aug || typeof aug !== 'object') continue
      if ((aug as { status?: unknown }).status !== 'pending') continue
      out.push({
        messageId: row.id,
        conversationId: row.conversation_id,
        timestamp: row.timestamp,
        meta,
      })
    }
    return out
  }

  /**
   * Boot-time sweep: rewrite every pending ask_user_questions card to
   * status='cancelled' with reason='app_restart'. Idempotent. Returns the
   * number of rows mutated for telemetry / logging.
   *
   * Stage U (PR 1, B.4b) — `liveCardIds` lets callers exclude cards whose
   * in-memory Promise resolver is still alive. dev-reload of the main process
   * re-runs `setupAgentIPC`; without this guard the sweep would cancel
   * DB rows for cards still being awaited in memory, then the in-memory
   * Promise eventually times out at 24h with no UI feedback.
   *
   * Callers that genuinely need "cancel everything pending" (initial boot
   * after a hard restart) should pass `liveCardIds=undefined` so the gate
   * is bypassed. The ipc-handler boot path passes the live set from
   * `getAskUserQuestionsStore().list()`.
   *
   * Returns `{ mutated, skippedLive }` so the caller can emit the
   * `ask_user_questions_boot_sweep_skipped_live` metric when warranted.
   */
  sweepPendingAskUserQuestionsCardsOnBoot(
    options: { now?: string; liveCardIds?: ReadonlySet<string> } = {},
  ): { mutated: number; skippedLive: number } {
    if (!this.db) return { mutated: 0, skippedLive: 0 }
    // Pure logic lives in `ask-user-questions-sweep.ts` so behavior tests run
    // on host Node without the better-sqlite3 native gate. This method only
    // injects the DB read + write closures.
    return performBootSweep({
      pending: this.listPendingAskUserQuestionsCards().map((entry) => ({
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        meta: entry.meta,
      })),
      liveCardIds: options.liveCardIds,
      now: options.now ?? new Date().toISOString(),
      updateMeta: (messageId, nextMeta) => this.updateChatMessageMeta(messageId, nextMeta),
    })
  }

  /**
   * Stage U (PR 1, B.4c) — sweep every pending ask_user_questions card
   * belonging to a given session/conversation. Used by session lifecycle
   * hooks (`cleanupSkillSessionState` / `cancelSkillSessionPendingInteractions`)
   * AFTER `getAskUserQuestionsStore().rejectBySession(...)` has dropped the
   * in-memory waiters — that way DB and memory stay aligned.
   *
   * Returns the number of rows mutated; emit
   * `ask_user_questions_session_reset_swept_db` at the call site if > 0.
   */
  sweepPendingAskUserQuestionsCardsBySession(
    sessionId: string,
    cancelReason: string = 'session_reset',
    now: string = new Date().toISOString(),
  ): number {
    if (!this.db) return 0
    if (!sessionId) return 0
    return performSessionSweep({
      pending: this.listPendingAskUserQuestionsCards().map((entry) => ({
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        meta: entry.meta,
      })),
      sessionId,
      cancelReason,
      now,
      updateMeta: (messageId, nextMeta) => this.updateChatMessageMeta(messageId, nextMeta),
    })
  }

  listConversationAttachments(conversationId: string): ConversationAttachmentRecord[] {
    const rows = this.getChatMessages(conversationId)
    if (rows.length === 0) return []

    const seen = new Set<string>()
    const attachments: ConversationAttachmentRecord[] = []
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {}
      } catch {
        meta = {}
      }
      const raw = meta.attachments
      if (!Array.isArray(raw)) continue
      for (let index = raw.length - 1; index >= 0; index -= 1) {
        const item = raw[index]
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const name = String(record.name || '').trim()
        const path = String(record.path || '').trim()
        if (!name || !path) continue
        const attachmentId = String(record.id || `${row.id}-${index}`).trim()
        const key = `${attachmentId}::${path}`
        if (seen.has(key)) continue
        seen.add(key)
        attachments.push({
          attachment_id: attachmentId,
          conversation_id: conversationId,
          source_message_id: row.id,
          name,
          path,
          type: String(record.type || 'other'),
          size: Number(record.size || 0),
          ext: String(record.ext || ''),
          url: typeof record.url === 'string' ? record.url : null,
          mime_type: typeof record.mimeType === 'string' ? record.mimeType : null,
          remote_id: typeof record.remoteId === 'string' ? record.remoteId : null,
          channel_id: typeof meta.channelId === 'string' ? meta.channelId : null,
          thread_key: typeof meta.threadKey === 'string' ? meta.threadKey : null,
          created_at: row.timestamp,
        })
      }
    }
    return attachments
  }

  private syncConversationRecallAttachments(
    conversationId: string,
    sourceMessageId: string,
    createdAt: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.db) return
    const raw = meta?.attachments
    if (!Array.isArray(raw)) return
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index]
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const attachmentId = String(record.id || `${sourceMessageId}-${index}`).trim()
      const path = String(record.path || '').trim()
      const name = String(record.name || '').trim()
      if (!attachmentId || !name) continue
      const attachmentKey = `${conversationId}::${attachmentId}::${path || name}`
      this.db.prepare(`
        INSERT OR REPLACE INTO session_recall_attachment_index (
          attachment_key, conversation_id, attachment_id, source_message_id, name, type, ext, path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachmentKey,
        conversationId,
        attachmentId,
        sourceMessageId,
        name,
        String(record.type || '').trim() || null,
        String(record.ext || '').trim() || null,
        path || null,
        createdAt,
      )
    }
  }

  private syncConversationRecallMetadata(
    conversationId: string,
    overrides?: {
      previewText?: string | null
      latestTaskTitle?: string | null
      latestTaskSummary?: string | null
      updatedAt?: string
    },
  ): void {
    if (!this.db) return
    const conversation = this.getConversationScope(conversationId)
    if (!conversation) return
    const existing = this.db.prepare(`
      SELECT preview_text, latest_task_title, latest_task_summary
      FROM session_recall_metadata
      WHERE conversation_id = ?
      LIMIT 1
    `).get<{
      preview_text?: string | null
      latest_task_title?: string | null
      latest_task_summary?: string | null
    }>(conversationId)
    const attachmentRows = this.db.prepare(`
      SELECT DISTINCT name
      FROM session_recall_attachment_index
      WHERE conversation_id = ?
      ORDER BY created_at DESC, name COLLATE NOCASE ASC
    `).all<{ name: string }>(conversationId)
    const attachmentNames = attachmentRows
      .map((row) => String(row.name || '').trim())
      .filter(Boolean)
      .slice(0, 12)
    const previewText = String(overrides?.previewText ?? existing?.preview_text ?? '').trim()
    const latestTaskTitle = overrides?.latestTaskTitle !== undefined
      ? overrides.latestTaskTitle
      : existing?.latest_task_title ?? null
    const latestTaskSummary = overrides?.latestTaskSummary !== undefined
      ? overrides.latestTaskSummary
      : existing?.latest_task_summary ?? null
    const channelKey = `${conversation.source_kind}:${conversation.source_kind === 'local' ? 'app' : conversation.source_id}`
    this.db.prepare(`
      INSERT INTO session_recall_metadata (
        conversation_id, lineage_root_id, resume_title, title, source_kind, source_id, thread_key,
        user_id, agent, channel_key, preview_text, latest_task_title, latest_task_summary, attachment_names_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        lineage_root_id = excluded.lineage_root_id,
        resume_title = excluded.resume_title,
        title = excluded.title,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        thread_key = excluded.thread_key,
        user_id = excluded.user_id,
        agent = excluded.agent,
        channel_key = excluded.channel_key,
        preview_text = excluded.preview_text,
        latest_task_title = excluded.latest_task_title,
        latest_task_summary = excluded.latest_task_summary,
        attachment_names_json = excluded.attachment_names_json,
        updated_at = excluded.updated_at
    `).run(
      conversationId,
      conversation.lineage_root_id || conversationId,
      conversation.resume_title || conversation.title,
      conversation.title,
      conversation.source_kind,
      conversation.source_id,
      conversation.thread_key,
      conversation.user_id || null,
      conversation.agent || null,
      channelKey,
      previewText ? previewText.slice(0, 280) : null,
      latestTaskTitle || null,
      latestTaskSummary || null,
      JSON.stringify(attachmentNames),
      overrides?.updatedAt || conversation.updated_at,
    )
  }
}
