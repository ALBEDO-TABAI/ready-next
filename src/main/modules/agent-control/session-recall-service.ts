import { createHash } from 'crypto'
import type { ChatConversationRecord, ConversationSourceKind, DatabaseManager } from '../database'
import type { SessionRecallCapsule, SessionRecallContextRef, SessionRecallHit, SessionRecallMatchKind } from '../../../shared/session-recall'

interface SessionRecallMetadataRow {
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
  getConversationScope(id: string): ChatConversationRecord | null
  updateConversationScopeMeta(id: string, meta: Record<string, unknown>): ChatConversationRecord | null
}

interface SessionRecallVectorRow {
  conversation_id: string
  content_hash: string
  vector_version: string
  vector_json: string
  updated_at: string
}

const SESSION_RECALL_VECTOR_VERSION = 'hashing-v1'
// D4: Cap session_recall_vectors growth — keep at most this many most-recent
// rows per write. vector_json can be sizable (per-conv hashing vectors); without
// a cap, table grows linearly with conversation count for the lifetime of the app.
const SESSION_RECALL_VECTORS_LRU_CAP = 200
const SESSION_RECALL_VECTOR_DIMENSIONS = 256

export class SessionRecallService {
  constructor(private readonly db: SessionRecallDatabaseAdapter | DatabaseManager) {}

  searchSessionRecall(params: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
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
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    const exclusionLineageRootId = this.resolveExcludedLineageRootId(params?.currentScopeId)
    const rows = this.listRecentMetadata()
      .filter((row) => this.matchesFilters(row, params || {}, exclusionLineageRootId))
    const hits = rows.map((row) => this.buildHit(row, ['recent'], 20, row.preview_text))
    return this.groupAndLimitHits(hits, params?.limit)
  }

  getAutomaticRecallCapsules(params: {
    query: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
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
    const scope = this.db.getConversationScope(scopeId)
    if (!scope) return []
    const refs = this.readSessionRecallContextRefs(scope)
    return refs
      .map((ref) => this.getSessionRecallCapsule({ conversationId: ref.conversationId }))
      .filter(Boolean) as SessionRecallCapsule[]
  }

  attachSessionRecallContext(params: { currentScopeId: string; conversationId: string }): {
    scope: ChatConversationRecord
    capsule: SessionRecallCapsule
  } {
    const scope = this.db.getConversationScope(params.currentScopeId)
    if (!scope) throw new Error(`Conversation scope not found: ${params.currentScopeId}`)
    const capsule = this.getSessionRecallCapsule({ conversationId: params.conversationId })
    if (!capsule) throw new Error(`Session recall capsule not found: ${params.conversationId}`)
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
    const updatedScope = this.db.updateConversationScopeMeta(params.currentScopeId, nextMeta)
    if (!updatedScope) throw new Error(`Failed to update conversation scope: ${params.currentScopeId}`)
    return {
      scope: updatedScope,
      capsule,
    }
  }

  detachSessionRecallContext(params: { currentScopeId: string; conversationId: string }): {
    scope: ChatConversationRecord
  } {
    const scope = this.db.getConversationScope(params.currentScopeId)
    if (!scope) throw new Error(`Conversation scope not found: ${params.currentScopeId}`)
    const refs = this.readSessionRecallContextRefs(scope)
      .filter((item) => item.conversationId !== params.conversationId)
    const nextMeta = {
      ...this.parseConversationMeta(scope),
      sessionRecallContext: refs,
    }
    const updatedScope = this.db.updateConversationScopeMeta(params.currentScopeId, nextMeta)
    if (!updatedScope) throw new Error(`Failed to update conversation scope: ${params.currentScopeId}`)
    return { scope: updatedScope }
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
      ORDER BY updated_at DESC
      LIMIT 1
    `).get<SessionRecallMetadataRow>(resumeTitle)
    return metadata ? this.buildHit(metadata, ['recent'], 20, metadata.preview_text) : null
  }

  private searchMessageMatches(query: string): SearchMessageRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    return db.prepare(`
      SELECT conversation_id, snippet(chat_messages_fts, 2, '[', ']', ' … ', 18) as excerpt
      FROM chat_messages_fts
      WHERE content MATCH ?
      LIMIT 60
    `).all<SearchMessageRow>(this.toFtsQuery(query))
  }

  private searchMetadataMatches(query: string): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    const likeQuery = `%${query}%`
    const attachmentConversationIds = db.prepare(`
      SELECT DISTINCT conversation_id
      FROM session_recall_attachment_index
      WHERE name LIKE ?
    `).all<{ conversation_id: string }>(likeQuery).map((row) => row.conversation_id)
    const directMatches = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE title LIKE ?
         OR resume_title LIKE ?
         OR COALESCE(latest_task_title, '') LIKE ?
         OR COALESCE(latest_task_summary, '') LIKE ?
    `).all<SessionRecallMetadataRow>(likeQuery, likeQuery, likeQuery, likeQuery)
    if (attachmentConversationIds.length === 0) return directMatches
    const placeholders = attachmentConversationIds.map(() => '?').join(', ')
    const attachmentMatches = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE conversation_id IN (${placeholders})
    `).all<SessionRecallMetadataRow>(...attachmentConversationIds)
    const merged = new Map<string, SessionRecallMetadataRow>()
    for (const row of [...directMatches, ...attachmentMatches]) merged.set(row.conversation_id, row)
    return Array.from(merged.values())
  }

  private listRecentMetadata(): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    return db.prepare(`
      SELECT *
      FROM session_recall_metadata
      ORDER BY updated_at DESC
      LIMIT 80
    `).all<SessionRecallMetadataRow>()
  }

  private listVectorSearchMetadata(): SessionRecallMetadataRow[] {
    const db = this.db.getRawDb()
    if (!db) return []
    return db.prepare(`
      SELECT *
      FROM session_recall_metadata
      ORDER BY updated_at DESC
      LIMIT 240
    `).all<SessionRecallMetadataRow>()
  }

  private getMetadataRow(conversationId: string): SessionRecallMetadataRow | null {
    const db = this.db.getRawDb()
    if (!db) return null
    const row = db.prepare(`
      SELECT *
      FROM session_recall_metadata
      WHERE conversation_id = ?
      LIMIT 1
    `).get<SessionRecallMetadataRow>(conversationId)
    return row || null
  }

  private resolveExcludedLineageRootId(currentScopeId?: string): string | null {
    if (!currentScopeId) return null
    const scope = this.db.getConversationScope(currentScopeId)
    if (!scope) return null
    return scope.lineage_root_id || scope.id
  }

  private matchesFilters(
    metadata: SessionRecallMetadataRow,
    params: {
      channelKey?: string
      sourceKind?: ConversationSourceKind
      userId?: string
      hasAttachments?: boolean
    },
    exclusionLineageRootId: string | null,
  ): boolean {
    if (exclusionLineageRootId && metadata.lineage_root_id === exclusionLineageRootId) return false
    if (params.channelKey && metadata.channel_key !== params.channelKey) return false
    if (params.sourceKind && metadata.source_kind !== params.sourceKind) return false
    if (params.userId && metadata.user_id !== params.userId) return false
    if (params.hasAttachments && this.parseAttachmentNames(metadata.attachment_names_json).length === 0) return false
    return true
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
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(20, Number(limit))) : 5
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
