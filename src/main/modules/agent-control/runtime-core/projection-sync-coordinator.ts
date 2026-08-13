// B8-D R1 — ProjectionSyncCoordinator: run-projection event publication and
// the terminal projection-sync retry ledger, extracted from
// AgentControlRuntime (runtime.ts) as a delegated sub-service. Method bodies
// are mechanical moves; the only substitutions are `this.emit(...)` →
// `this.deps.emit(...)` (events still fire from the runtime EventEmitter so
// the claude-bridge/ipc-handler listener surface is unchanged) and the
// shared `taskProjectionStore` / `runProjection` references becoming
// injected dependencies. The retry ledger repository and the retry-timer
// trio are cluster-exclusive state and migrated here.
import type { DatabaseManager } from '../../database'
import { logAgentMetric } from '../metrics'
import type { TaskProjectionRepository } from '../../repositories/task-projection-repository'
import type { RunProjection } from '../task-projection/run-projection'
import { syncTaskProjection } from '../task-projection/task-projection-sync'
import {
  drainPendingProjectionSyncs,
  isTerminalProjectionSyncPayload,
  PendingProjectionSyncRepository,
} from '../task-projection/projection-terminal-retry-ledger'
import type { ProjectionTruthSnapshot } from '../contracts/run-contracts'
import type {
  ConversationEventPayload,
  ScopeRunEventPayload,
  ScopeRunSummary,
} from '../contracts/types'

export interface ProjectionSyncCoordinatorDeps {
  db: DatabaseManager
  taskProjectionStore: TaskProjectionRepository
  runProjection: RunProjection
  readAliasGeneration: (aliasId: string) => number | null
  readActiveProductRunVisibilityIdentity: (readyRunId: string) => {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null
  readCommittedProductRunVisibilityIdentity: (readyRunId: string) => {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null
  /** Bound to the runtime EventEmitter — preserves the
   *  `this.emit('scopeRunEvent'|'conversationEvent'|'projectionSyncFailed')`
   *  semantics so external listeners keep observing AgentControlRuntime. */
  emit: (
    event: 'conversationEvent' | 'scopeRunEvent' | 'projectionSyncFailed',
    payload: unknown,
  ) => void
}

export class ProjectionSyncCoordinator {
  private readonly publishedCommittedProductTerminals = new Set<string>()
  private readonly pendingProjectionSyncs: PendingProjectionSyncRepository
  private projectionSyncRetryDrainInFlight: Promise<void> | null = null
  private projectionSyncRetryTimer: NodeJS.Timeout | null = null
  private projectionSyncRetryTimerDueAt = 0

  constructor(private readonly deps: ProjectionSyncCoordinatorDeps) {
    this.pendingProjectionSyncs = new PendingProjectionSyncRepository(deps.db)
  }

  emitConversationEvent(payload: ConversationEventPayload): void {
    this.deps.emit('conversationEvent', payload)
  }

  emitScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    const recorded = this.recordCanonicalScopeRunEvent(payload, projectionTruth)
    if (!recorded) return
    this.deps.emit('scopeRunEvent', {
      ...recorded.payload,
      aliasGeneration: recorded.summary.aliasGeneration,
      messageVisibilityEpoch: recorded.summary.messageVisibilityEpoch,
    })
  }

  publishScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.emitScopeRunEvent(payload, projectionTruth)
  }

  /** Publishes a terminal readback already committed by Ready closeout. */
  publishCommittedScopeRunEvent(payload: ScopeRunEventPayload): void {
    if (payload.visibilityOwnerKind !== 'product_alias'
      || !['checkpoint', 'done', 'error', 'cancelled'].includes(payload.phase)) return
    const authoritativePayload = this.resolveRunVisibilityIdentity(payload, true)
    const runId = typeof authoritativePayload?.runId === 'string'
      ? authoritativePayload.runId.trim()
      : ''
    if (!authoritativePayload || !runId || this.publishedCommittedProductTerminals.has(runId)) return

    // The closeout transaction has already persisted the terminal projection.
    // Refresh the in-memory summary only while the frozen context is still
    // current; a reset-stale terminal must still be published for consumers
    // that own the exact committed product identity.
    this.recordRunProjectionEvent(authoritativePayload, null)
    if (this.publishedCommittedProductTerminals.size >= 2_048) {
      const oldest = this.publishedCommittedProductTerminals.values().next().value
      if (typeof oldest === 'string') this.publishedCommittedProductTerminals.delete(oldest)
    }
    this.publishedCommittedProductTerminals.add(runId)
    try {
      this.deps.emit('scopeRunEvent', authoritativePayload)
    } catch (error) {
      this.publishedCommittedProductTerminals.delete(runId)
      throw error
    }
  }

  recordScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    return this.recordCanonicalScopeRunEvent(payload, projectionTruth)?.summary ?? null
  }

  private recordCanonicalScopeRunEvent(
    payload: ScopeRunEventPayload,
    projectionTruth?: ProjectionTruthSnapshot | null,
    committedProductTerminal = false,
    syncProjection = true,
  ): { payload: ScopeRunEventPayload; summary: ScopeRunSummary } | null {
    const authoritativePayload = this.resolveRunVisibilityIdentity(payload, committedProductTerminal)
    if (!authoritativePayload) return null
    const summary = this.recordRunProjectionEvent(authoritativePayload, projectionTruth)
    if (summary && syncProjection) {
      // Stage U PR U2.1 — projection sync is still fire-and-forget (the
      // ScopeRunEvent acknowledgement path must not block on disk I/O),
      // but failures now surface through a metric + an IPC event so the
      // renderer can show a diagnostic instead of pretending sync went
      // through. See plan §3 U2.1 / audit §3.3 fire-and-forget remediation.
      void syncTaskProjection(this.deps.taskProjectionStore, summary, authoritativePayload, projectionTruth).catch((error) => {
        this.handleProjectionSyncFailure(summary, authoritativePayload, projectionTruth, error)
      })
    }
    return summary ? { payload: authoritativePayload, summary } : null
  }

  private resolveRunVisibilityIdentity(
    payload: ScopeRunEventPayload,
    committedProductTerminal = false,
  ): ScopeRunEventPayload | null {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : ''
    if (!runId) return null
    const db = this.deps.db.getRawDb()
    if (!db) return null
    const messageVisibilityEpoch = payload.messageVisibilityEpoch
    if (!Number.isSafeInteger(messageVisibilityEpoch) || Number(messageVisibilityEpoch) < 0) return null
    if (payload.visibilityOwnerKind === 'product_alias') {
      const aliasGeneration = payload.aliasGeneration
      if (!Number.isSafeInteger(aliasGeneration) || Number(aliasGeneration) < 1) return null
      const owner = committedProductTerminal
        ? this.deps.readCommittedProductRunVisibilityIdentity(runId)
        : this.deps.readActiveProductRunVisibilityIdentity(runId)
      if (!owner
        || owner.readyScopeId !== payload.scopeId
        || owner.readyAliasId !== payload.scopeId
        || owner.aliasGeneration !== aliasGeneration
        || owner.messageVisibilityEpoch !== messageVisibilityEpoch) return null
      if (committedProductTerminal) return payload
      const current = db.prepare(`
        SELECT message_visibility_epoch
          FROM chat_conversations
         WHERE id = ? AND closed_at IS NULL
         LIMIT 1
      `).get<{ message_visibility_epoch: number }>(payload.scopeId)
      if (!current
        || current.message_visibility_epoch !== messageVisibilityEpoch) return null
      return payload
    }
    if (payload.visibilityOwnerKind !== 'context_background') return null
    const ledger = payload.visibilityOwnerLedger
    if (!ledger || typeof ledger.id !== 'string' || !ledger.id.trim()) return null
    const current = db.prepare(`
      SELECT message_visibility_epoch
        FROM chat_conversations
       WHERE id = ? AND closed_at IS NULL
       LIMIT 1
    `).get<{ message_visibility_epoch: number }>(payload.scopeId)
    if (!current || current.message_visibility_epoch !== messageVisibilityEpoch) return null
    let ownerMatches = false
    if (ledger.kind === 'run_meta') {
      ownerMatches = Boolean(db.prepare(`
        SELECT 1 AS found
          FROM run_meta
         WHERE run_id = ? AND scope_id = ? AND message_visibility_epoch = ?
         LIMIT 1
      `).get(ledger.id, payload.scopeId, messageVisibilityEpoch))
    } else if (ledger.kind === 'skill_task_run') {
      ownerMatches = Boolean(db.prepare(`
        SELECT 1 AS found
          FROM skill_task_runs
         WHERE (id = ? OR detached_task_id = ?)
           AND scope_id = ? AND message_visibility_epoch = ?
         LIMIT 1
      `).get(ledger.id, ledger.id, payload.scopeId, messageVisibilityEpoch))
    } else if (ledger.kind === 'task_projection') {
      ownerMatches = Boolean(db.prepare(`
        SELECT 1 AS found
          FROM task_projections
         WHERE task_id = ? AND scope_id = ? AND message_visibility_epoch = ?
         LIMIT 1
      `).get(ledger.id, payload.scopeId, messageVisibilityEpoch))
    }
    if (!ownerMatches) return null
    return {
      ...payload,
      aliasGeneration: this.deps.readAliasGeneration(payload.scopeId),
    }
  }

  private handleProjectionSyncFailure(
    summary: ScopeRunSummary,
    payload: ScopeRunEventPayload,
    projectionTruth: ProjectionTruthSnapshot | null | undefined,
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : String(error)
    const failurePayload = {
      scopeId: summary.scopeId,
      taskId: payload.taskId || summary.taskId || null,
      reason,
      timestamp: new Date().toISOString(),
    }
    console.error('[AgentControlRuntime] Failed to sync task projection:', error)
    logAgentMetric('projection.sync_failed', failurePayload)
    // Emit on the runtime EventEmitter so claude-bridge/ipc-handler.ts
    // can forward it to the renderer alongside scopeRunEvent. The emit is
    // wrapped because this path already runs inside a fire-and-forget catch.
    try {
      this.deps.emit('projectionSyncFailed', failurePayload)
    } catch (emitErr) {
      // silent-catch: emit failure is purely an observability degradation; the runtime must keep running.
      console.error('[AgentControlRuntime] projectionSyncFailed emit failed:', emitErr)
    }
    if (!isTerminalProjectionSyncPayload(summary)) return
    try {
      this.pendingProjectionSyncs.upsertPending({
        summary,
        eventPayload: payload,
        projectionTruth,
        error,
      })
      this.scheduleTerminalProjectionSyncRetryDrain('terminal_sync_failed')
    } catch (enqueueErr) {
      logAgentMetric('projection.sync_retry_enqueue_failed', {
        scopeId: summary.scopeId,
        taskId: payload.taskId || summary.taskId || null,
        reason: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      })
      console.error('[AgentControlRuntime] Failed to enqueue terminal projection sync retry:', enqueueErr)
    }
  }

  private clearProjectionSyncRetryTimer(): void {
    if (this.projectionSyncRetryTimer) {
      clearTimeout(this.projectionSyncRetryTimer)
      this.projectionSyncRetryTimer = null
      this.projectionSyncRetryTimerDueAt = 0
    }
  }

  scheduleTerminalProjectionSyncRetryDrain(reason: string, delayMs = 0): void {
    if (delayMs > 0) {
      const dueAt = Date.now() + delayMs
      if (this.projectionSyncRetryTimer && this.projectionSyncRetryTimerDueAt <= dueAt) return
      this.clearProjectionSyncRetryTimer()
      this.projectionSyncRetryTimerDueAt = dueAt
      this.projectionSyncRetryTimer = setTimeout(() => {
        this.projectionSyncRetryTimer = null
        this.projectionSyncRetryTimerDueAt = 0
        this.scheduleTerminalProjectionSyncRetryDrain(`${reason}:timer`)
      }, delayMs)
      this.projectionSyncRetryTimer.unref?.()
      return
    }
    if (this.projectionSyncRetryDrainInFlight) return
    this.clearProjectionSyncRetryTimer()
    this.projectionSyncRetryDrainInFlight = this.drainTerminalProjectionSyncRetries(reason)
      .catch((error) => {
        logAgentMetric('projection.sync_retry_drain_failed', {
          reason: error instanceof Error ? error.message : String(error),
          source: reason,
        })
        console.error('[AgentControlRuntime] terminal projection sync retry drain failed:', error)
      })
      .finally(() => {
        this.projectionSyncRetryDrainInFlight = null
      })
  }

  private async drainTerminalProjectionSyncRetries(reason: string): Promise<void> {
    const result = await drainPendingProjectionSyncs({
      repository: this.pendingProjectionSyncs,
      sync: async (entry) => {
        await syncTaskProjection(
          this.deps.taskProjectionStore,
          entry.summary,
          entry.eventPayload,
          entry.projectionTruth,
        )
      },
      onMetric: (metric) => {
        logAgentMetric(metric.name, {
          ...metric.payload,
          source: reason,
        })
      },
    })
    const nextAttemptAt = result.nextAttemptAt ? Date.parse(result.nextAttemptAt) : NaN
    if (Number.isFinite(nextAttemptAt)) {
      this.scheduleTerminalProjectionSyncRetryDrain(
        'terminal_sync_retry_backoff',
        Math.max(0, nextAttemptAt - Date.now()),
      )
    }
  }

  private recordRunProjectionEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    return this.deps.runProjection.recordEvent(payload, projectionTruth)
  }
}
