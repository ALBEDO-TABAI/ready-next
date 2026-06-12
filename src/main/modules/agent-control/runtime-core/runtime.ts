import { app, BrowserWindow } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
// L5-C-Universal: channel-agnostic remote-message → calendar-event detector.
// Imported here so the inbound-channel pipeline can opportunistically push
// suggestions to the renderer without each adapter implementing detection.
import { detectRemoteChannelEventSuggestions } from '../../calendar-engine/remote-channel-event-detector'
import {
  REMOTE_CHANNEL_CALENDAR_POLICY_KEY,
  type RemoteChannelKind,
  type RemoteChannelMessage,
} from '../../../../shared/calendar-remote-channel'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { extname, isAbsolute, join } from 'path'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import { resumeWaitingHumanBrowserTaskFromBridge } from '../../browser-engine/task-event-bridge'
import type { AgentManager } from '../../claude-bridge/agent-manager'
import type { MultimodalBlock } from '../../claude-bridge/direct-chat'
import {
  getDatabase,
  type AgentChannelRecord,
  type AgentChannelType,
  type AgentScheduleRecord,
  type ChatConversationRecord,
  type ChatMessageRecord,
  type ConversationSourceKind,
  type UpsertConversationScopeMode,
} from '../../database'
import { ReadyAgentOrchestrator } from './orchestrator'
import { defaultSystemPrompt } from './agent-sdk-runtime'
import { composePersonaSystemPrompt } from './persona-system-prompt'
import { PromptAssemblyService } from '../prompt-assembly'
import { selectScopeTaskIndexEntries } from '../session/daily-task-index-builder'
import { selectFollowupTaskRefs } from '../intent-state-first'
import { BeliefCardStore } from '../knowledge/belief-card-store'
import { RunCoordinator } from '../task-projection/run-coordinator'
import { executeAgentSchedule, type ScheduleTriggerSource } from './schedule-execution'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import {
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  rememberLastReferenceSkill,
  getLastReferenceSkill,
  peekLastReferenceSkill,
  REFERENCE_SKILL_HINT_TTL_MS,
  type PersistedReferenceSkillHint,
} from '../skills/skill-reference-hints'
import { findSkillHintInCapsuleTexts } from '../skills/skill-hint-recovery'
import { shouldDisplayReferenceSkillHintForLatestUserText } from '../reference-skill-hint-display'
import { findSkillToolByName } from '../../tools/skills-tools'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { SkillTaskRunRepository } from '../../repositories/skill-task-run-repository'
import {
  cancelSkillChildRun,
  configureSkillChildRunner,
  getSkillChildRunner,
} from '../skills/skill-child-runner'
import { listRegisteredSkillChildDrivers } from '../skills/skill-child-drivers'
// Importing the VEA driver triggers its module-load-time
// `registerSkillChildDriver(...)` side-effect. The runner relies on the
// registry being primed before any `startSkillChildRun` call.
import '../video-expert-child-driver'
import { assertStageNChildLoopInvariants } from '../stage-n-boot-assertion'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import { ToolNameCollisionError } from '../tools-runtime/tool-registry-errors'
import { RunProjection } from '../task-projection/run-projection'
import { syncTaskProjection } from '../task-projection/task-projection-sync'
import { reconcileTaskProjections } from '../task-projection/task-projection-reconciler'
import { canResumeShape, type ResumeHandle } from '../contracts/resume-handle'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'
import { isAwaitingUserInteractionState } from '../../../../shared/task-interaction-state'
import { assertSkillTaskRunInvariantConsistency } from '../skills/skill-task-tracker'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from '../contracts/run-contracts'
import { createTaskBudgetRuntime, getBudgetUsagePercent, restoreContinuationTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import {
  normalizeContinuationIntent,
  selectContinuationProjection,
  type ContinuationState,
  type ContinuationIntent,
} from '../contracts/continuation-state'
import {
  AutoNarrationContinuationRunner,
  getOldestPendingTaskEvent,
  markPendingTaskEventConsumed,
  registerPendingTaskEventListener,
  type PendingTaskEventRow,
} from '../system-reminders/background-task-terminal-reminder'
import { taskEventBridge, type TaskEventBridgePayload } from '../../browser-engine/task-event-bridge'
import { createTaskEventProofListener, createTaskProofSink } from '../quality/proof-collector'
import { isKnowledgeSystemEnabled, runStartupBeliefSync, KnowledgeWatcher } from '../knowledge/knowledge-truth-source'
import { BrowserCollectionConsentStore } from '../../browser-engine/browser-collection-consent'
import { forgetSession } from '../session/session-continuity'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import {
  classifySendScopedError,
  runConfirmedSendScoped,
  type SendScopedResponse,
  type SendScopedUserMessage,
} from '../send-scoped-confirmation'
import { SessionRecallService } from '../session/session-recall-service'
import { SidecarManager } from '../sidecar-manager'
import { MemoryRepository } from '../../repositories/memory-repository'
import { MemoryLifecycleManager } from '../memory/memory-lifecycle'
import { ReflectionService } from '../reflection-service'
import { UserProfileRepository } from '../../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../../repositories/agent-personality-repository'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import { readAgentAutoNarrationContinuationSetting } from '../../settings-engine/agent-auto-narration-setting'
import type { CapabilityRuntimeSnapshot } from '../../../../shared/ai-capability-runtime'
import { ExternalMemoryProviderSlot } from '../memory/external-memory-provider-slot'
import { decryptChannelConfig, encryptChannelConfig } from '../memory/secret-storage'
import { ToolGateway } from '../tools-runtime/tool-gateway'
import { buildCapabilityRuntimeSnapshot } from '../domain-adapters/capability-runtime-snapshot'
import { TaskProjectionRepository } from '../../repositories/task-projection-repository'
import { AgentRegistryRepository } from '../../repositories/agent-registry-repository'
import { RunMetaRepository } from '../task-projection/run-meta-repository'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import {
  DetachedSkillTaskTracker,
  registerDetachedSkillTaskTracker,
  type DetachedSkillTaskRecord,
} from '../detached-skill-task-tracker'
import type {
  AgentChannelConfig,
  AgentRuntimeStatus,
  ChannelAdapterType,
  ChannelAttachment,
  ConversationAttachment,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
  CronTask,
  HeartbeatSnapshot,
  ScopeRunMemoryCapture,
  ScopeRunEventPayload,
  ScopeRunSkillProgress,
  ScopeRunSummary
} from '../contracts/types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../../shared/session-recall'

export interface UpsertChannelPayload {
  id?: string
  type: ChannelAdapterType
  name: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export interface UpsertSchedulePayload {
  id?: string
  name: string
  cronExpr: string
  prompt: string
  channelId?: string | null
  enabled?: boolean
  payload?: Record<string, unknown>
}

type ActiveChildRunSummaryForRuntime = {
  childRunId: string
  skillId: string
  sessionId: string | null
  scopeId: string | null
  status: string
  startedAt: string
  outputDir: string
  runStatePath: string
  progress?: ScopeRunSkillProgress
  blockedReason?: string | null
  liveness?: 'background' | null
  closeStatus?: string | null
}

interface TaskProjectionChildSummaryRow {
  task_id: string
  scope_id: string
  status: string
  blocked_reason: string | null
  continuation_ref_json: string | null
  recent_artifacts_json: string | null
  created_at: string
  updated_at: string
}

function parseRecordJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseArrayJson(value: string | null | undefined): Array<Record<string, unknown>> {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item)),
        )
      : []
  } catch {
    return []
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parsePendingTaskEventPayload(row: PendingTaskEventRow): TaskEventBridgePayload | null {
  try {
    const parsed = JSON.parse(row.eventPayload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Partial<TaskEventBridgePayload>
    if (typeof record.taskId !== 'string' || typeof record.status !== 'string') return null
    return record as TaskEventBridgePayload
  } catch {
    return null
  }
}

function resolvePendingTaskEventScopeId(payload: TaskEventBridgePayload | null): string | null {
  if (!payload) return null
  const extra = asRecord(payload.extra)
  return readScopeIdFromPendingEvent(extra)
}

function readScopeIdFromPendingEvent(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const direct = stringFromUnknown(record.scopeId)
    || stringFromUnknown(record.sessionId)
    || stringFromUnknown(record.publicSessionId)
  if (direct) return direct
  return readScopeIdFromPendingEvent(asRecord(record.payload))
}

function summarizePendingTaskEvent(payload: TaskEventBridgePayload): string {
  const extra = asRecord(payload.extra)
  const summary = stringFromUnknown(extra?.summary)
    || stringFromUnknown(extra?.title)
    || stringFromUnknown(extra?.message)
    || stringFromUnknown(extra?.statusText)
  return summary || `后台任务 ${payload.taskId} 已进入终态：${payload.status}`
}

function buildPendingTaskNarrationPrompt(payload: TaskEventBridgePayload): string {
  const summary = summarizePendingTaskEvent(payload)
  return [
    '请向用户简短播报这个后台任务的最新结果，只做说明和下一步建议，不执行任何写入、浏览器操作或高风险动作。',
    `任务 ID：${payload.taskId}`,
    `状态：${payload.status}`,
    `摘要：${summary}`,
  ].join('\n')
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function progressFromUnknown(value: unknown): ScopeRunSkillProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Partial<ScopeRunSkillProgress>
  return {
    stage: record.stage ?? null,
    completed: record.completed ?? null,
    total: record.total ?? null,
    coverage: record.coverage ?? null,
    overallCoverage: record.overallCoverage ?? null,
    fingerprint: record.fingerprint ?? null,
    updatedAt: record.updatedAt ?? null,
    lastError: record.lastError ?? null,
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.activityUpdatedAt ? { activityUpdatedAt: record.activityUpdatedAt } : {}),
    ...(record.handoff ? { handoff: record.handoff } : {}),
  }
}

function artifactMetaString(
  artifacts: Array<Record<string, unknown>>,
  key: string,
): string | null {
  for (const artifact of artifacts) {
    const meta = artifact.meta && typeof artifact.meta === 'object' && !Array.isArray(artifact.meta)
      ? artifact.meta as Record<string, unknown>
      : null
    const value = stringFromUnknown(meta?.[key])
    if (value) return value
  }
  return null
}

function childRunSummaryStatusFromProjection(status: string): string {
  if (status === 'queued') return 'queued'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'killed'
  if (status === 'done') return 'completed'
  if (status === 'blocked') return 'blocked'
  return 'running'
}

function canRespondToUserInteractionWithoutResumeHandle(params: {
  projection: TaskProjectionRecord | null
  scopeRunSummary: ScopeRunSummary | null
}): boolean {
  return isAwaitingUserInteractionState(params.projection)
    || isAwaitingUserInteractionState(params.scopeRunSummary)
}

export class AgentControlRuntime extends EventEmitter {
  private readonly db = getDatabase()
  private readonly settingsRepository = new AppSettingsRepository()
  private readonly sidecar = new SidecarManager()
  private readonly orchestrator: ReadyAgentOrchestrator
  private readonly toolGateway = new ToolGateway()
  private readonly memoryRepository = new MemoryRepository()
  private readonly memoryLifecycle = new MemoryLifecycleManager(this.memoryRepository)
  private readonly userProfileRepository = new UserProfileRepository()
  private readonly agentPersonalityRepository = new AgentPersonalityRepository()
  private readonly externalMemoryProviderSlot = new ExternalMemoryProviderSlot()
  private readonly sessionRecallService = new SessionRecallService(this.db)
  private readonly reflectionService = new ReflectionService({
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    knowledgeRepository: {
      set: async (key: string, value: string) => {
        const rawDb = this.db.getRawDb()
        if (!rawDb) throw new Error('Database not available')
        rawDb
          .prepare(
            `
          INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `
          )
          .run(
            `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            'system',
            key,
            value,
            new Date().toISOString(),
            new Date().toISOString()
          )
      },
      get: async (key: string) => {
        const rawDb = this.db.getRawDb()
        if (!rawDb) return null
        const row = rawDb
          .prepare(
            `
          SELECT value FROM agent_knowledge WHERE agent_name = 'system' AND key = ?
        `
          )
          .get(key) as { value: string } | undefined
        return row?.value || null
      }
    }
  })
  private readonly promptAssembly = new PromptAssemblyService({
    getMemoryRoot: () => join(app.getPath('userData'), 'agent-memory'),
    memoryRepository: this.memoryRepository,
    userProfileRepository: this.userProfileRepository,
    agentPersonalityRepository: this.agentPersonalityRepository,
    getScopeSessionRecallCapsules: (scope) =>
      this.sessionRecallService.listAttachedSessionRecallContexts(scope.id),
    getAutoSessionRecallCapsules: ({ scope, userText }) =>
      this.sessionRecallService.getAutomaticRecallCapsules({
        query: userText,
        currentScopeId: scope.id,
        channelKey: this.toChannelKey(scope),
        sourceKind: scope.sourceKind,
        userId: scope.userId,
        limit: 2
      }),
    // EP1-X1a: lazy — taskProjectionStore is declared after this field, so we
    // resolve `this.taskProjectionStore` only when invoked at turn time.
    getScopeTaskIndexEntries: (scopeId) =>
      selectScopeTaskIndexEntries(this.taskProjectionStore, scopeId),
    // EP2-K3: lazy for the same declaration-order reason.
    getBeliefCardStore: () => this.getBeliefCardStore(),
    // EP3-A3: lazy — the agents-table roster for the main-session
    // charter/routing index (empty/dead table degrades to []).
    getAgentRoster: () => this.agentRegistry.list(),
    // EP2-K6: rollback switch (single read entry in the knowledge module).
    isKnowledgeSystemEnabled: () => isKnowledgeSystemEnabled(this.db),
    enableDatabaseMemory: true
  })
  private readonly agentRegistry = new AgentRegistryRepository(this.db)
  private readonly agentManager: AgentManager
  private readonly runCoordinator: RunCoordinator
  private readonly runProjection: RunProjection
  private readonly taskProjectionStore = new TaskProjectionRepository(this.db)
  private knowledgeWatcher: KnowledgeWatcher | null = null
  private beliefCardStore: BeliefCardStore | null = null
  private readonly skillTaskRunRepository = new SkillTaskRunRepository(this.db)
  private readonly detachedSkillTasks: DetachedSkillTaskTracker
  private readonly autoNarrationContinuationRunner = new AutoNarrationContinuationRunner({
    getOldestPendingTaskEvent,
    markPendingTaskEventConsumed,
    hasActiveNarrationContinuationRun: () => this.hasActiveNarrationContinuationRun(),
    isAutoNarrationContinuationEnabled: () => readAgentAutoNarrationContinuationSetting(this.settingsRepository),
    startNarrationContinuationRun: (row) => this.startNarrationContinuationFromPending(row),
    onNarrationContinuationFailure: (row, error) => this.markNarrationContinuationFailure(row, error),
  })
  private readonly pendingInboundChannels = new Map<
    string,
    {
      channelId: string
      thread: string
      sender: string
      eventIds: string[]
      texts: string[]
      attachments: ChannelAttachment[]
      timer: NodeJS.Timeout | null
    }
  >()
  private pollTimer: NodeJS.Timeout | null = null
  private readonly scopeRunSummaries = new Map<string, ScopeRunSummary>()
  private lastSidecarRestartAttemptAt = 0
  // Channel connected/error counts are fetched from the sidecar over HTTP, which is too slow
  // to do on every getRuntimeStatus() call (it is on the Settings render path). Cache the last
  // values and refresh them from the 3s poll loop instead.
  private channelStateCache = { connected: 0, errors: 0 }
  private readonly lastAdapterRestartAttemptAt = new Map<string, number>()
  private heartbeat: HeartbeatSnapshot = {
    sidecar: { status: 'stopped' },
    adapters: [],
    orchestrator: { healthy: true, activeTasks: 0, lastBeatAt: new Date().toISOString() },
    toolGateway: {
      healthy: true,
      availableTools: this.toolGateway.count(),
      lastBeatAt: new Date().toISOString()
    }
  }

  constructor(agentManager: AgentManager, browserController?: BrowserController) {
    super()
    this.agentManager = agentManager
    // Stage Q (Stage 11) — boot fence: detect the incompatible
    // combination of `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED='0'` AND
    // a migrated CHECK constraint on `skill_task_runs`. PR-3 shipped
    // the `assertSkillTaskRunInvariantConsistency()` helper body; PR-5
    // wires it into the constructor here, immediately after the
    // database accessor is ready and before any code path that could
    // attempt to write a violator row. If the schema is fresh (no
    // CHECK yet) or the flag is on (default), this is a no-op. If
    // both conditions diverge, throw early so the user sees the error
    // at startup rather than mid-session.
    this.maybeAssertSkillTaskRunInvariant()
    this.orchestrator = new ReadyAgentOrchestrator({
      browserController,
      sidecarManager: this.sidecar,
      // EP2-I1 — lazy: taskProjectionStore is declared later; resolved at turn time.
      agentSdkRuntimeDeps: {
        getScopeTaskRefs: (scopeId) => selectFollowupTaskRefs(this.taskProjectionStore, scopeId),
      },
    })
    this.orchestrator.setPersonaResolver((agent) =>
      composePersonaSystemPrompt(
        agent,
        this.agentPersonalityRepository,
        this.userProfileRepository,
        defaultSystemPrompt,
      )
    )
    this.orchestrator.setRuntime(this)
    this.runCoordinator = new RunCoordinator({
      promptAssembly: this.promptAssembly,
      executeAndCollect: (request) => this.orchestrator.executeAndCollect(request),
      emitScopeRunEvent: (payload, projectionTruth) => this.emitScopeRunEvent(payload, projectionTruth),
      reflectOnConversation: (scope, usedTools) => this.reflectOnConversation(scope, usedTools)
    })
    this.runProjection = new RunProjection({
      getScope: (scopeId) => this.getConversationScope(scopeId),
      getPrevious: (scopeId) => this.scopeRunSummaries.get(scopeId),
      setSummary: (scopeId, summary) => {
        this.scopeRunSummaries.set(scopeId, summary)
        this.db.updateConversationRecallTaskState(scopeId, summary.taskTitle, summary.taskSummary)
      },
      toChannelKey: (scope) => this.toChannelKey(scope)
    })
    this.detachedSkillTasks = new DetachedSkillTaskTracker({
      storagePath: join(app.getPath('userData'), 'skill-runtime', 'detached-tasks.json'),
      runSkill: (request) => getSkillsRuntimeManager().runSkill(request),
      onUpdate: (record) => this.publishDetachedSkillTaskUpdate(record),
    })
    registerDetachedSkillTaskTracker(this.detachedSkillTasks)

    // Phase 5 — wire the skill child runner. The runner stays as a
    // module-level singleton so `skills-tools.ts` (Team 6) can call
    // `startSkillChildRun(...)` without crossing class boundaries. We
    // configure it once at runtime construction so the SQLite-backed
    // repository is ready and `getSkillsRuntimeManager()` is safe to
    // call.
    try {
      configureSkillChildRunner({
        runtimeManager: getSkillsRuntimeManager(),
        repository: this.skillTaskRunRepository,
        taskProjectionStore: this.taskProjectionStore,
        publishScopeRunEvent: (payload) => this.publishScopeRunEvent(payload),
      })
    } catch (error) {
      // Boot-time wiring failure is best-effort logged; the parent loop
      // continues to function via legacy paths if the child runner
      // can't be configured (e.g. DB unavailable in a test harness).
      console.warn(
        '[AgentControlRuntime] configureSkillChildRunner failed:',
        error instanceof Error ? error.message : String(error),
      )
    }

    // Stage N (Phase 0.3) — manifest⇔driver + manifest⇔static-name boot
    // invariants. Runs OUTSIDE the configureSkillChildRunner try/catch so a
    // violation throws uncaught and aborts boot via the global
    // unhandledRejection handler (process-handlers.ts:141-145). Static gate
    // `scripts/check-manifest-vs-static-tool-name.cjs` is the build-time
    // peer; this assertion is the runtime mirror that catches refactors
    // landing without `verify:n`. Pure-helper extracted to
    // `stage-n-boot-assertion.ts` so unit tests can verify the throw
    // shape without constructing a full AgentControlRuntime.
    assertStageNChildLoopInvariants({
      skills: getSkillsRuntimeManager().listSkills().map((s) => ({
        id: s.id,
        source: s.source,
        childLoop: s.childLoop,
      })),
      registeredDriverSkillIds: listRegisteredSkillChildDrivers(),
    })

    // Stage R W2.3 — tool-name uniqueness invariant. Eagerly walk the
    // full registry so any inter-group name collision (e.g. a static
    // tool sharing a name with a dynamic skill action in another group)
    // surfaces here at boot rather than as a wrong-handler dispatch
    // later. Same-group repeats are deduped silently inside
    // `listToolDefinitions()`. On violation we log + rethrow so the
    // global unhandledRejection handler aborts the process, mirroring
    // the Stage N assertion above.
    try {
      defaultToolRegistry.listToolDefinitions()
    } catch (error) {
      if (error instanceof ToolNameCollisionError) {
        console.error('[boot] ToolNameCollisionError detected:', error.collisions)
      }
      throw error
    }
    registerPendingTaskEventListener(() => this.autoNarrationContinuationRunner.trigger())
  }

  getOrchestrator(): ReadyAgentOrchestrator {
    return this.orchestrator
  }

  getMemoryRepository(): MemoryRepository {
    return this.memoryRepository
  }

  getMemoryLifecycleManager(): MemoryLifecycleManager {
    return this.memoryLifecycle
  }

  /** EP2-Q4a — projection store handle for the finalize-channel shadow
   *  adjudication (get/update only; lifecycle fields stay untouched there). */
  getTaskProjectionStoreForFinalize(): {
    get(taskId: string): TaskProjectionRecord | null
    update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: { silent?: boolean; reasonHint?: string }): void
  } {
    return this.taskProjectionStore
  }

  registerSessionAbortController(
    scopeId: string | null,
    sessionId: string | null,
    controller: AbortController,
  ): void {
    this.skillTaskRunRepository.registerSessionAbortController(scopeId, sessionId, controller)
  }

  unregisterSessionAbortController(
    scopeId: string | null,
    sessionId: string | null,
    controller?: AbortController,
  ): void {
    this.skillTaskRunRepository.unregisterSessionAbortController(scopeId, sessionId, controller)
  }

  getPromptAssembly(): PromptAssemblyService {
    return this.promptAssembly
  }

  /** EP1-K1: belief card store rooted at the same agent memory root. */
  getBeliefCardStore(): BeliefCardStore {
    if (!this.beliefCardStore) {
      this.beliefCardStore = new BeliefCardStore({
        memoryRoot: join(app.getPath('userData'), 'agent-memory'),
      })
    }
    return this.beliefCardStore
  }

  private getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.orchestrator.getDomainAdapters()
  }

  getExternalMemoryProviderSlot(): ExternalMemoryProviderSlot {
    return this.externalMemoryProviderSlot
  }

  async start(): Promise<void> {
    this.cleanupLegacyCopawSettings()
    this.publishRestoredDetachedSkillTasks()

    // Start memory lifecycle manager
    this.memoryLifecycle.start()
    this.autoNarrationContinuationRunner.trigger()

    // EP2-Q3 — additive bridge listener: terminal task events become
    // task_event proofs on the owning projection (bridge itself untouched).
    taskEventBridge.registerProjectionSink(
      createTaskEventProofListener(createTaskProofSink(this.taskProjectionStore)),
    )

    // EP2-K6 — truth-source boundary: startup full sync (K2 handover) +
    // hand-edit watcher, both behind the rollback switch. Files are never
    // written here — file → DB only.
    try {
      const knowledgeEnabled = isKnowledgeSystemEnabled(this.db)
      const rawDb = this.db.getRawDb?.()
      if (knowledgeEnabled && rawDb) {
        runStartupBeliefSync(rawDb as never, this.getBeliefCardStore(), true)
        this.knowledgeWatcher = new KnowledgeWatcher({ db: rawDb as never, store: this.getBeliefCardStore() })
        this.knowledgeWatcher.start()
      }
    } catch (error) {
      console.error('[runtime] knowledge truth-source wiring failed:', error)
    }

    const sidecarEnabled = this.getSettingBool('remote_channels_enabled', true)
    const autostart = this.getSettingBool('sidecar_autostart', true)
    const bindHost = this.db.getSetting('sidecar_bind_host') || '127.0.0.1'
    const bindPort = this.parsePortSetting(this.db.getSetting('sidecar_bind_port'))
    this.sidecar.setBindConfig(bindHost, bindPort)
    if (!sidecarEnabled || !autostart) return
    await this.startSidecar()
  }

  async stop(): Promise<void> {
    const terminalStates = new Set(['done', 'failed', 'cancelled', 'closed'])
    for (const session of this.orchestrator.listAllSessions()) {
      if (terminalStates.has(session.state)) continue
      await this.orchestrator.closeSession(session.agent, session.sessionId || undefined)
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    // Stop memory lifecycle manager
    this.memoryLifecycle.stop()
    this.knowledgeWatcher?.stop()
    await this.externalMemoryProviderSlot.shutdown()

    await this.sidecar.stop()
  }

  async startSidecar(): Promise<void> {
    const status = await this.sidecar.start()
    this.heartbeat.sidecar = {
      status: status.state,
      pid: status.pid || undefined,
      port: status.port || undefined,
      lastBeatAt: status.lastHeartbeatAt || undefined,
      error: status.error || undefined
    }
    if (status.state === 'running') {
      await this.syncDatabaseToSidecar()
      this.ensurePollLoop()
    }
  }

  async getRuntimeStatus(): Promise<AgentRuntimeStatus> {
    const channels = this.listChannels()
    const schedules = this.listSchedules()
    const byType: Record<string, number> = {}
    for (const channel of channels) {
      byType[channel.type] = (byType[channel.type] || 0) + 1
    }

    const sidecarStatus = this.sidecar.getStatus()
    this.heartbeat.sidecar = {
      status: sidecarStatus.state,
      pid: sidecarStatus.pid || undefined,
      port: sidecarStatus.port || undefined,
      lastBeatAt: sidecarStatus.lastHeartbeatAt || undefined,
      error: sidecarStatus.error || undefined
    }
    this.heartbeat.orchestrator = {
      healthy: true,
      activeTasks: this.orchestrator.getSessionManager().getActiveCount(),
      lastBeatAt: new Date().toISOString()
    }
    this.heartbeat.toolGateway = {
      healthy: true,
      availableTools: this.toolGateway.count(),
      lastBeatAt: new Date().toISOString()
    }

    const { connected, errors } = this.sidecar.isRunning()
      ? this.channelStateCache
      : { connected: 0, errors: 0 }

    return {
      orchestrator: this.orchestrator.getRuntimeKernel(),
      sidecarEnabled: this.getSettingBool('remote_channels_enabled', true),
      sidecar: this.heartbeat.sidecar,
      channels: {
        total: channels.length,
        enabled: channels.filter((item) => item.enabled).length,
        connected,
        errors,
        byType
      },
      schedules: {
        total: schedules.length,
        enabled: schedules.filter((item) => item.enabled).length
      },
      heartbeat: this.heartbeat
    }
  }

  async getCapabilityRuntimeSnapshot(configOverride?: AIModelConfig): Promise<CapabilityRuntimeSnapshot> {
    await this.getRuntimeStatus()

    const config = normalizeAIConfig(
      configOverride || this.settingsRepository.getAIConfig() || getDefaultConfig()
    )
    const enabledChannelTypes = Array.from(
      new Set(
        this.listChannels()
          .filter((channel) => channel.enabled)
          .map((channel) => channel.type)
      )
    )
    const connectedChannelTypes = Array.from(
      new Set(
        this.heartbeat.adapters
          .filter(
            (adapter) =>
              adapter.healthy && adapter.status !== 'error' && adapter.status !== 'stopped'
          )
          .map((adapter) => adapter.type)
      )
    )
    const feishuConnected =
      connectedChannelTypes.includes('feishu-app') || this.isChannelTypeAvailable('feishu-app')

    return buildCapabilityRuntimeSnapshot({
      config,
      profile: 'local_chat',
      browserDecisionMode: 'free_tool_loop',
      runtimeAvailability: {
        browserHostAvailable: this.orchestrator.hasBrowserController(),
        feishuConnected
      },
      enabledChannelTypes,
      connectedChannelTypes
    })
  }

  listChannels(): AgentChannelConfig[] {
    const rows = this.db.listAgentChannels()
    return rows.map((row) => this.mapChannelRow(row))
  }

  isChannelTypeAvailable(type: AgentChannelType): boolean {
    const hasEnabledChannel = this.listChannels().some(
      (channel) => channel.type === type && channel.enabled
    )
    if (!hasEnabledChannel) return false

    const heartbeatAdapter = this.heartbeat.adapters.find((adapter) => adapter.type === type)
    if (!heartbeatAdapter) return true
    return (
      heartbeatAdapter.healthy &&
      heartbeatAdapter.status !== 'error' &&
      heartbeatAdapter.status !== 'stopped'
    )
  }

  listConversationScopes(agent?: string): ConversationScope[] {
    return this.db.listConversationScopes(agent).map((row) => this.mapConversationRow(row))
  }

  listScopeRuns(payload?: {
    channelKey?: string
    statuses?: Array<ScopeRunEventPayload['phase']>
    limit?: number
  }): ScopeRunSummary[] {
    const channelKey = String(payload?.channelKey || '').trim()
    const statuses = Array.isArray(payload?.statuses) ? new Set(payload?.statuses) : null
    const limit = Number.isFinite(Number(payload?.limit))
      ? Math.max(1, Math.min(100, Number(payload?.limit)))
      : 20
    return Array.from(this.scopeRunSummaries.values())
      .filter((item) => (channelKey ? item.channelKey === channelKey : true))
      .filter((item) => (statuses ? statuses.has(item.phase) : true))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit)
  }

  /**
   * Stage O — exposes the repository so `setupAgentIPC` can subscribe to
   * the `change` event and forward it as `agent:taskProjectionsChanged`.
   * Read-only by intent: callers must not mutate; writes still go through
   * `recordScopeRunEvent` / `syncTaskProjection` / `skill-child-runner` so
   * the emit contract is preserved.
   */
  getTaskProjectionStore(): TaskProjectionRepository {
    return this.taskProjectionStore
  }

  getRunMetaRepository(): RunMetaRepository | null {
    const rawDb = this.db.getRawDb()
    return rawDb ? new RunMetaRepository(rawDb) : null
  }

  private hasActiveNarrationContinuationRun(): boolean {
    const activePhases = new Set<ScopeRunEventPayload['phase']>([
      'queued',
      'planning',
      'tool_running',
      'resuming',
      'responding',
    ])
    return Array.from(this.scopeRunSummaries.values()).some((summary) =>
      summary.taskType === 'continuation' && activePhases.has(summary.phase)
    )
  }

  private async startNarrationContinuationFromPending(
    row: PendingTaskEventRow,
  ): Promise<{ success: boolean; error?: string | null }> {
    const event = parsePendingTaskEventPayload(row)
    const scopeId = resolvePendingTaskEventScopeId(event)
    if (!event || !scopeId) {
      return { success: false, error: 'Pending task event is missing a scopeId.' }
    }
    const scope = this.getConversationScope(scopeId)
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

    this.emitScopeRunEvent({
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

    const result = await this.orchestrator.send(
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

    this.emitScopeRunEvent({
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
    const scopeId = resolvePendingTaskEventScopeId(event)
    if (!event || !scopeId) return
    const scope = this.getConversationScope(scopeId)
    if (!scope) return
    this.emitScopeRunEvent({
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

  listTaskProjections(scopeId: string): TaskProjectionRecord[] {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return []
    const records = this.taskProjectionStore.listByScope(normalizedScopeId) as TaskProjectionRecord[]
    try {
      const taskRuns = this.skillTaskRunRepository.listByScope(normalizedScopeId, 100)
      reconcileTaskProjections({
        store: this.taskProjectionStore,
        records,
        taskRuns,
        now: new Date().toISOString(),
      })
    } catch (error) {
      console.warn(`[task-projection-reconciler] failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const refreshed = this.taskProjectionStore.listByScope(normalizedScopeId) as TaskProjectionRecord[]
    // Stage Q (Stage 11) — derive canResume per record before returning.
    // See `TaskProjectionRecord.canResume` doc comment for rationale.
    return refreshed.map((record) => deriveTaskProjectionCanResume(record))
  }

  getTaskProjection(taskId: string): TaskProjectionRecord | null {
    const normalizedTaskId = String(taskId || '').trim()
    if (!normalizedTaskId) return null
    const record = this.taskProjectionStore.get(normalizedTaskId) as TaskProjectionRecord | null
    if (!record) return null
    // Stage Q (Stage 11) — derive canResume on the single-record path too,
    // so direct fetches (renderer cold-start, IPC `getTaskProjection`)
    // see the same truth as `listTaskProjections`. Stage Q plan §3.4
    // contract C10.
    return deriveTaskProjectionCanResume(record)
  }

  searchSessionRecall(payload?: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecallService.searchSessionRecall(payload || {})
  }

  listRecentSessions(payload?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecallService.listRecentSessions(payload || {})
  }

  getSessionRecallCapsule(conversationId: string): SessionRecallCapsule | null {
    return this.sessionRecallService.getSessionRecallCapsule({ conversationId })
  }

  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[] {
    return this.sessionRecallService.listAttachedSessionRecallContexts(scopeId)
  }

  getReferenceSkillHint(scopeId: string): { id: string; name: string; at: number; expiresAt: number } | null {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return null
    const live = peekLastReferenceSkill(normalizedScopeId)
    // This IPC is a renderer read for the small "skill context enabled"
    // badge. It must not re-arm persisted hints by itself; otherwise merely
    // opening Ready can light up a stale VEA context before the next user
    // turn proves it is relevant. Turn execution still restores persisted
    // hints in `sendScoped(...)`, where intent gating can immediately clear
    // unrelated turns.
    if (!live) return null
    const latestUserText = (() => {
      try {
        const messages = this.db.getChatMessages(normalizedScopeId)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message.role === 'user') return message.content || ''
        }
      } catch {
        return ''
      }
      return ''
    })()
    if (!shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText,
      skillId: live.id,
      skillName: live.name,
    })) {
      return null
    }
    return {
      id: live.id,
      name: live.name,
      at: live.at,
      expiresAt: live.at + REFERENCE_SKILL_HINT_TTL_MS,
    }
  }

  /**
   * Phase 1.1 — Public hook the renderer's `chat:saveMessage` IPC calls after
   * persisting a message, so a hint armed during the assistant's turn survives
   * a Ready restart for LOCAL conversations too.
   *
   * Background: assistant messages saved via `chat:saveMessage` IPC go through
   * `ChatRepository.saveMessage` (a thin wrapper over `db.addChatMessage`),
   * which bypasses `runtime.createConversationMessage` — the only path that
   * previously snapshot the in-memory hint into `meta_json.lastReferenceSkill`.
   * Result before this hook: local sessions never persisted hints, so a Ready
   * restart always re-armed `referenceSkillHintArmed=false` and the model lost
   * VEA / other typed actions mid-flow.
   *
   * No-op for non-assistant roles. Safe to call after every message; the
   * underlying `persistReferenceHintToScope` is idempotent (skips DB write
   * when the persisted snapshot equals the in-memory one).
   */
  persistReferenceHintAfterAssistantMessage(scopeId: string, role: string): void {
    if (role !== 'assistant') return
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return
    this.persistReferenceHintToScope(normalizedScopeId)
  }

  startDetachedSkillAction(payload: {
    scopeId?: string | null
    sessionId?: string | null
    agent?: string | null
    parentTaskId?: string | null
    parentStepId?: string | null
    taskProjectionId?: string | null
    skillId: string
    action: string
    params?: Record<string, unknown>
  }): DetachedSkillTaskRecord {
    return this.detachedSkillTasks.start(payload)
  }

  inspectDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    const normalizedScopeId = String(scopeId || '').trim()
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return task
  }

  listDetachedSkillTasks(payload?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    return this.detachedSkillTasks.list(payload)
  }

  cancelDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const normalizedScopeId = String(scopeId || '').trim()
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return this.detachedSkillTasks.cancel(taskId)
  }

  listActiveChildRuns(): ActiveChildRunSummaryForRuntime[] {
    return this.listActiveChildRunsWithDiagnostics().rows
  }

  /**
   * Stage 3 W1 — same merged result as `listActiveChildRuns`, plus a
   * diagnostic field that surfaces projection DB query failures. The IPC
   * normalizer (`active-child-run-ipc.ts`) reads `projectionFailure` and
   * emits `active_child_run_projection_query_failed`; in-memory rows from
   * `getSkillChildRunner().listActiveRuns()` are NEVER dropped on DB jitter.
   */
  listActiveChildRunsWithDiagnostics(): {
    rows: ActiveChildRunSummaryForRuntime[]
    projectionFailure: { reason: 'projection_db_error'; message: string } | null
  } {
    const projection = this.listProjectionBackedChildRunSummaries()
    const merged = new Map<string, ActiveChildRunSummaryForRuntime>()
    for (const row of projection.rows) {
      merged.set(row.childRunId, row)
    }
    for (const row of getSkillChildRunner()?.listActiveRuns() ?? []) {
      merged.set(row.childRunId, row)
    }
    const rows = Array.from(merged.values())
      .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))
    return { rows, projectionFailure: projection.failure }
  }

  private listProjectionBackedChildRunSummaries(): {
    rows: ActiveChildRunSummaryForRuntime[]
    failure: { reason: 'projection_db_error'; message: string } | null
  } {
    const rawDb = this.db.getRawDb()
    if (!rawDb) return { rows: [], failure: null }
    let rows: TaskProjectionChildSummaryRow[] = []
    try {
      rows = rawDb.prepare(`
        SELECT task_id, scope_id, status, blocked_reason, continuation_ref_json,
               recent_artifacts_json, created_at, updated_at
        FROM task_projections
        WHERE task_id LIKE 'skill-child:%'
          AND status IN ('queued', 'running', 'blocked', 'failed')
        ORDER BY updated_at DESC
        LIMIT 100
      `).all<TaskProjectionChildSummaryRow>()
    } catch (error) {
      return {
        rows: [],
        failure: {
          reason: 'projection_db_error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    const mapped = rows.map((row) => {
      const continuation = parseRecordJson(row.continuation_ref_json)
      const artifacts = parseArrayJson(row.recent_artifacts_json)
      const childRunId = stringFromUnknown(continuation?.childRunId)
        || row.task_id.replace(/^skill-child:/, '')
      const skillId = stringFromUnknown(continuation?.skillId)
        || artifactMetaString(artifacts, 'skillId')
        || 'unknown'
      const outputDir = stringFromUnknown(continuation?.outputDir)
        || artifactMetaString(artifacts, 'outputDir')
        || ''
      const runStatePath = stringFromUnknown(continuation?.runStatePath)
        || artifactMetaString(artifacts, 'runStatePath')
        || ''
      return {
        childRunId,
        skillId,
        sessionId: null,
        scopeId: row.scope_id,
        status: childRunSummaryStatusFromProjection(row.status),
        startedAt: row.created_at || row.updated_at,
        outputDir,
        runStatePath,
        progress: progressFromUnknown(continuation?.progress),
        blockedReason: row.blocked_reason,
        liveness: row.status === 'queued' || row.status === 'running' || row.status === 'blocked'
          ? 'background' as const
          : null,
        closeStatus: row.status === 'failed' ? 'failed' : null,
      }
    }).filter((row) => Boolean(row.childRunId))
    return { rows: mapped, failure: null }
  }

  async cancelChildRun(childRunId: string, options: { source: 'ui_button' }): Promise<unknown> {
    return cancelSkillChildRun(childRunId, options)
  }

  attachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope; capsule: SessionRecallCapsule } {
    const result = this.sessionRecallService.attachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.mapConversationRow(result.scope)
    this.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope, capsule: result.capsule }
  }

  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope } {
    const result = this.sessionRecallService.detachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.mapConversationRow(result.scope)
    this.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope }
  }

  resumeSessionCandidate(payload: {
    conversationId?: string
    resumeTitle?: string
  }): SessionRecallHit | null {
    return this.sessionRecallService.resumeSessionCandidate(payload)
  }

  getConversationScope(scopeId: string): ConversationScope | null {
    const row = this.db.getConversationScope(scopeId)
    return row ? this.mapConversationRow(row) : null
  }

  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[] {
    return this.db.getChatMessages(scopeId).map((row) => this.mapMessageRow(row))
  }

  deleteConversation(scopeId: string): void {
    this.scopeRunSummaries.delete(scopeId)
    forgetSession(scopeId)
    this.taskProjectionStore.deleteByScope(scopeId)
    try {
      new BrowserCollectionConsentStore().deleteByScope(scopeId)
    } catch (error) {
      console.warn('[Runtime] Failed to clear browser collection consent scope:', error)
    }
    this.db.deleteConversation(scopeId)
  }

  listScopeAttachments(scopeId: string): ConversationAttachment[] {
    return this.db
      .listConversationAttachments(scopeId)
      .filter((item) => item.path && existsSync(item.path))
      .map((item) => ({
        attachmentId: item.attachment_id,
        scopeId: item.conversation_id,
        sourceMessageId: item.source_message_id,
        name: item.name,
        path: item.path,
        type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(String(item.type))
          ? (item.type as ConversationAttachment['type'])
          : 'other',
        size: item.size,
        ext: item.ext,
        url: item.url,
        mimeType: item.mime_type,
        remoteId: item.remote_id,
        channelId: item.channel_id,
        threadKey: item.thread_key,
        createdAt: item.created_at
      }))
  }

  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null {
    return (
      this.listScopeAttachments(scopeId).find((item) => item.attachmentId === attachmentId) || null
    )
  }

  getRemoteAttachmentCacheStats(channelId?: string): {
    totalFiles: number
    totalBytes: number
    targetPath: string
    channels: Array<{ channelId: string; files: number; bytes: number }>
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let totalFiles = 0
    let totalBytes = 0
    const byChannel = new Map<string, { files: number; bytes: number }>()

    const walk = (currentPath: string, currentChannelId?: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        totalFiles += 1
        totalBytes += stat.size
        if (currentChannelId) {
          const current = byChannel.get(currentChannelId) || { files: 0, bytes: 0 }
          current.files += 1
          current.bytes += stat.size
          byChannel.set(currentChannelId, current)
        }
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        const nextPath = join(currentPath, entry)
        const nextChannelId =
          currentChannelId || (!channelId && currentPath === basePath ? entry : currentChannelId)
        walk(nextPath, nextChannelId)
      }
    }

    walk(targetPath, channelId || undefined)

    return {
      totalFiles,
      totalBytes,
      targetPath,
      channels: Array.from(byChannel.entries()).map(([itemChannelId, value]) => ({
        channelId: itemChannelId,
        files: value.files,
        bytes: value.bytes
      }))
    }
  }

  clearRemoteAttachmentCache(channelId?: string): {
    removedFiles: number
    removedBytes: number
    targetPath: string
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let removedFiles = 0
    let removedBytes = 0

    const walk = (currentPath: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        removedFiles += 1
        removedBytes += stat.size
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        walk(join(currentPath, entry))
      }
    }

    walk(targetPath)
    rmSync(targetPath, { recursive: true, force: true })
    return { removedFiles, removedBytes, targetPath }
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
  createLocalScopeWithMode(
    agent: string,
    id?: string,
  ): { scope: ConversationScope; mode: UpsertConversationScopeMode } {
    const scopeId = typeof id === 'string' && id.trim() ? id.trim() : `conv-${randomUUID()}`
    const { row, mode } = this.db.upsertConversationScope({
      id: scopeId,
      agent,
      userId: 'default-user',
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: scopeId,
      meta: { sourceLabel: '应用内', createdBy: 'app' }
    })
    const scope = this.mapConversationRow(row)
    logAgentMetric('local_scope_upsert', { scopeId: scope.id, agent, mode })
    this.emitConversationEvent({ type: 'scope_created', scope })
    return { scope, mode }
  }

  async sendScoped(payload: {
    scopeId: string
    agent?: string
    message: string | MultimodalBlock[]
    requestId?: string
    userMessage?: SendScopedUserMessage
    taskId?: string
    parentTaskId?: string
    parentStepId?: string
    sessionIdOverride?: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<SendScopedResponse> {
    return runConfirmedSendScoped({
      scopeId: payload.scopeId,
      agent: payload.agent,
      userMessage: payload.userMessage,
      getScope: (scopeId) => this.db.getConversationScope(scopeId),
      createLocalScope: (agent, scopeId) => {
        const recoveredScope = this.createLocalScope(agent, scopeId)
        const recoveredRow = this.db.getConversationScope(recoveredScope.id)
        if (!recoveredRow) {
          throw new Error(`Conversation scope not found after create: ${scopeId}`)
        }
        return recoveredRow
      },
      persistUserMessage: (scopeRow, userMessage) => {
        const scope = this.mapConversationRow(scopeRow)
        this.db.addChatMessage(
          userMessage.id,
          scope.id,
          'user',
          userMessage.content,
          userMessage.timestamp || new Date().toISOString(),
          userMessage.meta,
        )
      },
      onLazyCreate: (scopeId, agent) => {
        logAgentMetric('local_scope_lazy_created_on_send', { scopeId, agent })
      },
      runConfirmed: async (scopeRow, persistence) => {
        const scope = this.mapConversationRow(scopeRow)
        // skill-resume A1: restore reference-skill hint from persisted conv meta
        // before any skill detection runs, so resumed sessions don't lose context
        // after Ready restart (in-memory Map alone wouldn't survive).
        this.restoreReferenceHintFromScope(scope, payload.scopeId)
        // skill-resume E1: when the user fires a bare retry/continue intent on a
        // scope with no manually-attached recall context, auto-attach the top
        // predecessors in the same lineage so prompt assembly has prior context
        // when it runs.
        this.maybeAutoAttachSessionRecallOnResume(payload.scopeId, payload.message)
        const normalizedContinuationIntent = (() => {
          const intent = normalizeContinuationIntent(payload.continuationIntent || null)
          if (!intent) {
            const text = this.extractTextFromMessage(payload.message)
            if (!isRetryOnlyTurn(text)) return null
            const projections = this.listTaskProjections(payload.scopeId)
            const sortedProjections = projections
              .slice()
              .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
            const resumableProjection = sortedProjections.find((projection) =>
              deriveTaskProjectionCanResume(projection).canResume === true
            ) || null
            const targetProjection = resumableProjection || selectContinuationProjection({
              projections,
              userText: text,
            })
            const scopeRunSummary = this.scopeRunSummaries.get(payload.scopeId) || null
            const built = this.buildContinuationIntent({
              projection: targetProjection,
              scopeRunSummary,
              incoming: null,
              responseText: text,
            })
            if (built) {
              logAgentMetric('runtime_resume_intent_auto_built_on_send', {
                scopeId: scope.id,
                taskId: built.taskId,
                hasChildRunId: Boolean(built.childRunId),
                hasOutputDir: Boolean(built.outputDir),
                hasRunStatePath: Boolean(built.runStatePath),
              })
            }
            return built
          }
          const target = this.resolveTaskControlTarget(payload.scopeId, intent.taskId)
          if (!target) return null
          return this.buildContinuationIntent({
            projection: target.projection,
            scopeRunSummary: target.scopeRunSummary,
            incoming: intent,
          })
        })()
        const result = await this.runCoordinator.runScoped(
          {
            scope,
            message: payload.message as
              | string
              | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
            requestId: payload.requestId,
            taskId: payload.taskId,
            parentTaskId: payload.parentTaskId,
            parentStepId: payload.parentStepId,
            sessionIdOverride: payload.sessionIdOverride,
            continuationIntent: normalizedContinuationIntent,
            coordinators: this.getDomainAdapters(),
          },
          {
            onSuccess: async (result) => {
              if (scope.sourceKind !== 'channel') return
              const outboundText =
                result.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
              const sendOk = await this.sendLongTextToChannel(
                scope.sourceId,
                scope.threadKey,
                outboundText
              )
              if (!sendOk.success) {
                throw new Error(sendOk.error || 'Failed to send channel reply')
              }
            }
          }
        )
        return {
          ...result,
          errorKind: result.scopeRunAuthority?.state === 'lost'
            ? 'superseded'
            : result.success ? undefined : classifySendScopedError(result.error, 'run'),
          persistence,
        }
      },
    })
  }

  async suspendRun(payload: {
    scopeId: string
    taskId?: string
  }): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    this.orchestrator.kill(target.scope.agent, target.scope.id)

    const restored = restoreContinuationTaskBudgetRuntime({
      taskType: target.projection?.taskType || 'short_task',
      projectionBudget: target.projection?.budget || null,
      projectionBudgetRuntime: null,
      budget: target.projection?.budget || null,
    })
    const runtime = restored.runtime
      ? {
        ...restored.runtime,
        frozen: true,
      }
      : null
    const resolvedTaskId = target.projection?.taskId || target.scopeRunSummary?.taskId || payload.taskId
    const resolvedTaskType = target.projection?.taskType || target.scopeRunSummary?.taskType || 'short_task'
    const timestamp = new Date().toISOString()
    this.emitScopeRunEvent({
      type: 'updated',
      scopeId: target.scope.id,
      agent: target.scope.agent,
      runId: target.projection?.runId,
      taskId: resolvedTaskId,
      phase: 'takeover',
      taskType: resolvedTaskType,
      interactionState: 'suspended',
      taskTitle: target.projection?.taskTitle || target.scopeRunSummary?.taskTitle || undefined,
      taskSummary: target.projection?.taskSummary || target.scopeRunSummary?.taskSummary || undefined,
      steps: (target.projection?.steps || target.scopeRunSummary?.steps || []) as any,
      currentStepId: target.projection?.currentStepId || target.scopeRunSummary?.currentStepId || null,
      waitingFor: 'none',
      resumableActions: ['continue', 'cancel'],
      blockedReason: '任务已暂停，等待继续。',
      taskContinuation: target.projection?.continuationRef || target.scopeRunSummary?.taskContinuation || undefined,
      taskProjectionId: resolvedTaskId,
      executionDiagnostics: runtime
        ? {
          taskId: resolvedTaskId,
          taskBudgetRuntime: runtime,
          budget: {
            ...runtime.budget,
            ...runtime.usage,
          },
          stepBudget: runtime.stepBudget
            ? {
              stepId: runtime.stepBudget.stepId || null,
              maxIterations: runtime.stepBudget.maxIterations,
              remainingIterations: runtime.stepBudget.remainingIterations,
            }
            : null,
          budgetUsagePercent: getBudgetUsagePercent(runtime),
          budgetWarningLevel: runtime.warningLevel,
        }
        : null,
      timestamp,
    })
    return { success: true }
  }

  async resumeRun(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText?: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    const builtIntent = this.buildContinuationIntent({
      projection: target.projection,
      scopeRunSummary: target.scopeRunSummary,
      incoming: payload.continuationIntent || null,
      responseText: payload.responseText,
    })
    // Stage Q (Stage 11) — Audit §F-6 / plan §3.4 contract C6+C7:
    // refuse to fire `sendScoped` with an empty-shell intent. The
    // `buildContinuationIntent` gate (canResumeShape) returns null
    // when no real durable handle is present; the renderer button
    // double-gates via `canResume`, but main MUST also refuse so
    // direct IPC calls (programmatic resumes, future agents) cannot
    // bypass the contract.
    if (builtIntent === null) {
      logAgentMetric('runtime_resume_run_rejected_not_resumable', {
        scopeId: target.scope.id,
        taskId: payload.taskId || null,
      })
      return {
        success: false,
        error: 'Task is not resumable: no durable handle (childRunId, detachedTaskId, or outputDir+runStatePath).',
        errorKind: 'not_resumable',
      }
    }
    return this.sendScoped({
      scopeId: target.scope.id,
      requestId: payload.requestId,
      message: String(payload.responseText || '').trim() || '继续当前任务。',
      continuationIntent: builtIntent,
    })
  }

  async respondToInteraction(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText: string
    confirmed?: boolean
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    const responseText = String(payload.responseText || '').trim()
    if (!responseText) {
      return { success: false, error: 'Interaction response is required' }
    }
    if (payload.confirmed === true && payload.taskId?.startsWith('browser-task-')) {
      const resumed = await resumeWaitingHumanBrowserTaskFromBridge({
        taskId: payload.taskId,
        confirmed: payload.confirmed,
      })
      if (resumed.success) return { success: true }
    }
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
    const builtIntent = this.buildContinuationIntent({
      projection: target.projection,
      scopeRunSummary: target.scopeRunSummary,
      incoming: payload.continuationIntent || null,
      responseText,
    })
    const canRespondWithoutResumeHandle = canRespondToUserInteractionWithoutResumeHandle({
      projection: target.projection,
      scopeRunSummary: target.scopeRunSummary,
    })
    if (builtIntent === null && !canRespondWithoutResumeHandle) {
      logAgentMetric('runtime_respond_to_interaction_rejected_not_resumable', {
        scopeId: target.scope.id,
        taskId: payload.taskId || null,
      })
      return {
        success: false,
        error: 'Task is not resumable: no durable handle (childRunId, detachedTaskId, or outputDir+runStatePath).',
        errorKind: 'not_resumable',
      }
    }
    return this.sendScoped({
      scopeId: target.scope.id,
      requestId: payload.requestId,
      taskId: target.projection?.taskId || target.scopeRunSummary?.taskId || payload.taskId,
      message: responseText,
      continuationIntent: builtIntent,
    })
  }

  async upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig> {
    const id = payload.id || `channel-${randomUUID()}`
    const encryptedConfig = encryptChannelConfig(payload.config || {})
    const row = this.db.upsertAgentChannel({
      id,
      type: payload.type as AgentChannelType,
      name: payload.name.trim() || id,
      enabled: payload.enabled ?? true,
      configJson: JSON.stringify(encryptedConfig)
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertChannel({
        id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(encryptedConfig)
      })
      if (row.enabled) {
        await this.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async deleteChannel(id: string): Promise<boolean> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.stopChannel(id).catch(() => undefined)
      await this.sidecar.deleteChannel(id).catch(() => undefined)
    }
    return this.db.deleteAgentChannel(id)
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null> {
    const row = this.db.setAgentChannelEnabled(id, enabled)
    if (!row) return null
    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertChannel({
        id: row.id,
        type: row.type,
        name: row.name,
        enabled: Boolean(row.enabled),
        config: decryptChannelConfig(
          this.tryParseJson<Record<string, unknown>>(row.config_json, {})
        )
      })
      if (enabled) {
        await this.sidecar.startChannel(id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(id).catch(() => undefined)
      }
    }
    return this.mapChannelRow(row)
  }

  async sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    const channel = this.db.getAgentChannel(id)
    if (!channel) return { success: false, error: `Channel not found: ${id}` }
    try {
      await this.sidecar.sendChannel({
        id,
        text: text.trim() || 'Ready 连接测试成功'
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    try {
      const response = await this.sidecar.testChannel({
        id: payload.id || `temp-${randomUUID()}`,
        type: payload.type,
        name: payload.name,
        enabled: payload.enabled ?? true,
        config: payload.config || {}
      })
      if (response.success === false) {
        return { success: false, error: String(response.error || 'channel test failed') }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async startWechatLogin(payload: {
    id?: string
    defaultTarget?: string
    force?: boolean
  }): Promise<Record<string, unknown>> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    const id = payload.id || 'channel-wechat-openclaw-default'
    const existing = this.db.getAgentChannel(id)
    const existingConfig = existing
      ? decryptChannelConfig(this.tryParseJson<Record<string, unknown>>(existing.config_json, {}))
      : {}
    const defaultTarget = String(payload.defaultTarget || existingConfig.defaultTarget || '').trim()
    const config: Record<string, unknown> = {
      ...existingConfig,
      ...(defaultTarget ? { defaultTarget } : {}),
    }
    await this.sidecar.upsertChannel({
      id,
      type: 'wechat-openclaw',
      name: existing?.name || '微信',
      enabled: false,
      config,
    })
    return this.sidecar.startWechatLogin(id, payload.force ?? true)
  }

  async getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    return this.sidecar.getWechatLoginStatus(channelId, sessionKey)
  }

  async submitWechatLoginVerifyCode(channelId: string, sessionKey: string, code: string): Promise<Record<string, unknown>> {
    if (!this.sidecar.isRunning()) {
      await this.startSidecar()
    }
    return this.sidecar.submitWechatLoginVerifyCode(channelId, sessionKey, code)
  }

  listSchedules(): CronTask[] {
    const rows = this.db.listAgentSchedules()
    return rows.map((row) => this.mapScheduleRow(row))
  }

  async upsertSchedule(payload: UpsertSchedulePayload): Promise<CronTask> {
    const id = payload.id || `cron-${randomUUID()}`
    const row = this.db.upsertAgentSchedule({
      id,
      name: payload.name.trim() || id,
      cronExpr: payload.cronExpr,
      prompt: payload.prompt,
      channelId: payload.channelId ?? null,
      enabled: payload.enabled ?? true,
      payloadJson: payload.payload ? JSON.stringify(payload.payload) : null
    })

    if (this.sidecar.isRunning()) {
      await this.sidecar.upsertSchedule({
        id,
        name: row.name,
        cronExpr: row.cron_expr,
        prompt: row.prompt,
        channelId: row.channel_id,
        enabled: Boolean(row.enabled),
        payload: payload.payload || {}
      })
    }
    return this.mapScheduleRow(row)
  }

  async pauseSchedule(id: string): Promise<CronTask | null> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.pauseSchedule(id)
    }
    const row = this.db.setAgentScheduleEnabled(id, false)
    return row ? this.mapScheduleRow(row) : null
  }

  async resumeSchedule(id: string): Promise<CronTask | null> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.resumeSchedule(id)
    }
    const row = this.db.setAgentScheduleEnabled(id, true)
    return row ? this.mapScheduleRow(row) : null
  }

  async deleteSchedule(id: string): Promise<boolean> {
    if (this.sidecar.isRunning()) {
      await this.sidecar.deleteSchedule(id)
    }
    return this.db.deleteAgentSchedule(id)
  }

  async runScheduleNow(id: string): Promise<{ success: boolean; error?: string }> {
    const schedule = this.db.getAgentSchedule(id)
    if (!schedule) return { success: false, error: `Schedule not found: ${id}` }
    return await this.executeSchedule(schedule, 'manual')
  }

  async syncDatabaseToSidecar(): Promise<void> {
    if (!this.sidecar.isRunning()) return
    const channels = this.listChannels()
    for (const channel of channels) {
      await this.sidecar.upsertChannel({
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        config: channel.config
      })
      if (channel.enabled) {
        await this.sidecar.startChannel(channel.id).catch(() => undefined)
      } else {
        await this.sidecar.stopChannel(channel.id).catch(() => undefined)
      }
    }
    const schedules = this.listSchedules()
    for (const schedule of schedules) {
      await this.sidecar.upsertSchedule({
        id: schedule.id,
        name: schedule.name,
        cronExpr: schedule.cronExpr,
        prompt: schedule.prompt,
        channelId: schedule.channelId,
        enabled: schedule.enabled,
        payload: schedule.payload || {}
      })
    }
  }

  private ensurePollLoop(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollSidecarEvents()
    }, 3_000)
  }

  private async pollSidecarEvents(): Promise<void> {
    if (!this.sidecar.isRunning()) {
      const sidecarEnabled = this.getSettingBool('remote_channels_enabled', true)
      const autostart = this.getSettingBool('sidecar_autostart', true)
      const now = Date.now()
      if (sidecarEnabled && autostart && now - this.lastSidecarRestartAttemptAt > 30_000) {
        this.lastSidecarRestartAttemptAt = now
        await this.startSidecar()
      }
      return
    }
    try {
      const heart = await this.sidecar.heartbeat()
      this.heartbeat.sidecar.lastBeatAt = new Date().toISOString()
      this.heartbeat.sidecar.status = 'running'
      const adapters = Array.isArray((heart as { adapters?: unknown[] }).adapters)
        ? ((heart as { adapters?: unknown[] }).adapters as Array<Record<string, unknown>>)
        : []
      this.heartbeat.adapters = adapters.map((item) => ({
        id: String(item.id || ''),
        type: String(item.type || 'local-debug') as ChannelAdapterType,
        healthy: Boolean(item.healthy),
        status:
          typeof item.status === 'string'
            ? (item.status as 'starting' | 'running' | 'stopped' | 'error')
            : undefined,
        lastBeatAt: typeof item.lastBeatAt === 'string' ? item.lastBeatAt : undefined,
        error: typeof item.error === 'string' ? item.error : undefined
      }))
      await this.reviveErroredAdapters()

      const channelState = await this.sidecar.getChannelState().catch(() => null)
      if (channelState) {
        this.channelStateCache = {
          connected: Number((channelState as { connected?: number }).connected || 0),
          errors: Number((channelState as { errors?: number }).errors || 0)
        }
      }

      const events = await this.sidecar.pullEvents(24)
      for (const evt of events) {
        const evtType = String(evt.type || '')
        if (evtType === 'schedule.trigger') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          const scheduleId = String(payload.scheduleId || '')
          if (!scheduleId) continue
          const schedule = this.db.getAgentSchedule(scheduleId)
          if (!schedule || schedule.enabled === 0) continue
          await this.executeSchedule(schedule, 'cron')
          continue
        }
        if (evtType === 'channel.inbound') {
          const payload = (evt.payload || {}) as Record<string, unknown>
          await this.handleInboundChannel(payload)
        }
      }
    } catch (error) {
      this.heartbeat.sidecar.status = 'error'
      this.heartbeat.sidecar.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async reviveErroredAdapters(): Promise<void> {
    const enabledChannelIds = new Set(
      this.listChannels()
        .filter((item) => item.enabled)
        .map((item) => item.id)
    )
    const now = Date.now()
    for (const adapter of this.heartbeat.adapters) {
      if (!adapter.id || !enabledChannelIds.has(adapter.id)) continue
      const shouldRestart =
        adapter.status === 'error' ||
        adapter.status === 'stopped' ||
        (adapter.healthy === false && adapter.status !== 'starting')
      if (!shouldRestart) continue
      const lastAttempt = this.lastAdapterRestartAttemptAt.get(adapter.id) || 0
      if (now - lastAttempt < 15_000) continue
      this.lastAdapterRestartAttemptAt.set(adapter.id, now)
      await this.sidecar.stopChannel(adapter.id).catch(() => undefined)
      await this.sidecar.startChannel(adapter.id).catch(() => undefined)
    }
  }

  private async executeSchedule(
    schedule: AgentScheduleRecord,
    triggerSource: ScheduleTriggerSource = 'cron'
  ): Promise<{ success: boolean; error?: string }> {
    return executeAgentSchedule(schedule, {
      parseJson: (value, fallback) => this.tryParseJson<Record<string, unknown>>(value, fallback),
      sendScoped: (payload) => this.sendScoped(payload),
      sendUnscoped: (agent, message, requestId) =>
        this.orchestrator.send(agent, message, undefined, requestId),
      markRun: (scheduleId) => this.db.markAgentScheduleRun(scheduleId),
      appendLog: appendToolCapabilityLog,
    }, triggerSource)
  }

  private async handleInboundChannel(payload: Record<string, unknown>): Promise<void> {
    const eventId = String(payload.id || payload.idempotencyKey || '')
    const channelId = String(payload.channelId || payload.source || '')
    const thread = String(payload.thread || '')
    const sender = String(payload.sender || '')
    const text = String(payload.text || '').trim()
    const attachments = this.parseChannelAttachments(payload.attachments)
    const existingEvent = this.db.getAgentChannelEvent(eventId)
    if (existingEvent && existingEvent.status === 'done') return
    if (!eventId || !channelId || (!text && attachments.length === 0)) return
    this.enqueueInboundChannelEvent({
      eventId,
      channelId,
      thread: thread || 'default',
      sender,
      text,
      attachments
    })
  }

  private getInboundCoalesceWindowMs(): number {
    const raw = Number(this.db.getSetting('agent_message_coalesce_window_ms') || 1200)
    if (!Number.isFinite(raw)) return 1200
    return Math.min(2500, Math.max(600, Math.round(raw)))
  }

  private enqueueInboundChannelEvent(payload: {
    eventId: string
    channelId: string
    thread: string
    sender: string
    text: string
    attachments: ChannelAttachment[]
  }): void {
    const key = `${payload.channelId}::${payload.thread}`
    const pending = this.pendingInboundChannels.get(key) || {
      channelId: payload.channelId,
      thread: payload.thread,
      sender: payload.sender,
      eventIds: [],
      texts: [],
      attachments: [],
      timer: null as NodeJS.Timeout | null
    }

    if (!pending.eventIds.includes(payload.eventId)) {
      pending.eventIds.push(payload.eventId)
      this.db.upsertAgentChannelEvent({
        eventId: payload.eventId,
        channelId: payload.channelId,
        status: 'running'
      })
    }
    if (payload.text) pending.texts.push(payload.text)
    if (payload.attachments.length > 0) {
      const seen = new Set(
        pending.attachments.map((item) => `${item.remoteId || item.path}::${item.name}`)
      )
      for (const attachment of payload.attachments) {
        const dedupeKey = `${attachment.remoteId || attachment.path}::${attachment.name}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        pending.attachments.push(attachment)
      }
    }
    pending.sender = payload.sender || pending.sender
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      void this.flushInboundChannel(key)
    }, this.getInboundCoalesceWindowMs())
    this.pendingInboundChannels.set(key, pending)
  }

  private markInboundChannelEvents(
    eventIds: string[],
    channelId: string,
    status: 'running' | 'done' | 'failed',
    error?: string | null
  ): void {
    for (const eventId of eventIds) {
      this.db.upsertAgentChannelEvent({
        eventId,
        channelId,
        status,
        error: error || null
      })
    }
  }

  /**
   * L5-C-Universal — channel-agnostic calendar-event detection on
   * inbound messages.
   *
   * Wired by `flushInboundChannel`. Best-effort by design:
   *   - Reads channel kind + per-channel policy override from
   *     `agent_channels` (a malformed `config_json` is treated as "no
   *     override" — registry default wins).
   *   - Runs the universal detector (chrono inside; channel kind is just
   *     the dispatch label, not feishu-specific).
   *   - Pushes each suggestion to the renderer via
   *     `calendar:remoteEventSuggested`. The renderer dedupes by
   *     `suggestionId` and shows a "create event?" prompt.
   *
   * Any thrown error is swallowed + logged: this enhancement must NEVER
   * block the inbound conversation pipeline. If detection or IPC push
   * fails, the user simply doesn't see a suggestion — the agent loop
   * proceeds normally.
   */
  private maybeEmitRemoteCalendarSuggestions(
    pending: {
      channelId: string
      thread: string
      sender: string | null
      eventIds: string[]
    },
    inboundText: string,
  ): void {
    try {
      const channel = this.db.getAgentChannel(pending.channelId)
      if (!channel) return
      const channelKind = (channel.type ?? 'generic-webhook') as RemoteChannelKind
      let autoDetectOverride: boolean | null = null
      const rawConfig = (channel as { config_json?: string | null }).config_json
      if (typeof rawConfig === 'string' && rawConfig.length > 0) {
        try {
          const parsed = JSON.parse(rawConfig) as Record<string, unknown>
          const policy = parsed[REMOTE_CHANNEL_CALENDAR_POLICY_KEY]
          if (policy && typeof policy === 'object') {
            const v = (policy as Record<string, unknown>).autoDetectCalendarEvents
            if (v === true || v === false) autoDetectOverride = v
          }
        } catch {
          // Malformed config — treat as "no override"; registry default wins.
        }
      }
      const message: RemoteChannelMessage = {
        messageId: pending.eventIds[pending.eventIds.length - 1] ?? `channel-${Date.now()}`,
        channelKind,
        channelId: pending.channelId,
        threadKey: pending.thread,
        sender: pending.sender,
        text: inboundText,
        receivedAtUnix: Math.floor(Date.now() / 1000),
      }
      const suggestions = detectRemoteChannelEventSuggestions(message, { autoDetectOverride })
      if (suggestions.length === 0) return
      const mainWin = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!mainWin) return
      for (const suggestion of suggestions) {
        mainWin.webContents.send('calendar:remoteEventSuggested', suggestion)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[runtime] remote-channel calendar detection swallowed:', message)
    }
  }

  private async flushInboundChannel(key: string): Promise<void> {
    const pending = this.pendingInboundChannels.get(key)
    if (!pending) return
    this.pendingInboundChannels.delete(key)
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }

    const mergedText = pending.texts
      .map((item) => item.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    const inboundText = mergedText || this.describeChannelAttachments(pending.attachments)
    if (!inboundText && pending.attachments.length === 0) {
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      return
    }

    const agent = 'butler'
    const scope = this.ensureChannelScope(pending.channelId, pending.thread, agent, pending.sender)
    this.db.upsertAgentChannelThread({
      channelId: pending.channelId,
      remoteThread: pending.thread,
      sessionId: scope.id,
      conversationId: scope.id
    })

    const inboundMessage = this.createConversationMessage(scope.id, {
      role: 'user',
      content: inboundText,
      meta: {
        source: 'channel',
        channelId: pending.channelId,
        threadKey: pending.thread,
        sender: pending.sender,
        direction: 'inbound',
        attachments: pending.attachments
      }
    })
    this.emitConversationEvent({
      type: 'message_added',
      scope: this.refreshScope(scope.id),
      message: inboundMessage
    })

    // L5-C-Universal: opportunistically detect calendar events in this
    // inbound message. Channel-agnostic — works for any
    // `RemoteChannelKind` declared in the registry. Per-channel policy
    // (registry default OR user override stored in
    // `agent_channels.config_json.calendar.autoDetectCalendarEvents`)
    // decides whether to scan at all. Failures are swallowed; this is a
    // best-effort enhancement, not part of the conversation contract.
    this.maybeEmitRemoteCalendarSuggestions(pending, inboundText)

    if (!mergedText) {
      this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
      return
    }

    let statusSent = false
    const statusTimer = setTimeout(() => {
      // fire-and-forget: cosmetic "处理中…" status push to the upstream channel; failure means the user sees no typing indicator, which is acceptable degradation.
      void this.sidecar
        .sendChannel({
          id: pending.channelId,
          thread: pending.thread,
          text: '处理中…'
        })
        .then(() => {
          statusSent = true
        })
        .catch(() => undefined)
    }, 2500)

    const promptPayload = this.buildInboundChannelPayload(inboundText, pending.attachments)
    const requestId = `channel-${pending.eventIds[pending.eventIds.length - 1]}`
    const result = await this.runCoordinator.runInboundChannel(
      {
        scope,
        message: promptPayload as
          | string
          | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
        requestId,
        coordinators: this.getDomainAdapters()
      },
      {
        onFailure: async (errorText) => {
          clearTimeout(statusTimer)
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'failed', errorText)
          const errorMessage = this.createConversationMessage(scope.id, {
            role: 'system',
            content: `处理失败：${errorText}`,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              direction: 'outbound',
              error: true
            }
          })
          this.emitConversationEvent({
            type: 'message_added',
            scope: this.refreshScope(scope.id),
            message: errorMessage
          })
          await this.sendLongTextToChannel(
            pending.channelId,
            pending.thread,
            `处理失败：${errorText}`
          ).catch(() => undefined)
        },
        onSuccess: async (executionResult) => {
          clearTimeout(statusTimer)
          const finalText =
            executionResult.finalText.trim() || '任务已完成，但本次没有产生可发送的文本结果。'
          const assistantMessage = this.createConversationMessage(scope.id, {
            role: 'assistant',
            content: finalText,
            meta: {
              source: 'channel',
              channelId: pending.channelId,
              threadKey: pending.thread,
              sender: agent,
              direction: 'outbound',
              delayedStatusSent: statusSent
            }
          })
          this.markInboundChannelEvents(pending.eventIds, pending.channelId, 'done', null)
          this.db.markAgentChannelSeen(pending.channelId)
          this.emitConversationEvent({
            type: 'message_added',
            scope: this.refreshScope(scope.id),
            message: assistantMessage
          })
          await this.sendLongTextToChannel(pending.channelId, pending.thread, finalText).catch(
            () => undefined
          )
        }
      }
    )
    clearTimeout(statusTimer)
    if (!result.success) return
  }

  private mapChannelRow(row: AgentChannelRecord): AgentChannelConfig {
    return {
      id: row.id,
      type: row.type as ChannelAdapterType,
      name: row.name,
      enabled: Boolean(row.enabled),
      config: decryptChannelConfig(this.tryParseJson<Record<string, unknown>>(row.config_json, {})),
      lastError: row.last_error,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapScheduleRow(row: AgentScheduleRecord): CronTask {
    return {
      id: row.id,
      name: row.name,
      cronExpr: row.cron_expr,
      prompt: row.prompt,
      channelId: row.channel_id,
      enabled: Boolean(row.enabled),
      payload: this.tryParseJson<Record<string, unknown>>(row.payload_json || '{}', {}),
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private mapConversationRow(
    row: ChatConversationRecord & { last_message_at?: string | null }
  ): ConversationScope {
    return {
      id: row.id,
      agent: row.agent,
      userId: row.user_id || undefined,
      title: row.title,
      parentConversationId: row.parent_conversation_id ?? null,
      lineageRootId: row.lineage_root_id || row.id,
      resumeTitle: row.resume_title || row.title,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      threadKey: row.thread_key,
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {}),
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
      meta: this.tryParseJson<Record<string, unknown>>(row.meta_json || '{}', {})
    }
  }

  private ensureChannelScope(
    channelId: string,
    remoteThread: string,
    agent: string,
    sender: string
  ): ConversationScope {
    const channel = this.db.getAgentChannel(channelId)
    const channelMeta = channel ? this.mapChannelRow(channel) : null
    const existing = this.db.findConversationScope('channel', channelId, remoteThread, agent)
    const { row } = this.db.upsertConversationScope({
      id: existing?.id || `conv-${randomUUID()}`,
      agent,
      title: existing?.title || sender || channelMeta?.name || '远程会话',
      sourceKind: 'channel',
      sourceId: channelId,
      threadKey: remoteThread,
      meta: {
        ...(existing
          ? this.tryParseJson<Record<string, unknown>>(existing.meta_json || '{}', {})
          : {}),
        sourceLabel: channelMeta?.name || '远程 IM',
        channelType: channelMeta?.type || 'generic-webhook',
        sender
      }
    })
    const scope = this.mapConversationRow(row)
    // Phase 1.2 — recover any persisted lastReferenceSkill into the in-memory
    // map before the inbound message hits the orchestrator. Without this, a
    // Ready restart loses the hint until the user manually re-arms it; the
    // first remote IM turn after restart goes out with `referenceSkillHintArmed=false`
    // and the model loses access to typed skill actions. Idempotent: replay
    // checks TTL and same-value short-circuits.
    this.restoreReferenceHintFromScope(scope, scope.id)
    this.emitConversationEvent({
      type: existing ? 'scope_updated' : 'scope_created',
      scope
    })
    return scope
  }

  private refreshScope(scopeId: string): ConversationScope {
    const row = this.db.getConversationScope(scopeId)
    if (!row) throw new Error(`Conversation scope not found: ${scopeId}`)
    return this.mapConversationRow(row)
  }

  private createConversationMessage(
    scopeId: string,
    payload: {
      role: string
      content: string
      meta?: Record<string, unknown>
    }
  ): ConversationScopeMessage {
    const messageId = `msg-${randomUUID()}`
    const timestamp = new Date().toISOString()
    this.db.addChatMessage(
      messageId,
      scopeId,
      payload.role,
      payload.content,
      timestamp,
      payload.meta
    )
    // skill-resume A1: snapshot reference-skill hint after each assistant
    // message and persist it to the conversation's meta_json so a Ready
    // restart can re-arm the in-memory hint on session resume.
    if (payload.role === 'assistant') {
      this.persistReferenceHintToScope(scopeId)
    }
    return this.mapMessageRow(this.db.getChatMessages(scopeId).find((row) => row.id === messageId)!)
  }

  // ---------------------------------------------------------------------------
  // skill-resume A1: reference-skill hint persistence helpers
  // ---------------------------------------------------------------------------

  private parseScopeMeta(scope: ConversationScope | null | undefined): Record<string, unknown> {
    const raw = (scope?.meta as unknown as string | Record<string, unknown> | null | undefined)
    if (!raw) return {}
    if (typeof raw === 'object') return { ...raw } as Record<string, unknown>
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') return { ...(parsed as Record<string, unknown>) }
        // Phase 1.4 — JSON parsed but produced something that's not a record
        // (string/array/number/null). Surface this so silent meta loss has a
        // signal in the metrics log.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'not_object',
          sample: raw.slice(0, 80),
        })
      } catch (error) {
        // Phase 1.4 — JSON.parse threw. Previously the catch swallowed the
        // error and returned {}, so corruption silently nuked any
        // `lastReferenceSkill` field at the next read. Emit a metric instead.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'parse_error',
          message: error instanceof Error ? error.message : String(error),
          sample: raw.slice(0, 80),
        })
      }
    }
    return {}
  }

  private restoreReferenceHintFromScope(scope: ConversationScope, scopeId: string): void {
    try {
      const meta = this.parseScopeMeta(scope)
      const hint = meta['lastReferenceSkill']
      if (!hint || typeof hint !== 'object') return
      const persisted = hint as PersistedReferenceSkillHint
      if (typeof persisted.id !== 'string' || typeof persisted.name !== 'string' || typeof persisted.at !== 'number') return
      restoreLastReferenceSkill(scopeId, persisted)
    } catch (error) {
      console.warn('[AgentControlRuntime] restoreReferenceHintFromScope failed', error)
    }
  }

  private extractTextFromMessage(message: string | MultimodalBlock[]): string {
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

  private maybeAutoAttachSessionRecallOnResume(
    scopeId: string,
    message: string | MultimodalBlock[],
  ): void {
    try {
      const text = this.extractTextFromMessage(message)
      if (!text || !isRetryOnlyTurn(text)) return
      const result = this.sessionRecallService.autoAttachOnResume({
        currentScopeId: scopeId,
        intent: 'continue',
        limit: 3,
      })
      if (result.attached.length > 0) {
        logAgentMetric('session_recall_auto_attached', {
          scopeId,
          attachedCount: result.attached.length,
          attachedConversationIds: result.attached.map((c) => c.conversationId),
        })
        // skill-resume G4 — last-recourse hint recovery for OLD conversations.
        // If neither the meta_json restore nor the in-process lookback armed a
        // hint, scan the just-attached capsule texts for canonical skill_*
        // tool names. This is the only signal we have about prior skill usage
        // when the conversation predates A1 persistence.
        if (!getLastReferenceSkill(scopeId)) {
          this.maybeArmReferenceHintFromCapsules(scopeId, result.attached)
        }
      }
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeAutoAttachSessionRecallOnResume failed', error)
    }
  }

  private maybeArmReferenceHintFromCapsules(
    scopeId: string,
    capsules: Array<{
      summary?: string | null
      latestTaskTitle?: string | null
      latestTaskSummary?: string | null
      title?: string | null
      resumeTitle?: string | null
    }>,
  ): void {
    try {
      const texts: string[] = []
      for (const capsule of capsules) {
        if (typeof capsule.summary === 'string') texts.push(capsule.summary)
        if (typeof capsule.latestTaskSummary === 'string') texts.push(capsule.latestTaskSummary)
        if (typeof capsule.latestTaskTitle === 'string') texts.push(capsule.latestTaskTitle)
        if (typeof capsule.title === 'string') texts.push(capsule.title)
        if (typeof capsule.resumeTitle === 'string') texts.push(capsule.resumeTitle)
      }
      const recovered = findSkillHintInCapsuleTexts(texts, {
        resolveToolByName: (name) => findSkillToolByName(name),
        listSkills: () => getSkillsRuntimeManager().listSkills(),
      })
      if (!recovered) return
      rememberLastReferenceSkill(scopeId, { id: recovered.skillId, name: recovered.skillName })
      logAgentMetric('skill_reference_hint_recovered_from_capsule', {
        scopeId,
        skillId: recovered.skillId,
        skillName: recovered.skillName,
      })
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeArmReferenceHintFromCapsules failed', error)
    }
  }

  private persistReferenceHintToScope(scopeId: string): void {
    try {
      const hint = snapshotLastReferenceSkill(scopeId)
      const scopeRow = this.db.getConversationScope(scopeId)
      if (!scopeRow) return
      const scope = this.mapConversationRow(scopeRow)
      const meta = this.parseScopeMeta(scope)
      if (!hint) {
        if ('lastReferenceSkill' in meta) {
          delete meta['lastReferenceSkill']
          this.db.updateConversationScopeMeta(scopeId, meta)
        }
        return
      }
      const existing = meta['lastReferenceSkill'] as PersistedReferenceSkillHint | undefined
      // Avoid noisy DB writes: skip if persisted hint is identical (same id+name+at).
      if (
        existing
        && existing.id === hint.id
        && existing.name === hint.name
        && existing.at === hint.at
      ) {
        return
      }
      meta['lastReferenceSkill'] = hint
      this.db.updateConversationScopeMeta(scopeId, meta)
    } catch (error) {
      console.warn('[AgentControlRuntime] persistReferenceHintToScope failed', error)
    }
  }

  private publishRestoredDetachedSkillTasks(): void {
    for (const record of this.detachedSkillTasks.list()) {
      if (record.status === 'blocked' || record.status === 'running') {
        this.publishDetachedSkillTaskUpdate(record)
      }
    }
  }

  private buildDetachedSkillArtifacts(record: DetachedSkillTaskRecord): NonNullable<ScopeRunEventPayload['artifactRefs']> {
    const nowIso = record.updatedAt
    const entries: Array<{ key: string; path?: string | null; label: string; kind: string }> = [
      { key: 'outputDir', path: record.outputDir, label: '技能输出目录', kind: 'directory' },
      { key: 'runStatePath', path: record.runStatePath, label: 'run_state.json', kind: 'artifact' },
      { key: 'sceneScoresPath', path: record.sceneScoresPath, label: 'scene_scores.json', kind: 'artifact' },
      { key: 'deliveryReportPath', path: record.deliveryReportPath, label: '交付报告', kind: 'artifact' },
    ]
    const seen = new Set<string>()
    return entries
      .filter((entry) => {
        const path = String(entry.path || '').trim()
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .map((entry) => ({
        id: `${record.id}:${entry.key}`,
        module: 'skill',
        kind: entry.kind,
        label: entry.label,
        path: entry.path || null,
        createdAt: nowIso,
        meta: {
          detachedTaskId: record.id,
          skillId: record.skillId,
          action: record.action,
          outputKey: entry.key,
        },
      }))
  }

  private publishDetachedSkillTaskUpdate(record: DetachedSkillTaskRecord): void {
    const scopeId = record.scopeId || record.sessionId
    if (!scopeId) return
    const phase: ScopeRunEventPayload['phase'] =
      record.status === 'running' ? 'tool_running'
        : record.status === 'done' ? 'done'
          : record.status === 'cancelled' ? 'cancelled'
            : record.status === 'blocked' ? 'checkpoint'
              : 'error'
    const stepStatus =
      record.status === 'running' ? 'running'
        : record.status === 'done' ? 'done'
          : record.status === 'blocked' ? 'blocked'
            : 'error'
    const artifacts = this.buildDetachedSkillArtifacts(record)
    const taskId = `detached:${record.id}`
    const summary =
      record.status === 'running' ? '后台技能任务正在执行'
        : record.status === 'done' ? '后台技能任务已完成'
          : record.status === 'blocked' ? (record.error || '后台技能任务需要继续')
            : record.status === 'cancelled' ? '后台技能任务已取消'
              : (record.error || '后台技能任务失败')
    this.publishScopeRunEvent({
      type: record.status === 'running' ? 'started' : record.status === 'blocked' ? 'updated' : 'finished',
      scopeId,
      agent: record.agent || 'assistant',
      runId: record.id,
      taskId,
      taskProjectionId: taskId,
      phase,
      module: 'skill',
      executionKind: 'job',
      jobId: record.id,
      taskTitle: `后台技能任务 · ${record.skillId}`,
      taskSummary: summary,
      steps: [{
        id: record.action,
        title: record.action,
        status: stepStatus,
        detail: record.error || record.outputDir || null,
        updatedAt: record.updatedAt,
      }],
      currentStepId: record.action,
      waitingFor: record.status === 'running' || record.status === 'blocked' ? 'background' : 'none',
      resumableActions: record.status === 'running'
        ? ['cancel']
        : record.status === 'blocked'
          ? ['continue', 'cancel']
          : artifacts.length > 0
            ? ['open_artifact']
            : ['none'],
      recentArtifacts: artifacts,
      artifactRefs: artifacts,
      blockedReason: record.status === 'blocked' ? record.error || '后台任务需要继续' : null,
      error: record.status === 'failed' ? record.error || '后台技能任务失败' : undefined,
      timestamp: record.updatedAt,
    })
  }

  private emitConversationEvent(payload: ConversationEventPayload): void {
    this.emit('conversationEvent', payload)
  }

  private emitScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.recordScopeRunEvent(payload, projectionTruth)
    this.emit('scopeRunEvent', payload)
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
      void syncTaskProjection(this.taskProjectionStore, summary, payload, projectionTruth).catch((error) => {
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
        // can forward it to the renderer alongside scopeRunEvent. The
        // emit is wrapped because we are already inside a fire-and-forget
        // catch — re-throwing would surface as unhandledRejection.
        try {
          this.emit('projectionSyncFailed', failurePayload)
        } catch (emitErr) {
          // silent-catch: emit failure is purely an observability degradation; the runtime must keep running.
          console.error('[AgentControlRuntime] projectionSyncFailed emit failed:', emitErr)
        }
      })
    }
    return summary
  }

  private recordRunProjectionEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    return this.runProjection.recordEvent(payload, projectionTruth)
  }

  /**
   * Stage Q (Stage 11) — boot-fence helper. Reads the `skill_task_runs`
   * table SQL from sqlite_master and compares against the
   * `READY_SKILL_TASK_RUN_INVARIANT_ENFORCED` flag. Throws when the
   * combination is incompatible:
   *
   *   - flag=false + migrated CHECK present  →  hard fail
   *
   * All other combinations (flag=true regardless of schema, flag=false
   * with no CHECK yet) are no-ops.
   *
   * On host-Node where better-sqlite3 may not be loaded yet (test
   * harnesses, dev launcher), the underlying `getRawDb()` returns null
   * and `getCheckEnforcedSql` returns null → `assertSkillTaskRunInvariantConsistency`
   * returns 'unknown', which we treat as no-op.
   */
  private maybeAssertSkillTaskRunInvariant(): void {
    const rawFlag = (process.env.READY_SKILL_TASK_RUN_INVARIANT_ENFORCED ?? '').trim().toLowerCase()
    const invariantEnforced = !(rawFlag === '0' || rawFlag === 'false' || rawFlag === 'off')
    const result = assertSkillTaskRunInvariantConsistency({
      getCheckEnforcedSql: () => {
        try {
          const rawDb = this.db.getRawDb()
          if (!rawDb) return null
          const row = rawDb
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_task_runs'")
            .get() as { sql?: string } | undefined
          return row?.sql ?? null
        } catch {
          return null
        }
      },
      invariantEnforced,
    })
    if (result === 'incompatible') {
      throw new Error(
        'READY_SKILL_TASK_RUN_INVARIANT_ENFORCED=0 is incompatible with a migrated CHECK '
          + 'constraint on skill_task_runs. To restore legacy matching, write a forward-fix '
          + 'migration that drops the CHECK before disabling the flag.',
      )
    }
  }

  private resolveTaskControlTarget(
    scopeId: string,
    taskId?: string,
  ): {
    scope: ConversationScope
    projection: TaskProjectionRecord | null
    scopeRunSummary: ScopeRunSummary | null
  } | null {
    const scope = this.getConversationScope(scopeId)
    if (!scope) return null
    const scopeRunSummary = this.scopeRunSummaries.get(scopeId) || null
    if (taskId) {
      return {
        scope,
        projection: this.getTaskProjection(taskId),
        scopeRunSummary,
      }
    }

    const projections = this.listTaskProjections(scopeId)
    const matchedProjection = [
      scopeRunSummary?.taskId || null,
      scopeRunSummary?.taskContinuation?.taskId || null,
    ]
      .filter(Boolean)
      .map((candidateTaskId) => this.getTaskProjection(candidateTaskId as string))
      .find((item) => Boolean(item)) || null
    const activeProjection = projections.find((item) =>
      item.status === 'running' || item.status === 'blocked' || item.interactionState === 'resuming',
    ) || null

    return {
      scope,
      projection: matchedProjection || activeProjection || projections[0] || null,
      scopeRunSummary,
    }
  }

  private buildContinuationIntent(params: {
    projection: TaskProjectionRecord | null
    scopeRunSummary: ScopeRunSummary | null
    incoming?: ContinuationIntent | null
    responseText?: string
  }): ContinuationIntent | null {
    const incoming = normalizeContinuationIntent(params.incoming || null)
    const taskId =
      params.projection?.taskId
      || params.scopeRunSummary?.taskId
      || params.scopeRunSummary?.taskContinuation?.taskId
      || incoming?.taskId
      || null
    if (!taskId) return null

    const continuationRef = params.projection?.continuationRef || params.scopeRunSummary?.taskContinuation || null
    if (params.projection && deriveTaskProjectionCanResume(params.projection).canResume !== true) {
      return null
    }

    // Stage Q (Stage 11) — Audit §F-6 found this builder was the main-side
    // empty-shell escape route: any taskId would pass, regardless of
    // whether the merged intent carried a real durable handle. Stage Q
    // contract C6 routes the resume gate through `canResumeShape` here.
    // When the resulting intent has no real handle (no childRunId, no
    // detachedTaskId, no outputDir+runStatePath pair), return null so
    // `runtime.resumeRun` can emit `agent:error{errorKind:'not_resumable'}`.
    const incomingChildRunId = incoming?.childRunId
    const continuationRefChildRunId =
      (continuationRef as { childRunId?: string | null } | null)?.childRunId || null
    const mergedChildRunId = incomingChildRunId || continuationRefChildRunId || null
    const intentHandle: ResumeHandle = {
      childRunId: mergedChildRunId,
      detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || null,
      outputDir: incoming?.outputDir || continuationRef?.outputDir || null,
      runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || null,
    }
    if (!canResumeShape(intentHandle)) {
      return null
    }

    return normalizeContinuationIntent({
      taskId,
      // Stage Q (Stage 11) — propagate childRunId through the
      // normalize step so downstream consumers (resumeRun, IPC,
      // child runner) see the fresh handle.
      childRunId: mergedChildRunId || undefined,
      executionId: incoming?.executionId || continuationRef?.executionId || undefined,
      stepId:
        incoming?.stepId
        || continuationRef?.stepId
        || params.projection?.currentStepId
        || params.scopeRunSummary?.currentStepId
        || undefined,
      blockedReason:
        incoming?.blockedReason
        || params.projection?.blockedReason
        || params.scopeRunSummary?.blockedReason
        || undefined,
      responseText: params.responseText || incoming?.responseText,
      todoId: incoming?.todoId || continuationRef?.todoId || undefined,
      todoTitle: incoming?.todoTitle || continuationRef?.todoTitle || undefined,
      pauseReason: incoming?.pauseReason || continuationRef?.pauseReason || undefined,
      detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || undefined,
      taskRunId: incoming?.taskRunId || continuationRef?.taskRunId || undefined,
      jobId: incoming?.jobId || continuationRef?.jobId || undefined,
      skillId: incoming?.skillId || continuationRef?.skillId || undefined,
      action: incoming?.action || continuationRef?.action || undefined,
      runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || undefined,
      outputDir: incoming?.outputDir || continuationRef?.outputDir || undefined,
      progressFingerprint: incoming?.progressFingerprint || continuationRef?.progressFingerprint || undefined,
    })
  }

  private parseChannelAttachments(raw: unknown): ChannelAttachment[] {
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const name = String(record.name || '').trim()
        const path = String(record.path || '').trim()
        if (!name || !path) return null
        return {
          name,
          path,
          url: typeof record.url === 'string' ? record.url : undefined,
          mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
          size: Number(record.size || 0),
          type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(
            String(record.type || '')
          )
            ? (String(record.type) as ChannelAttachment['type'])
            : 'other',
          ext: typeof record.ext === 'string' ? record.ext : undefined,
          remoteId: typeof record.remoteId === 'string' ? record.remoteId : undefined
        }
      })
      .filter(Boolean) as ChannelAttachment[]
  }

  private describeChannelAttachments(attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) return ''
    if (attachments.length === 1) {
      const item = attachments[0]
      const kind =
        item.type === 'image'
          ? '图片'
          : item.type === 'video'
            ? '视频'
            : item.type === 'text'
              ? '文件'
              : '附件'
      return `[收到${kind}] ${item.name}`
    }
    return `[收到 ${attachments.length} 个附件]`
  }

  private formatChannelAttachmentSummary(attachments: ChannelAttachment[]): string {
    if (attachments.length === 0) return ''
    const lines = attachments.map((attachment) => {
      const kind =
        attachment.type === 'image'
          ? '图片'
          : attachment.type === 'video'
            ? '视频'
            : attachment.type === 'text'
              ? '文件'
              : '附件'
      return `- ${kind}: ${attachment.name}`
    })
    return ['[附件]', ...lines].join('\n')
  }

  private buildInboundChannelPayload(
    inboundText: string,
    attachments: ChannelAttachment[]
  ): string | MultimodalBlock[] {
    if (attachments.length === 0) return inboundText

    const blocks: MultimodalBlock[] = []
    if (inboundText) {
      blocks.push({ type: 'text', text: inboundText })
    }

    const nonInlineAttachments: ChannelAttachment[] = []
    for (const attachment of attachments) {
      const mediaBlock = this.tryInlineChannelAttachment(attachment)
      if (mediaBlock) {
        blocks.push(mediaBlock)
      } else {
        nonInlineAttachments.push(attachment)
      }
    }

    const summary = this.formatChannelAttachmentSummary(nonInlineAttachments)
    if (summary) {
      blocks.push({ type: 'text', text: `\n\n${summary}` })
    }

    const hasMediaBlocks = blocks.some((item) => item.type === 'image' || item.type === 'video')
    if (hasMediaBlocks) return blocks
    return [inboundText, this.formatChannelAttachmentSummary(attachments)]
      .filter(Boolean)
      .join('\n\n')
  }

  private tryInlineChannelAttachment(attachment: ChannelAttachment): MultimodalBlock | null {
    const filePath = typeof attachment.path === 'string' ? attachment.path : ''
    if (!filePath || !isAbsolute(filePath) || !existsSync(filePath)) {
      return null
    }

    const ext = (attachment.ext || extname(filePath)).toLowerCase()
    const declaredType = String(attachment.type || '').toLowerCase()
    const stat = statSync(filePath)

    if (
      declaredType === 'video' ||
      ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)
    ) {
      if (stat.size > 40 * 1024 * 1024) return null
      return {
        type: 'video',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'video/mp4')
      }
    }

    if (
      declaredType === 'image' ||
      [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.bmp',
        '.svg',
        '.tiff',
        '.tif',
        '.ico',
        '.avif'
      ].includes(ext)
    ) {
      return {
        type: 'image',
        base64: readFileSync(filePath).toString('base64'),
        mimeType: attachment.mimeType || this.mimeTypeFromExt(ext, 'image/png')
      }
    }

    return null
  }

  private mimeTypeFromExt(ext: string, fallback: string): string {
    const table: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.ico': 'image/x-icon',
      '.avif': 'image/avif',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.m4v': 'video/x-m4v'
    }
    return table[ext] || fallback
  }

  private splitLongText(text: string, maxChars = 1800): string[] {
    const normalized = text.trim()
    if (!normalized) return []
    const chunks: string[] = []
    let cursor = 0
    while (cursor < normalized.length) {
      const next = normalized.slice(cursor, cursor + maxChars)
      chunks.push(next)
      cursor += next.length
    }
    return chunks
  }

  private async sendLongTextToChannel(
    channelId: string,
    thread: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    for (const chunk of this.splitLongText(text)) {
      const result = await this.sidecar
        .sendChannel({
          id: channelId,
          thread,
          text: chunk
        })
        .then(() => ({ success: true as const }))
        .catch((error) => ({
          success: false as const,
          error: error instanceof Error ? error.message : String(error)
        }))
      if (!result.success) {
        return result
      }
    }
    return { success: true }
  }

  private tryParseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private getSettingBool(key: string, fallback: boolean): boolean {
    const raw = this.db.getSetting(key)
    if (!raw) return fallback
    const normalized = raw.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
    return fallback
  }

  private parsePortSetting(raw: string | undefined): number | null {
    if (!raw) return null
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed || trimmed === 'auto') return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return null
    const port = Math.floor(parsed)
    if (port <= 0 || port > 65535) return null
    return port
  }

  private cleanupLegacyCopawSettings(): void {
    const keys = [
      'agent_orchestrator',
      'copaw_base_url',
      'copaw_api_token',
      'copaw_user_id',
      'copaw_channel'
    ]
    for (const key of keys) {
      try {
        this.db.deleteSetting(key)
      } catch {
        // ignore cleanup failures
      }
    }
  }

  /**
   * Reflect on a completed conversation and extract learnings
   */
  private async reflectOnConversation(
    scope: ConversationScope,
    usedTools: string[]
  ): Promise<ScopeRunMemoryCapture | null> {
    try {
      // Get conversation messages
      const messages = this.db.getChatMessages(scope.id).map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      // Skip reflection for very short conversations
      if (messages.length < 2) {
        return null
      }

      // Run reflection
      const result = await this.reflectionService.reflectOnConversation({
        scope,
        messages,
        usedTools,
        success: true
      })
      return result.memoryCapture || null
    } catch (error) {
      console.error('[Runtime] Failed to reflect on conversation:', error)
      return null
    }
  }

  private toChannelKey(scope: ConversationScope): string {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }
}
