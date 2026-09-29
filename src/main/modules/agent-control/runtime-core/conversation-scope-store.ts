// B8-D R4 — ConversationScopeStore: conversation-scope reads/local-scope
// creation, row→contract mapping, the channel-scope
// ensure path for remote IM, scope refresh, and message append, extracted
// from AgentControlRuntime (runtime.ts) as a delegated sub-service. Method
// bodies are mechanical moves; the only substitutions are `this.db` →
// `this.deps.db` and
// the cross-cluster calls (`emitConversationEvent` via ProjectionSync,
// `channelConfig.mapChannelRow`, the remote-channel session-key helpers, and
// the ReferenceHintService replay/persist hooks) becoming injected callbacks.
// The service owns no state. `parseScopeMeta` migrated to ReferenceHintService
// in R2 and is NOT part of this cluster (verified: no remaining reference in
// these bodies).
//
// Phase C landing point (surgery map §4): this service is the typed home for
// the conversation-lifecycle merge — DirectChat's `sessions` Map is scheduled
// to fold into this store's public surface (scope CRUD + ensureChannelScope +
// createConversationMessage) instead of into the runtime monolith. This batch
// performs NO Phase C migration; it only fixes the boundary.
import { randomUUID } from 'crypto'
import { canonicalProjectDirectory } from '../codex-runtime/chat-project-directory'
import {
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../../../shared/action-authorization-mode'
import type {
  AgentChannelRecord,
  ChatConversationRecord,
  ChatMessageRecord,
  DatabaseManager,
  UpsertConversationScopeMode,
} from '../../database'
import type { MultimodalBlock } from '../contracts/run-contracts'
import type {
  AgentChannelConfig,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
} from '../contracts/types'
import { logAgentMetric } from '../metrics'
import { tryParseJson } from './runtime-helpers'

export interface ConversationScopeStoreDeps {
  ensureChannelAlias: (scopeId: string) => void
  db: DatabaseManager
  /** Bound to `ProjectionSyncCoordinator.emitConversationEvent`. */
  emitConversationEvent: (payload: ConversationEventPayload) => void
  /** Bound to `ChannelConfigService.mapChannelRow`. */
  mapChannelRow: (row: AgentChannelRecord) => AgentChannelConfig
  /** Bound to the runtime remote-channel session-key helpers (that cluster
   *  stays on the runtime until the next batch; the callbacks re-bind
   *  through it automatically when it migrates). */
  getScopedRemoteThreadKey: (channelId: string, remoteThread: string, agent: string) => string
  getRemoteChannelSessionSettingKey: (
    channelId: string,
    remoteThread: string,
    agent: string
  ) => string
  /** Bound to `ReferenceHintService` — hint replay on channel-scope ensure
   *  and hint persist after each assistant message append. */
  restoreReferenceHintFromScope: (scope: ConversationScope, scopeId: string) => void
  persistReferenceHintToScope: (scopeId: string, expectedMessageVisibilityEpoch: number) => void
  resolveConversationAgentId: (requestedAgentId: string) => string
  readAliasGeneration: (aliasId: string) => number | null
  readLatestAliasGeneration?: (aliasId: string) => number | null
}

export class ConversationScopeStore {
  constructor(private readonly deps: ConversationScopeStoreDeps) {}

  listConversationScopes(agent?: string): ConversationScope[] {
    return this.deps.db.listConversationScopes(agent).map((row) => this.mapConversationRow(row))
  }

  getConversationScope(scopeId: string): ConversationScope | null {
    const row = this.deps.db.getConversationScope(scopeId)
    return row ? this.mapConversationRow(row) : null
  }

  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[] {
    if (!this.deps.db.getConversationScope(scopeId)) {
      throw new Error(`conversation_scope_closed_or_missing:${scopeId}`)
    }
    return this.deps.db.getChatMessages(scopeId).map((row) => this.mapMessageRow(row))
  }

  setProjectDirectory(scopeId: string, path: unknown, expectedMessageVisibilityEpoch: number): ConversationScope {
    const existing = this.deps.db.getConversationScope(scopeId)
    if (!existing || existing.source_kind !== 'local') throw new Error('只能为本地聊天选择项目')
    const projectDirectory = canonicalProjectDirectory(path)
    const meta = tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {})
    const updated = this.deps.db.updateConversationScopeMeta(
      scopeId, { ...meta, projectDirectory }, expectedMessageVisibilityEpoch,
    )
    if (!updated) throw new Error('聊天已发生变化，请重新选择项目')
    const scope = this.mapConversationRow(updated)
    this.deps.emitConversationEvent({ type: 'scope_updated', scope })
    return scope
  }

  setActionAuthorizationMode(
    scopeId: string,
    mode: ActionAuthorizationMode,
    expectedMessageVisibilityEpoch: number,
  ): ConversationScope {
    const existing = this.deps.db.getConversationScope(scopeId)
    if (!existing) throw new Error(`Conversation scope not found: ${scopeId}`)
    if (existing.source_kind !== 'local') {
      throw new Error('action_authorization_mode_local_scope_required')
    }
    const normalizedMode = parseActionAuthorizationMode(mode)
    if (normalizedMode !== mode) throw new Error('action_authorization_mode_invalid')
    const meta = tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {})
    const updated = this.deps.db.updateConversationScopeMeta(
      scopeId,
      {
        ...meta,
        actionAuthorizationMode: normalizedMode,
      },
      expectedMessageVisibilityEpoch,
    )
    if (!updated) throw new Error('action_authorization_scope_identity_changed')
    const scope = this.mapConversationRow(updated)
    this.deps.emitConversationEvent({ type: 'scope_updated', scope })
    return scope
  }

  createLocalScope(agent: string, id?: string): ConversationScope {
    return this.createLocalScopeWithMode(agent, id).scope
  }

  /**
   * Same as createLocalScope but exposes whether the underlying upsert
   * inserted a new chat_conversations row or reused an existing one
   * (matched either by id or by the unique (source_kind, source_id,
   * thread_key, agent) tuple).
   *
   * The IPC handler uses this to log mode; renderer callers stay on the
   * legacy scope-only signature.
   */
  private createLocalScopeWithMode(
    agent: string,
    id?: string,
  ): { scope: ConversationScope; mode: UpsertConversationScopeMode } {
    const scopeId = typeof id === 'string' && id.trim() ? id.trim() : `conv-${randomUUID()}`
    const { row, mode } = this.deps.db.upsertConversationScope({
      id: scopeId,
      agent,
      activeAgentId: this.deps.resolveConversationAgentId(agent),
      userId: 'default-user',
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: scopeId,
      meta: { sourceLabel: '应用内', createdBy: 'app' }
    })
    const scope = this.mapConversationRow(row)
    logAgentMetric('local_scope_upsert', { scopeId: scope.id, agent, mode })
    this.deps.emitConversationEvent({ type: 'scope_created', scope })
    return { scope, mode }
  }

  mapConversationRow(
    row: ChatConversationRecord & { last_message_at?: string | null }
  ): ConversationScope {
    return {
      id: row.id,
      aliasGeneration: this.deps.readAliasGeneration(row.id),
      latestAliasGeneration: this.deps.readLatestAliasGeneration?.(row.id)
        ?? this.deps.readAliasGeneration(row.id),
      messageVisibilityEpoch: row.message_visibility_epoch ?? 0,
      agent: row.agent,
      activeAgentId: row.active_agent_id || row.agent,
      handoffGeneration: row.handoff_generation ?? 0,
      userId: row.user_id || undefined,
      title: row.title,
      parentConversationId: row.parent_conversation_id ?? null,
      lineageRootId: row.lineage_root_id || row.id,
      resumeTitle: row.resume_title || row.title,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      threadKey: row.thread_key,
      meta: tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? null
    }
  }

  private mapMessageRow(row: ChatMessageRecord): ConversationScopeMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      meta: tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {})
    }
  }

  ensureChannelScope(
    channelId: string,
    remoteThread: string,
    agent: string,
    sender: string
  ): ConversationScope {
    const channel = this.deps.db.getAgentChannel(channelId)
    const channelMeta = channel ? this.deps.mapChannelRow(channel) : null
    const scopedThreadKey = this.deps.getScopedRemoteThreadKey(channelId, remoteThread, agent)
    const existing = this.deps.db.findConversationScope('channel', channelId, scopedThreadKey, agent)
    const database = this.deps.db.getRawDb()
    if (!database) throw new Error('remote_database_unavailable')
    const ownsTransaction = !database.inTransaction
    if (ownsTransaction) database.exec('BEGIN IMMEDIATE')
    let row: ReturnType<DatabaseManager['upsertConversationScope']>['row']
    try {
      row = this.deps.db.upsertConversationScope({
      id: existing?.id || `conv-${randomUUID()}`,
      agent,
      activeAgentId: this.deps.resolveConversationAgentId(agent),
      title: existing?.title || sender || channelMeta?.name || '远程会话',
      sourceKind: 'channel',
      sourceId: channelId,
      threadKey: scopedThreadKey,
      meta: {
        ...(existing
          ? tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {})
          : {}),
        sourceLabel: channelMeta?.name || '远程 IM',
        channelType: channelMeta?.type || 'generic-webhook',
        channelBindingId: channelMeta?.config.bindingId,
        sender,
        remoteThread,
        channelSessionToken: this.deps.db.getSetting(
          this.deps.getRemoteChannelSessionSettingKey(channelId, remoteThread, agent)
        ) || null
      }
      }).row
      this.deps.ensureChannelAlias(row.id)
      if (ownsTransaction) database.exec('COMMIT')
    } catch (error) {
      if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK')
      throw error
    }
    const scope = this.mapConversationRow(row)
    // Phase 1.2 — recover any persisted lastReferenceSkill into the in-memory
    // map before the inbound message hits the orchestrator. Without this, a
    // Ready restart loses the hint until the user manually re-arms it; the
    // first remote IM turn after restart goes out with `referenceSkillHintArmed=false`
    // and the model loses access to typed skill actions. Idempotent: replay
    // checks TTL and same-value short-circuits.
    this.deps.restoreReferenceHintFromScope(scope, scope.id)
    this.deps.emitConversationEvent({
      type: existing ? 'scope_updated' : 'scope_created',
      scope
    })
    return scope
  }

  refreshScope(scopeId: string): ConversationScope {
    const row = this.deps.db.getConversationScope(scopeId)
    if (!row) throw new Error(`Conversation scope not found: ${scopeId}`)
    return this.mapConversationRow(row)
  }

  createConversationMessage(
    scopeId: string,
    payload: {
      role: string
      content: string
      meta?: Record<string, unknown>
    },
    expectedMessageVisibilityEpoch: number,
  ): ConversationScopeMessage {
    const messageId = `msg-${randomUUID()}`
    const timestamp = new Date().toISOString()
    this.deps.db.addChatMessage(
      messageId,
      scopeId,
      payload.role,
      payload.content,
      timestamp,
      payload.meta,
      expectedMessageVisibilityEpoch,
    )
    // skill-resume A1: snapshot reference-skill hint after each assistant
    // message and persist it to the conversation's meta_json so a Ready
    // restart can re-arm the in-memory hint on session resume.
    if (payload.role === 'assistant') {
      this.deps.persistReferenceHintToScope(scopeId, expectedMessageVisibilityEpoch)
    }
    return this.mapMessageRow(this.deps.db.getChatMessages(scopeId).find((row) => row.id === messageId)!)
  }

  extractTextFromMessage(message: string | MultimodalBlock[]): string {
    if (typeof message === 'string') return message
    if (!Array.isArray(message)) return ''
    return message
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        if (typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text?: string }).text || ''
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
}
