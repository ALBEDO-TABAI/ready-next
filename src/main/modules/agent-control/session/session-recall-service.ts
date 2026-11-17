import type { ChatConversationRecord, ConversationSourceKind } from '../../database/records'
import { createHash } from 'crypto'
import type { SessionRecallCapsule, SessionRecallContextRef, SessionRecallHit, SessionRecallMatchKind, SessionRecallSessionStatus } from '../../../../shared/session-recall'

interface SessionRecallMetadataRow {
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

interface SearchMessageRow {
  conversation_id: string
  excerpt: string
}

interface SessionRecallStatement {
  run?(...params: unknown[]): unknown
  all<T = unknown>(...params: unknown[]): T[]
  get<T = unknown>(...params: unknown[]): T | undefined
}

interface SessionRecallRawDb {
  prepare(sql: string): SessionRecallStatement
}

export interface SessionRecallDatabaseAdapter {
  getRawDb(): SessionRecallRawDb | null
  chat: {
  getConversationScope(id: string): ChatConversationRecord | null
  updateConversationScopeMeta(
    id: string,
    meta: Record<string, unknown>,
    expectedMessageVisibilityEpoch?: number,
  ): ChatConversationRecord | null
  }
}

interface SessionRecallVectorRow {
  conversation_id: string
  content_hash: string
  vector_version: string
  vector_json: string
  updated_at: string
}

const SESSION_RECALL_VECTOR_VERSION = 'hashing-v1'
const SESSION_RECALL_RESULT_LIMIT_MAX = 80
// D4: Cap session_recall_vectors growth — keep at most this many most-recent
// rows per write. vector_json can be sizable (per-conv hashing vectors); without
// a cap, table grows linearly with conversation count for the lifetime of the app.
const SESSION_RECALL_VECTORS_LRU_CAP = 200
const SESSION_RECALL_VECTOR_DIMENSIONS = 256

export class SessionRecallService {
  constructor(private readonly db: SessionRecallDatabaseAdapter) {}

  searchSessionRecall(params: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    const query = String(params.query || '').trim()
    if (!query) {
      return this.listRecentSessions(params)
    }

    const exclusionLineageRootId = this.resolveExcludedLineageRootId(params.currentScopeId)
    const hits = new Map<string, SessionRecallHit>()

    for (const row of this.searchMessageMatches(query)) {
      const metadata = this.getMetadataRow(row.conversation_id)
      if (!metadata || !this.matchesFilters(metadata, params, exclusionLineageRootId)) continue
      this.mergeHit(hits, metadata, 'message', 60, row.excerpt)
    }

    for (const metadata of this.searchMetadataMatches(query)) {
      if (!this.matchesFilters(metadata, params, exclusionLineageRootId)) continue
      const lowerQuery = query.toLowerCase()
      const matchedBy: SessionRecallMatchKind[] = []
      let score = 0
      if (metadata.title.toLowerCase().includes(lowerQuery) || metadata.resume_title.toLowerCase().includes(lowerQuery)) {
        matchedBy.push('title')
        score += 45
      }
      if ((metadata.latest_task_title || '').toLowerCase().includes(lowerQuery) || (metadata.latest_task_summary || '').toLowerCase().includes(lowerQuery)) {
        matchedBy.push('task')
        score += 40
      }
      const attachmentNames = this.parseAttachmentNames(metadata.attachment_names_json)
      if (attachmentNames.some((name) => name.toLowerCase().includes(lowerQuery))) {
        matchedBy.push('attachment')
        score += 35
      }
      if (matchedBy.length === 0) continue
      for (const matchKind of matchedBy) {
        const excerpt = matchKind === 'task'
          ? metadata.latest_task_summary || metadata.latest_task_title || metadata.preview_text
          : matchKind === 'attachment'
            ? attachmentNames.find((name) => name.toLowerCase().includes(lowerQuery)) || metadata.preview_text
            : metadata.preview_text
        this.mergeHit(hits, metadata, matchKind, score, excerpt)
      }
    }

    for (const vectorHit of this.searchVectorMatches(query, params, exclusionLineageRootId)) {
      const metadata = this.getMetadataRow(vectorHit.conversationId)
      if (!metadata || !this.matchesFilters(metadata, params, exclusionLineageRootId)) continue
      this.mergeHit(hits, metadata, 'semantic', vectorHit.score, vectorHit.excerpt)
    }

    return this.groupAndLimitHits(Array.from(hits.values()), params.limit)
  }

  listRecentSessions(params?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    const exclusionLineageRootId = this.resolveExcludedLineageRootId(params?.currentScopeId)
    const metadata = this.listRecentMetadata()
    const rows = metadata.filter((row) => this.matchesFilters(row, params || {}, exclusionLineageRootId))
    if (rows.length > 0) {
      const hits = rows.map((row) => this.buildHit(row, ['recent'], 20, row.preview_text))
      return this.groupAndLimitHits(hits, params?.limit)
    }
    // Soft-exclude fallback: when the strict filter wipes everything (typical
    // when the DB has a single lineage and the user is currently in it),
    // retry without the lineage exclusion so the "历史对话" popover honors
    // its "这里会先显示当前频道最近会话" promise. The keyword search path
    // (`searchSessionRecall`) keeps the hard exclusion — users searching for
    // an old topic shouldn't see their current scope as a hit.
    const fallbackRows = metadata.filter((row) => this.matchesFilters(row, params || {}, null))
    const fallbackHits = fallbackRows.map((row) => this.buildHit(row, ['recent_self_lineage'], 15, row.preview_text))
    return this.groupAndLimitHits(fallbackHits, params?.limit)
  }

  getAutomaticRecallCapsules(params: {
    query: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallCapsule[] {
    const normalized = String(params.query || '').trim()
    if (normalized.length < 4) return []
    const hits = this.searchSessionRecall({
      ...params,
      query: normalized,
      limit: Math.max(1, Math.min(4, Number(params.limit || 2))),
    })
    return hits
      .filter((hit) => hit.score >= 32)
      .slice(0, Math.max(1, Math.min(4, Number(params.limit || 2))))
      .map((hit) => this.getSessionRecallCapsule({ conversationId: hit.conversationId }))
      .filter(Boolean) as SessionRecallCapsule[]
  }

  getSessionRecallCapsule(params: { conversationId: string }): SessionRecallCapsule | null {
    const metadata = this.getMetadataRow(params.conversationId)
    if (!metadata) return null
    return this.buildCapsule(metadata)
  }

  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[] {
    const scope = this.db.chat.getConversationScope(scopeId)
    if (!scope) return []
    const refs = this.readSessionRecallContextRefs(scope)
    return refs
      .map((ref) => {
        const metadata = this.getMetadataRow(ref.conversationId)
        if (!metadata || !this.canAttachSessionRecallContext(scope, metadata)) return null
        return this.buildCapsule(metadata)
      })
      .filter(Boolean) as SessionRecallCapsule[]
  }

  attachSessionRecallContext(params: {
    currentScopeId: string
    conversationId: string
    expectedMessageVisibilityEpoch: number
  }): {
    scope: ChatConversationRecord
    capsule: SessionRecallCapsule
  } {
    const scope = this.db.chat.getConversationScope(params.currentScopeId)
    if (!scope) throw new Error(`Conversation scope not found: ${params.currentScopeId}`)
    if ((scope.message_visibility_epoch ?? 0) !== params.expectedMessageVisibilityEpoch) {
      throw new Error('conversation_context_epoch_stale')
    }
    const metadata = this.getMetadataRow(params.conversationId)
    if (!metadata) throw new Error(`Session recall capsule not found: ${params.conversationId}`)
    if (!this.canAttachSessionRecallContext(scope, metadata)) {
      throw new Error('Session recall context belongs to a different agent')
    }
    const capsule = this.buildCapsule(metadata)
    const refs = this.readSessionRecallContextRefs(scope)
    if (!refs.some((item) => item.conversationId === params.conversationId)) {
      refs.push({
        conversationId: params.conversationId,
        attachedAt: new Date().toISOString(),
      })
    }
    const nextMeta = {
      ...this.parseConversationMeta(scope),
      sessionRecallContext: refs,
    }
    const updatedScope = this.db.chat.updateConversationScopeMeta(
      params.currentScopeId,
      nextMeta,
      params.expectedMessageVisibilityEpoch,
    )
    if (!updatedScope) throw new Error('conversation_context_epoch_stale')
    return {
      scope: updatedScope,
      capsule,
    }
  }

  detachSessionRecallContext(params: {
    currentScopeId: string
    conversationId: string
    expectedMessageVisibilityEpoch: number
  }): {
    scope: ChatConversationRecord
  } {
    const scope = this.db.chat.getConversationScope(params.currentScopeId)
    if (!scope) throw new Error(`Conversation scope not found: ${params.currentScopeId}`)
    if ((scope.message_visibility_epoch ?? 0) !== params.expectedMessageVisibilityEpoch) {
      throw new Error('conversation_context_epoch_stale')
    }
    const refs = this.readSessionRecallContextRefs(scope)
      .filter((item) => item.conversationId !== params.conversationId)
    const nextMeta = {
      ...this.parseConversationMeta(scope),
      sessionRecallContext: refs,
    }
    const updatedScope = this.db.chat.updateConversationScopeMeta(
      params.currentScopeId,
      nextMeta,
      params.expectedMessageVisibilityEpoch,
    )
    if (!updatedScope) throw new Error('conversation_context_epoch_stale')
    return { scope: updatedScope }
  }

  /**
   * skill-resume E1 — when the user issues a bare retry/continue intent
   * ("继续 / 接着 / 恢复 ...") on a scope that has no manually-attached recall
   * refs, auto-attach the top-N predecessors in the same lineage_root so the
   * prompt assembler picks up prior context (which the LLM needs to know what
   * "继续" actually means). No-op when:
   *   - scope already has attached refs (user/UI already chose),
   *   - scope is the only conv in its lineage (no peers to attach), or
   *   - DB is unreachable.
   * Returns the actually-attached capsules so the caller can emit a metric /
   * surface them in UI.
   */
  autoAttachOnResume(params: {
    currentScopeId: string
    intent: 'continue'
    expectedMessageVisibilityEpoch: number
    limit?: number
  }): { attached: SessionRecallCapsule[] } {
    const limit = Math.max(1, Math.min(5, Number(params.limit ?? 3)))
    const scope = this.db.chat.getConversationScope(params.currentScopeId)
    if (!scope) return { attached: [] }
    if ((scope.message_visibility_epoch ?? 0) !== params.expectedMessageVisibilityEpoch) {
      return { attached: [] }
    }
    const existingRefs = this.readSessionRecallContextRefs(scope)
    if (existingRefs.length > 0) return { attached: [] }
    const lineageRootId = scope.lineage_root_id || scope.id
    const db = this.db.getRawDb()
    if (!db) return { attached: [] }
    const candidates = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE lineage_root_id = ? AND conversation_id != ? AND COALESCE(agent, '') = ?
        AND EXISTS (
          SELECT 1 FROM chat_conversations active
           WHERE active.id = session_recall_metadata.conversation_id
             AND active.closed_at IS NULL
        )
      ORDER BY updated_at DESC
      LIMIT ?
    `).all<SessionRecallMetadataRow>(lineageRootId, params.currentScopeId, scope.agent || '', limit)
    if (candidates.length === 0) return { attached: [] }
    const attached: SessionRecallCapsule[] = []
    for (const row of candidates) {
      try {
        const result = this.attachSessionRecallContext({
          currentScopeId: params.currentScopeId,
          conversationId: row.conversation_id,
          expectedMessageVisibilityEpoch: params.expectedMessageVisibilityEpoch,
        })
        attached.push(result.capsule)
      } catch {
        // Skip individual attach failures; auto-attach is best-effort.
      }
    }
    return { attached }
  }

  resumeSessionCandidate(params: { conversationId?: string; resumeTitle?: string }): SessionRecallHit | null {
    if (params.conversationId) {
      const metadata = this.getMetadataRow(params.conversationId)
      return metadata ? this.buildHit(metadata, ['recent'], 20, metadata.preview_text) : null
    }
    const resumeTitle = String(params.resumeTitle || '').trim()
    if (!resumeTitle) return null
    const db = this.db.getRawDb()
    if (!db) return null
    const metadata = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE resume_title = ?
        AND EXISTS (
          SELECT 1 FROM chat_conversations active
           WHERE active.id = session_recall_metadata.conversation_id
             AND active.closed_at IS NULL
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SessionRecallMetadataRow>(resumeTitle)
    const active = metadata ? this.getMetadataRow(metadata.conversation_id) : null
    return active ? this.buildHit(active, ['recent'], 20, active.preview_text) : null
  }

  private searchMessageMatches(query: string): SearchMessageRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    return db.prepare(`
      SELECT chat_messages_fts.conversation_id,
             snippet(chat_messages_fts, 2, '[', ']', ' … ', 18) as excerpt
      FROM chat_messages_fts
      JOIN chat_messages message ON message.id = chat_messages_fts.message_id
      JOIN chat_conversations active ON active.id = message.conversation_id
      WHERE chat_messages_fts.content MATCH ?
        AND active.closed_at IS NULL
        AND message.message_visibility_epoch = active.message_visibility_epoch
      LIMIT 60
    `).all<SearchMessageRow>(this.toFtsQuery(query))
  }

  private searchMetadataMatches(query: string): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    const likeQuery = `%${query}%`
    const attachmentConversationIds = db.prepare(`
      SELECT DISTINCT attachment.conversation_id
      FROM session_recall_attachment_index attachment
      JOIN chat_messages message ON message.id = attachment.source_message_id
      JOIN chat_conversations active ON active.id = message.conversation_id
      WHERE attachment.name LIKE ?
        AND active.closed_at IS NULL
        AND message.message_visibility_epoch = active.message_visibility_epoch
        AND message.replaced_by_run_id IS NULL
    `).all<{ conversation_id: string }>(likeQuery).map((row) => row.conversation_id)
    const directMatches = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE title LIKE ?
         OR resume_title LIKE ?
         OR COALESCE(latest_task_title, '') LIKE ?
         OR COALESCE(latest_task_summary, '') LIKE ?
    `).all<SessionRecallMetadataRow>(likeQuery, likeQuery, likeQuery, likeQuery)
    const lowerQuery = query.toLowerCase()
    const conversationMatches = this.listRecentConversationMetadata()
      .filter((row) => (
        row.title.toLowerCase().includes(lowerQuery) ||
        row.resume_title.toLowerCase().includes(lowerQuery)
      ))
    if (attachmentConversationIds.length === 0) {
      const merged = new Map<string, SessionRecallMetadataRow>()
      for (const row of [...directMatches, ...conversationMatches]) merged.set(row.conversation_id, row)
      return Array.from(merged.values()).filter(
        (row) => Boolean(this.db.chat.getConversationScope(row.conversation_id)),
      )
    }
    const placeholders = attachmentConversationIds.map(() => '?').join(', ')
    const attachmentMatches = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE conversation_id IN (${placeholders})
    `).all<SessionRecallMetadataRow>(...attachmentConversationIds)
    const merged = new Map<string, SessionRecallMetadataRow>()
    for (const row of [...directMatches, ...attachmentMatches, ...conversationMatches]) merged.set(row.conversation_id, row)
    return Array.from(merged.values()).filter(
      (row) => Boolean(this.db.chat.getConversationScope(row.conversation_id)),
    )
  }

  private listRecentMetadata(): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    const metadataRows = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE EXISTS (
        SELECT 1 FROM chat_conversations active
         WHERE active.id = session_recall_metadata.conversation_id
           AND active.closed_at IS NULL
      )
      ORDER BY updated_at DESC
      LIMIT 80
    `).all<SessionRecallMetadataRow>()
    const merged = new Map<string, SessionRecallMetadataRow>()
    for (const row of [...metadataRows, ...this.listRecentConversationMetadata()]) {
      if (!merged.has(row.conversation_id)) merged.set(row.conversation_id, row)
    }
    return Array.from(merged.values())
      .filter((row) => Boolean(this.db.chat.getConversationScope(row.conversation_id)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 80)
  }

  private listVectorSearchMetadata(): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    return db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE EXISTS (
        SELECT 1 FROM chat_conversations active
         WHERE active.id = session_recall_metadata.conversation_id
           AND active.closed_at IS NULL
      )
      ORDER BY updated_at DESC
      LIMIT 240
    `).all<SessionRecallMetadataRow>().filter(
      (row) => Boolean(this.db.chat.getConversationScope(row.conversation_id)),
    )
  }

  private getMetadataRow(conversationId: string): SessionRecallMetadataRow | null {
    if (!this.db.chat.getConversationScope(conversationId)) return null
    const db = this.db.getRawDb()
    if (!db) return null
    const row = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE conversation_id = ?
      LIMIT 1
    `).get<SessionRecallMetadataRow>(conversationId)
    return row || this.getConversationFallbackMetadata(conversationId)
  }

  private listRecentConversationMetadata(): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    const rows = db.prepare(`
      SELECT *
      FROM chat_conversations
      WHERE closed_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 80
    `).all<ChatConversationRecord>()
    return rows.map((row) => this.metadataFromConversation(row))
  }

  private getConversationFallbackMetadata(conversationId: string): SessionRecallMetadataRow | null {
    const row = this.db.chat.getConversationScope(conversationId)
    return row ? this.metadataFromConversation(row) : null
  }

  private metadataFromConversation(row: ChatConversationRecord): SessionRecallMetadataRow {
    const sourceKind = row.source_kind
    const sourceId = row.source_id || (sourceKind === 'local' ? 'app' : '')
    return {
      conversation_id: row.id,
      lineage_root_id: row.lineage_root_id || row.id,
      resume_title: row.resume_title || row.title || '新对话',
      title: row.title || row.resume_title || '新对话',
      source_kind: sourceKind,
      source_id: sourceId,
      thread_key: row.thread_key || row.id,
      user_id: row.user_id || null,
      agent: row.agent || null,
      channel_key: `${sourceKind}:${sourceKind === 'local' ? 'app' : sourceId}`,
      preview_text: null,
      latest_task_title: null,
      latest_task_summary: null,
      attachment_names_json: '[]',
      updated_at: row.updated_at,
    }
  }

  private resolveExcludedLineageRootId(currentScopeId?: string): string | null {
    if (!currentScopeId) return null
    const scope = this.db.chat.getConversationScope(currentScopeId)
    if (!scope) return null
    return scope.lineage_root_id || scope.id
  }

  private matchesFilters(
    metadata: SessionRecallMetadataRow,
    params: {
      channelKey?: string
      sourceKind?: ConversationSourceKind
      userId?: string
      agent?: string
      hasAttachments?: boolean
    },
    exclusionLineageRootId: string | null,
  ): boolean {
    if (exclusionLineageRootId && metadata.lineage_root_id === exclusionLineageRootId) return false
    if (params.channelKey && metadata.channel_key !== params.channelKey) return false
    if (params.sourceKind && metadata.source_kind !== params.sourceKind) return false
    if (params.userId && metadata.user_id !== params.userId) return false
    if (params.agent && metadata.agent !== params.agent) return false
    if (params.hasAttachments && this.parseAttachmentNames(metadata.attachment_names_json).length === 0) return false
    return true
  }

  private canAttachSessionRecallContext(
    scope: ChatConversationRecord,
    metadata: SessionRecallMetadataRow,
  ): boolean {
    return (scope.agent || '') === (metadata.agent || '')
  }

  private mergeHit(
    hits: Map<string, SessionRecallHit>,
    metadata: SessionRecallMetadataRow,
    matchKind: SessionRecallMatchKind,
    score: number,
    excerpt?: string | null,
  ): void {
    const existing = hits.get(metadata.conversation_id)
    if (!existing) {
      hits.set(metadata.conversation_id, this.buildHit(metadata, [matchKind], score, excerpt))
      return
    }
    const matchedBy = existing.matchedBy.includes(matchKind)
      ? existing.matchedBy
      : [...existing.matchedBy, matchKind]
    hits.set(metadata.conversation_id, {
      ...existing,
      matchedBy,
      score: Math.max(existing.score, score),
      hitExcerpt: existing.hitExcerpt || excerpt || null,
    })
  }

  private buildHit(
    metadata: SessionRecallMetadataRow,
    matchedBy: SessionRecallMatchKind[],
    score: number,
    excerpt?: string | null,
  ): SessionRecallHit {
    return {
      sessionStatus: this.latestSessionStatus(metadata.conversation_id),
      conversationId: metadata.conversation_id,
      lineageRootId: metadata.lineage_root_id,
      resumeTitle: metadata.resume_title,
      title: metadata.title,
      sourceKind: metadata.source_kind,
      sourceId: metadata.source_id,
      threadKey: metadata.thread_key,
      matchedBy,
      score,
      hitExcerpt: excerpt || null,
      latestTaskTitle: metadata.latest_task_title,
      latestTaskSummary: metadata.latest_task_summary,
      attachmentNames: this.parseAttachmentNames(metadata.attachment_names_json),
      updatedAt: metadata.updated_at,
    }
  }

  /** P0-1 — history rows need a REAL status source: the scope's latest task
   *  projection (read-only ledger consumption; writes stay with the owners).
   *  Failures degrade to null (= unlit), never break recall. */
  private latestSessionStatus(conversationId: string): SessionRecallSessionStatus | null {
    try {
      const db = this.db.getRawDb()
      if (!db) return null
      const row = db.prepare(
        `SELECT status, interaction_state FROM task_projections
         WHERE scope_id = ? ORDER BY updated_at DESC LIMIT 1`,
      ).get(conversationId) as { status?: unknown; interaction_state?: unknown } | undefined
      if (!row) return null
      if (row.interaction_state === 'check_in_pending') return 'check_in_pending'
      const status = String(row.status || '')
      if (status === 'running' || status === 'queued') return 'working'
      if (status === 'blocked' || status === 'recoverable_paused' || status === 'budget_paused') return 'blocked'
      if (status === 'completed') return 'done'
      if (status === 'failed' || status === 'killed') return 'error'
      return null
    } catch {
      return null
    }
  }

  private buildCapsule(metadata: SessionRecallMetadataRow): SessionRecallCapsule {
    const attachmentNames = this.parseAttachmentNames(metadata.attachment_names_json)
    const summaryParts = [
      metadata.preview_text ? `摘要：${metadata.preview_text}` : null,
      metadata.latest_task_summary ? `最近任务：${metadata.latest_task_summary}` : null,
      attachmentNames.length > 0 ? `相关附件：${attachmentNames.join('、')}` : null,
    ].filter(Boolean)
    return {
      conversationId: metadata.conversation_id,
      lineageRootId: metadata.lineage_root_id,
      resumeTitle: metadata.resume_title,
      title: metadata.title,
      sourceKind: metadata.source_kind,
      sourceId: metadata.source_id,
      threadKey: metadata.thread_key,
      summary: summaryParts.join('\n'),
      latestTaskTitle: metadata.latest_task_title,
      latestTaskSummary: metadata.latest_task_summary,
      attachmentNames,
      updatedAt: metadata.updated_at,
    }
  }

  private groupAndLimitHits(hits: SessionRecallHit[], limit?: number): SessionRecallHit[] {
    const grouped = new Map<string, SessionRecallHit>()
    for (const hit of hits) {
      const existing = grouped.get(hit.lineageRootId)
      if (!existing) {
        grouped.set(hit.lineageRootId, hit)
        continue
      }
      const existingTime = new Date(existing.updatedAt).getTime()
      const currentTime = new Date(hit.updatedAt).getTime()
      if (hit.score > existing.score || (hit.score === existing.score && currentTime > existingTime)) {
        grouped.set(hit.lineageRootId, hit)
      }
    }
    const max = Number.isFinite(Number(limit))
      ? Math.max(1, Math.min(SESSION_RECALL_RESULT_LIMIT_MAX, Number(limit)))
      : 5
    return Array.from(grouped.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
      .slice(0, max)
  }

  private toFtsQuery(query: string): string {
    return query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `"${part.replace(/"/g, '""')}"`)
      .join(' OR ')
  }

  private parseAttachmentNames(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.map((item) => String(item || '').trim()).filter(Boolean)
        : []
    } catch {
      return []
    }
  }

  private parseConversationMeta(scope: ChatConversationRecord): Record<string, unknown> {
    try {
      return scope.meta_json ? JSON.parse(scope.meta_json) as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }

  private readSessionRecallContextRefs(scope: ChatConversationRecord): SessionRecallContextRef[] {
    const meta = this.parseConversationMeta(scope)
    const raw = meta.sessionRecallContext
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const conversationId = String(record.conversationId || '').trim()
        if (!conversationId) return null
        return {
          conversationId,
          attachedAt: typeof record.attachedAt === 'string' ? record.attachedAt : new Date().toISOString(),
        } satisfies SessionRecallContextRef
      })
      .filter(Boolean) as SessionRecallContextRef[]
  }

  private searchVectorMatches(
    query: string,
    params: {
      channelKey?: string
      sourceKind?: ConversationSourceKind
      userId?: string
      agent?: string
      hasAttachments?: boolean
    },
    exclusionLineageRootId: string | null,
  ): Array<{ conversationId: string; score: number; excerpt: string | null }> {
    const candidates = this.listVectorSearchMetadata()
      .filter((row) => this.matchesFilters(row, params, exclusionLineageRootId))
    if (candidates.length === 0) return []

    const queryVector = this.encodeVector(query)
    if (this.vectorNorm(queryVector) === 0) return []

    const hits: Array<{ conversationId: string; score: number; excerpt: string | null }> = []
    for (const metadata of candidates) {
      const vector = this.ensureConversationVector(metadata)
      if (!vector || vector.length === 0) continue
      const similarity = this.cosineSimilarity(queryVector, vector)
      if (similarity < 0.18) continue
      hits.push({
        conversationId: metadata.conversation_id,
        score: 24 + similarity * 24,
        excerpt: metadata.preview_text,
      })
    }

    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
  }

  private ensureConversationVector(metadata: SessionRecallMetadataRow): number[] | null {
    const db = this.db.getRawDb()
    if (!db) return null
    const content = this.buildVectorSourceText(metadata)
    const contentHash = createHash('sha1').update(content).digest('hex')
    const existing = db.prepare(`
      SELECT conversation_id, content_hash, vector_version, vector_json, updated_at
      FROM session_recall_vectors
      WHERE conversation_id = ?
      LIMIT 1
    `).get<SessionRecallVectorRow>(metadata.conversation_id)
    if (existing && existing.content_hash === contentHash && existing.vector_version === SESSION_RECALL_VECTOR_VERSION) {
      return this.parseVector(existing.vector_json)
    }

    const vector = this.encodeVector(content)
    const upsert = db.prepare(`
      INSERT INTO session_recall_vectors (
        conversation_id, content_hash, vector_version, vector_json, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        vector_version = excluded.vector_version,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
    `)
    upsert.run?.(
      metadata.conversation_id,
      contentHash,
      SESSION_RECALL_VECTOR_VERSION,
      JSON.stringify(vector),
      metadata.updated_at,
    )
    // D4: LRU eviction — keep only most-recent SESSION_RECALL_VECTORS_LRU_CAP rows.
    // Cheap (O(N log N) once per upsert; uses idx_session_recall_vectors_updated).
    try {
      db.prepare(`
        DELETE FROM session_recall_vectors
        WHERE conversation_id NOT IN (
          SELECT conversation_id FROM session_recall_vectors
          ORDER BY updated_at DESC LIMIT ?
        )
      `).run?.(SESSION_RECALL_VECTORS_LRU_CAP)
    } catch (err) {
      // Don't let LRU cleanup failure break vector upsert; log and continue.
      console.warn('[session-recall] vector LRU eviction failed:', err)
    }
    return vector
  }

  private buildVectorSourceText(metadata: SessionRecallMetadataRow): string {
    return [
      metadata.title,
      metadata.resume_title,
      metadata.preview_text || '',
      metadata.latest_task_title || '',
      metadata.latest_task_summary || '',
      this.parseAttachmentNames(metadata.attachment_names_json).join(' '),
    ].filter(Boolean).join('\n')
  }

  private encodeVector(text: string): number[] {
    const vector = new Array<number>(SESSION_RECALL_VECTOR_DIMENSIONS).fill(0)
    const normalized = String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
    if (!normalized) return vector

    const compact = normalized.replace(/\s+/g, '')
    for (const token of this.extractVectorTokens(normalized, compact)) {
      const index = this.hashToken(token) % SESSION_RECALL_VECTOR_DIMENSIONS
      vector[index] += 1
    }

    const norm = this.vectorNorm(vector)
    if (norm === 0) return vector
    return vector.map((value) => value / norm)
  }

  private extractVectorTokens(normalized: string, compact: string): string[] {
    const tokens: string[] = []
    const wordTokens = normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter(Boolean)
    tokens.push(...wordTokens)

    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= compact.length - size; index += 1) {
        tokens.push(compact.slice(index, index + size))
      }
    }

    return tokens
  }

  private hashToken(token: string): number {
    let hash = 2166136261
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return Math.abs(hash >>> 0)
  }

  private vectorNorm(vector: number[]): number {
    let sum = 0
    for (const value of vector) sum += value * value
    return Math.sqrt(sum)
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0
    let dot = 0
    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index]
    }
    return dot
  }

  private parseVector(raw: string): number[] {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.map((item) => Number(item) || 0)
        : []
    } catch {
      return []
    }
  }
}
