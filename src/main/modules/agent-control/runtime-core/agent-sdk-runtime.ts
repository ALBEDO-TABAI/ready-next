import { EventEmitter } from 'events'
import {
  MemorySession, type AgentInputItem
} from '@openai/agents'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type {
  ExecutionTurnResult, RunMessage, TaskProjectionRecord
} from '../contracts/run-contracts'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose,
} from '../skills/skill-child-runner'
import type { MultimodalBlock } from '../contracts/run-contracts'
import {
  readAIConfigDetailed,
  type AIConfigLoad,
} from '../../claude-bridge/direct-chat-ai-config'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import {
  DEFAULT_CONTEXT_WINDOW
} from '../../../../shared/context-budget-types'
import { logAgentMetric } from '../metrics'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { resolveCurrentLegalAuthorizationForSavedSkill } from '../skills/prepared-skill-turn'
import { getSkillActionOwnersForTrustedResume } from '../../tools/skills-tools'
import { type FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import { wrapRunMetaRepositoryWithCloseoutSnapshot } from '../task-projection/run-meta-snapshot'
import { resolveSkillShellAllowed, isEmbeddedSkill, getSkillShellConsent } from '../../skills-runtime/skill-shell-consent'
import { executeToolCall as executeReadyToolCall } from '../../tools'
import {
  normalizeToolExecutionOutput,
  type ToolExecutionOutput
} from '../tools-runtime/tool-result-types'
import { createRotatingLogger } from '../../../utils/rotating-logger'
import {
  clearScopeSessionSnapshot,
} from '../session/scope-session-snapshot'

// ─── V3 Phase 1: extracted helpers (split into sibling modules) ───
import type {
  AgentSdkExecutionOptions, AgentSdkRuntimeDeps, CompactReason,
  CompactSessionResult, ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle,
  RunMetaRepositoryLike, SkillContextOrchestratorLike,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import {
  allowedPrimitiveToolsForSdkSkillTurn, defaultFetchWithTimeout,
  defaultSystemPrompt, errorMessage,
  resolveExplicitReferenceSkillExecutableSurface, readStructuredResultRecord,
  readTextField, resolveManifestBoundSkillTools, resolveToolFailurePageUrl, skillAuthorizationTextCandidates
} from './agent-sdk-utils'
import {
  log, runWithOpenAIAgentsSdk
} from './agent-sdk-provider'
import { AgentSdkIntentTracker } from './agent-sdk-intent-tracker'
import { AgentSdkCompactor } from './agent-sdk-compactor'
import { AgentSdkRunLifecycle, createInitiatorAbort } from './agent-sdk-run-lifecycle'
import { AgentSdkToolExecutor } from './agent-sdk-tool-executor'
import { AgentSdkTurnOrchestrator } from './agent-sdk-turn-orchestrator'
import { updateActiveToolUseMode } from './tool-use-mode-config-update'
import { DynamicDeliveryCoordinator } from './dynamic-delivery/dynamic-delivery-coordinator'
import { DynamicDeliveryTaskStore } from './dynamic-delivery/dynamic-delivery-task-store'
import { AgentSdkSessionManager } from './agent-sdk-session'
import { resolveSemanticSkillAuthorizationForTurn } from './skill-turn-authorization-resolver'


const agentSdkLogger = createRotatingLogger('ready-agent-sdk.log')
const settingsRepository = new AppSettingsRepository()

interface MapCandidateChoice {
  option: string
  candidate: {
    name: string
    location: string
    address?: string
    city?: string
    district?: string
  }
}

interface MapPlaceAmbiguityPrompt {
  source: ToolBridgeResultItem
  message: string
  field: { kind: 'origin' | 'destination' | 'waypoint'; index?: number } | null
  choices: MapCandidateChoice[]
  askArgs: {
    questions: Array<{
      id: string
      question: string
      kind: 'single_choice'
      options: string[]
      required: true
    }>
  }
}

const MAP_PLACE_AMBIGUITY_QUESTION_ID = 'map_place_choice'

function truncateForQuestionOption(value: string, maxLength: number): string {
  const text = value.trim()
  if (text.length <= maxLength) return text
  if (maxLength <= 3) return text.slice(0, maxLength)
  return `${text.slice(0, maxLength - 3).trimEnd()}...`
}

function normalizeMapCandidate(value: unknown): MapCandidateChoice['candidate'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const location = readTextField(record, 'location')
  if (!location) return null
  const name = readTextField(record, 'name')
    || readTextField(record, 'address')
    || location
  return {
    name,
    location,
    address: readTextField(record, 'address') || undefined,
    city: readTextField(record, 'city') || undefined,
    district: readTextField(record, 'district') || undefined,
  }
}

function formatMapCandidateOption(candidate: MapCandidateChoice['candidate'], index: number): string {
  const locationSuffix = ` | ${candidate.location}`
  const parts = [
    `${index + 1}. ${candidate.name}`,
    candidate.district || candidate.city || '',
    candidate.address && candidate.address !== candidate.name ? candidate.address : '',
  ].filter((part, partIndex, arr) => part && arr.indexOf(part) === partIndex)
  const prefix = parts.join(' | ')
  const prefixLimit = Math.max(1, 80 - locationSuffix.length)
  return `${truncateForQuestionOption(prefix, prefixLimit)}${locationSuffix}`.slice(0, 80)
}

function inferAmbiguousMapField(message: string): MapPlaceAmbiguityPrompt['field'] {
  const normalized = message.trim()
  if (normalized.startsWith('起点')) return { kind: 'origin' }
  if (normalized.startsWith('终点')) return { kind: 'destination' }
  const waypointMatch = normalized.match(/^途经点\s*(\d+)/)
  if (waypointMatch) {
    const index = Number(waypointMatch[1])
    if (Number.isInteger(index) && index > 0) return { kind: 'waypoint', index: index - 1 }
  }
  return null
}

function findMapPlaceAmbiguityPrompt(
  results: ToolBridgeResultItem[],
): MapPlaceAmbiguityPrompt | null {
  for (const item of results) {
    if (item.name !== 'map_plan_route') continue
    const normalized = normalizeToolExecutionOutput(item.result)
    const data = readStructuredResultRecord(normalized)
    if (data.ok !== false || data.errorKind !== 'place_ambiguous') continue
    const message = readTextField(data, 'message') || normalized.text || '地点存在多个可能结果，请选择一个。'
    const rawCandidates = Array.isArray(data.candidates) ? data.candidates : []
    const seenOptions = new Set<string>()
    const choices: MapCandidateChoice[] = []
    for (const raw of rawCandidates) {
      const candidate = normalizeMapCandidate(raw)
      if (!candidate) continue
      const baseOption = formatMapCandidateOption(candidate, choices.length)
      let option = baseOption
      let suffix = 2
      while (seenOptions.has(option)) {
        option = truncateForQuestionOption(`${baseOption} #${suffix}`, 80)
        suffix += 1
      }
      seenOptions.add(option)
      choices.push({ option, candidate })
      if (choices.length >= 8) break
    }
    if (choices.length < 2) return null
    return {
      source: item,
      message,
      field: inferAmbiguousMapField(message),
      choices,
      askArgs: {
        questions: [{
          id: MAP_PLACE_AMBIGUITY_QUESTION_ID,
          question: truncateForQuestionOption(`${message}\n请选择要用于路线规划的具体地点。`, 500),
          kind: 'single_choice',
          options: choices.map((choice) => choice.option),
          required: true,
        }],
      },
    }
  }
  return null
}

function readMapAmbiguityAnswer(output: ToolExecutionOutput): string | null {
  const data = readStructuredResultRecord(output)
  const answers = Array.isArray(data.answers) ? data.answers : []
  for (const raw of answers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const answer = raw as Record<string, unknown>
    if (answer.id !== MAP_PLACE_AMBIGUITY_QUESTION_ID) continue
    return typeof answer.answer === 'string' && answer.answer.trim()
      ? answer.answer.trim()
      : null
  }
  return null
}

function buildMapRetryArgs(
  originalArgs: Record<string, unknown>,
  field: MapPlaceAmbiguityPrompt['field'],
  candidate: MapCandidateChoice['candidate'],
): Record<string, unknown> | null {
  if (!field) return null
  const place = { name: candidate.name, location: candidate.location }
  if (field.kind === 'origin') {
    return { ...originalArgs, origin: place }
  }
  if (field.kind === 'destination') {
    return { ...originalArgs, destination: place }
  }
  const waypoints = Array.isArray(originalArgs.waypoints) ? [...originalArgs.waypoints] : []
  if (typeof field.index !== 'number' || field.index < 0 || field.index >= waypoints.length) return null
  waypoints[field.index] = place
  return { ...originalArgs, waypoints }
}

export class AgentSdkRuntime extends EventEmitter {
  /** Session storage + lock primitive (V3 Phase 2). Lifecycle ops stay in this class. */
  private readonly sessionManager = new AgentSdkSessionManager()
  private readonly domainAdapters: ReadonlyArray<DomainAdapter>
  private readonly loadAIConfig: () => AIConfigLoad
  private readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  private readonly setActiveToolUseMode: NonNullable<AgentSdkRuntimeDeps['setActiveToolUseMode']>
  private readonly listToolDefinitionsForTurn: NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>
  private readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  private readonly fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  private readonly skillContextOrchestrator: SkillContextOrchestratorLike | null
  private readonly resumeSkillChildRun: typeof defaultResumeSkillChildRun
  private readonly waitForSkillChildRunClose: typeof defaultWaitForSkillChildRunClose
  private browserController: BrowserController | null = null
  private sidecarManager: SidecarManager | null = null
  private runtime: AgentControlRuntime | null = null
  private runCleanupRegistry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null = null
  private cancelPendingToolActions: ((agent: string, sessionId?: string) => void) | null = null
  /** EP2-I1 — null = facts unavailable (legacy callers keep S4-1 behavior). */
  private readonly getScopeTaskRefs: ((scopeId: string) => FollowupTaskRef[]) | null
  private readonly dynamicDelivery: DynamicDeliveryCoordinator

  constructor(deps: AgentSdkRuntimeDeps = {}) {
    super()
    this.domainAdapters = deps.domainAdapters || []
    this.loadAIConfig = deps.loadAIConfig || (() => {
      const detail = readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config'))
      if (!detail.ok) return detail
      try {
        return {
          ...detail,
          activeProfileId: settingsRepository.getActiveAIProfileId(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logAgentMetric('ai_config_db_error', { message: message.slice(0, 200) })
        return { ok: false, reason: 'db_error', message }
      }
    })
    this.runAgent = deps.runAgent || runWithOpenAIAgentsSdk
    this.setActiveToolUseMode = deps.setActiveToolUseMode || ((request) =>
      updateActiveToolUseMode(settingsRepository, request))
    this.executeToolCall = deps.executeToolCall || executeReadyToolCall
    this.fetchWithTimeout = deps.fetchWithTimeout || defaultFetchWithTimeout
    this.skillContextOrchestrator = deps.skillContextOrchestrator || null
    this.resumeSkillChildRun = deps.resumeSkillChildRun || defaultResumeSkillChildRun
    this.waitForSkillChildRunClose = deps.waitForSkillChildRunClose || defaultWaitForSkillChildRunClose
    this.getScopeTaskRefs = deps.getScopeTaskRefs || null
    this.listToolDefinitionsForTurn = deps.listToolDefinitions || ((params) =>
      this.toolExecutor.listDefaultToolDefinitionsForTurn(params))
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- adapter getters must retain the runtime instance receiver
    const self = this
    this.dynamicDelivery = new DynamicDeliveryCoordinator({
      getProjection: (taskId) => {
        const runtime = self.runtime as (AgentControlRuntime & {
          getTaskProjection?: (id: string) => TaskProjectionRecord | null
        }) | null
        return typeof runtime?.getTaskProjection === 'function'
          ? runtime.getTaskProjection(taskId)
          : null
      },
      updateProjection: (taskId, patch) => {
        const store = self.runtime?.getTaskProjectionStore()
        if (!store) throw new Error('[dynamic-delivery] task projection store unavailable')
        store.update(taskId, patch, { reasonHint: 'update' })
      },
      taskStore: () => {
        const store = self.runtime?.getTaskProjectionStore()
        if (!store) throw new Error('[dynamic-delivery] task projection store unavailable')
        return new DynamicDeliveryTaskStore(store)
      },
      listProfiles: () => {
        const runtime = self.runtime as (AgentControlRuntime & {
          listAgentProfileSummaries?: () => Array<{ agentId: string; name: string; collaborationReady: boolean }>
        }) | null
        return typeof runtime?.listAgentProfileSummaries === 'function'
          ? runtime.listAgentProfileSummaries()
          : []
      },
      resolveProfile: (agentId) => {
        if (!self.runtime) throw new Error('[dynamic-delivery] runtime unavailable')
        return self.runtime.resolveAgentExecutionProfile(agentId)
      },
      createRegisteredBinding: (input) => {
        if (!self.runtime) throw new Error('[dynamic-delivery] runtime unavailable')
        return self.runtime.createWorkflowParticipantBinding(input)
      },
    }, this.runAgent)
    this.runLifecycle = new AgentSdkRunLifecycle({
      sessionManager: this.sessionManager,
      compactor: this.compactor,
      get cancelPendingToolActions() {
        return self.cancelPendingToolActions
      },
    })
    this.toolExecutor = new AgentSdkToolExecutor({
      executeToolCall: this.executeToolCall,
      sessionManager: this.sessionManager,
      get browserController() { return self.browserController },
      get sidecarManager() { return self.sidecarManager },
      get runtime() { return self.runtime },
      get runCleanupRegistry() { return self.runCleanupRegistry },
      compactCapturedSession: (name, runHandle, baseItems, reason, windowTokens) =>
        self.compactCapturedSession(name, runHandle, baseItems, reason, windowTokens),
      resolveMapPlaceAmbiguityIfNeeded: (params) =>
        self.resolveMapPlaceAmbiguityIfNeeded(params),
    })
    this.turnOrchestrator = new AgentSdkTurnOrchestrator({
      executeToolCall: this.executeToolCall,
      fetchWithTimeout: this.fetchWithTimeout,
      getScopeTaskRefs: this.getScopeTaskRefs,
      intentTracker: this.intentTracker,
      listToolDefinitionsForTurn: this.listToolDefinitionsForTurn,
      loadAIConfig: this.loadAIConfig,
      resumeSkillChildRun: this.resumeSkillChildRun,
      runAgent: this.runAgent,
      setActiveToolUseMode: this.setActiveToolUseMode,
      dispatchToolConsentRetry: deps.dispatchToolConsentRetry || (() => (
        Promise.reject(new Error('ready_agent_sdk_tool_consent_retry_retired'))
      )),
      dynamicDelivery: this.dynamicDelivery,
      runLifecycle: this.runLifecycle,
      get runtime() { return self.runtime },
      sessionManager: this.sessionManager,
      skillContextOrchestrator: this.skillContextOrchestrator,
      toolExecutor: this.toolExecutor,
      waitForSkillChildRunClose: this.waitForSkillChildRunClose,
      compactCapturedSession: (name, runHandle, baseItems, reason, windowTokens) =>
        self.compactCapturedSession(name, runHandle, baseItems, reason, windowTokens),
      getRunMetaRepositoryForFinalize: () => self.getRunMetaRepositoryForFinalize(),
      hasBrowserController: () => self.hasBrowserController(),
      readVerifiedBrowserWorkflowEvidence: (browserTaskId) =>
        self.browserController?.readVerifiedBrowserWorkflowEvidence(browserTaskId) ?? null,
      hasPendingTaskProjection: (scopeId) => self.hasPendingTaskProjection(scopeId),
      newSession: (name, systemPrompt) => self.newSession(name, systemPrompt),
      resolveMapPlaceAmbiguityIfNeeded: (params) => self.resolveMapPlaceAmbiguityIfNeeded(params),
      resolveSkillAuthorizationForTurn: (message, sessionId, messageVisibilityEpoch, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn) =>
        self.resolveSkillAuthorizationForTurn(message, sessionId, messageVisibilityEpoch, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn),
      resolvePreparedSkillTurnForTurn: (message, sessionId, messageVisibilityEpoch, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn) =>
        self.resolvePreparedSkillTurnForTurn(message, sessionId, messageVisibilityEpoch, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn),
      resolveSavedSkillAuthorizationForResume: (saved) =>
        self.resolveSavedSkillAuthorizationForResume(saved),
      emit: (event, ...args) => self.emit(event, ...args),
    })
  }

  async sendMessage(
    name: string,
    content: string | MultimodalBlock[],
    requestId?: string,
    executionOptions?: AgentSdkExecutionOptions,
  ): Promise<ExecutionTurnResult> {
    return this.turnOrchestrator.sendMessage(name, content, requestId, executionOptions)
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.toolExecutor.setRendererToolActionRequester(requester)
  }

  setRunCleanupRegistry(registry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null): void {
    this.runCleanupRegistry = registry
  }

  setBrowserController(controller: BrowserController): void {
    this.browserController = controller
  }

  hasBrowserController(): boolean {
    return Boolean(this.browserController)
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapters
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sidecarManager = manager
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.runtime = runtime
  }

  private getRunMetaRepositoryForFinalize(): RunMetaRepositoryLike | null {
    try {
      const repository = (this.runtime?.getRunMetaRepository?.() || null) as RunMetaRepositoryLike | null
      if (!repository) return null
      // EP2-T1 — close-out snapshot: task_type/budget copied from the
      // projection (口径源) at finalize; run_meta never maintains them alone.
      return wrapRunMetaRepositoryWithCloseoutSnapshot(
        repository,
        (taskId) => this.runtime?.getTaskProjection?.(taskId) ?? null,
      )
    } catch {
      return null
    }
  }

  private hasPendingTaskProjection(scopeId?: string): boolean {
    if (!scopeId || !this.runtime?.listTaskProjections) return false
    try {
      return this.runtime.listTaskProjections(scopeId).some((projection) =>
        projection.status === 'running'
        || projection.status === 'queued'
        || projection.status === 'blocked'
      )
    } catch {
      return false
    }
  }

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.cancelPendingToolActions = canceller
  }

  /**
   * Per-session browser-collection / local-send-im intent TTL (continuity).
   * Extracted to {@link AgentSdkIntentTracker} (V3 Phase 2) — synchronous
   * in-memory state that never adds an `await` to the run() hot path.
   */
  /** Run admission/release + budget-checkpoint I/O service (V3 Phase 4). Wired in the constructor. */
  private readonly runLifecycle: AgentSdkRunLifecycle
  /** Tool building + execution + event publishing (V3 Phase 5-A). Wired in the constructor. */
  private readonly toolExecutor: AgentSdkToolExecutor
  /** Turn loop (sendMessage) + funnel finalizers (V3 Phase 5-B). Wired in the constructor. */
  private readonly turnOrchestrator: AgentSdkTurnOrchestrator
  private readonly intentTracker = new AgentSdkIntentTracker()
  /** Pure session compaction primitive (V3 Phase 2). Lock orchestration stays in this class. */
  private readonly compactor = new AgentSdkCompactor()

  newSession(name: string, systemPrompt?: string): void {
    this.stopGeneration(name)
    this.sessionManager.set(name, {
      sdkSession: new MemorySession({ sessionId: name }),
      systemPrompt: systemPrompt || defaultSystemPrompt(),
      messageVisibilityEpoch: 0,
      generation: 0,
      currentRun: null,
      orphanCount: 0,
      pendingCompact: null,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
      lastUsageTokens: 0,
    })
  }

  setSystemPrompt(name: string, systemPrompt?: string): void {
    if (!this.sessionManager.has(name)) {
      this.newSession(name, systemPrompt)
      return
    }
    const session = this.sessionManager.get(name)!
    session.systemPrompt = systemPrompt || defaultSystemPrompt()
  }

  stopGeneration(name: string, initiator: AbortInitiator = 'user_stop'): void {
    const session = this.sessionManager.get(name)
    if (!session) return
    const currentRun = session.currentRun
    session.generation += 1
    if (currentRun?.abortController) {
      try {
        this.cancelPendingToolActions?.(name)
      } catch (error) {
        log(`cancelPendingToolActions failed: ${errorMessage(error)}`)
      }
      const message = initiator === 'user_stop'
        ? 'cancelled_user'
        : initiator === 'process_exit'
          ? 'process_exit'
          : initiator === 'manual_suspend'
            ? 'manual_suspend'
            : initiator === 'timeout'
              ? 'main_no_progress_timeout'
              : 'cancelled_runtime'
      currentRun.abortController.abort(createInitiatorAbort(currentRun, initiator, message))
      currentRun.abortController = null
    }
  }

  clearScopeContext(scopeId: string): void {
    this.intentTracker.clearScope(scopeId)
    this.turnOrchestrator.discardScopeContext(scopeId)
  }

  resetSessionContext(
    name: string,
    scopeId: string,
    messageVisibilityEpoch: number,
  ): void {
    const existing = this.sessionManager.get(name)
    const systemPrompt = existing?.systemPrompt
    this.stopGeneration(name, 'preempted')
    this.clearScopeContext(scopeId)
    clearScopeSessionSnapshot(name)
    this.newSession(name, systemPrompt)
    const replacement = this.sessionManager.get(name)
    if (replacement) replacement.messageVisibilityEpoch = messageVisibilityEpoch
  }

  async compactSession(name: string, reason: CompactReason = 'manual'): Promise<CompactSessionResult> {
    return this.sessionManager.withSessionLock(name, async () => {
      const session = this.sessionManager.get(name)
      if (!session) return { status: 'not_found', message: 'session not found' }
      if (session.currentRun) {
        session.pendingCompact = { reason }
        return { status: 'queued' }
      }
      return this.compactor.compactMemorySession(
        session.sdkSession,
        session.contextWindowTokens,
        undefined,
        reason === 'manual',
      )
    })
  }

  private async compactCapturedSession(
    name: string,
    runHandle: RunHandle,
    baseItems: AgentInputItem[] | undefined,
    reason: CompactReason,
    windowTokens: number,
  ): Promise<CompactSessionResult> {
    return this.sessionManager.withSessionLock(name, async () => {
      const session = this.sessionManager.get(name)
      if (
        !session
        || session.generation !== runHandle.runGeneration
        || session.currentRun?.runId !== runHandle.runId
      ) {
        return { status: 'superseded', message: 'run no longer owns this session' }
      }
      const result = await this.compactor.compactMemorySession(
        runHandle.capturedSession,
        windowTokens,
        baseItems,
        reason === 'overflow' || reason === 'manual',
      )
      if (result.status === 'compacted') {
        session.pendingCompact = null
        log(`context compacted agent=${name} reason=${reason} before=${result.report.beforeTokens} after=${result.report.afterTokens}`)
      }
      return result
    })
  }

  private async resolveMapPlaceAmbiguityIfNeeded(params: {
    bridgeResults: ToolBridgeResultItem[]
    definitionByName: Map<string, ToolDefinition>
    runtimeContext: ToolBridgeRuntimeContext
  }): Promise<boolean> {
    const askDefinition = params.definitionByName.get('ask_user_questions')
    if (!askDefinition) return false
    const mapDefinition = params.definitionByName.get('map_plan_route')
    let searchResults = params.bridgeResults
    let handled = false
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ambiguity = findMapPlaceAmbiguityPrompt(searchResults)
      if (!ambiguity) return handled
      handled = true

      const askOutput = await this.toolExecutor.executeReadyToolDefinition(
        askDefinition,
        ambiguity.askArgs,
        params.runtimeContext,
      )
      params.bridgeResults.push({
        id: `${ambiguity.source.id}-ask-user`,
        name: 'ask_user_questions',
        args: ambiguity.askArgs,
        result: askOutput,
      })

      const answer = readMapAmbiguityAnswer(askOutput)
      const selected = answer
        ? ambiguity.choices.find((choice) => choice.option === answer) || null
        : null
      const retryArgs = selected && mapDefinition
        ? buildMapRetryArgs(ambiguity.source.args, ambiguity.field, selected.candidate)
        : null
      if (!mapDefinition || !retryArgs) return true

      const retryOutput = await this.toolExecutor.executeReadyToolDefinition(
        mapDefinition,
        retryArgs,
        params.runtimeContext,
      )
      const retryResult = {
        id: `${ambiguity.source.id}-retry`,
        name: 'map_plan_route',
        args: retryArgs,
        result: retryOutput,
      }
      params.bridgeResults.push(retryResult)
      searchResults = [retryResult]
    }
    return handled
  }

  private resolveSkillAuthorizationForTurn(
    message: RunMessage,
    sessionId?: string,
    messageVisibilityEpoch?: number,
    requestEnvelope?: unknown,
    forceLocalSendImIntent = false,
    skillHintRelevantForTurn = false,
  ): SkillToolAuthorization {
    return resolveSemanticSkillAuthorizationForTurn({
      message,
      sessionId,
      messageVisibilityEpoch,
      requestEnvelope,
      forceLocalSendImIntent,
      skillHintRelevantForTurn,
      orchestrator: this.skillContextOrchestrator,
      log,
    })
  }

  private resolvePreparedSkillTurnForTurn(
    message: RunMessage,
    sessionId?: string,
    messageVisibilityEpoch?: number,
    requestEnvelope?: unknown,
    forceLocalSendImIntent = false,
    skillHintRelevantForTurn = false,
  ): {
    authorization: SkillToolAuthorization
    identity: import('../skills/skill-turn-identity').SkillTurnIdentity
  } {
    const authorization = this.resolveSkillAuthorizationForTurn(
      message,
      sessionId,
      messageVisibilityEpoch,
      requestEnvelope,
      forceLocalSendImIntent,
      skillHintRelevantForTurn,
    )
    if (authorization.mode === 'none') {
      return { authorization, identity: { mode: 'none', reason: authorization.reason } }
    }
    return {
      authorization,
      identity: {
        mode: 'skill',
        relation: authorization.source === 'explicit' ? 'new' : 'resume',
        skillId: authorization.skillId,
        skillName: authorization.skillId,
        confidence: authorization.source === 'explicit'
          ? 'explicit'
          : authorization.source === 'trusted_resume'
            ? 'trusted_handle'
            : 'hint',
        source: authorization.source === 'explicit'
          ? 'explicit_user_mention'
          : authorization.source === 'trusted_resume'
            ? 'run_state_resource'
            : 'reference_hint',
        contextText: skillAuthorizationTextCandidates(message, requestEnvelope).join('\n'),
      },
    }
  }

  private resolveSavedSkillAuthorizationForResume(
    saved: PreparedSkillTurnTruth,
  ): SkillToolAuthorization {
    const skillId = saved.identity.mode === 'skill' ? saved.identity.skillId : null
    const skill = skillId
      ? getSkillsRuntimeManager().listSkills()
          .find((candidate) => candidate.id === skillId && candidate.manifestValid !== false) ?? null
      : null
    const executableSurface =
      resolveExplicitReferenceSkillExecutableSurface(skill, saved.authorizedTypedActions)
    const allowRunShell = Boolean(skillId && skill && resolveSkillShellAllowed({
      ...executableSurface,
      isEmbedded: isEmbeddedSkill(skillId),
      hasConsent: getSkillShellConsent(skillId),
    }))
    const registryActionOwners = skillId
      ? getSkillActionOwnersForTrustedResume(skillId)
      : new Map<string, string>()
    const manifestTools = resolveManifestBoundSkillTools(
      skill,
      [...registryActionOwners.keys()],
      allowedPrimitiveToolsForSdkSkillTurn({
        skillId: skillId || undefined,
        allowRunShell,
        allowAskUser: true,
      }),
    )
    return resolveCurrentLegalAuthorizationForSavedSkill({
      saved,
      skillPresent: saved.identity.mode === 'none' || Boolean(skill),
      currentActionOwners: new Map(manifestTools.typedActions.map((name) => [name, skillId || ''])),
      currentAllowedPrimitives: new Set(manifestTools.primitives),
    })
  }


}

// ─── V3 Phase 1 barrel re-exports (backward compatibility) ───
export type {
  AgentSdkRuntimeDeps,
} from './agent-sdk-types'
export {
  defaultSystemPrompt,
  projectionPatchFromChildClose,
  removeAlreadyEmittedNativeText,
  resolveToolFailurePageUrl,
  sdkStatusFromTerminalReason,
  splitNativeTextBufferForSafeFlush,
} from './agent-sdk-utils'
export {
  ReadyAnthropicModel,
  ReadyOpenAICompatibleModel,
} from './agent-sdk-provider'
