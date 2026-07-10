import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import { resumeWaitingHumanBrowserTaskFromBridge } from '../../browser-engine/task-event-bridge'
import type { AskUserQuestionsCardEvent } from '../../tools/builtins/ask-user-questions'
import { registerChannelOutboundSender } from '../channel-outbound-bridge'
import type { AgentManager } from '../../claude-bridge/agent-manager'
import type { MultimodalBlock } from '../contracts/run-contracts'
import {
  getDatabase,
  type AgentChannelType,
  type ChatConversationRecord,
  type ConversationSourceKind,
  type UpsertConversationScopeMode,
} from '../../database'
import { ReadyAgentOrchestrator } from './orchestrator'
import { defaultSystemPrompt } from './agent-sdk-runtime'
import {
  buildManualSuspendProjectionPatch,
  finalizeRunOutcome,
  type RunMetaRepositoryLike,
  writeRunCloseMetric,
} from './run-finalizer'
import { finalizeStaleWithoutHandleProjections } from './stale-projection-finalizer'
import { recoverUndeliveredAnswerForRetry } from './undelivered-answer-recovery'
import { composePersonaSystemPrompt } from './persona-system-prompt'
import { PromptAssemblyService } from '../prompt-assembly'
import { selectScopeTaskIndexEntries } from '../session/daily-task-index-builder'
import { selectFollowupTaskRefs } from '../intent-state-first'
import { BeliefCardStore } from '../knowledge/belief-card-store'
import type { MirrorDb } from '../knowledge/belief-card-mirror'
import { bumpBeliefCardAccess, readBeliefCardAccessStats } from '../knowledge/belief-card-mirror'
import { runBeliefDecayRound, collectBeliefDecaySignals, createBeliefDecayEffectors } from '../memory/belief-decay'
import {
  getSpecialistContentEditProposalStore,
} from '../agents/specialist-content-edit-runtime'
import type { SpecialistContentEditProposalStore } from '../agents/specialist-content-edit-proposals'
import { RunCoordinator } from '../task-projection/run-coordinator'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
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
import { ProjectionSyncCoordinator } from './projection-sync-coordinator'
import { SessionPrerouteService } from './session-preroute-service'
import { DetachedSkillService } from './detached-skill-service'
import { SessionRecallFacade } from './session-recall-facade'
import { NarrationContinuationService } from './narration-continuation-service'
import { ReferenceHintService } from './reference-hint-service'
import { ScheduleService } from './schedule-service'
import { ChannelConfigService } from './channel-config-service'
import { ScopeAttachmentService } from './scope-attachment-service'
import { SidecarPollService } from './sidecar-poll-service'
import { ConversationScopeStore } from './conversation-scope-store'
import { RemoteChannelService } from './remote-channel-service'
import { reconcileTaskProjections } from '../task-projection/task-projection-reconciler'
import { canResumeAsUserPoint, type ResumePointHandle } from '../contracts/resume-handle'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'
import { assertSkillTaskRunInvariantConsistency } from '../skills/skill-task-tracker'
import type { ProjectionTruthSnapshot, RunCoordinatorResult, TaskProjectionRecord } from '../contracts/run-contracts'
import { getBudgetUsagePercent, restoreContinuationTaskBudgetRuntime } from '../task-projection/run-budget-policy'
import {
  normalizeContinuationIntent,
  selectContinuationProjection,
  type ContinuationIntent,
} from '../contracts/continuation-state'
import { registerPendingTaskEventListener } from '../system-reminders/background-task-terminal-reminder'
import { taskEventBridge } from '../../browser-engine/task-event-bridge'
import { createTaskEventProofListener, createTaskProofSink } from '../quality/proof-collector'
import { isKnowledgeSystemEnabled, runStartupBeliefSync, KnowledgeWatcher } from '../knowledge/knowledge-truth-source'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import {
  classifySendScopedError,
  normalizeSendScopedErrorKind,
  runConfirmedSendScoped,
  type SendScopedResponse,
  type SendScopedUserMessage,
} from '../send-scoped-confirmation'
import { SessionRecallService } from '../session/session-recall-service'
import { SidecarManager } from '../sidecar-manager'
import { MemoryRepository } from '../../repositories/memory-repository'
import { MemoryLifecycleManager } from '../memory/memory-lifecycle'
import { CrystallizeScheduler, createCrystallizeEffectors, runCrystallizeRound, type CrystallizeSignals } from '../maintenance/crystallize-gate'
import { runMaintenanceLlmRoundTick } from '../maintenance/maintenance-llm-driver'
import { readAIConfigDetailed } from '../../claude-bridge/direct-chat-ai-config'
import { ReflectionService } from '../reflection-service'
import { runUserPictureCasMerge } from '../maintenance/cas-merge'
import { UserProfileRepository } from '../../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../../repositories/agent-personality-repository'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type { PrerouteResult } from '../agents/session-preroute'
import type { CapabilityRuntimeSnapshot } from '../../../../shared/ai-capability-runtime'
import type { AgentSystemStudioPrerouteTrace, AgentSystemStudioRoutingSimulation } from '../../../../shared/agent-system-studio'
import { ExternalMemoryProviderSlot } from '../memory/external-memory-provider-slot'
import { ToolGateway } from '../tools-runtime/tool-gateway'
import { buildCapabilityRuntimeSnapshot } from '../domain-adapters/capability-runtime-snapshot'
import { TaskProjectionRepository } from '../../repositories/task-projection-repository'
import { AgentRegistryRepository } from '../../repositories/agent-registry-repository'
import { reconcileAgentIdentityAssets, seedBuiltinAgentAssets } from '../agents/agent-identity-assets'
import { RunMetaRepository } from '../task-projection/run-meta-repository'
import { wrapRunMetaRepositoryWithCloseoutSnapshot } from '../task-projection/run-meta-snapshot'
import type { DetachedSkillTaskRecord } from '../detached-skill-task-tracker'
import type {
  AgentChannelConfig,
  AgentRuntimeStatus,
  ConversationAttachment,
  ConversationEventPayload,
  ConversationScope,
  ConversationScopeMessage,
  CronTask,
  HeartbeatSnapshot,
  ScopeRunMemoryCapture,
  ScopeRunEventPayload,
  ScopeRunSummary
} from '../contracts/types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../../shared/session-recall'

import {
  parseRecordJson,
  parseArrayJson,
  stringFromUnknown,
  progressFromUnknown,
  artifactMetaString,
  childRunSummaryStatusFromProjection,
  canRespondToUserInteractionWithoutResumeHandle,
  type ActiveChildRunSummaryForRuntime,
  type TaskProjectionChildSummaryRow,
  type UpsertChannelPayload,
  type UpsertSchedulePayload,
} from './runtime-helpers'

export type { UpsertChannelPayload, UpsertSchedulePayload } from './runtime-helpers'

export class AgentControlRuntime extends EventEmitter {
  private readonly db = getDatabase()
  // EP3-A3: declared BEFORE promptAssembly so the roster closure can never
  // observe an uninitialized field (empty/dead table degrades to []).
  private readonly agentRegistry = new AgentRegistryRepository(this.db)
  private readonly settingsRepository = new AppSettingsRepository()
  private readonly sidecar = new SidecarManager()
  private readonly orchestrator: ReadyAgentOrchestrator
  private readonly toolGateway = new ToolGateway()
  private readonly memoryRepository = new MemoryRepository()
  private readonly memoryLifecycle = new MemoryLifecycleManager(this.memoryRepository)
  // P2-1 (2026-07-03) — the deterministic crystallize round (backlink rewrite /
  // staged-expiry / duplicate marking / index rebuild) existed but was never
  // instantiated. Wire it to the same 6h rhythm as memory lifecycle. The gate
  // (decideCrystallizeRun) still decides run/skip each tick and always leaves a
  // maintenance_audit metric, so skips are observable.
  private lastCrystallizeRunAt: Date | null = null
  private readonly crystallizeScheduler = new CrystallizeScheduler(() => this.runCrystallizeRoundOnce(false))
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
    },
    pictureCasMerge: ({ userId, observations }) => {
      const rawDb = this.db.getRawDb()
      if (!rawDb) {
        return {
          decision: 'error',
          reason: 'db_unavailable',
          accepted: observations.length,
          rejected: 0,
          addedCount: 0,
          droppedCount: 0,
          mirrorSynced: false,
        }
      }
      return runUserPictureCasMerge({
        db: rawDb as never,
        userId,
        observations,
        now: new Date(),
      })
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
        agent: scope.agent,
        limit: 2
      }),
    // EP1-X1a: lazy — taskProjectionStore is declared after this field, so we
    // resolve `this.taskProjectionStore` only when invoked at turn time.
    getScopeTaskIndexEntries: (scopeId) =>
      selectScopeTaskIndexEntries(this.taskProjectionStore, scopeId),
    // EP2-K3: lazy for the same declaration-order reason.
    getBeliefCardStore: () => this.getBeliefCardStore(),
    // P2-4: bump mirror access_count for the cards that got injected this turn.
    recordBeliefInjection: (relPaths) => {
      const db = this.getBeliefCardMirrorDb()
      if (!db) return
      try { bumpBeliefCardAccess(db, relPaths) } catch { /* silent-catch: metrics never break assembly */ }
    },
    // EP3-A3: agents-table roster for the main-session charter/routing
    // index (registry declared above; empty/dead table degrades to []).
    getAgentRoster: () => this.agentRegistry.list(),
    // EP2-K6: rollback switch (single read entry in the knowledge module).
    isKnowledgeSystemEnabled: () => isKnowledgeSystemEnabled(this.db),
    // P1 (2026-07-03, 7/01 reliability contract D) — active browser tab URL
    // so site cards match the current domain mid-run, not only user text.
    getActiveBrowserUrl: () => this.orchestrator.getActiveBrowserUrl(),
    enableDatabaseMemory: true
  })
  private readonly agentManager: AgentManager
  private readonly runCoordinator: RunCoordinator
  private readonly runProjection: RunProjection
  private readonly taskProjectionStore = new TaskProjectionRepository(this.db)
  // B8-D R1 — projection-sync/preroute/detached-skill clusters live in
  // delegated sub-services; the runtime keeps one-line public delegates.
  private readonly projectionSync: ProjectionSyncCoordinator
  private readonly sessionPreroute = new SessionPrerouteService({
    settingsRepository: this.settingsRepository,
    agentRegistry: this.agentRegistry,
    taskProjectionStore: this.taskProjectionStore,
    getBeliefCardStore: () => this.getBeliefCardStore(),
  })
  // B8-D R2 — session-recall/reference-hint/narration-continuation clusters
  // live in delegated sub-services; same one-line-delegate pattern as R1.
  private readonly referenceHints = new ReferenceHintService({
    db: this.db,
    mapConversationRow: (row) => this.mapConversationRow(row),
  })
  private readonly sessionRecall = new SessionRecallFacade({
    sessionRecallService: this.sessionRecallService,
    mapConversationRow: (row) => this.mapConversationRow(row),
    emitConversationEvent: (payload) => this.emitConversationEvent(payload),
    extractTextFromMessage: (message) => this.extractTextFromMessage(message),
    armReferenceHintFromCapsules: (scopeId, capsules) =>
      this.referenceHints.maybeArmReferenceHintFromCapsules(scopeId, capsules),
  })
  private knowledgeWatcher: KnowledgeWatcher | null = null
  private beliefCardStore: BeliefCardStore | null = null
  private readonly skillTaskRunRepository = new SkillTaskRunRepository(this.db)
  private readonly detachedSkills: DetachedSkillService
  private readonly narrationContinuation: NarrationContinuationService
  private readonly scopeRunSummaries = new Map<string, ScopeRunSummary>()
  // Channel connected/error counts are fetched from the sidecar over HTTP, which is too slow
  // to do on every getRuntimeStatus() call (it is on the Settings render path). Cache the last
  // values and refresh them from the 3s poll loop instead. B8-D R4: the poll
  // loop lives in SidecarPollService, which holds this object by reference
  // and mutates it in place — `readonly` pins the shared identity.
  private readonly channelStateCache = { connected: 0, errors: 0 }
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
  // B8-D R3 — the schedule / channel-config / scope-attachment clusters live
  // in delegated sub-services; same one-line-delegate pattern as R1/R2.
  // Declared AFTER `heartbeat` so the ChannelConfigService deps capture an
  // initialized snapshot reference (field initializers run in declaration
  // order; the heartbeat object is mutated in place, never reassigned). The
  // sendScoped/sendUnscoped/startSidecar callbacks are lazy closures, so the
  // constructor-assigned `orchestrator` is safe to reference here.
  private readonly schedules = new ScheduleService({
    db: this.db,
    sidecar: this.sidecar,
    sendScoped: (payload) => this.sendScoped(payload),
    sendUnscoped: (agent, message, requestId) =>
      this.orchestrator.send(agent, message, undefined, requestId),
  })
  private readonly channelConfig = new ChannelConfigService({
    db: this.db,
    sidecar: this.sidecar,
    startSidecar: () => this.startSidecar(),
    heartbeat: this.heartbeat,
  })
  private readonly scopeAttachments = new ScopeAttachmentService({ db: this.db })
  // B8-D R4 — the sidecar-poll / conversation-scope clusters live in delegated
  // sub-services; same one-line-delegate pattern as R1–R3. Declared AFTER
  // `heartbeat` / `channelStateCache` / `scopeRunSummaries` /
  // `taskProjectionStore` so the deps capture initialized object references
  // (all are mutated in place, never reassigned). Every function dep is a
  // lazy closure, so constructor-assigned hubs (`projectionSync`) and the
  // remote-channel cluster methods (`handleInboundChannel`,
  // `getScopedRemoteThreadKey`, `getRemoteChannelSessionSettingKey` — that
  // cluster migrates in the next batch and these callbacks re-bind through
  // the runtime automatically) are safe to reference here.
  private readonly sidecarPoll = new SidecarPollService({
    db: this.db,
    sidecar: this.sidecar,
    heartbeat: this.heartbeat,
    channelStateCache: this.channelStateCache,
    startSidecar: () => this.startSidecar(),
    getSettingBool: (key, fallback) => this.getSettingBool(key, fallback),
    listChannels: () => this.listChannels(),
    listSchedules: () => this.listSchedules(),
    executeSchedule: (schedule, triggerSource) =>
      this.schedules.executeSchedule(schedule, triggerSource),
    handleInboundChannel: (payload) => this.handleInboundChannel(payload),
  })
  private readonly conversationScopes = new ConversationScopeStore({
    db: this.db,
    scopeRunSummaries: this.scopeRunSummaries,
    taskProjectionStore: this.taskProjectionStore,
    emitConversationEvent: (payload) => this.projectionSync.emitConversationEvent(payload),
    mapChannelRow: (row) => this.channelConfig.mapChannelRow(row),
    getScopedRemoteThreadKey: (channelId, remoteThread, agent) =>
      this.getScopedRemoteThreadKey(channelId, remoteThread, agent),
    getRemoteChannelSessionSettingKey: (channelId, remoteThread, agent) =>
      this.getRemoteChannelSessionSettingKey(channelId, remoteThread, agent),
    restoreReferenceHintFromScope: (scope, scopeId) =>
      this.referenceHints.restoreReferenceHintFromScope(scope, scopeId),
    persistReferenceHintToScope: (scopeId) =>
      this.referenceHints.persistReferenceHintToScope(scopeId),
  })
  // B8-D R5 — the remote-channel / inbound-IM cluster lives in a delegated
  // sub-service; same one-line-delegate pattern as R1–R4. Declared AFTER
  // `conversationScopes` so the store-backed callbacks close over an
  // initialized field. Every function dep is a lazy closure, so
  // constructor-assigned hubs (`runCoordinator`, `projectionSync`) and
  // lifecycle methods are safe to reference here. The runtime keeps one-line
  // delegates for `handleInboundChannel` / `getScopedRemoteThreadKey` /
  // `getRemoteChannelSessionSettingKey` (the R4 SidecarPollService /
  // ConversationScopeStore injection closures bind those runtime methods and
  // re-bind through this service automatically) and `sendLongTextToChannel`
  // (called from the stay-behind `sendScoped` channel ack path).
  private readonly remoteChannel = new RemoteChannelService({
    db: this.db,
    sidecar: this.sidecar,
    settingsRepository: this.settingsRepository,
    runCoordinator: {
      runInboundChannel: (request, hooks) => this.runCoordinator.runInboundChannel(request, hooks),
    },
    getDomainAdapters: () => this.getDomainAdapters(),
    getTaskProjection: (taskId) => this.getTaskProjection(taskId),
    getRuntimeStatus: () => this.getRuntimeStatus(),
    emitConversationEvent: (payload) => this.projectionSync.emitConversationEvent(payload),
    recordChannelDeliveryResult: (channelId, result) =>
      this.channelConfig.recordChannelDeliveryResult(channelId, result),
    ensureChannelScope: (channelId, remoteThread, agent, sender) =>
      this.conversationScopes.ensureChannelScope(channelId, remoteThread, agent, sender),
    createConversationMessage: (scopeId, payload) =>
      this.conversationScopes.createConversationMessage(scopeId, payload),
    refreshScope: (scopeId) => this.conversationScopes.refreshScope(scopeId),
    // Phase I P0 —— 渠道答案提交后与本地 IPC submit 同构刷新 run 进度
    // （懒闭包：orchestrator 在构造函数中才赋值，调用发生在答案时刻）。
    refreshActiveRunProgress: (agent, scopeId, requestId) => {
      this.orchestrator.refreshActiveRunProgress(agent, scopeId, requestId)
    },
  })
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
    // Phase I —— channel_send_file 工具的发送面：线程反查 + sidecar 发送由
    // RemoteChannelService 承担（工具侧只校验参数并消费结构化结果）。
    registerChannelOutboundSender((scopeId, file) =>
      this.remoteChannel.sendFileToScopeThread(scopeId, file))
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
      emitScopeRunEvent: (payload, projectionTruth) => this.projectionSync.emitScopeRunEvent(payload, projectionTruth),
      reflectOnConversation: (scope, usedTools) => this.reflectOnConversation(scope, usedTools),
      // EP3-A4 — handoff adoption moves the scope's owner; next turn's
      // injection follows it (A2 channel).
      resolveScopeOwnerAgent: (scopeId) => this.taskProjectionStore.getLatestOwnerAgentForScope(scopeId)
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
    this.projectionSync = new ProjectionSyncCoordinator({
      db: this.db,
      taskProjectionStore: this.taskProjectionStore,
      runProjection: this.runProjection,
      emit: (event, payload) => {
        this.emit(event, payload)
      },
    })
    this.detachedSkills = new DetachedSkillService({
      publishScopeRunEvent: (payload) => this.projectionSync.publishScopeRunEvent(payload),
    })
    this.narrationContinuation = new NarrationContinuationService({
      db: this.db,
      settingsRepository: this.settingsRepository,
      orchestrator: this.orchestrator,
      scopeRunSummaries: this.scopeRunSummaries,
      getConversationScope: (scopeId) => this.getConversationScope(scopeId),
      emitScopeRunEvent: (payload, projectionTruth) => this.emitScopeRunEvent(payload, projectionTruth),
    })

    // Phase 5 — wire the skill child runner. The runner stays as a
    // module-level singleton so `skills-tools.ts` (Team 6) can call
    // `startSkillChildRun(...)` without crossing class boundaries. We
    // configure it once at runtime construction so the SQLite-backed
    // repository is ready and `getSkillsRuntimeManager()` is safe to
    // call.
    try {
      const childRunner = configureSkillChildRunner({
        runtimeManager: getSkillsRuntimeManager(),
        repository: this.skillTaskRunRepository,
        taskProjectionStore: this.taskProjectionStore,
        publishScopeRunEvent: (payload) => this.projectionSync.publishScopeRunEvent(payload),
      })
      this.orchestrator.setChildLivenessProvider(childRunner)
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
    registerPendingTaskEventListener(() => this.narrationContinuation.trigger())
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

  getBeliefCardMirrorDb(): MirrorDb | null {
    return this.db.getRawDb?.() as MirrorDb | null
  }

  /**
   * P2-1 — run one deterministic crystallize round. The gate decides run/skip;
   * we only advance `lastCrystallizeRunAt` when it actually ran, so the 6h
   * interval math stays honest. Guarded by the knowledge-system switch and a
   * live belief store. Never throws into the scheduler (round logs its own
   * maintenance_audit; unexpected errors are swallowed by the scheduler).
   */
  async runCrystallizeRoundOnce(forced: boolean): Promise<void> {
    if (!isKnowledgeSystemEnabled(this.db)) return
    const store = this.getBeliefCardStore()
    if (!store) return
    const now = new Date()
    const signals: CrystallizeSignals = {
      lastRunAt: this.lastCrystallizeRunAt ? this.lastCrystallizeRunAt.toISOString() : null,
      newCheckInsWithLearning: 0,
      newConversationTurns: 0,
      cardWritesSinceLast: 0,
      memoryFileMtimeChanged: false,
      forced,
    }
    const result = await runCrystallizeRound({
      signals,
      now,
      store,
      effectors: createCrystallizeEffectors(store),
    })
    if (result.decision === 'run') {
      this.lastCrystallizeRunAt = now
      // P5d fired ledger (positive gate signal): crystallize actually ran live.
      logAgentMetric('crystallize_round_fired', { report: result.report ?? null })
      // P5d — belief-decay piggybacks the same deterministic tick (decoupled
      // from the dormant LLM round). Closes the "belief rows excluded from L2
      // archival but never decayed" leak (audit §2.1). Conservative decisions
      // (demote-before-delete, two-phase L, duplicates never deleted); must
      // never break the crystallize tick.
      try {
        const mirrorDb = this.getBeliefCardMirrorDb()
        const readMirror = (relPath: string) => (mirrorDb ? readBeliefCardAccessStats(mirrorDb, relPath) : null)
        const decayReport = runBeliefDecayRound(
          collectBeliefDecaySignals(store, readMirror, now),
          createBeliefDecayEffectors(store),
          now,
        )
        logAgentMetric('belief_decay_round_fired', { report: decayReport })
      } catch (error) {
        logAgentMetric('belief_decay_round_failed', { reason: error instanceof Error ? error.message : String(error) })
      }
    }
    // D7 —— LLM 维护回合捎带同一确定性 tick（合同 2026-07-05-p3-backlog-closeout §2）。
    // 驱动自带三层预算闸：专项开关 / durable lastRunAt 进 EP2-C2 门控（6h 内
    // skip=零调用）/ 空信号跳过；单轮单调用、强制 staged 写。失败面包屑化，
    // 绝不破坏 crystallize tick。
    try {
      const aiSettings = new AppSettingsRepository()
      await runMaintenanceLlmRoundTick({
        settings: this.db,
        store,
        loadAIConfig: () => readAIConfigDetailed(() => aiSettings.getSetting('ai_model_config')),
      })
    } catch (error) {
      logAgentMetric('maintenance_llm_round_failed', { reason: error instanceof Error ? error.message : String(error) })
    }
  }

  private getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.orchestrator.getDomainAdapters()
  }

  getExternalMemoryProviderSlot(): ExternalMemoryProviderSlot {
    return this.externalMemoryProviderSlot
  }

  async start(): Promise<void> {
    this.cleanupLegacyCopawSettings()
    this.detachedSkills.publishRestoredDetachedSkillTasks()

    // Start memory lifecycle manager
    this.memoryLifecycle.start()
    // P2-1 — deterministic crystallize round on the same 6h rhythm + a startup
    // pass (deferred 90s so it trails first-run belief sync / seeding above the
    // memory lifecycle's own 60s initial tick).
    this.crystallizeScheduler.start()
    setTimeout(() => { void this.runCrystallizeRoundOnce(false) }, 90_000)
    this.narrationContinuation.trigger()

    // EP2-Q3 — additive bridge listener: terminal task events become
    // task_event proofs on the owning projection (bridge itself untouched).
    taskEventBridge.registerProjectionSink(
      createTaskEventProofListener(createTaskProofSink(this.taskProjectionStore)),
    )
    this.projectionSync.scheduleTerminalProjectionSyncRetryDrain('startup')

    // EP2-K6 — truth-source boundary: startup full sync (K2 handover) +
    // hand-edit watcher, both behind the rollback switch. Files are never
    // written here — file → DB only.
    try {
      const knowledgeEnabled = isKnowledgeSystemEnabled(this.db)
      const rawDb = this.db.getRawDb?.()
      if (rawDb) {
        // Identity asset reconciliation (064 reserved-slug reassign → move agents/<old> to
        // agents/<new>) must run regardless of the knowledge toggle: the DB id already
        // changed in the migration, so the on-disk asset dir has to follow even when the
        // knowledge system is off. Idempotent via agent_identity_migration.asset_reconciled_at.
        reconcileAgentIdentityAssets(rawDb as never, this.getBeliefCardStore())
        // 内置专项 agent（文案/美术/智识）预设资产 seed。独立 try/catch：seed 失败不得
        // 拖垮后续知识同步与 watcher 启动。幂等（缺失才写 + soul 守卫更新）。
        try {
          const seeded = seedBuiltinAgentAssets(rawDb as never, this.getBeliefCardStore())
          if (seeded.souls || seeded.files || seeded.cards) {
            console.log(`[runtime] seeded builtin agent presets: souls=${seeded.souls} files=${seeded.files} cards=${seeded.cards}`)
          }
        } catch (seedError) {
          console.error('[runtime] builtin agent preset seeding failed:', seedError)
        }
        if (knowledgeEnabled) {
          runStartupBeliefSync(rawDb as never, this.getBeliefCardStore(), true)
          this.knowledgeWatcher = new KnowledgeWatcher({ db: rawDb as never, store: this.getBeliefCardStore() })
          this.knowledgeWatcher.start()
        }
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

    this.sidecarPoll.stopPollLoop()

    // Stop memory lifecycle manager
    this.memoryLifecycle.stop()
    this.crystallizeScheduler.stop()
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
      this.sidecarPoll.ensurePollLoop()
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

    const { connected, errors: sidecarErrors } = this.sidecar.isRunning()
      ? this.channelStateCache
      : { connected: 0, errors: 0 }
    const persistedErrorCount = channels.filter((item) => item.enabled && item.lastError).length
    const errors = Math.max(sidecarErrors, persistedErrorCount)

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
        feishuConnected,
        // 设备级快照无 scope 语义；channel_outbound 只在具体 run 的 scope 判据下可见
        channelScopeBound: false
      },
      enabledChannelTypes,
      connectedChannelTypes
    })
  }

  listChannels(): AgentChannelConfig[] {
    return this.channelConfig.listChannels()
  }

  /** Phase I —— channel_outbound 可见性判据：scope 是否绑定远程渠道线程。 */
  isScopeChannelBound(scopeId: string | undefined): boolean {
    const key = String(scopeId || '').trim()
    if (!key) return false
    try {
      return Boolean(this.db.getAgentChannelThreadBySession(key))
    } catch {
      // silent-catch: 判据读取失败按未绑定处理（工具隐藏，不炸 turn 准备）
      return false
    }
  }

  isChannelTypeAvailable(type: AgentChannelType): boolean {
    return this.channelConfig.isChannelTypeAvailable(type)
  }

  listConversationScopes(agent?: string): ConversationScope[] {
    return this.conversationScopes.listConversationScopes(agent)
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

  private getRunMetaRepositoryForFinalize(): RunMetaRepositoryLike | null {
    try {
      const repository = this.getRunMetaRepository() as unknown as RunMetaRepositoryLike | null
      if (!repository) return null
      return wrapRunMetaRepositoryWithCloseoutSnapshot(
        repository,
        (taskId) => this.taskProjectionStore.get(taskId) as TaskProjectionRecord | null,
      )
    } catch {
      return null
    }
  }

  /** EP3-A4 — agents-table registry for the handoff proposal flow. */
  getAgentRegistry(): AgentRegistryRepository {
    return this.agentRegistry
  }

  getSpecialistContentEditProposalStore(): SpecialistContentEditProposalStore {
    return getSpecialistContentEditProposalStore()
  }

  applyKnowledgeSystemEnabled(enabled: boolean): void {
    const rawDb = this.db.getRawDb?.()
    if (!rawDb) return
    if (!enabled) {
      this.knowledgeWatcher?.stop()
      this.knowledgeWatcher = null
      return
    }
    runStartupBeliefSync(rawDb as never, this.getBeliefCardStore(), true)
    if (!this.knowledgeWatcher) {
      this.knowledgeWatcher = new KnowledgeWatcher({ db: rawDb as never, store: this.getBeliefCardStore() })
    }
    this.knowledgeWatcher.start()
  }

  /** EP4-A5 — session-creation preroute; delegated to SessionPrerouteService. */
  evaluateSessionPreroute(firstMessage: string): PrerouteResult {
    return this.sessionPreroute.evaluateSessionPreroute(firstMessage)
  }

  /** P8g-8a — read-only Studio routing simulation; delegated to SessionPrerouteService. */
  simulateSessionPrerouteForStudio(firstMessage: string): AgentSystemStudioRoutingSimulation {
    return this.sessionPreroute.simulateSessionPrerouteForStudio(firstMessage)
  }

  listRecentSessionPrerouteTraces(limit = 10): AgentSystemStudioPrerouteTrace[] {
    return this.sessionPreroute.listRecentSessionPrerouteTraces(limit)
  }

  /**
   * 梯队三 emergence feed — 跨 scope 最近任务投影（resume/follow_up 卡信号源）。
   * 只读，复用 preroute 的仓储入口；不做 reconcile（feed 是提示面，不是裁决面）。
   */
  listRecentTaskProjections(limit = 50): TaskProjectionRecord[] {
    return this.taskProjectionStore.listRecentTasksForPreroute(limit) as TaskProjectionRecord[]
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

  listTaskProjectionsByOwner(ownerAgentId: string, limit = 20): TaskProjectionRecord[] {
    const records = this.taskProjectionStore.listByOwnerAgent(ownerAgentId, limit) as TaskProjectionRecord[]
    return records.map((record) => deriveTaskProjectionCanResume(record))
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
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecall.searchSessionRecall(payload)
  }

  listRecentSessions(payload?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.sessionRecall.listRecentSessions(payload)
  }

  getSessionRecallCapsule(conversationId: string): SessionRecallCapsule | null {
    return this.sessionRecall.getSessionRecallCapsule(conversationId)
  }

  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[] {
    return this.sessionRecall.listAttachedSessionRecallContexts(scopeId)
  }

  /** Renderer badge read for the live reference-skill hint; delegated to ReferenceHintService. */
  getReferenceSkillHint(scopeId: string): { id: string; name: string; at: number; expiresAt: number } | null {
    return this.referenceHints.getReferenceSkillHint(scopeId)
  }

  /** Phase 1.1 — `chat:saveMessage` post-persist hook; delegated to ReferenceHintService. */
  persistReferenceHintAfterAssistantMessage(scopeId: string, role: string): void {
    this.referenceHints.persistReferenceHintAfterAssistantMessage(scopeId, role)
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
    return this.detachedSkills.startDetachedSkillAction(payload)
  }

  inspectDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    return this.detachedSkills.inspectDetachedSkillTask(taskId, scopeId)
  }

  listDetachedSkillTasks(payload?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    return this.detachedSkills.listDetachedSkillTasks(payload)
  }

  cancelDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    return this.detachedSkills.cancelDetachedSkillTask(taskId, scopeId)
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
    return this.sessionRecall.attachSessionRecallContext(currentScopeId, conversationId)
  }

  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope } {
    return this.sessionRecall.detachSessionRecallContext(currentScopeId, conversationId)
  }

  resumeSessionCandidate(payload: {
    conversationId?: string
    resumeTitle?: string
  }): SessionRecallHit | null {
    return this.sessionRecall.resumeSessionCandidate(payload)
  }

  getConversationScope(scopeId: string): ConversationScope | null {
    return this.conversationScopes.getConversationScope(scopeId)
  }

  getConversationScopeMessages(scopeId: string): ConversationScopeMessage[] {
    return this.conversationScopes.getConversationScopeMessages(scopeId)
  }

  deleteConversation(scopeId: string): void {
    this.conversationScopes.deleteConversation(scopeId)
  }

  listScopeAttachments(scopeId: string): ConversationAttachment[] {
    return this.scopeAttachments.listScopeAttachments(scopeId)
  }

  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null {
    return this.scopeAttachments.getScopeAttachment(scopeId, attachmentId)
  }

  getRemoteAttachmentCacheStats(channelId?: string): {
    totalFiles: number
    totalBytes: number
    targetPath: string
    channels: Array<{ channelId: string; files: number; bytes: number }>
  } {
    return this.scopeAttachments.getRemoteAttachmentCacheStats(channelId)
  }

  clearRemoteAttachmentCache(channelId?: string): {
    removedFiles: number
    removedBytes: number
    targetPath: string
  } {
    return this.scopeAttachments.clearRemoteAttachmentCache(channelId)
  }

  createLocalScope(agent: string, id?: string): ConversationScope {
    return this.conversationScopes.createLocalScope(agent, id)
  }

  createLocalScopeWithMode(
    agent: string,
    id?: string,
  ): { scope: ConversationScope; mode: UpsertConversationScopeMode } {
    return this.conversationScopes.createLocalScopeWithMode(agent, id)
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
    workspaceRoots?: string[]
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
        this.referenceHints.restoreReferenceHintFromScope(scope, payload.scopeId)
        // skill-resume E1: when the user fires a bare retry/continue intent on a
        // scope with no manually-attached recall context, auto-attach the top
        // predecessors in the same lineage so prompt assembly has prior context
        // when it runs.
        this.sessionRecall.maybeAutoAttachSessionRecallOnResume(payload.scopeId, payload.message)
        let recoveredUndeliveredAnswer: string | null = null
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
            if (!built && targetProjection) {
              const runMeta = targetProjection.runId
                ? this.getRunMetaRepository()?.get(targetProjection.runId)
                : null
              recoveredUndeliveredAnswer = recoverUndeliveredAnswerForRetry({
                projection: targetProjection,
                runMeta,
              })
              if (recoveredUndeliveredAnswer) {
                logAgentMetric('runtime_resume_recovered_undelivered_answer', {
                  scopeId: scope.id,
                  taskId: targetProjection.taskId,
                  runId: targetProjection.runId,
                })
              }
            }
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
        if (recoveredUndeliveredAnswer) {
          return {
            success: true,
            responseText: recoveredUndeliveredAnswer,
            persistence,
          }
        }
        let result: RunCoordinatorResult
        try {
          result = await this.runCoordinator.runScoped(
            {
              scope,
              message: payload.message as
                | string
                | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
              requestId: payload.requestId,
              sourceMessageId: payload.userMessage?.id ?? null,
              taskId: payload.taskId,
              parentTaskId: payload.parentTaskId,
              parentStepId: payload.parentStepId,
              sessionIdOverride: payload.sessionIdOverride,
              workspaceRoots: payload.workspaceRoots,
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
                  if (result.success && result.usedTools.includes('skill_send_im_file')) {
                    logAgentMetric('send_scoped_channel_ack_failed_after_send_im', {
                      scopeId: scope.id,
                      channelId: scope.sourceId,
                      taskId: result.taskId || null,
                      runId: payload.requestId || null,
                      usedTools: result.usedTools,
                      error: sendOk.error || 'Failed to send channel reply',
                    })
                    return
                  }
                  throw new Error(sendOk.error || 'Failed to send channel reply')
                }
              }
            }
          )
        } finally {
          await this.finalizeStaleWithoutHandleProjectionsForScope(scope)
        }
        const autoRecoveredUndeliveredAnswer = !result.success && payload.requestId
          ? this.recoverUndeliveredAnswerForRun(scope.id, payload.requestId)
          : null
        if (autoRecoveredUndeliveredAnswer) {
          logAgentMetric('runtime_auto_recovered_undelivered_answer', {
            scopeId: scope.id,
            runId: payload.requestId,
            taskId: autoRecoveredUndeliveredAnswer.taskId,
          })
          return {
            success: true,
            responseText: autoRecoveredUndeliveredAnswer.responseText,
            persistence,
          }
        }
        return {
          ...result,
          errorKind: result.scopeRunAuthority?.state === 'lost'
            ? 'superseded'
            : result.success ? undefined : normalizeSendScopedErrorKind(result.errorKind) || classifySendScopedError(result.error, 'run'),
          persistence,
        }
      },
    })
  }

  private recoverUndeliveredAnswerForRun(scopeId: string, runId: string): { responseText: string; taskId: string | null } | null {
    const normalizedScopeId = String(scopeId || '').trim()
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedScopeId || !normalizedRunId) return null
    const projection = (this.taskProjectionStore.listByScope(normalizedScopeId) as TaskProjectionRecord[])
      .find((record) => record.runId === normalizedRunId) || null
    const runMeta = this.getRunMetaRepository()?.get(normalizedRunId) || null
    const responseText = recoverUndeliveredAnswerForRetry({ projection, runMeta })
    return responseText ? { responseText, taskId: projection?.taskId || null } : null
  }

  private async finalizeStaleWithoutHandleProjectionsForScope(scope: ConversationScope): Promise<number> {
    if (this.orchestrator.isScopeLive(scope.agent, scope.id)) return 0
    const records = this.taskProjectionStore.listByScope(scope.id) as TaskProjectionRecord[]
    const finalized = await finalizeStaleWithoutHandleProjections({
      scopeId: scope.id,
      records,
      taskProjectionStore: this.getTaskProjectionStoreForFinalize(),
      runMetaRepository: this.getRunMetaRepositoryForFinalize(),
      hasActiveRun: () => this.orchestrator.isScopeLive(scope.agent, scope.id),
    })
    if (finalized > 0) {
      logAgentMetric('stale_without_handle_projection_finalized', {
        scopeId: scope.id,
        agent: scope.agent,
        count: finalized,
      })
    }
    return finalized
  }

  async suspendRun(payload: {
    scopeId: string
    taskId?: string
  }): Promise<{ success: boolean; error?: string }> {
    const target = this.resolveTaskControlTarget(payload.scopeId, payload.taskId)
    if (!target) {
      return { success: false, error: 'Conversation scope not found' }
    }
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
    const resolvedTaskId =
      target.projection?.taskId
      || target.scopeRunSummary?.taskId
      || target.scopeRunSummary?.taskProjectionId
      || payload.taskId
      || null
    if (!resolvedTaskId) {
      return { success: false, error: 'Task projection not found' }
    }
    const stopped = this.orchestrator.interruptForSuspend(target.scope.agent, target.scope.id)
    const resolvedRunId =
      stopped.runId
      || target.projection?.runId
      || target.scopeRunSummary?.runId
      || null
    if (!resolvedRunId) {
      return { success: false, error: 'Active run not found' }
    }
    const timestamp = new Date().toISOString()
    const projectionPatch = buildManualSuspendProjectionPatch({
      projection: target.projection,
      taskTitle: target.projection?.taskTitle ?? target.scopeRunSummary?.taskTitle ?? null,
      taskSummary: target.projection?.taskSummary ?? target.scopeRunSummary?.taskSummary ?? null,
      steps: target.projection?.steps ?? [],
      currentStepId: target.projection?.currentStepId ?? target.scopeRunSummary?.currentStepId ?? null,
      continuationRef: target.projection?.continuationRef ?? target.scopeRunSummary?.taskContinuation ?? null,
      budget: target.projection?.budget ?? null,
      budgetUsagePercent: runtime ? getBudgetUsagePercent(runtime) : target.projection?.budgetUsagePercent ?? null,
      budgetWarningLevel: runtime?.warningLevel ?? target.projection?.budgetWarningLevel ?? null,
      recoveryHistory: target.projection?.recoveryHistory ?? [],
      updatedAt: timestamp,
    })
    await finalizeRunOutcome({
      kind: 'interrupted',
      runId: resolvedRunId,
      taskId: resolvedTaskId,
      scopeId: target.scope.id,
      durationMs: 1,
      toolCallsUsed: 0,
      initiator: 'manual_suspend',
      terminalReason: 'manual_suspend',
      projectionPatch,
      taskBudgetRuntime: runtime,
    }, {
      runMetaRepository: this.getRunMetaRepositoryForFinalize(),
      taskProjectionStore: this.getTaskProjectionStoreForFinalize(),
      writeProjectionTerminalPatch: async (patch) => {
        if (!patch) return
        this.taskProjectionStore.update(
          resolvedTaskId,
          patch as Partial<TaskProjectionRecord>,
          { reasonHint: 'update' },
        )
      },
      writeRunCloseMetric,
    })
    return { success: true }
  }

  async reportInfrastructureTimeout(payload: {
    scopeId: string
    requestId: string
    elapsedMs?: number
  }): Promise<{
    success: boolean
    state?: 'cancel_requested' | 'stale' | 'not_found' | 'paused_user_input'
    error?: string
    errorKind?: string
    activeRunId?: string | null
  }> {
    const scopeId = String(payload.scopeId || '').trim()
    const requestId = String(payload.requestId || '').trim()
    if (!scopeId || !requestId) {
      return {
        success: false,
        state: 'not_found',
        error: 'scopeId and requestId are required',
        errorKind: 'invalid_payload',
      }
    }

    const scope = this.getConversationScope(scopeId)
    if (!scope) {
      return {
        success: false,
        state: 'not_found',
        error: `Conversation scope not found: ${scopeId}`,
        errorKind: 'scope_missing',
      }
    }

    if (this.orchestrator.isActiveRun(scope.agent, scope.id, requestId)
      && this.orchestrator.isActiveRunAwaitingUserInput(scope.agent, scope.id, requestId)) {
      this.orchestrator.refreshActiveRunProgress(scope.agent, scope.id, requestId)
      logAgentMetric('renderer_infrastructure_timeout_awaiting_user_input', {
        scopeId,
        requestId,
        elapsedMs: Number.isFinite(Number(payload.elapsedMs)) ? Number(payload.elapsedMs) : null,
      })
      return { success: true, state: 'paused_user_input' }
    }

    const result = this.orchestrator.interruptActiveRunIfMatches(
      scope.agent,
      scope.id,
      requestId,
      'process_exit',
    )
    logAgentMetric('renderer_infrastructure_timeout_main_report', {
      scopeId,
      requestId,
      elapsedMs: Number.isFinite(Number(payload.elapsedMs)) ? Number(payload.elapsedMs) : null,
      state: result.state,
      activeRunId: result.activeRunId || result.runId || null,
    })

    if (result.state === 'stale') {
      return {
        success: true,
        state: result.state,
        errorKind: 'stale_request',
        activeRunId: result.activeRunId || null,
      }
    }
    return { success: true, state: result.state }
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
    return this.channelConfig.upsertChannel(payload)
  }

  async deleteChannel(id: string): Promise<boolean> {
    return this.channelConfig.deleteChannel(id)
  }

  async setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null> {
    return this.channelConfig.setChannelEnabled(id, enabled)
  }

  async sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }> {
    return this.channelConfig.sendChannelProbe(id, text)
  }

  recordChannelDeliveryResult(
    channelId: string,
    result: { success: boolean; error?: string }
  ): void {
    this.channelConfig.recordChannelDeliveryResult(channelId, result)
  }

  async testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }> {
    return this.channelConfig.testChannel(payload)
  }

  async startWechatLogin(payload: {
    id?: string
    force?: boolean
  }): Promise<Record<string, unknown>> {
    return this.channelConfig.startWechatLogin(payload)
  }

  async getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>> {
    return this.channelConfig.getWechatLoginStatus(channelId, sessionKey)
  }

  async submitWechatLoginVerifyCode(channelId: string, sessionKey: string, code: string): Promise<Record<string, unknown>> {
    return this.channelConfig.submitWechatLoginVerifyCode(channelId, sessionKey, code)
  }

  listSchedules(): CronTask[] {
    return this.schedules.listSchedules()
  }

  async upsertSchedule(payload: UpsertSchedulePayload): Promise<CronTask> {
    return this.schedules.upsertSchedule(payload)
  }

  async pauseSchedule(id: string): Promise<CronTask | null> {
    return this.schedules.pauseSchedule(id)
  }

  async resumeSchedule(id: string): Promise<CronTask | null> {
    return this.schedules.resumeSchedule(id)
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.schedules.deleteSchedule(id)
  }

  async runScheduleNow(id: string): Promise<{ success: boolean; error?: string }> {
    return this.schedules.runScheduleNow(id)
  }

  async syncDatabaseToSidecar(): Promise<void> {
    return this.sidecarPoll.syncDatabaseToSidecar()
  }

  // B8-D R5 — cluster body lives in RemoteChannelService; this delegate keeps
  // the SidecarPollService injection closure (`handleInboundChannel` dep)
  // bound through the runtime, exactly like the R4 wiring promised.
  private async handleInboundChannel(payload: Record<string, unknown>): Promise<void> {
    return this.remoteChannel.handleInboundChannel(payload)
  }

  /**
   * Phase I P0 —— ask/confirm 卡渠道转投公开口（claude-bridge 的 emitter
   * 注册点在本地 push 之外追加调用；非渠道 scope 内部零动作）。
   */
  async forwardAskUserCardToRemoteChannel(event: AskUserQuestionsCardEvent): Promise<boolean> {
    return this.remoteChannel.maybeForwardAskCardToChannel(event)
  }

  private mapConversationRow(
    row: ChatConversationRecord & { last_message_at?: string | null }
  ): ConversationScope {
    return this.conversationScopes.mapConversationRow(row)
  }

  // B8-D R5 — bodies live in RemoteChannelService; these delegates keep the
  // R4 ConversationScopeStore injection closures (`getScopedRemoteThreadKey`
  // / `getRemoteChannelSessionSettingKey` deps) bound through the runtime.
  // The R4 `ensureChannelScope` / `refreshScope` / `createConversationMessage`
  // delegates are gone with the cluster: their only callers migrated, and the
  // service now binds the ConversationScopeStore public face directly.
  private getRemoteChannelSessionSettingKey(
    channelId: string,
    remoteThread: string,
    agent: string
  ): string {
    return this.remoteChannel.getRemoteChannelSessionSettingKey(channelId, remoteThread, agent)
  }

  private getScopedRemoteThreadKey(
    channelId: string,
    remoteThread: string,
    agent: string
  ): string {
    return this.remoteChannel.getScopedRemoteThreadKey(channelId, remoteThread, agent)
  }

  private extractTextFromMessage(message: string | MultimodalBlock[]): string {
    return this.conversationScopes.extractTextFromMessage(message)
  }

  private emitConversationEvent(payload: ConversationEventPayload): void {
    this.projectionSync.emitConversationEvent(payload)
  }

  private emitScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.projectionSync.emitScopeRunEvent(payload, projectionTruth)
  }

  publishScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): void {
    this.projectionSync.publishScopeRunEvent(payload, projectionTruth)
  }

  recordScopeRunEvent(payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null): ScopeRunSummary | null {
    return this.projectionSync.recordScopeRunEvent(payload, projectionTruth)
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

    // Stage Q (Stage 11) plus 2026-06 resume-kind amendment — Audit §F-6
    // found this builder was the main-side empty-shell escape route. The
    // gate now checks the real user-resume proof, not just handle shape.
    const incomingChildRunId = incoming?.childRunId
    const continuationRefChildRunId =
      (continuationRef as { childRunId?: string | null } | null)?.childRunId || null
    const mergedChildRunId = incomingChildRunId || continuationRefChildRunId || null
    const mergedResumeKind = incoming?.resumeKind || continuationRef?.resumeKind || null
    const intentHandle: ResumePointHandle = {
      childRunId: mergedChildRunId,
      detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || null,
      outputDir: incoming?.outputDir || continuationRef?.outputDir || null,
      runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || null,
      resumeKind: mergedResumeKind,
    }
    if (!canResumeAsUserPoint(intentHandle)) {
      return null
    }

    return normalizeContinuationIntent({
      taskId,
      // Stage Q (Stage 11) — propagate childRunId through the
      // normalize step so downstream consumers (resumeRun, IPC,
      // child runner) see the fresh handle.
      childRunId: mergedChildRunId || undefined,
      resumeKind: mergedResumeKind || undefined,
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

  // B8-D R5 — body lives in RemoteChannelService; this delegate keeps the
  // stay-behind `sendScoped` channel ack call site untouched.
  private async sendLongTextToChannel(
    channelId: string,
    thread: string,
    text: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.remoteChannel.sendLongTextToChannel(channelId, thread, text)
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
      logAgentMetric('reflection_outcome', {
        scopeId: scope.id,
        agent: scope.agent,
        decision: 'error',
        reason: error instanceof Error ? error.message : String(error),
        preferences: 0,
        accepted: null,
        rejected: null,
        addedCount: null,
        droppedCount: null,
        summaryKept: false,
      })
      return null
    }
  }

  private toChannelKey(scope: ConversationScope): string {
    const sourceId = scope.sourceKind === 'local' ? 'app' : scope.sourceId
    return `${scope.sourceKind}:${sourceId}`
  }
}
