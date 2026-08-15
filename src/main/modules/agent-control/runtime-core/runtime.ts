import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import {
  getDefaultConfig,
  normalizeAIConfig,
  type AIModelConfig
} from '../../../../shared/ai-providers'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import { getBrowserTargetClaimService } from '../../browser-engine/browser-target-claim-singleton'
import {
  commitCodexFailureCoreCloseoutAndReconcileClaims,
  reconcileReleasedBrowserClaims,
} from '../../browser-engine/browser-claim-closeout'
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
import { AgentSdkToolExecutor } from './agent-sdk-tool-executor'
import { AgentSdkSessionManager } from './agent-sdk-session'
import { executeToolCall as executeReadyToolCall } from '../../tools/tool-executor'
import { resolveReadyToolTurnSnapshot } from '../codex-runtime/codex-tool-surface'
import {
  digestFeishuChannelSnapshot,
} from '../../tools/feishu-tools'
import {
  prepareFeishuExternalReadSlice,
  prepareLarkExternalReadSlice,
  readLarkCliAuthReadback,
} from '../codex-runtime/codex-external-read-slice'
import { resolveDeclaredSiblingSkillReadRoots } from '../../skills-runtime/skill-sibling-reference-roots'
import { resolveSkillSurfaceComposition } from '../skills/skill-surface-composition'
import { resolveFrozenDesktopExecutableAuthority } from '../../skills-runtime/desktop-executable-authority'
import {
  resolveCodexNativeSkillInput,
  resolveCodexSelectedSkillMethodology,
} from '../codex-runtime/codex-thread-instructions'
import { createCodexHostExecutionBinding } from '../codex-runtime/codex-host-execution-binding'
import { RunProjection } from '../task-projection/run-projection'
import { ProjectionSyncCoordinator } from './projection-sync-coordinator'
import { DetachedSkillService } from './detached-skill-service'
import { SessionRecallFacade } from './session-recall-facade'
import { ReferenceHintService } from './reference-hint-service'
import { ChannelConfigService } from './channel-config-service'
import { ScopeAttachmentService } from './scope-attachment-service'
import { SidecarPollService } from './sidecar-poll-service'
import { ConversationScopeStore } from './conversation-scope-store'
import { RemoteChannelService } from './remote-channel-service'
import { reconcileTaskProjections } from '../task-projection/task-projection-reconciler'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'
import { assertSkillTaskRunInvariantConsistency } from '../skills/skill-task-tracker'
import type { ProjectionTruthSnapshot, TaskProjectionRecord } from '../contracts/run-contracts'
import { TaskEventProofSubscription } from './task-event-proof-subscription'
import { runStartupBeliefSync, KnowledgeWatcher } from '../knowledge/knowledge-truth-source'
import { logAgentMetric } from '../metrics'
import {
  createRejectedBeforePersistence,
  runConfirmedSendScoped
} from '../send-scoped-confirmation'
import { SessionRecallService } from '../session/session-recall-service'
import { clearActiveSkillContext } from '../session/active-skill-context'
import { clearScopeSessionSnapshot } from '../session/scope-session-snapshot'
import { forgetSession } from '../session/session-continuity'
import { clearAuthorizationFactsForScope } from '../safety/authorization-fact-store'
import { clearNegationsForScope } from '../safety/negation-state'
import { clearLarkCliAuthFlowsForSession } from '../safety/lark-cli-auth-flow-authority'
import { clearLastReferenceSkill } from '../skills/skill-reference-hints'
import { clearSkillTaskProjection } from '../skills/skill-task-tracker'
import { getEphemeralExecutionStore } from '../../tools/skill-primitives/ephemeral-execution-store'
import { getAskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'
import { SidecarManager } from '../sidecar-manager'
import { MemoryRepository } from '../../repositories/memory-repository'
import { MemoryLifecycleManager } from '../memory/memory-lifecycle'
import { CrystallizeScheduler, createCrystallizeEffectors, runCrystallizeRound, type CrystallizeSignals } from '../maintenance/crystallize-gate'
import { ReflectionService } from '../reflection-service'
import { runUserPictureCasMerge } from '../maintenance/cas-merge'
import { UserProfileRepository } from '../../repositories/user-profile-repository'
import { AgentPersonalityRepository } from '../../repositories/agent-personality-repository'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type { CapabilityRuntimeSnapshot } from '../../../../shared/ai-capability-runtime'
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
  filterCurrentScopeRunSummaries,
  listCurrentProjectionBackedChildRunSummaries,
  type ActiveChildRunSummaryForRuntime,
  type UpsertChannelPayload,
} from './runtime-helpers'
import { resolveTrustedBrowserEnvironment } from './trusted-browser-environment'
import type { CodexRuntimeComposition } from '../codex-runtime/codex-runtime-composition'
import {
  preparedCodexProductRunMatchesIngress,
  type PreparedCodexProductRun,
} from '../codex-runtime/codex-product-run-preparer'
import { TERMINAL_ERROR_KINDS } from '../../../../shared/ipc-contracts/agent-runtime'
import type {
  LifecycleRequest,
  ProductLifecycleRequest,
  StopLifecycleRequest,
  SendScopedRequest,
  SendScopedResponse,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { LifecycleOperationProjection } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import {
  settleScopeContextCloseLifecycleResult,
  settleScopeContextResetLifecycleResult,
  type ScopeContextResetCommitDeps,
} from './scope-context-reset'
import { getInteractionLifecycleRegistry } from './interaction-lifecycle-registry'

export type { UpsertChannelPayload } from './runtime-helpers'

export class AgentControlRuntime extends EventEmitter {
  private readonly db = getDatabase()
  private readonly agentSessionCheckpoints: AgentSessionCheckpointRepository
  private readonly browserController: BrowserController | null
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
  private readonly taskEventProofSubscription = new TaskEventProofSubscription()
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
    // P1 (2026-07-03, 7/01 reliability contract D) — active browser tab URL
    // so site cards match the current domain mid-run, not only user text.
    getActiveBrowserUrl: () => this.orchestrator.getActiveBrowserUrl(),
    enableDatabaseMemory: true
  })
  private readonly agentManager: AgentManager
  private readonly runCoordinator: RunCoordinator
  private readonly runProjection: RunProjection
  private readonly taskProjectionStore = new TaskProjectionRepository(this.db)
  // B8-D R1 — projection-sync and detached-skill clusters live in delegated
  // sub-services; the runtime keeps one-line public delegates.
  private readonly projectionSync: ProjectionSyncCoordinator
  // B8-D R2 — session-recall/reference-hint clusters live in delegated
  // sub-services; same one-line-delegate pattern as R1.
  private readonly referenceHints = new ReferenceHintService({
    db: this.db,
    mapConversationRow: (row) => this.mapConversationRow(row),
  })
  private readonly sessionRecall = new SessionRecallFacade({
    sessionRecallService: this.sessionRecallService,
    mapConversationRow: (row) => this.mapConversationRow(row),
    emitConversationEvent: (payload) => this.emitConversationEvent(payload),
    extractTextFromMessage: (message) => this.extractTextFromMessage(message),
    armReferenceHintFromCapsules: (scopeId, messageVisibilityEpoch, capsules) =>
      this.referenceHints.maybeArmReferenceHintFromCapsules(
        scopeId,
        messageVisibilityEpoch,
        capsules,
      ),
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
    persistReferenceHintToScope: (scopeId, expectedMessageVisibilityEpoch) =>
      this.referenceHints.persistReferenceHintToScope(
        scopeId,
        expectedMessageVisibilityEpoch,
      ),
    resolveConversationAgentId: (requestedAgentId) =>
      resolveConversationAgentId(requestedAgentId, this.agentRegistry).effectiveAgentId,
    readAliasGeneration: (aliasId) =>
      this.codexRuntime.aliasBindingPort.readAliasGeneration(aliasId),
    readLatestAliasGeneration: (aliasId) =>
      this.codexRuntime.aliasBindingPort.readLatestAliasGeneration(aliasId),
  })
  // B8-D R5 — the remote-channel / inbound-IM cluster lives in a delegated
  // sub-service; same one-line-delegate pattern as R1–R4. Declared AFTER
  // `conversationScopes` so the store-backed callbacks close over an
  // initialized field. Every function dep is a lazy closure, so the
  // constructor-assigned `projectionSync` hub and lifecycle methods are safe
  // to reference here. The runtime keeps one-line
  // delegates for `handleInboundChannel` / `getScopedRemoteThreadKey` /
  // `getRemoteChannelSessionSettingKey` (the R4 SidecarPollService /
  // ConversationScopeStore injection closures bind those runtime methods and
  // re-bind through this service automatically).
  private readonly remoteChannel = new RemoteChannelService({
    db: this.db,
    sidecar: this.sidecar,
    settingsRepository: this.settingsRepository,
    getRuntimeStatus: () => this.getRuntimeStatus(),
    emitConversationEvent: (payload) => this.projectionSync.emitConversationEvent(payload),
    recordChannelDeliveryResult: (channelId, result) =>
      this.channelConfig.recordChannelDeliveryResult(channelId, result),
    ensureChannelScope: (channelId, remoteThread, agent, sender) =>
      this.conversationScopes.ensureChannelScope(channelId, remoteThread, agent, sender),
    createConversationMessage: (scopeId, payload, expectedMessageVisibilityEpoch) =>
      this.conversationScopes.createConversationMessage(
        scopeId,
        payload,
        expectedMessageVisibilityEpoch,
      ),
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
        aliasId: prepared.conversationAlias.aliasId,
        requestId,
        runId: prepared.runId,
      }),
      onRunSettled: ({ requestId, prepared, scope }) => this.orchestrator.finishActiveProductRun({
        agent: scope.agent,
        scopeId: scope.id,
        requestId,
        runId: prepared.runId,
      }),
    })
    this.runProjection = new RunProjection({
      getScope: (scopeId) => this.getConversationScope(scopeId),
      getPrevious: (scopeId) => this.scopeRunSummaries.get(scopeId),
      setSummary: (scopeId, summary) => {
        if (!this.db.updateConversationRecallTaskState(
          scopeId,
          summary.taskTitle,
          summary.taskSummary,
          summary.messageVisibilityEpoch,
        )) {
          this.scopeRunSummaries.delete(scopeId)
          return false
        }
        this.scopeRunSummaries.set(scopeId, summary)
        return true
      },
      toChannelKey: (scope) => this.toChannelKey(scope)
    })
    this.projectionSync = new ProjectionSyncCoordinator({
      db: this.db,
      taskProjectionStore: this.taskProjectionStore,
      runProjection: this.runProjection,
      readAliasGeneration: (aliasId) =>
        this.codexRuntime.aliasBindingPort.readAliasGeneration(aliasId),
      readActiveProductRunVisibilityIdentity: (readyRunId) =>
        this.codexRuntime.aliasBindingPort.readActiveProductRunVisibilityIdentity(readyRunId),
      readCommittedProductRunVisibilityIdentity: (readyRunId) =>
        this.codexRuntime.aliasBindingPort.readCommittedProductRunVisibilityIdentity(readyRunId),
      emit: (event, payload) => {
        this.emit(event, payload)
      },
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
    this.codexRuntime.bindHost({
      runtime: this,
      browserController: this.browserController,
      sidecarManager: this.sidecar,
      getScope: (scopeId) => this.getConversationScope(scopeId),
      createLocalScope: (agent, id) => this.createLocalScope(agent, id),
      getTaskProjectionStore: () => this.taskProjectionStore,
      createCodexActiveRunMetaInOpenTransaction: (input) => {
        const repository = this.getRunMetaRepository()
        if (!repository) throw new Error('codex_run_meta_repository_unavailable')
        repository.create({ ...input, status: 'running', initiator: null })
      },
      createInitialExecutionBinding: async ({ runId, ownerAgentIdAtStart }) => (
        createCodexHostExecutionBinding({ runId, ownerAgentIdAtStart })
      ),
      resolveSkillAuthorizationForTurn: (input) =>
        this.orchestrator.resolveSkillAuthorizationForTurn(input),
      resolveSelectedSkillMethodology: (skillId) => resolveCodexSelectedSkillMethodology({
        skillId,
        skills: getSkillsRuntimeManager().listSkills(),
      }),
      resolveNativeSkillInput: ({ skillId, path }) => resolveCodexNativeSkillInput({
        skillId,
        path,
        skills: getSkillsRuntimeManager().listSkills(),
      }),
      resolveToolTurnSnapshot: (input) => {
        const source = new AgentSdkToolExecutor({
          executeToolCall: executeReadyToolCall,
          sessionManager: new AgentSdkSessionManager(),
          browserController: this.browserController,
          sidecarManager: this.sidecar,
          runtime: this,
          runCleanupRegistry: null,
          async compactCapturedSession() {
            throw new Error('codex_native_compaction_owned_by_sidecar')
          },
          async resolveMapPlaceAmbiguityIfNeeded() { return false },
        })
        return resolveReadyToolTurnSnapshot({
          surfaceId: input.surfaceId,
          authorizationId: input.authorizationId,
          authorization: input.authorization,
          source,
          frozenToolSurface: input.frozenToolSurface,
          resolutionInput: {
            message: input.message,
            sessionId: input.sessionId,
            scopeId: input.scopeId,
            config: input.config,
            browserHostAvailable: Boolean(this.browserController),
            feishuConnected: this.sidecar.isRunning() && this.listChannels().some(
              (channel) => channel.enabled && channel.type === 'feishu-app',
            ),
            channelScopeBound: this.isScopeChannelBound(input.scopeId),
            authorization: input.authorization,
            skillSurfaceComposition: resolveSkillSurfaceComposition(input.authorization, input.scopeId).composition,
            requestEnvelope: input.requestEnvelope,
            skillCatalogAvailable: getSkillsRuntimeManager().listSkills().length > 0,
          },
        })
      },
      resolveExternalReadSlice: async (request) => {
        if (request.kind === 'feishu_typed_read') {
          const sidecarRunning = this.sidecar.isRunning()
          const listed = sidecarRunning ? await this.sidecar.listChannels() : { channels: [] }
          const channels = Array.isArray(listed.channels) ? listed.channels : []
          const channel = channels.find((candidate) => candidate
            && typeof candidate === 'object'
            && !Array.isArray(candidate)
            && (candidate as Record<string, unknown>).id === request.channelId)
          return prepareFeishuExternalReadSlice({
            request,
            sidecarRunning,
            channelIdentityDigest: channel ? digestFeishuChannelSnapshot(channel) : null,
          })
        }
        const skills = getSkillsRuntimeManager().listSkills()
        const selected = skills.find((skill) => skill.id === 'lark-doc' && skill.installed)
        const skillRoot = selected?.managedPath || selected?.sourcePath || ''
        if (!skillRoot || !existsSync(join(skillRoot, 'SKILL.md'))
          || !existsSync(join(skillRoot, 'references', 'lark-doc-fetch.md'))) {
          throw new Error('codex_external_read_lark_resources_unavailable')
        }
        const siblingReadRoots = resolveDeclaredSiblingSkillReadRoots({
          selectedSkillId: 'lark-doc',
          skills,
        }).filter((root) => existsSync(join(root, 'SKILL.md')))
        const program = process.platform === 'darwin'
          ? '/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli'
          : 'lark-cli'
        const executableAuthority = await resolveFrozenDesktopExecutableAuthority({
          program,
          directPayloadRequired: true,
        })
        const authReadback = await readLarkCliAuthReadback({ executableAuthority })
        return prepareLarkExternalReadSlice({
          request,
          skillRoot,
          siblingReadRoots,
          executableAuthority,
          authReadback,
        })
      },
      commitCanonicalCoreCloseout: (input) => this.commitCanonicalCoreCloseout(input),
      commitCodexFailureCoreCloseout: (input) => (
        commitCodexFailureCoreCloseoutAndReconcileClaims(this.agentSessionCheckpoints, input)
      ),
      getActiveRunAbortSignal: (input) => this.orchestrator.getActiveRunAbortSignal(input),
      abortActiveProductRun: (input) => this.orchestrator.abortActiveProductRun(input),
      restoreActiveProductRun: (input) => {
        const scope = this.getConversationScope(input.readyScopeId)
        if (!scope || scope.id !== input.readyAliasId) {
          throw new Error('codex_recovered_product_scope_mismatch')
        }
        this.orchestrator.beginActiveProductRun({
          agent: scope.agent,
          scopeId: scope.id,
          aliasId: input.readyAliasId,
          requestId: input.requestId,
          runId: input.readyRunId,
        })
      },
      finishActiveProductRun: (input) => {
        const scope = this.getConversationScope(input.readyScopeId)
        if (!scope || scope.id !== input.readyAliasId) return
        this.orchestrator.finishActiveProductRun({
          agent: scope.agent,
          scopeId: scope.id,
          requestId: input.requestId,
          runId: input.readyRunId,
        })
      },
      publishCommittedTerminalEvent: (event) => {
        this.projectionSync.publishCommittedScopeRunEvent(event)
      },
      publishActivityProjection: (event) => {
        this.projectionSync.publishScopeRunEvent(event)
      },
      emitProvisionalDelta: (input) => {
        this.projectionSync.emitScopeRunEvent({
          type: 'updated',
          scopeId: input.scopeId,
          aliasGeneration: input.aliasGeneration,
          messageVisibilityEpoch: input.messageVisibilityEpoch,
          visibilityOwnerKind: 'product_alias',
          agent: input.agent,
          ownerAgentId: input.ownerAgentId,
          taskOrigin: 'user_root',
          handoffGeneration: input.handoffGeneration,
          runId: input.runId,
          taskId: input.taskId,
          phase: 'responding',
          latestText: input.delta,
          taskProjectionId: input.taskId,
          timestamp: new Date().toISOString(),
        })
      },
    })
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
    reconcileReleasedBrowserClaims(input.ownerRunId)
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
   * interval math stays honest. Requires a live belief store. Never throws
   * into the scheduler (round logs its own
   * maintenance_audit; unexpected errors are swallowed by the scheduler).
   */
  async runCrystallizeRoundOnce(forced: boolean): Promise<void> {
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
  }

  private getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.orchestrator.getDomainAdapters()
  }

  private registerTaskEventProofSink(): void {
    this.taskEventProofSubscription.start(this.taskProjectionStore)
  }

  private unregisterTaskEventProofSink(): void {
    this.taskEventProofSubscription.stop()
  }

  getExternalMemoryProviderSlot(): ExternalMemoryProviderSlot {
    return this.externalMemoryProviderSlot
  }

  async start(): Promise<void> {
    try {
      await this.codexRuntime.start()
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : ''
      logAgentMetric('codex_runtime_start_degraded', {
        reason: /^[a-z0-9_:-]{1,96}$/i.test(code) ? code : 'codex_runtime_start_failed',
      })
    }
    this.cleanupLegacyCopawSettings()
    this.detachedSkills.publishRestoredDetachedSkillTasks()

    // Start memory lifecycle manager
    this.memoryLifecycle.start()
    // P2-1 — deterministic crystallize round on the same 6h rhythm + a startup
    // pass (deferred 90s so it trails first-run belief sync / seeding above the
    // memory lifecycle's own 60s initial tick).
    this.crystallizeScheduler.start({ startupDelayMs: 90_000 })

    // EP2-Q3 — additive bridge listener: terminal task events become
    // task_event proofs on the owning projection (bridge itself untouched).
    this.registerTaskEventProofSink()
    this.projectionSync.scheduleTerminalProjectionSyncRetryDrain('startup')
    // Local archive mirror: startup full sync + hand-edit watcher. Files are
    // never written here — file → DB only.
    try {
      const rawDb = this.db.getRawDb?.()
      if (rawDb) {
        // Identity asset reconciliation (064 reserved-slug reassign → move agents/<old> to
        // agents/<new>) must run regardless of the knowledge toggle: the DB id already
        // changed in the migration, so the on-disk asset dir has to follow.
        // Idempotent via agent_identity_migration.asset_reconciled_at.
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
        runStartupBeliefSync(rawDb as never, this.getBeliefCardStore())
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
    this.unregisterTaskEventProofSink()
    this.codexRuntime.sealIngress('runtime_stop')
    this.browserController?.setBrowserWorkflowWriteAdmissionPort(null)
    this.browserController?.setBrowserWorkflowJournalUnitOfWork(null)
    for (const session of this.orchestrator.listAllSessions()) {
      if (!session.sessionId) continue
      this.orchestrator.abortActiveProductRunByAlias(session.sessionId)
    }
    await this.codexRuntime.stop()

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

  readCodexLifecycleSnapshot(request: LifecycleRequest): LifecycleOperationProjection {
    return this.codexRuntime.aliasBindingPort.readLifecycleSnapshot(request)
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
    return filterCurrentScopeRunSummaries(
      this.scopeRunSummaries.values(),
      (scopeId) => this.getConversationScope(scopeId),
    )
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

  readActiveRunMessageVisibilityEpoch(runId: string, scopeId: string): number | null {
    const record = this.getRunMetaRepository()?.get(runId)
    if (
      record?.scopeId !== scopeId
      || record.status !== 'running'
      || !Number.isSafeInteger(record.messageVisibilityEpoch)
    ) {
      return null
    }
    return record.messageVisibilityEpoch
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

  /**
   * 梯队三 emergence feed — 跨 scope 最近任务投影（resume/follow_up 卡信号源）。
   * 只读，不做 reconcile（feed 是提示面，不是裁决面）。
   */
  listRecentTaskProjections(limit = 50): TaskProjectionRecord[] {
    return this.taskProjectionStore.listRecentTasks(limit) as TaskProjectionRecord[]
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
      const current = row.scopeId ? this.getConversationScope(row.scopeId) : null
      if (row.scopeId
        ? !current || row.messageVisibilityEpoch !== current.messageVisibilityEpoch
        : row.messageVisibilityEpoch !== -1) continue
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
    return listCurrentProjectionBackedChildRunSummaries(this.db.getRawDb())
  }

  async cancelChildRun(childRunId: string, options: { source: 'ui_button' }): Promise<unknown> {
    return cancelSkillChildRun(childRunId, options)
  }

  attachSessionRecallContext(
    currentScopeId: string,
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
  ): { scope: ConversationScope; capsule: SessionRecallCapsule } {
    return this.sessionRecall.attachSessionRecallContext(
      currentScopeId,
      conversationId,
      expectedMessageVisibilityEpoch,
    )
  }

  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
  ): { scope: ConversationScope } {
    return this.sessionRecall.detachSessionRecallContext(
      currentScopeId,
      conversationId,
      expectedMessageVisibilityEpoch,
    )
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

  setActionAuthorizationMode(
    scopeId: string,
    mode: import('../../../../shared/action-authorization-mode').ActionAuthorizationMode,
    expectedMessageVisibilityEpoch: number,
  ): ConversationScope {
    return this.conversationScopes.setActionAuthorizationMode(
      scopeId,
      mode,
      expectedMessageVisibilityEpoch,
    )
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

  createCodexSession(request: import('../../../../shared/ipc-contracts/agent-runtime').CreateSessionRequest) {
    return this.codexRuntime.lifecycleAdapter.createSession(request)
  }

  async resetCodexSession(request: ProductLifecycleRequest) {
    const result = await this.codexRuntime.lifecycleAdapter.resetSession(request)
    return settleScopeContextResetLifecycleResult({
      requestAliasId: request.aliasId,
      result,
      readScope: (aliasId) => this.getConversationScope(aliasId),
      deps: this.scopeContextCleanupDeps(result.aliasId, 'reset'),
    })
  }

  private scopeContextCleanupDeps(
    scopeIdForReport: string,
    lifecycleAction: 'reset' | 'close',
  ): ScopeContextResetCommitDeps {
    return {
      resetExecutionContext: (scopeId, agents) => this.orchestrator.resetScopeContext(scopeId, agents),
      discardPendingRemoteInbound: (scopeId) => {
        this.remoteChannel.discardScopeContext(scopeId)
      },
      closeBrowserTargetClaims: (scopeId) => {
        getBrowserTargetClaimService().closeScopeContext(scopeId)
      },
      clearActiveSkillContext,
      forgetContinuity: forgetSession,
      clearAuthorizationFacts: clearAuthorizationFactsForScope,
      clearNegations: clearNegationsForScope,
      clearLarkAuthFlows: clearLarkCliAuthFlowsForSession,
      clearReferenceHint: clearLastReferenceSkill,
      clearSkillProjection: clearSkillTaskProjection,
      cancelInteractionLifecycle: (scopeId) => {
        getInteractionLifecycleRegistry().cancelScope(scopeId)
      },
      rejectEphemeralInteractions: (scopeId, error) => {
        getEphemeralExecutionStore().rejectBySession(scopeId, error)
      },
      rejectAskUserInteractions: (scopeId, error) => {
        getAskUserQuestionsStore().rejectBySession(scopeId, error)
      },
      sweepPendingAskUserCards: (scopeId) => {
        const reason = lifecycleAction === 'reset' ? 'session_reset' : 'session_close'
        const swept = this.db.sweepPendingAskUserQuestionsCardsBySession(scopeId, reason)
        if (swept > 0) logAgentMetric('ask_user_questions_scope_context_swept_db', {
          scopeId,
          lifecycleAction,
          swept,
        })
      },
      clearSessionSnapshot: clearScopeSessionSnapshot,
      clearRunSummary: (scopeId) => {
        this.scopeRunSummaries.delete(scopeId)
      },
      reportCleanupFailure: (step, error) => {
        logAgentMetric('scope_context_cleanup_failed', {
          scopeId: scopeIdForReport,
          lifecycleAction,
          step,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    }
  }

  stopCodexSession(request: StopLifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.stopSession(request)
  }

  async closeCodexSession(request: ProductLifecycleRequest) {
    const closingScope = this.getConversationScope(request.aliasId)
    const result = await this.codexRuntime.lifecycleAdapter.closeSession(request)
    if (!result.ok || result.action !== 'close') return result
    const closeIdentity = closingScope?.id === result.aliasId
      ? {
          scopeId: closingScope.id,
          agents: [closingScope.agent, closingScope.activeAgentId],
        }
      : {
          scopeId: result.aliasId,
          agents: [],
        }
    return settleScopeContextCloseLifecycleResult({
      requestAliasId: request.aliasId,
      result,
      readClosedScopeIdentity: () => closeIdentity,
      deps: this.scopeContextCleanupDeps(result.aliasId, 'close'),
    })
  }

  compactCodexSession(request: LifecycleRequest) {
    return this.codexRuntime.lifecycleAdapter.compactSession(request)
  }

  async resolveTrustedRequestEnvironment(
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
    try {
      await this.codexRuntime.ensureReadyForUserIngress()
    } catch (error) {
      return createRejectedBeforePersistence({
        scope: 'pre-existing',
        code: 'host_unavailable',
        retryableByUser: true,
        error: error instanceof Error ? error.message : 'sidecar_recovery_exhausted',
        admissionEvidenceDigest: `runtime_retry_failed:${payload.scopeId}:${payload.requestId}`,
      })
    }
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
