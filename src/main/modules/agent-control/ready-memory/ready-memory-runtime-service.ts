import { createHash, randomUUID } from 'node:crypto'

import type {
  ReadyMemoryAddRequest,
  ReadyMemoryConversationPolicyRequest,
  ReadyMemoryDeleteRequest,
  ReadyMemoryGlobalPolicyRequest,
  ReadyMemoryPinRequest,
  ReadyMemoryReadRequest,
  ReadyMemoryResetRequest,
  ReadyMemoryUpdateRequest,
  ReadyMemoryView,
  ReadyMemoryStateChange,
} from '../../../../shared/ready-memory'
import type { DatabaseConnection } from '../../database/connection'
import type { ReadyMemoryGenerationCoordinator } from './ready-memory-generation'
import type {
  ReadyMemoryEvidenceLoader,
  ReadyMemoryEvidenceRef,
  ReadyMemoryEvidenceSegment,
  ReadyMemorySourceEnqueueResult,
} from './ready-memory-generation-types'
import { ReadyMemoryRepository } from './ready-memory-repository'
import { publishReadyMemoryStateChangeIfAdvanced } from './ready-memory-state-events'

type SealResult = ReadyMemorySourceEnqueueResult | {
  enqueued: false
  reason: 'scope_ineligible' | 'terminal_ineligible' | 'untrusted_context' | 'evidence_unavailable'
}

interface ScopeRow {
  id: string
  source_kind: string
  source_id: string
  thread_key: string
  parent_conversation_id: string | null
  lineage_root_id: string | null
  meta_json: string
  message_visibility_epoch: number
  closed_at: string | null
}

interface TerminalRow {
  ready_run_id: string
  ready_task_id: string
  origin_user_message_id: string | null
  engine_terminal_status: string | null
  product_terminal_digest: string | null
  host_failure_product_terminal_digest: string | null
  lifecycle_action: string | null
  ingress_json: string
  run_status: string | null
  projection_status: string | null
  product_closeout_at: string | null
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  message_visibility_epoch: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isoNow(): string {
  return new Date().toISOString()
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasUntrustedIngress(raw: string): boolean {
  let ingress: Record<string, unknown> | null
  try {
    ingress = record(JSON.parse(raw))
  } catch {
    // silent-catch: unparseable ingress JSON counts as untrusted context, which keeps the conversation out of memory
    return true
  }
  const prepared = record(ingress?.prepared)
  const turnIngress = record(prepared?.ingress)
  const resources = record(turnIngress?.explicitResourceEnvelope)
  return !prepared || !turnIngress || !resources
    || (Array.isArray(resources.resourceRefs) && resources.resourceRefs.length > 0)
    || turnIngress.currentDocumentAnchor != null
    || prepared.externalReadSlice != null
    || (Array.isArray(prepared.resourceAuthorities) && prepared.resourceAuthorities.length > 0)
    || prepared.browserPageRef != null
    || prepared.productSurfaceTargets != null
}

function eligibleConversationScope(conversation: ScopeRow | undefined): conversation is ScopeRow {
  let meta: Record<string, unknown> | null = null
  try {
    meta = record(JSON.parse(conversation?.meta_json || ''))
  } catch {
    // silent-catch: missing or unparseable conversation meta_json makes the scope ineligible for memory
    return false
  }
  return Boolean(conversation && conversation.closed_at === null
    && conversation.source_kind === 'local' && conversation.source_id === 'app'
    && conversation.thread_key === conversation.id
    && conversation.parent_conversation_id === null
    && conversation.lineage_root_id === conversation.id
    && meta?.createdBy === 'app' && meta.temporary !== true && meta.ephemeral !== true)
}

function entryView(entry: ReturnType<ReadyMemoryRepository['listEntries']>[number]) {
  return {
    entryId: entry.entryId,
    category: entry.category,
    content: entry.content,
    origin: entry.origin,
    confidence: entry.confidence,
    pinned: entry.pinned,
    status: entry.status,
    expiresAt: entry.expiresAt,
    sourceRefs: entry.sourceRefs,
    lastUsedAt: entry.lastUsedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export class ReadyMemorySqliteEvidenceLoader implements ReadyMemoryEvidenceLoader {
  constructor(private readonly db: DatabaseConnection) {}

  async load(refs: ReadyMemoryEvidenceRef[]): Promise<ReadyMemoryEvidenceSegment[]> {
    const statement = this.db.prepare(`
      SELECT id, role, content, timestamp FROM chat_messages
      WHERE id = ? AND role IN ('user', 'assistant') LIMIT 1
    `)
    return refs.map((ref) => {
      const row = statement.get<MessageRow>(ref.ref)
      if (!row) throw new Error('ready_memory_evidence_missing')
      return { ref: row.id, role: row.role as 'user' | 'assistant', content: row.content, createdAt: row.timestamp }
    })
  }
}

export class ReadyMemoryRuntimeService {
  constructor(private readonly dependencies: {
    db: DatabaseConnection
    repository: ReadyMemoryRepository
    coordinator: ReadyMemoryGenerationCoordinator
    automaticGenerationAvailable: boolean
    wakeWorker?: () => void
    now?: () => string
    makeId?: (prefix: string) => string
    onStateChanged?: (event: ReadyMemoryStateChange) => void
    onStateChangePublishError?: (error: unknown) => void
  }) {}

  read(request: ReadyMemoryReadRequest): ReadyMemoryView {
    const policy = this.dependencies.repository.getGlobalPolicy()
    const conversationId = request.conversationId || null
    const conversationPolicy = conversationId
      && eligibleConversationScope(this.readConversation(conversationId))
      ? this.dependencies.repository.getConversationPolicy(conversationId)
      : null
    const counts = this.dependencies.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'leased', 'submitted') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unresolved
      FROM ready_memory_jobs
    `).get<{ pending: number | null; unresolved: number | null }>()
    return {
      useMemories: policy.useMemories,
      generateMemories: policy.generateMemories,
      automaticGenerationAvailable: this.dependencies.automaticGenerationAvailable,
      conversationId,
      contributeToMemories: conversationPolicy?.contributeToMemories ?? null,
      entries: this.dependencies.repository.listEntries().slice(0, 1_000).map(entryView),
      pendingGenerationJobs: Number(counts?.pending || 0),
      unresolvedGenerationJobs: Number(counts?.unresolved || 0),
    }
  }

  setGlobalPolicy(request: ReadyMemoryGlobalPolicyRequest): ReadyMemoryView {
    if (request.generateMemories === true && !this.dependencies.automaticGenerationAvailable) {
      throw new Error('ready_memory_automatic_generation_unavailable')
    }
    if (request.generateMemories === true && request.acknowledgeModelCost !== true) {
      throw new Error('ready_memory_cost_ack_required')
    }
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.setGlobalPolicy({
      useMemories: request.useMemories,
      generateMemories: request.generateMemories,
      updatedAt: this.now(),
    })
    if (request.generateMemories === true) this.dependencies.wakeWorker?.()
    this.publishStateChange(before, 'policy')
    return this.read({})
  }

  setConversationPolicy(request: ReadyMemoryConversationPolicyRequest): ReadyMemoryView {
    if (!eligibleConversationScope(this.readConversation(request.conversationId))) {
      throw new Error('ready_memory_conversation_ineligible')
    }
    this.dependencies.repository.setConversationContribution({
      ...request,
      updatedAt: this.now(),
    })
    return this.read({ conversationId: request.conversationId })
  }

  add(request: ReadyMemoryAddRequest): ReadyMemoryView {
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.addManualMemory({
      entryId: this.makeId('ready-memory'),
      category: request.category,
      content: request.content,
      pinned: request.pinned,
      createdAt: this.now(),
    })
    this.publishStateChange(before, 'add')
    return this.read({})
  }

  update(request: ReadyMemoryUpdateRequest): ReadyMemoryView {
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.editMemory({ ...request, updatedAt: this.now() })
    this.publishStateChange(before, 'update')
    return this.read({})
  }

  pin(request: ReadyMemoryPinRequest): ReadyMemoryView {
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.setMemoryPinned(request.entryId, request.pinned, this.now())
    this.publishStateChange(before, 'pin')
    return this.read({})
  }

  delete(request: ReadyMemoryDeleteRequest): ReadyMemoryView {
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.deleteMemory(request.entryId, this.now())
    this.publishStateChange(before, 'delete')
    return this.read({})
  }

  reset(request: ReadyMemoryResetRequest): ReadyMemoryView {
    if (request.confirm !== true) throw new Error('ready_memory_reset_confirmation_required')
    const before = this.dependencies.repository.getGlobalPolicy()
    this.dependencies.repository.resetMemories(this.now())
    this.dependencies.wakeWorker?.()
    this.publishStateChange(before, 'reset')
    return this.read({})
  }

  private publishStateChange(
    before: { stateRevision: number; revocationRevision: number },
    reason: ReadyMemoryStateChange['reason'],
  ): void {
    const after = this.dependencies.repository.getGlobalPolicy()
    publishReadyMemoryStateChangeIfAdvanced({
      before,
      after,
      reason,
      publish: this.dependencies.onStateChanged,
      onError: this.dependencies.onStateChangePublishError,
    })
  }

  sealClosedConversationInOpenTransaction(input: {
    conversationId: string
    closedAt: string
  }): SealResult {
    if (!this.dependencies.db.inTransaction) throw new Error('ready_memory_close_transaction_missing')
    const scope = this.dependencies.db.prepare(`
      SELECT id, source_kind, source_id, thread_key, parent_conversation_id,
             lineage_root_id, meta_json, message_visibility_epoch, closed_at
      FROM chat_conversations WHERE id = ? LIMIT 1
    `).get<ScopeRow>(input.conversationId)
    let meta: Record<string, unknown> | null = null
    try {
      meta = record(JSON.parse(scope?.meta_json || ''))
    } catch {
      // silent-catch: missing or unparseable meta_json leaves meta null, which fails the eligibility check below
    }
    if (!scope || scope.closed_at !== input.closedAt || scope.source_kind !== 'local'
      || scope.source_id !== 'app' || scope.thread_key !== scope.id
      || scope.parent_conversation_id !== null || scope.lineage_root_id !== scope.id
      || meta?.createdBy !== 'app' || meta.temporary === true || meta.ephemeral === true) {
      return { enqueued: false, reason: 'scope_ineligible' }
    }
    const terminal = this.dependencies.db.prepare(`
      SELECT turn.ready_run_id, turn.ready_task_id, turn.origin_user_message_id,
             turn.engine_terminal_status, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest, turn.lifecycle_action, turn.ingress_json,
             run.status AS run_status, projection.status AS projection_status,
             turn.product_closeout_at
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      LEFT JOIN run_meta run ON run.run_id = turn.ready_run_id
      LEFT JOIN task_projections projection ON projection.task_id = turn.ready_task_id
        AND projection.run_id = turn.ready_run_id
      WHERE thread.ready_scope_id = ? AND turn.message_visibility_epoch = ?
        AND (turn.product_terminal_digest IS NOT NULL
          OR turn.host_failure_product_terminal_digest IS NOT NULL)
      ORDER BY COALESCE(turn.product_closeout_at, turn.host_failure_closeout_at, turn.updated_at) DESC,
               turn.created_at DESC, turn.ready_run_id DESC
      LIMIT 1
    `).get<TerminalRow>(scope.id, scope.message_visibility_epoch)
    if (!terminal || terminal.engine_terminal_status !== 'completed'
      || !terminal.product_terminal_digest || terminal.host_failure_product_terminal_digest
      || terminal.lifecycle_action || terminal.run_status !== 'done'
      || terminal.projection_status !== 'completed') {
      return { enqueued: false, reason: 'terminal_ineligible' }
    }
    const toolCall = this.dependencies.db.prepare(`
      SELECT 1 AS present FROM codex_tool_call_bindings call
      JOIN codex_turn_bindings turn ON turn.ready_run_id = call.ready_run_id
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      WHERE thread.ready_scope_id = ? AND turn.message_visibility_epoch = ? LIMIT 1
    `).get<{ present: number }>(scope.id, scope.message_visibility_epoch)
    const ingressRows = this.dependencies.db.prepare(`
      SELECT turn.ingress_json FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      WHERE thread.ready_scope_id = ? AND turn.message_visibility_epoch = ?
    `).all<{ ingress_json: string }>(scope.id, scope.message_visibility_epoch)
    if (toolCall || ingressRows.some((row) => hasUntrustedIngress(row.ingress_json))) {
      return { enqueued: false, reason: 'untrusted_context' }
    }
    const successfulTurns = this.dependencies.db.prepare(`
      SELECT turn.ready_run_id, turn.ready_task_id,
             COALESCE(turn.origin_user_message_id, (
               SELECT root.origin_user_message_id FROM codex_turn_bindings root
               WHERE root.thread_binding_id = turn.thread_binding_id
                 AND root.ready_task_id = turn.ready_task_id
                 AND root.message_visibility_epoch = turn.message_visibility_epoch
                 AND root.origin_user_message_id IS NOT NULL
               ORDER BY root.created_at ASC, root.ready_run_id ASC LIMIT 1
             )) AS origin_user_message_id,
             turn.engine_terminal_status, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest, turn.lifecycle_action, turn.ingress_json,
             run.status AS run_status, projection.status AS projection_status,
             turn.product_closeout_at
      FROM codex_turn_bindings turn
      JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
      LEFT JOIN run_meta run ON run.run_id = turn.ready_run_id
      LEFT JOIN task_projections projection ON projection.task_id = turn.ready_task_id
        AND projection.run_id = turn.ready_run_id
      WHERE thread.ready_scope_id = ? AND turn.message_visibility_epoch = ?
        AND turn.engine_terminal_status = 'completed'
        AND turn.product_terminal_digest IS NOT NULL
        AND turn.host_failure_product_terminal_digest IS NULL
        AND turn.lifecycle_action IS NULL AND run.status = 'done'
        AND projection.status = 'completed' AND turn.product_closeout_at IS NOT NULL
      ORDER BY turn.product_closeout_at DESC, turn.created_at DESC, turn.ready_run_id DESC
      LIMIT 32
    `).all<TerminalRow>(scope.id, scope.message_visibility_epoch)
    const message = this.dependencies.db.prepare(`
      SELECT id, conversation_id, role, content, timestamp, message_visibility_epoch
      FROM chat_messages WHERE id = ? AND replaced_by_run_id IS NULL LIMIT 1
    `)
    const pairs: Array<[MessageRow, MessageRow]> = []
    const seenMessageIds = new Set<string>()
    for (const turn of successfulTurns) {
      if (!turn.origin_user_message_id || !turn.product_closeout_at) continue
      const user = message.get<MessageRow>(turn.origin_user_message_id)
      const assistant = message.get<MessageRow>(`assistant:${turn.ready_task_id}:${turn.ready_run_id}:terminal`)
      if (!user || !assistant || user.conversation_id !== scope.id || assistant.conversation_id !== scope.id
        || user.message_visibility_epoch !== scope.message_visibility_epoch
        || assistant.message_visibility_epoch !== scope.message_visibility_epoch
        || user.role !== 'user' || assistant.role !== 'assistant'
        || assistant.timestamp !== turn.product_closeout_at
        || !user.content.trim() || !assistant.content.trim()
        || seenMessageIds.has(user.id) || seenMessageIds.has(assistant.id)) continue
      seenMessageIds.add(user.id)
      seenMessageIds.add(assistant.id)
      pairs.push([user, assistant])
    }
    const selectedPairs: Array<[MessageRow, MessageRow]> = []
    let characters = 0
    for (const pair of pairs) {
      const lengths = pair.map((row) => Array.from(row.content).length)
      const pairCharacters = lengths[0]! + lengths[1]!
      if (lengths.some((length) => length > 8_000) || characters + pairCharacters > 24_000) continue
      selectedPairs.push(pair)
      characters += pairCharacters
    }
    const selected = selectedPairs.reverse().flat()
    if (!selected.some((row) => row.role === 'user')
      || !selected.some((row) => row.role === 'assistant')) {
      return { enqueued: false, reason: 'evidence_unavailable' }
    }
    const evidence = selected.map((row) => ({
      ref: row.id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      createdAt: row.timestamp,
    }))
    const result = this.dependencies.coordinator.enqueueSuccessfulSource({
      sourceId: `ready-memory-source-${sha256(`${scope.id}\0${scope.message_visibility_epoch}\0${terminal.product_terminal_digest}`).slice(0, 32)}`,
      conversationId: scope.id,
      sourceUpdatedAt: selected[selected.length - 1]!.timestamp,
      evidence,
      eligibility: {
        terminalStatus: 'succeeded', sealed: true, localRoot: true,
        temporary: false, hasUntrustedExternalContext: false,
      },
      createdAt: input.closedAt,
    })
    if (result.enqueued) this.dependencies.wakeWorker?.()
    return result
  }

  private readConversation(conversationId: string): ScopeRow | undefined {
    return this.dependencies.db.prepare(`
      SELECT id, source_kind, source_id, thread_key, parent_conversation_id,
             lineage_root_id, meta_json, message_visibility_epoch, closed_at
      FROM chat_conversations WHERE id = ? LIMIT 1
    `).get<ScopeRow>(conversationId)
  }
  private now(): string { return this.dependencies.now?.() || isoNow() }
  private makeId(prefix: string): string {
    return this.dependencies.makeId?.(prefix) || `${prefix}-${randomUUID()}`
  }
}
