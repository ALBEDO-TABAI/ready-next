// B8-D R2 — NarrationContinuationService: the auto-narration continuation
// runner (pending background-task terminal events → narration-only
// continuation runs) plus its active-run predicate, run/failure publication,
// and the browser_tasks scopeId fallback lookup, extracted from
// AgentControlRuntime (runtime.ts) as a delegated sub-service. Method bodies
// are mechanical moves; the only substitutions are the shared
// `db` / `settingsRepository` / `orchestrator` / `scopeRunSummaries`
// references and the runtime-owned `getConversationScope` /
// `emitScopeRunEvent` helpers becoming injected dependencies. The
// `autoNarrationContinuationRunner` field (with its construction wiring) is
// cluster-exclusive and migrated here; the runtime keeps the
// `registerPendingTaskEventListener` + `start()` wiring rebound to
// `trigger()`. The whole cluster was runtime-private, so no public runtime
// delegates are kept.
import { randomUUID } from 'crypto'
import {
  AutoNarrationContinuationRunner,
  getOldestPendingTaskEvent,
  markPendingTaskEventConsumed,
  type PendingTaskEventRow,
} from '../system-reminders/background-task-terminal-reminder'
import type { TaskEventBridgePayload } from '../../browser-engine/task-event-bridge'
import { readAgentAutoNarrationContinuationSetting } from '../../settings-engine/agent-auto-narration-setting'
import { createTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import type { ContinuationState } from '../contracts/continuation-state'
import type { ProjectionTruthSnapshot } from '../contracts/run-contracts'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../contracts/types'
import type { DatabaseManager } from '../../database'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type { ReadyAgentOrchestrator } from './orchestrator'
import {
  parsePendingTaskEventPayload,
  resolvePendingTaskEventScopeId,
  readScopeIdFromPendingEvent,
  summarizePendingTaskEvent,
  buildPendingTaskNarrationPrompt,
  asRecord,
} from './runtime-helpers'

export interface NarrationContinuationServiceDeps {
  db: DatabaseManager
  settingsRepository: AppSettingsRepository
  orchestrator: ReadyAgentOrchestrator
  /** Runtime-owned run-summary map (run-dispatch/projection also read/write it);
   *  injected by reference, read-only here. */
  scopeRunSummaries: ReadonlyMap<string, ScopeRunSummary>
  getConversationScope: (scopeId: string) => ConversationScope | null
  emitScopeRunEvent: (
    payload: ScopeRunEventPayload,
    projectionTruth?: ProjectionTruthSnapshot | null,
  ) => void
}

export class NarrationContinuationService {
  private readonly autoNarrationContinuationRunner: AutoNarrationContinuationRunner

  constructor(private readonly deps: NarrationContinuationServiceDeps) {
    this.autoNarrationContinuationRunner = new AutoNarrationContinuationRunner({
      getOldestPendingTaskEvent,
      markPendingTaskEventConsumed,
      hasActiveNarrationContinuationRun: () => this.hasActiveNarrationContinuationRun(),
      isAutoNarrationContinuationEnabled: () => readAgentAutoNarrationContinuationSetting(this.deps.settingsRepository),
      startNarrationContinuationRun: (row) => this.startNarrationContinuationFromPending(row),
      onNarrationContinuationFailure: (row, error) => this.markNarrationContinuationFailure(row, error),
    })
  }

  /** Kick the pending-task-event drain (pending listener + runtime start()). */
  trigger(): void {
    this.autoNarrationContinuationRunner.trigger()
  }

  private hasActiveNarrationContinuationRun(): boolean {
    const activePhases = new Set<ScopeRunEventPayload['phase']>([
      'queued',
      'planning',
      'tool_running',
      'resuming',
      'responding',
    ])
    return Array.from(this.deps.scopeRunSummaries.values()).some((summary) =>
      summary.taskType === 'continuation' && activePhases.has(summary.phase)
    )
  }

  private async startNarrationContinuationFromPending(
    row: PendingTaskEventRow,
  ): Promise<{ success: boolean; error?: string | null }> {
    const event = parsePendingTaskEventPayload(row)
    const scopeId = this.resolvePendingTaskEventScopeId(event)
    if (!event || !scopeId) {
      return { success: false, error: 'Pending task event is missing a scopeId.' }
    }
    const scope = this.deps.getConversationScope(scopeId)
    if (!scope) {
      return { success: false, error: `Conversation scope not found: ${scopeId}` }
    }

    const runId = `auto-narration-${row.id}-${randomUUID()}`
    const narrationTaskId = `auto-narration:${row.id}`
    const taskBudgetRuntime = createTaskBudgetRuntime('continuation')
    const continuationState: ContinuationState = {
      taskId: narrationTaskId,
      scopeId: scope.id,
      runId,
      module: 'system',
      taskType: 'continuation',
      interactionState: 'resuming',
      steps: [],
      currentStepId: null,
      blockedReason: null,
      resumableActions: ['none'],
      continuationRef: {
        taskId: narrationTaskId,
        executionId: `pending-task-event:${row.id}`,
        taskRunId: row.taskRunId,
      },
      budgetRuntime: taskBudgetRuntime,
    }

    this.deps.emitScopeRunEvent({
      type: 'started',
      scopeId: scope.id,
      agent: scope.agent,
      runId,
      taskId: narrationTaskId,
      phase: 'resuming',
      taskType: 'continuation',
      taskTitle: '后台任务播报',
      taskSummary: summarizePendingTaskEvent(event),
      taskProjectionId: narrationTaskId,
      executionDiagnostics: {
        taskId: narrationTaskId,
        taskBudgetRuntime,
        budget: {
          ...taskBudgetRuntime.budget,
          ...taskBudgetRuntime.usage,
        },
      },
      timestamp: new Date().toISOString(),
    })

    const result = await this.deps.orchestrator.send(
      scope.agent,
      buildPendingTaskNarrationPrompt(event),
      scope.id,
      runId,
      narrationTaskId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      taskBudgetRuntime,
      undefined,
      continuationState,
    )

    this.deps.emitScopeRunEvent({
      type: 'updated',
      scopeId: scope.id,
      agent: scope.agent,
      runId,
      taskId: narrationTaskId,
      phase: result.success ? 'done' : 'error',
      terminalReason: result.terminalReason || (result.success ? 'done' : 'blocked_external'),
      taskType: 'continuation',
      taskTitle: '后台任务播报',
      taskSummary: result.finalText || summarizePendingTaskEvent(event),
      taskProjectionId: narrationTaskId,
      blockedReason: result.success ? null : (result.error || '自动播报续跑失败。'),
      executionDiagnostics: result.executionDiagnostics || {
        taskId: narrationTaskId,
        taskBudgetRuntime,
        budget: {
          ...taskBudgetRuntime.budget,
          ...taskBudgetRuntime.usage,
        },
      },
      timestamp: new Date().toISOString(),
    }, result.projectionTruth || null)

    return result.success
      ? { success: true }
      : { success: false, error: result.error || 'Agent narration continuation failed.' }
  }

  private markNarrationContinuationFailure(row: PendingTaskEventRow, error: string | null): void {
    const event = parsePendingTaskEventPayload(row)
    const scopeId = this.resolvePendingTaskEventScopeId(event)
    if (!event || !scopeId) return
    const scope = this.deps.getConversationScope(scopeId)
    if (!scope) return
    this.deps.emitScopeRunEvent({
      type: 'updated',
      scopeId: scope.id,
      agent: scope.agent,
      runId: `auto-narration-failed:${row.id}`,
      taskId: `auto-narration:${row.id}`,
      phase: 'error',
      terminalReason: 'blocked_external',
      taskType: 'continuation',
      taskTitle: '后台任务播报',
      taskSummary: summarizePendingTaskEvent(event),
      taskProjectionId: `auto-narration:${row.id}`,
      blockedReason: error || '自动播报续跑失败，后台任务结果仍待播报。',
      timestamp: new Date().toISOString(),
    })
  }

  private resolvePendingTaskEventScopeId(payload: TaskEventBridgePayload | null): string | null {
    const direct = resolvePendingTaskEventScopeId(payload)
    if (direct || !payload?.taskId) return direct
    try {
      const rawDb = this.deps.db.getRawDb()
      if (!rawDb) return null
      const row = rawDb
        .prepare('SELECT payload_json FROM browser_tasks WHERE id = ? LIMIT 1')
        .get<{ payload_json?: string | null }>(payload.taskId)
      const parsed = row?.payload_json ? JSON.parse(row.payload_json) : null
      return readScopeIdFromPendingEvent(asRecord(parsed))
    } catch {
      return null
    }
  }
}
