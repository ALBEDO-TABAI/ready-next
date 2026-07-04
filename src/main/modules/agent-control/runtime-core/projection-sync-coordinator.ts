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
  /** Bound to the runtime EventEmitter — preserves the
   *  `this.emit('scopeRunEvent'|'conversationEvent'|'projectionSyncFailed')`
   *  semantics so external listeners keep observing AgentControlRuntime. */
  emit: (
    event: 'conversationEvent' | 'scopeRunEvent' | 'projectionSyncFailed',
    payload: unknown,
  ) => void
}

export class ProjectionSyncCoordinator {
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
    this.recordScopeRunEvent(payload, projectionTruth)
    this.deps.emit('scopeRunEvent', payload)
  }

  publishScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.emitScopeRunEvent(payload, projectionTruth)
  }

  recordScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    const summary = this.recordRunProjectionEvent(payload, projectionTruth)
    if (summary) {
      // Stage U PR U2.1 — projection sync is still fire-and-forget (the
      // ScopeRunEvent acknowledgement path must not block on disk I/O),
      // but failures now surface through a metric + an IPC event so the
      // renderer can show a diagnostic instead of pretending sync went
      // through. See plan §3 U2.1 / audit §3.3 fire-and-forget remediation.
      void syncTaskProjection(this.deps.taskProjectionStore, summary, payload, projectionTruth).catch((error) => {
        this.handleProjectionSyncFailure(summary, payload, projectionTruth, error)
      })
    }
    return summary
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
