import { app } from 'electron'
import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { BrowserHumanTakeoverIntentInput, BrowserTargetResumeRequest } from '../../../../shared/browser-workflow-control'
import type { AskUserQuestionsCardEvent } from '../../tools/builtins/ask-user-questions'
import { registerChannelOutboundSender } from '../channel-outbound-bridge'
import type { AgentManager } from '../../claude-bridge/agent-manager'
import type { MultimodalBlock } from '../contracts/run-contracts'
import {
  getDatabase,
  type AgentChannelType,
  type ChatConversationRecord,
  type ConversationSourceKind,
} from '../../database'
import { CodexHostOrchestrator } from './codex-host-orchestrator'
import {
  type RunMetaRepositoryLike,
} from './run-finalizer'
import { finalizeStaleWithoutHandleProjections } from './stale-projection-finalizer'
import { PromptAssemblyService } from '../prompt-assembly'
import { selectScopeTaskIndexEntries } from '../session/daily-task-index-builder'
import { BeliefCardStore } from '../knowledge/belief-card-store'
import type { MirrorDb } from '../knowledge/belief-card-mirror'
import { bumpBeliefCardAccess, readBeliefCardAccessStats } from '../knowledge/belief-card-mirror'
import { runBeliefDecayRound, collectBeliefDecaySignals, createBeliefDecayEffectors } from '../memory/belief-decay'
import {
  getSpecialistContentEditProposalStore,
} from '../agents/specialist-content-edit-runtime'
import type { SpecialistContentEditProposalStore } from '../agents/specialist-content-edit-proposals'
import { RunCoordinator } from '../task-projection/run-coordinator'
import { AgentExecutionProfileResolver, resolveConversationAgentId } from '../agents/agent-execution-profile'
import { commitSameSessionHandoff } from '../agents/handoff-adoption-transaction'
import { getSpecialistBlueprintStore } from '../agents/specialist-blueprint-runtime'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { SkillTaskRunRepository } from '../../repositories/skill-task-run-repository'
import {
  AgentSessionCheckpointRepository,
  type CanonicalCoreCloseoutInput,
} from '../../repositories/agent-session-checkpoint-repository'
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
import { ReferenceHintService } from './reference-hint-service'
import { ScheduleCoordinator } from '../../scheduled-tasks/schedule-coordinator'
import { ScheduleRepository, type ScheduledTaskOccurrence } from '../../scheduled-tasks/schedule-repository'
import { ScheduleDispatchQueue } from '../../scheduled-tasks/schedule-dispatch-queue'
import { dispatchScheduledOccurrence } from '../../scheduled-tasks/schedule-execution'
import { recoverScheduledOccurrenceAfterRestart } from '../../scheduled-tasks/schedule-recovery'
import { getNextScheduleRuns } from '../../scheduled-tasks/schedule-next-run'
import { validateWorkspaceRoot } from '../../../../shared/workspace-validation'
import type {
  AgentScheduleDefinition,
  AgentScheduleOccurrence,
  ScheduleBlockedReason,
  ScheduleCreateRequest,
  SchedulePreview,
  SchedulePreviewRequest,
  ScheduleUpdateRequest,
} from '../../../../shared/scheduled-tasks'
import { ChannelConfigService } from './channel-config-service'
import { ScopeAttachmentService } from './scope-attachment-service'
import { SidecarPollService } from './sidecar-poll-service'
import { ConversationScopeStore } from './conversation-scope-store'
import { RemoteChannelService } from './remote-channel-service'
import { reconcileTaskProjections } from '../task-projection/task-projection-reconciler'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'
import { assertSkillTaskRunInvariantConsistency } from '../skills/skill-task-tracker'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from '../contracts/run-contracts'
import {
  type ContinuationIntent,
} from '../contracts/continuation-state'
import { taskEventBridge } from '../../browser-engine/task-event-bridge'
import { createTaskEventProofListener, createTaskProofSink } from '../quality/proof-collector'
import { isKnowledgeSystemEnabled, runStartupBeliefSync, KnowledgeWatcher } from '../knowledge/knowledge-truth-source'
import { logAgentMetric } from '../metrics'
import { runConfirmedSendScoped } from '../send-scoped-confirmation'
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
  type ActiveChildRunSummaryForRuntime,
  type TaskProjectionChildSummaryRow,
  type UpsertChannelPayload,
} from './runtime-helpers'
import { resolveTrustedBrowserEnvironment } from './trusted-browser-environment'
import { BrowserContinuationRuntime } from './browser-continuation-runtime'
import { buildContinuationIntent as buildContinuationIntentValue } from './continuation-intent-builder'
import type { CodexRuntimeComposition } from '../codex-runtime/codex-runtime-composition'
import {
  preparedCodexProductRunMatchesIngress,
  type PreparedCodexProductRun,
} from '../codex-runtime/codex-product-run-preparer'
import { TERMINAL_ERROR_KINDS } from '../../../../shared/ipc-contracts/agent-runtime'
import type {
  LifecycleRequest,
  SendScopedRequest,
  SendScopedResponse,
} from '../../../../shared/ipc-contracts/agent-runtime'

export type { UpsertChannelPayload } from './runtime-helpers'

export class AgentControlRuntime extends EventEmitter {
  private readonly db = getDatabase()
  private readonly agentSessionCheckpoints: AgentSessionCheckpointRepository
  private readonly browserController: BrowserController | null
  private readonly browserContinuation: BrowserContinuationRuntime
  // EP3-A3: declared BEFORE promptAssembly so the roster closure can never
  // observe an uninitialized field (empty/dead table degrades to []).
  private readonly agentRegistry = new AgentRegistryRepository(this.db)
  private readonly settingsRepository = new AppSettingsRepository()
  private readonly sidecar = new SidecarManager()
  private readonly codexRuntime: CodexRuntimeComposition
  private readonly orchestrator: CodexHostOrchestrator
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
  private readonly executionProfileResolver = new AgentExecutionProfileResolver({
    registry: this.agentRegistry,
    personality: this.agentPersonalityRepository,
    getKnowledgeStore: () => this.getBeliefCardStore(),
    readAsset: (relPath) => {
      const path = join(app.getPath('userData'), 'agent-memory', relPath)
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    },
    isKnowledgeEnabled: () => isKnowledgeSystemEnabled(this.db),
    listBlueprints: () => getSpecialistBlueprintStore().list(['confirmed']),
  })
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
    getAgentReadiness: (agentId) => this.executionProfileResolver.resolveReadiness(agentId),
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
    getAgentReadiness: (agentId) => this.executionProfileResolver.resolveReadiness(agentId),
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
  private readonly scheduleRepository = new ScheduleRepository(this.db)
  private readonly scheduleDispatchQueue = new ScheduleDispatchQueue({
    isScopeBusy: (scopeId) => {
      const row = this.db.getConversationScope(scopeId)
      if (!row) return false
      const scope = this.mapConversationRow(row)
      return this.orchestrator.isScopeLive(scope.agent, scope.id)
    },
    dispatch: async (item) => {
      const occurrence = this.scheduleRepository.getOccurrence(item.occurrenceId)
      if (!occurrence) return
      await this.dispatchScheduledTaskOccurrence(occurrence)
    },
    markSkippedCoalesced: (item) => {
      const updated = this.scheduleRepository.updateOccurrenceStatus(item.occurrenceId, 'skipped_coalesced', {
        finishedAt: new Date().toISOString(),
      })
      if (updated) logAgentMetric('scheduled_task_occurrence_status', {
        scheduleId: updated.scheduleId, occurrenceId: updated.id, status: updated.claimStatus,
      })
      this.emitScheduledTasksChanged(item.scheduleId)
    },
    onDispatchError: (item, error) => logAgentMetric('scheduled_task_dispatch_failed', {
      scheduleId: item.scheduleId,
      occurrenceId: item.occurrenceId,
      reason: error instanceof Error ? error.message : String(error),
    }),
  })
  private readonly scheduledTaskCoordinator = new ScheduleCoordinator({
    repository: {
      listEnabled: () => this.scheduleRepository.listEnabled().map((schedule) => ({
        id: schedule.id,
        spec: schedule.scheduleSpec,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
        missedPolicy: schedule.missedPolicy,
        claimedExecutionCount: this.scheduleRepository.countScheduledExecutionClaims(schedule.id),
      })),
      reconcile: (input) => {
        const occurrences = this.scheduleRepository.reconcile(input)
        for (const occurrence of occurrences) {
          logAgentMetric('scheduled_task_occurrence_status', {
            scheduleId: occurrence.scheduleId,
            occurrenceId: occurrence.id,
            scheduledFor: occurrence.scheduledFor,
            triggerSource: occurrence.triggerSource,
            status: occurrence.claimStatus,
          })
        }
        if (input.occurrences.length > 0 || input.disableAfterReconcile) {
          this.emitScheduledTasksChanged(input.scheduleId)
        }
        return occurrences
      },
      listRecoverable: () => this.scheduleRepository.listRecoverable(),
    },
    enqueue: (occurrence) => {
      const durable = this.scheduleRepository.getOccurrence(occurrence.id)
      if (!durable) return
      recoverScheduledOccurrenceAfterRestart(durable, {
        markInterrupted: (item) => {
          this.scheduleRepository.updateOccurrenceStatus(item.id, 'dispatch_failed', {
            errorKind: 'interrupted_restart',
            errorMessage: 'Ready restarted before Agent acceptance could be proven',
            finishedAt: new Date().toISOString(),
          })
          this.emitScheduledTasksChanged(item.scheduleId)
        },
        enqueue: (item) => this.enqueueScheduledOccurrence(item),
      })
    },
    log: (message) => logAgentMetric('scheduled_task_reconcile', { message }),
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
  // `heartbeat` / `channelStateCache` so the deps capture initialized object references
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
    handleInboundChannel: (payload) => this.handleInboundChannel(payload),
  })
  private readonly conversationScopes = new ConversationScopeStore({
    db: this.db,
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
    resolveConversationAgentId: (requestedAgentId) =>
      resolveConversationAgentId(requestedAgentId, this.agentRegistry).effectiveAgentId,
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
      runInboundChannel: async () => ({
        success: false,
        error: 'non_local_ingress_unsupported',
        errorKind: 'blocked_config',
      }),
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
  constructor(
    agentManager: AgentManager,
    browserController: BrowserController | undefined,
    codexRuntime: CodexRuntimeComposition,
  ) {
    super()
    this.agentManager = agentManager
    this.browserController = browserController || null
    this.codexRuntime = codexRuntime
    this.agentSessionCheckpoints = new AgentSessionCheckpointRepository(
      this.db,
      codexRuntime.canonicalCloseoutTransactionParticipant,
    )
    this.browserController?.setHumanTakeoverIntentPort((input) => this.createHumanTakeoverIntent(input))
    this.browserController?.setBrowserTargetResumePort((input) => this.resumeBrowserTargetClaim(input))
    this.browserController?.setBrowserTargetCheckpointResolver((parentTaskId) =>
      this.getTaskProjection(parentTaskId)?.checkpointRefs?.cleanBaseCheckpointId || null)
    this.browserController?.setBrowserWorkflowWriteAdmissionPort((input) =>
      this.agentSessionCheckpoints.isBrowserWorkflowWriteAdmitted({
        parentTaskId: input.parentTaskId,
        ownerRunId: input.ownerRunId,
        browserTaskId: input.browserTaskId,
        physicalTarget: {
          surface: input.surface,
          scopeId: input.scopeId,
          profileId: input.profileId,
          sessionId: input.sessionId,
          tabId: input.tabId,
          physicalTargetToken: input.physicalTargetToken,
          source: 'physical_input',
        },
      }),
    )
    this.browserController?.setBrowserWorkflowJournalUnitOfWork({
      beginAction: (input) => this.agentSessionCheckpoints.beginBrowserWorkflowAction(input),
      settleAction: (taskId, actionId, outcome) => (
        this.agentSessionCheckpoints.settleBrowserWorkflowAction(taskId, actionId, outcome)
      ),
      recordObservation: (input) => this.agentSessionCheckpoints.recordBrowserWorkflowObservation(input),
      upsertResearchWorkItems: (taskId, ownerRunId, inputs) => (
        this.agentSessionCheckpoints.upsertBrowserResearchWorkItems(taskId, ownerRunId, inputs)
      ),
      bindResearchEvidence: (taskId, ownerRunId, bindings) => (
        this.agentSessionCheckpoints.bindBrowserResearchEvidence(taskId, ownerRunId, bindings)
      ),
    })
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
    this.orchestrator = new CodexHostOrchestrator({
      browserController,
    })
    this.orchestrator.setRuntime(this)
    this.runCoordinator = new RunCoordinator({
      executeCodexPrepared: async (input) => {
        return this.codexRuntime.lifecycleAdapter.executePreparedRun({
          prepared: input.prepared,
          expectedScopeId: input.scope.id,
          emitStartedProjection: input.emitStartedProjection,
          resolveContext: () => this.codexRuntime.preparedRunContextPort.resolve(input),
        })
      },
      observeCodexCloseoutReadback: (input, onReadback) => (
        this.codexRuntime.lifecycleAdapter.observeRunCloseout({
          prepared: input.prepared,
          expectedScopeId: input.scope.id,
          pending: input.pending,
        }, onReadback)
      ),
      emitStartedScopeRunEvent: (payload) => this.projectionSync.emitScopeRunEvent(payload),
      publishCommittedTerminalEvent: (payload) => (
        this.projectionSync.publishCommittedScopeRunEvent(payload)
      ),
      onRunStarted: ({ requestId, prepared, scope }) => this.orchestrator.beginActiveProductRun({
        agent: scope.agent,
        scopeId: scope.id,
        requestId,
        runId: prepared.runId,
      }),
      onRunSettled: ({ requestId, scope }) => this.orchestrator.finishActiveProductRun({
        agent: scope.agent,
        scopeId: scope.id,
        requestId,
      }),
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
    this.browserContinuation = new BrowserContinuationRuntime({
      agentSessionCheckpoints: this.agentSessionCheckpoints,
      browserController: this.browserController,
      taskProjectionStore: this.taskProjectionStore,
      executionProfileResolver: this.executionProfileResolver,
      scopeRunSummaries: this.scopeRunSummaries,
      getConversationScope: (scopeId) => this.getConversationScope(scopeId),
      getTaskProjection: (taskId) => this.getTaskProjection(taskId),
      listTaskProjections: (scopeId) => this.listTaskProjections(scopeId),
      getDomainAdapters: () => this.getDomainAdapters(),
      dispatchSuccessor: async () => ({
        success: false,
        error: 'non_user_successor_unsupported',
        errorKind: 'non_user_successor_unsupported',
      }),
    })
    this.detachedSkills = new DetachedSkillService({
      publishScopeRunEvent: (payload) => this.projectionSync.publishScopeRunEvent(payload),
    })
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
        publishScopeRunEvent: (payload) => this.projectionSync.publishScopeRunEvent(payload),
      })
    } catch (error) {
      // This runner remains available only to its explicit management IPC.
      // Codex ingress never depends on it, so a setup failure is observable
      // without changing the native runtime branch.
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
  }

  getOrchestrator(): CodexHostOrchestrator {
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

  getAgentSessionCheckpointRepository(): AgentSessionCheckpointRepository {
    return this.agentSessionCheckpoints
  }

  async updateBrowserWorkflowCompletionDeclaration(input: {
    parentTaskId: string
    browserTaskId: string
    ownerRunId: string
    modelCriteria: string[]
    expectedOutputs: string[]
  }): Promise<void> {
    await this.agentSessionCheckpoints.updateBrowserWorkflowCompletionDeclaration(input)
  }

  async createHumanTakeoverIntent(
    input: BrowserHumanTakeoverIntentInput,
  ): Promise<{ takeoverId: string }> {
  return this.browserContinuation.createHumanTakeoverIntent(input)
  }

  async commitCanonicalCoreCloseout(
    input: Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'>,
  ) {
    const committed = await this.agentSessionCheckpoints.commitCanonicalCoreCloseout({
      ...input,
      repairDerivedState: async ({ canonicalMessage, canonicalMessageDigest }) => {
        this.db.repairChatMessageDerivedIndexes(canonicalMessage, canonicalMessageDigest)
      },
    })
    if (committed.derivedRepairError) {
      logAgentMetric('canonical_core_closeout_derived_repair_failed', {
        taskId: input.parentTaskId,
        runId: input.ownerRunId,
        reason: committed.derivedRepairError.message,
      })
    }
    return {
      canonicalMessage: committed.value.canonicalMessage,
      canonicalMessageDigest: committed.value.canonicalMessageDigest,
    }
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

  resolveAgentExecutionProfile(agentId: string) {
    return this.executionProfileResolver.resolve(agentId)
  }

  resolveAgentExecutionReadiness(agentId: string) {
    return this.executionProfileResolver.resolveReadiness(agentId)
  }

  listAgentProfileSummaries() {
    return this.agentRegistry.list()
      .filter((record) => record.status === 'active')
      .map((record) => ({
        agentId: record.id,
        name: record.name,
        collaborationReady: this.executionProfileResolver.resolveReadiness(record.id).collaborationReady,
      }))
  }

  createWorkflowParticipantBinding(input: {
    profile: import('../../../../shared/agent-execution-profile').AgentExecutionProfile
    runId: string
    ownerAgentIdAtStart: string
  }) {
    return this.executionProfileResolver.createBinding({
      ...input,
      runOrigin: 'workflow_participant',
      ownerAssignmentSource: 'parent_task',
      executionSelectionSource: 'workflow_participant',
    })
  }

  adoptSameSessionHandoff(input: {
    taskId: string
    scopeId: string
    targetAgentId: string
    userRequestVerbatim: string
    contextRefs: string[]
  }): { handoffGeneration: number } {
    const scope = this.getConversationScope(input.scopeId)
    if (scope && this.orchestrator.isScopeLive(scope.agent, scope.id)) {
      throw new Error('codex_handoff_requires_native_terminal_reconciliation')
    }
    const rawDb = this.db.getRawDb()
    if (!rawDb) throw new Error('[runtime] database unavailable')
    return commitSameSessionHandoff({
      getTask: (taskId) => {
        const task = this.taskProjectionStore.get(taskId)
        return task ? { scopeId: task.scopeId, runId: task.runId } : null
      },
      getConversation: (scopeId) => {
        const scope = this.db.getConversationScope(scopeId)
        return scope ? { agent: scope.agent, handoffGeneration: scope.handoff_generation ?? 0 } : null
      },
      begin: () => rawDb.exec('BEGIN'),
      commit: () => rawDb.exec('COMMIT'),
      rollback: () => rawDb.exec('ROLLBACK'),
      updateTask: (taskId, patch) => this.taskProjectionStore.update(taskId, patch as never),
      updateConversation: (scopeId, activeAgentId, handoffGeneration) => {
        this.db.updateConversationAgentState(scopeId, activeAgentId, handoffGeneration)
      },
      onCommitted: () => {},
    }, input)
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
    await this.scheduledTaskCoordinator.start()

    // Start memory lifecycle manager
    this.memoryLifecycle.start()
    // P2-1 — deterministic crystallize round on the same 6h rhythm + a startup
    // pass (deferred 90s so it trails first-run belief sync / seeding above the
    // memory lifecycle's own 60s initial tick).
    this.crystallizeScheduler.start()
    setTimeout(() => { void this.runCrystallizeRoundOnce(false) }, 90_000)

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
    this.browserController?.setHumanTakeoverIntentPort(null)
    this.browserController?.setBrowserTargetResumePort(null)
    this.browserController?.setBrowserWorkflowWriteAdmissionPort(null)
    this.browserController?.setBrowserWorkflowJournalUnitOfWork(null)
    this.scheduledTaskCoordinator.stop()
    for (const session of this.orchestrator.listAllSessions()) {
      if (!session.sessionId) continue
      const aliasGeneration = this.codexRuntime.aliasBindingPort.readAliasGeneration(session.sessionId)
      if (aliasGeneration === null) continue
      await this.codexRuntime.lifecycleAdapter.stopSession({
        aliasId: session.sessionId,
        aliasGeneration,
      })
    }

    this.sidecarPoll.stopPollLoop()

    // Stop memory lifecycle manager
    this.memoryLifecycle.stop()
    this.crystallizeScheduler.stop()
    this.knowledgeWatcher?.stop()
    await this.externalMemoryProviderSlot.shutdown()

    await this.sidecar.stop()
  }

  async reconcileScheduledTasks(source: 'timer' | 'startup' | 'resume'): Promise<void> {
    await this.scheduledTaskCoordinator.reconcile(source)
  }

  listScheduledTasks(): AgentScheduleDefinition[] {
    return this.scheduleRepository.list().map((schedule) => this.mapScheduledTask(schedule))
  }

  getScheduledTask(id: string): AgentScheduleDefinition | null {
    const schedule = this.scheduleRepository.get(id)
    return schedule ? this.mapScheduledTask(schedule) : null
  }

  previewScheduledTask(request: SchedulePreviewRequest): SchedulePreview {
    const occurrences = getNextScheduleRuns({
      spec: request.scheduleSpec,
      timezone: request.timezone,
      after: request.from || new Date().toISOString(),
      count: request.count ?? 3,
    })
    return { occurrences, nextRunAt: occurrences[0] ?? null, blockedReason: null }
  }

  async createScheduledTask(request: ScheduleCreateRequest): Promise<AgentScheduleDefinition> {
    const instruction = request.instruction.trim()
    if (!instruction) throw new Error('Schedule instruction is required')
    const name = request.name.trim() || instruction.split(/\r?\n/, 1)[0].slice(0, 48)
    const scopeId = this.resolveScheduleMutationScope(request, null)
    const nextRunAt = request.enabled
      ? this.previewScheduledTask({ scheduleSpec: request.scheduleSpec, timezone: request.timezone, count: 1 }).nextRunAt
      : null
    if (request.enabled && !nextRunAt) throw new Error('Schedule does not produce a future time')
    this.assertScheduleTargetAvailable(scopeId, request.agentId, request.workspaceRoots)
    const created = this.scheduleRepository.create({
      id: `schedule-${randomUUID()}`,
      name,
      instruction,
      scheduleSpec: request.scheduleSpec,
      timezone: request.timezone,
      scopeId,
      scopeMode: request.scopeMode,
      agentId: request.agentId,
      workspaceRoots: request.workspaceRoots,
      enabled: request.enabled,
      nextRunAt,
      missedPolicy: request.missedPolicy,
    })
    await this.scheduledTaskCoordinator.reschedule()
    return this.mapScheduledTask(created)
  }

  async updateScheduledTask(request: ScheduleUpdateRequest): Promise<AgentScheduleDefinition | null> {
    const existing = this.scheduleRepository.get(request.id)
    if (!existing) return null
    const instruction = request.instruction.trim()
    if (!instruction) throw new Error('Schedule instruction is required')
    const name = request.name.trim() || instruction.split(/\r?\n/, 1)[0].slice(0, 48)
    const scopeId = this.resolveScheduleMutationScope(request, existing)
    const nextRunAt = request.enabled
      ? this.previewScheduledTask({ scheduleSpec: request.scheduleSpec, timezone: request.timezone, count: 1 }).nextRunAt
      : null
    if (request.enabled && !nextRunAt) throw new Error('Schedule does not produce a future time')
    this.assertScheduleTargetAvailable(scopeId, request.agentId, request.workspaceRoots)
    const updated = this.scheduleRepository.update(request.id, {
      name,
      instruction,
      scheduleSpec: request.scheduleSpec,
      timezone: request.timezone,
      scopeId,
      scopeMode: request.scopeMode,
      agentId: request.agentId,
      workspaceRoots: request.workspaceRoots,
      enabled: request.enabled,
      nextRunAt,
      missedPolicy: request.missedPolicy,
      migrationState: null,
    })
    await this.scheduledTaskCoordinator.reschedule()
    return updated ? this.mapScheduledTask(updated) : null
  }

  async pauseScheduledTask(id: string): Promise<AgentScheduleDefinition | null> {
    const updated = this.scheduleRepository.update(id, { enabled: false, nextRunAt: null })
    await this.scheduledTaskCoordinator.reschedule()
    return updated ? this.mapScheduledTask(updated) : null
  }

  async resumeScheduledTask(id: string): Promise<AgentScheduleDefinition | null> {
    const existing = this.scheduleRepository.get(id)
    if (!existing || !existing.scopeId) return null
    this.assertScheduleTargetAvailable(existing.scopeId, existing.agentId, existing.workspaceRoots)
    const nextRunAt = this.previewScheduledTask({
      scheduleSpec: existing.scheduleSpec,
      timezone: existing.timezone,
      count: 1,
    }).nextRunAt
    if (!nextRunAt) throw new Error('Schedule does not produce a future time')
    const updated = this.scheduleRepository.update(id, { enabled: true, nextRunAt, migrationState: null })
    await this.scheduledTaskCoordinator.reschedule()
    return updated ? this.mapScheduledTask(updated) : null
  }

  async deleteScheduledTask(id: string): Promise<boolean> {
    const removed = this.scheduleRepository.delete(id)
    await this.scheduledTaskCoordinator.reschedule()
    return removed
  }

  async runScheduledTaskNow(id: string): Promise<AgentScheduleOccurrence | null> {
    const schedule = this.scheduleRepository.get(id)
    if (!schedule || !schedule.enabled || !schedule.scopeId) return null
    this.assertScheduleTargetAvailable(schedule.scopeId, schedule.agentId, schedule.workspaceRoots)
    const now = new Date().toISOString()
    const occurrence = this.scheduleRepository.claimDue({
      scheduleId: id,
      scheduledFor: now,
      triggeredAt: now,
      triggerSource: 'manual',
      nextRunAt: schedule.nextRunAt,
      occurrenceId: `occ-manual-${randomUUID()}`,
    })
    if (!occurrence) return null
    logAgentMetric('scheduled_task_occurrence_status', {
      scheduleId: occurrence.scheduleId,
      occurrenceId: occurrence.id,
      scheduledFor: occurrence.scheduledFor,
      triggerSource: occurrence.triggerSource,
      status: occurrence.claimStatus,
    })
    this.enqueueScheduledOccurrence(occurrence)
    return occurrence
  }

  listScheduledTaskOccurrences(scheduleId: string, limit?: number): AgentScheduleOccurrence[] {
    return this.scheduleRepository.listHistory(scheduleId, limit).map((occurrence) => {
      const projection = occurrence.taskId ? this.taskProjectionStore.get(occurrence.taskId) : null
      return {
        ...occurrence,
        runStatus: projection?.status ?? null,
        interactionState: projection?.interactionState ?? null,
        runBlockedReason: projection?.blockedReason ?? null,
      }
    })
  }

  private enqueueScheduledOccurrence(occurrence: ScheduledTaskOccurrence): void {
    const schedule = this.scheduleRepository.get(occurrence.scheduleId)
    if (!schedule?.scopeId) return
    void this.scheduleDispatchQueue.enqueue({
      occurrenceId: occurrence.id,
      scheduleId: occurrence.scheduleId,
      scopeId: schedule.scopeId,
      scheduledFor: occurrence.scheduledFor,
    })
  }

  private emitScheduledTasksChanged(scheduleId: string): void {
    this.emit('scheduledTasksChanged', scheduleId)
  }

  private resolveScheduleMutationScope(
    request: ScheduleCreateRequest | ScheduleUpdateRequest,
    existing: import('../../scheduled-tasks/schedule-repository').ScheduledTaskDefinition | null,
  ): string {
    if (request.scopeMode === 'existing') {
      if (!request.scopeId.trim()) throw new Error('Scheduled tasks require a scope')
      return request.scopeId.trim()
    }
    if (existing?.scopeMode === 'dedicated' && existing.agentId === request.agentId && existing.scopeId) {
      return existing.scopeId
    }
    return this.createLocalScope(request.agentId, `conv-scheduled-${randomUUID()}`).id
  }

  private assertScheduleTargetAvailable(scopeId: string, agentId: string, workspaceRoots: string[]): void {
    if (!this.db.getConversationScope(scopeId)) throw new Error('Target conversation is missing')
    if (!this.resolveAgentExecutionReadiness(agentId).conversationReady) throw new Error('Target Agent is unavailable')
    if (workspaceRoots.some((root) => !validateWorkspaceRoot(root).ok)) {
      throw new Error('Target workspace is unavailable')
    }
  }

  private mapScheduledTask(schedule: import('../../scheduled-tasks/schedule-repository').ScheduledTaskDefinition): AgentScheduleDefinition {
    const latest = this.scheduleRepository.listHistory(schedule.id, 1)[0]
    const blockedReason = latest?.claimStatus === 'blocked_target' && latest.errorKind?.startsWith('blocked_')
      ? latest.errorKind as ScheduleBlockedReason
      : null
    return {
      id: schedule.id,
      name: schedule.name,
      instruction: schedule.instruction,
      scheduleSpecVersion: schedule.scheduleSpecVersion,
      scheduleSpec: schedule.scheduleSpec,
      timezone: schedule.timezone,
      scopeId: schedule.scopeId,
      scopeMode: schedule.scopeMode,
      agentId: schedule.agentId,
      workspaceRoots: schedule.workspaceRoots,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      lastOccurrenceAt: schedule.lastOccurrenceAt,
      missedPolicy: schedule.missedPolicy,
      blockedReason,
      migrationState: schedule.migrationState,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    }
  }

  private async dispatchScheduledTaskOccurrence(
    occurrence: ScheduledTaskOccurrence,
  ): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    return dispatchScheduledOccurrence(occurrence, {
      getSchedule: (id) => this.scheduleRepository.get(id),
      scopeExists: (scopeId) => Boolean(this.db.getConversationScope(scopeId)),
      agentAvailable: (agentId) => this.resolveAgentExecutionReadiness(agentId).conversationReady,
      workspaceAvailable: (root) => validateWorkspaceRoot(root).ok,
      pauseSchedule: (id) => {
        this.scheduleRepository.update(id, { enabled: false, nextRunAt: null })
        this.emitScheduledTasksChanged(id)
        void this.scheduledTaskCoordinator.reschedule()
      },
      markDispatching: (id, runId, taskId) => {
        const updated = this.scheduleRepository.updateOccurrenceStatus(id, 'dispatching', { runId, taskId })
        if (updated) {
          logAgentMetric('scheduled_task_occurrence_status', {
            scheduleId: updated.scheduleId, occurrenceId: updated.id, runId, taskId, status: updated.claimStatus,
          })
          this.emitScheduledTasksChanged(updated.scheduleId)
        }
        return Boolean(updated)
      },
      markDispatched: (id, runId, taskId) => {
        this.scheduleRepository.updateOccurrenceStatus(id, 'dispatched', {
          runId,
          taskId,
          finishedAt: new Date().toISOString(),
        })
        logAgentMetric('scheduled_task_occurrence_status', {
          scheduleId: occurrence.scheduleId, occurrenceId: id, runId, taskId, status: 'dispatched',
        })
        this.emitScheduledTasksChanged(occurrence.scheduleId)
      },
      markFailed: (id, errorKind, errorMessage) => {
        const current = this.scheduleRepository.getOccurrence(id)
        if (!current) return
        const status = errorKind.startsWith('blocked_') ? 'blocked_target' : 'dispatch_failed'
        this.scheduleRepository.updateOccurrenceStatus(id, status, {
          errorKind,
          errorMessage,
          finishedAt: new Date().toISOString(),
        })
        logAgentMetric('scheduled_task_occurrence_status', {
          scheduleId: current.scheduleId,
          occurrenceId: id,
          runId: current.runId,
          taskId: current.taskId,
          status,
          errorKind,
        })
        this.emitScheduledTasksChanged(current.scheduleId)
      },
      send: async () => ({
        success: false,
        error: 'scheduled_codex_ingress_unsupported',
        errorKind: 'blocked_config',
      }),
      log: (message) => logAgentMetric('scheduled_task_dispatch', { message }),
    })
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
    const schedules = this.listScheduledTasks()
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
      activeTasks: this.orchestrator.getActiveRunCount(),
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
    return this.conversationScopes.listConversationScopes(agent).map((scope) => ({
      ...scope,
      aliasGeneration: this.codexRuntime.aliasBindingPort.readAliasGeneration(scope.id),
    }))
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

  createCodexSession() {
    return this.codexRuntime.lifecycleAdapter.createSession()
  }

  resetCodexSession(request: LifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.resetSession(request)
  }

  stopCodexSession(request: LifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.stopSession(request)
  }

  closeCodexSession(request: LifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.closeSession(request)
  }

  compactCodexSession(request: LifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.compactSession(request)
  }

  private async resolveTrustedRequestEnvironment(
    hint?: { workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' },
  ): Promise<import('../contracts/request-envelope').TrustedRequestEnvironment> {
    const workbenchMode = hint?.workbenchMode
    if (!workbenchMode) return {}
    if (workbenchMode !== 'browser' || !this.browserController) return { workbenchMode }
    try {
      return await resolveTrustedBrowserEnvironment(this.browserController)
    } catch (error) {
      logAgentMetric('trusted_browser_environment_degraded', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return { workbenchMode }
    }
  }

  async sendScoped(payload: SendScopedRequest): Promise<SendScopedResponse> {
    const canonicalUserMessage = payload.userMessage
    return runConfirmedSendScoped({
      scopeId: payload.scopeId,
      requestId: payload.requestId,
      userMessage: canonicalUserMessage,
      getScope: (scopeId) => this.db.getConversationScope(scopeId),
      resolveStartIdentityMethods: (scopeRow) => this.codexRuntime.startIdentityPort.resolveMethods(
        this.mapConversationRow(scopeRow).id,
      ),
      reserveStartIdentitySet: (input) => this.codexRuntime.startIdentityPort.reserve(input),
      reconcileReservationContractFailure: (input) => (
        this.codexRuntime.startIdentityPort.reconcileReservationContractFailure(input)
      ),
      prepareDispatch: ({ scope, reservation }) => this.codexRuntime.ingressPort.prepareIngress({
        scope: this.mapConversationRow(scope),
        request: payload,
        reservation,
      }),
      validateDispatchContext: (value, input): value is PreparedCodexProductRun => {
        const mappedScope = this.mapConversationRow(input.scope)
        return preparedCodexProductRunMatchesIngress(value, {
          scopeId: mappedScope.id,
          aliasId: mappedScope.id,
          aliasGeneration: this.codexRuntime.aliasBindingPort.readAliasGeneration(mappedScope.id),
          requestId: input.requestId,
          originUserMessageId: input.userMessage.id,
          reservationSetId: input.reservation.reservationSetId,
          reservationEvidenceDigest: input.reservation.reservationEvidenceDigest,
        })
      },
      persistIngressAtomic: async ({ scope, reservation, dispatchContext }) => {
        const admission = await this.codexRuntime.ingressPort.persistIngressAtomic({
          scope: this.mapConversationRow(scope),
          request: payload,
          reservation,
          prepared: dispatchContext,
        })
        return {
          persistence: admission.persistence,
          event: admission.event,
        }
      },
      releaseReservationAfterIngressFailure: (input) => (
        this.codexRuntime.startIdentityPort.releaseAfterIngressFailure(input)
      ),
      releaseReservationAfterPrePersistenceRejection: (input) => (
        this.codexRuntime.startIdentityPort.releaseAfterPrePersistenceRejection(input)
      ),
      emitIngressAdmitted: (event) => this.emit('ingressAdmitted', event),
      runConfirmed: async ({ scope, persistence, dispatchContext }) => {
        const result = await this.runCoordinator.runScoped({
          requestId: payload.requestId,
          scope: this.mapConversationRow(scope),
          preparedCodexRun: dispatchContext,
        })
        if (result.success) {
          return {
            success: true,
            disposition: 'terminal_success',
            ownerRunId: payload.requestId,
            shouldClearInput: true,
            preserveInput: false,
            retryableByUser: false,
            persistence,
            responseText: result.responseText,
            canonicalMessage: result.canonicalMessage,
            canonicalMessageDigest: result.canonicalMessageDigest,
          }
        }
        const errorKind = TERMINAL_ERROR_KINDS.includes(result.errorKind as never)
          ? result.errorKind as typeof TERMINAL_ERROR_KINDS[number]
          : 'persistence_failed'
        return {
          success: false,
          disposition: 'terminal_failure_after_persistence',
          ownerRunId: payload.requestId,
          shouldClearInput: true,
          preserveInput: false,
          retryableByUser: false,
          persistence,
          error: result.error || 'codex_closeout_contract_invalid',
          errorKind,
          productOutcomeDigest: result.productOutcomeDigest,
        }
      },
    })
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
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    return this.browserContinuation.suspendRun(payload)
  }

  async reportInfrastructureTimeout(payload: {
    scopeId: string
    requestId: string
    elapsedMs?: number
  }): Promise<{
    success: boolean
    state?: 'active' | 'stale' | 'not_found' | 'paused_user_input'
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

    const activeRun = this.orchestrator.inspectActiveRunIfMatches(scope.agent, scope.id, requestId)
    if (activeRun.state === 'active'
      && this.orchestrator.isActiveRunAwaitingUserInput(scope.agent, scope.id, requestId)) {
      this.orchestrator.refreshActiveRunProgress(scope.agent, scope.id, requestId)
      logAgentMetric('renderer_infrastructure_timeout_awaiting_user_input', {
        scopeId,
        requestId,
        elapsedMs: Number.isFinite(Number(payload.elapsedMs)) ? Number(payload.elapsedMs) : null,
      })
      return { success: true, state: 'paused_user_input' }
    }
    logAgentMetric('renderer_infrastructure_timeout_main_report', {
      scopeId,
      requestId,
      elapsedMs: Number.isFinite(Number(payload.elapsedMs)) ? Number(payload.elapsedMs) : null,
      state: activeRun.state,
      activeRunId: ('activeRunId' in activeRun ? activeRun.activeRunId : activeRun.runId) || null,
    })

    if (activeRun.state === 'stale') {
      return {
        success: true,
        state: activeRun.state,
        errorKind: 'stale_request',
        activeRunId: activeRun.activeRunId,
      }
    }
    return { success: true, state: activeRun.state }
  }

  async resumeRun(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText?: string
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  return this.browserContinuation.resumeRun(payload)
  }

  async completeHumanTakeover(payload: {
    taskId: string
    takeoverId: string
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  return this.browserContinuation.completeHumanTakeover(payload)
  }

  async resumeBrowserTargetClaim(payload: BrowserTargetResumeRequest): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  return this.browserContinuation.resumeBrowserTargetClaim(payload)
  }

  private async resumeBrowserWorkflowFromCheckpoint(
    projection: TaskProjectionRecord,
    scope: ConversationScope,
    trigger:
      | {
          kind: 'human_takeover'
          takeoverId: string
          wakeNonce?: string
          targetClaim?: {
            partition: string
            tabId: string
            physicalTargetToken: string
            claimId: string
            generation: number
            suspensionCheckpointId: string
            browserTaskId: string
          }
        }
      | { kind: 'typed_wake'; requestId?: string; confirmationDecision?: 'confirmed' | 'denied' },
  ): Promise<{ success: boolean; error?: string; errorKind?: string }> {
  return this.browserContinuation.resumeBrowserWorkflowFromCheckpoint(projection, scope, trigger)
  }

  async respondToInteraction(payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText: string
    confirmed?: boolean
    continuationIntent?: ContinuationIntent | null
  }): Promise<{ success: boolean; error?: string; errorKind?: string }> {
    return this.browserContinuation.respondToInteraction(payload)
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
  return this.browserContinuation.resolveTaskControlTarget(scopeId, taskId)
  }

  private buildContinuationIntent(params: {
    projection: TaskProjectionRecord | null
    scopeRunSummary: ScopeRunSummary | null
    incoming?: ContinuationIntent | null
    responseText?: string
  }): ContinuationIntent | null {
    return buildContinuationIntentValue(params)
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
