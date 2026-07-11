import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  Agent,
  MemorySession,
  OpenAIProvider,
  Runner,
  Usage,
  tool,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunStreamEvent,
  type StreamEvent,
  type Tool as AgentSdkTool,
} from '@openai/agents'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type {
  BudgetWarningLevel,
  ExecutionTurnResult,
  RunBudgetSeed,
  RunBudgetUsage,
  RunMessage,
  TaskBudgetRuntime,
  TaskType,
  TaskProjectionRecord,
  TurnTranscriptEvent,
} from '../contracts/run-contracts'
import {
  TARGET_DOCUMENT_ERROR_KINDS,
  TOOL_ADMISSION_ERROR_KINDS,
} from '../contracts/error-kinds'
import type { CheckInRecord } from '../quality/task-adjudicator'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import type { ScopeRunEventPayload } from '../contracts/types'
import type { TurnTerminalReason } from './turn-frame'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose,
} from '../skills/skill-child-runner'
import {
  isCompletedChildCloseStatus,
  isFailedChildCloseStatus,
  isKilledChildCloseStatus,
  type SkillChildCloseEvent,
} from '../skills/skill-child-run-types'
import type { MultimodalBlock } from '../contracts/run-contracts'
import {
  buildTextToolBridgePrompt,
  buildTextToolResultMessage,
  parseTextToolBridgeResponse,
} from '../../claude-bridge/tool-bridge'
import {
  hasExplicitDocumentWidgetCreateIntent,
  inferDocumentWidgetTaskKind,
} from '../../claude-bridge/tool-policy-heuristics'
import {
  readAIConfigDetailed,
  type AIConfigLoad,
} from '../../claude-bridge/direct-chat-ai-config'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import {
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  type AIModelDef,
  type AIModelConfig,
  type AIProviderDef,
} from '../../../../shared/ai-providers'
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveModelContextWindow,
} from '../../../../shared/context-budget-types'
import {
  buildContextUsageSnapshot,
} from '../../../../shared/context-usage-types'
import type {
  SpecialistBlueprintSourceMessageUnavailableReason,
} from '../../../../shared/agent-specialist-blueprint'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../../shared/ai-providers/index'
import {
  parseJsonOrEventStreamResponse,
} from '../../openai-responses'
import {
  buildChatCompletionsToolCalls,
  buildResponsesToolCalls,
} from '../../claude-bridge/provider-tool-arguments'
import { buildProviderHttpError } from '../../claude-bridge/provider-terminal-error'
import { resolveOpenAIProviderRuntime } from '../provider-runtime-resolver'
import {
  assertCurrentMessageCapability,
  sanitizeHistoricalMessagesByCapability,
  type CapabilityMessage,
  type MessageCapabilitySnapshot,
} from '../domain-adapters/message-capability-filter'
import { assertManualThinkingModeProviderSafe } from '../thinking-compatibility'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import type { BrowserTaskDecisionMode } from '../../../../shared/browser-agent-task'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import { resolveCapabilityResolution } from '../domain-adapters/capability-resolver'
import { resolveActiveSkillAllowedTools } from '../domain-adapters/run-capability-controller'
import { buildRequestEnvelope } from '../contracts/request-envelope'
import { classifyIntent } from '../intent-classifier'
import { resolveIntentCapabilityGroupModes } from '../execution-intent-resolver'
import {
  applyMapSemanticIntentToIntentClassification,
  classifyMapSemanticIntentFallback,
} from '../map-semantic-intent'
import { resolvePolicyConflictFacts } from '../policy-arbitration'
import {
  resolveBrowserCollectionIntent,
  isBrowserCollectionSubsetTool,
  resolveBrowserBatchCollectionIntent,
  isBrowserBatchCollectionWorkflowTool,
} from '../../../../shared/browser-collection-intent'
import { hasLocalSendImFileIntent } from '../../../../shared/remote-im-file-intent'
import { classifyFollowupIntent, followupConsultsRecalledContext, detectNegationReleases, hasContinuableTaskRef, type FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { peekLastReferenceSkill } from '../skills/skill-reference-hints'
import { shouldDisplayReferenceSkillHintForLatestUserText } from '../reference-skill-hint-display'
import { wrapRunMetaRepositoryWithCloseoutSnapshot } from '../task-projection/run-meta-snapshot'
import { recordNegations, releaseNegations, activeNegations } from '../safety/negation-state'
import { stageSpecialistTaskEvolutionProposal } from '../agents/specialist-task-evolution-proposals'
import { detectVerbatimGrants, recordVerbatimGrant, revokeAuthorizationsForCategories, authCategoriesForNegationFamilies } from '../safety/authorization-fact-store'
import { classifyBrowserToolCall } from '../../browser-engine/browser-tool-write-classification'
import { createBrowserTurnLease, type BrowserTurnLease } from '../../browser-engine/agent-browser-turn-lease'
import { filterToolsByAllowedTools, filterToolsByVisionCapability } from '../tools-runtime/tool-gateway'
import { sanitizeAssistantText } from '../tools-runtime/tool-call-text-guard'
import {
  buildToolRuntimeContext,
  toToolExecutorContext,
} from '../tools-runtime/tool-runtime-context-builder'
import {
  applyContextModifier,
  createEmptyActiveFrameContext,
  type ToolRuntimeActiveFrameContext,
} from '../tools-runtime/tool-runtime'
import { snapshotTurnFeatureFlags } from './turn-feature-flags'
import { buildAgentSpawnContextFromAIConfig } from '../../skills-runtime/agent-context-source'
import { resolveSkillShellAllowed, isEmbeddedSkill, getSkillShellConsent } from '../../skills-runtime/skill-shell-consent'
import { executeToolCall as executeReadyToolCall } from '../../tools'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import { PRIMITIVE_TOOL_DEFS, PRIMITIVE_TOOL_NAME_SET } from '../../tools/skill-primitives/tool-defs'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import {
  buildModelVisibleToolResultPayload,
  redactModelVisibleToolText,
} from '../tools-runtime/model-visible-tool-output'
import {
  collectToolOutputProofs,
  createTaskProofSink,
} from '../quality/proof-collector'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import { findDocumentVisualSyntaxIssue } from '../../../../shared/document-visual-syntax'
import {
  normalizeSessionSnapshotForSeed,
  type CompactResult,
} from '../compaction/compact-agent-input'
import {
  consumeToolCallBudget,
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  rebindTaskBudgetRuntime,
  resumeBudgetRuntime,
} from '../task-projection/run-budget-policy'
import { readResumeKind, type ResumeKind } from '../contracts/resume-handle'
import { createRotatingLogger } from '../../../utils/rotating-logger'
import { finalizeRunOutcome, type RunOutcome, writeRunCloseMetric } from './run-finalizer'
import {
  learnSiteCardFromFailure,
  siteCardLearningSignalFromToolFailure,
  siteCardLearningSignalsFromCheckIn,
} from '../knowledge/site-card-learning'
import {
  buildActionAnnouncementCheckpointMessage,
  buildActionAnnouncementSteerInput,
  evaluateActionAnnouncementGuard,
} from './action-announcement-guard'
import {
  buildSkillClarificationCheckpointMessage,
  buildSkillClarificationSteerInput,
  buildSkillClarificationSteerReminder,
  evaluateSkillClarificationGuard,
} from './skill-clarification-guard'
import { buildRuntimePreambleBill, emitContextBill, RUNTIME_PREAMBLE_STAGE } from '../context-bill'
import { createSystemReminderRegistry } from '../system-reminders/system-reminder-registry'
import { registerActionAnnouncementSteerReminder } from '../system-reminders/action-announcement-steer-reminder'
import {
  beginBackgroundTaskTerminalReminderRun,
  drainBackgroundTaskTerminalReminders,
  prependSystemReminderInput,
  registerBackgroundTaskTerminalReminder,
} from '../system-reminders/background-task-terminal-reminder'
import {
  buildActivePlanReminderText,
  clearActivePlanForScope,
  configureActivePlanPersistence,
  getActivePlanForScope,
  noteToolResultForActivePlan,
} from '../system-reminders/active-plan-step-reminder'
import {
  loadScopeSessionSnapshot,
  writeScopeSessionSnapshot,
} from '../session/scope-session-snapshot'
import { classifyExecutionError } from '../../claude-bridge/error-classifier'
import { buildRecoveryPlan } from '../../claude-bridge/recovery-router'

// ─── V3 Phase 1: extracted helpers (split into sibling modules) ───
import type {
  AgentSdkBudgetCheckpoint,
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  AgentSdkRuntimeDeps,
  AgentSdkSession,
  BeginRunResult,
  CompactReason,
  CompactSessionResult,
  DocumentTargetGuard,
  ObservedDocumentToolTarget,
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle,
  RunMetaRepositoryLike,
  SdkLongSkillCheckpoint,
  SkillContextOrchestratorLike,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext,
} from './agent-sdk-types'
import {
  DOCUMENT_TARGET_MUTATION_TOOL_NAMES,
  MAX_ORPHAN_RUNS,
  PREEMPT_SETTLE_TIMEOUT_MS,
  ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL,
  SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS,
  acquireBudgetCheckpointFlight,
  allowedPrimitiveToolsForSdkSkillTurn,
  appendBudgetWarningSteering,
  asRecord,
  authorizedPrimitiveToolNames,
  buildDocumentTargetContentRepairInput,
  buildDocumentTargetContinuationRepairInput,
  buildDocumentTargetInstruction,
  buildDocumentTargetRepairInput,
  buildLocalDocumentExcerptInstruction,
  buildLocalDocumentExcerptRepairInput,
  buildLocalSendImSkillAuthorization,
  buildNewDocumentSaveRepairInput,
  buildTerminalFailureProjectionPatch,
  classifySdkRuntimeError,
  continuationChildRunId,
  continuationHandleFromLongSkillCheckpoint,
  continuationRunStatePath,
  defaultFetchWithTimeout,
  defaultSystemPrompt,
  documentSaveSucceeded,
  documentToolMutatedContent,
  errorMessage,
  explicitReferenceSkillHasScripts,
  extractLongSkillCheckpoint,
  extractSdkMissingToolName,
  filterSelectedSkillToolSurface,
  finalTextIndicatesIncompleteDocument,
  formatToolCallTrace,
  formatToolResultTrace,
  hasLocalSendImIntentForTurn,
  hasRecalledTaskContext,
  hydrateDocumentTargetPreservation,
  inspectDocumentTargetContent,
  isAbortError,
  isCheckpointTerminalReason,
  isDocumentToolFailureText,
  isDocumentToolFailure,
  mergeProjectionPatches,
  isLocalDocumentToolDefinition,
  isLocalSendImRetryFollowup,
  isSameObservedDocumentTarget,
  mapToolFailureClose,
  messageHasBrowserBatchCollectionIntent,
  messageHasBrowserCollectionIntent,
  messageToText,
  nonEmptyString,
  normalizeExplicitDocumentTargetToolArgs,
  parseEnvelopeResourceReferences,
  primaryInstructionText,
  projectionPatchFromChildClose,
  publicAgentName,
  raceWithTimeout,
  readDocumentToolTarget,
  readSkillReferenceNames,
  readStructuredResultRecord,
  readTextField,
  recoverLooseXmlToolCallText,
  releaseBudgetCheckpointFlight,
  removeAlreadyEmittedNativeText,
  resolveAgentSdkMaxTurns,
  resolveAgentSdkProviderDiagnostics,
  resolveAgentSdkTaskBudgetRuntime,
  resolveBrowserDecisionMode,
  resolveConfiguredModelDef,
  resolveDocumentTargetGuard,
  resolveSdkDefaultIntentSurface,
  resolveSkillHintRelevanceForTurn,
  resolveSourceMessageProvenance,
  resolveTaskTypeFromToolDefinitions,
  resolveToolFailurePageUrl,
  restoreCheckpointToolSurface,
  safeContinuationPathSegment,
  scopeRunModuleForTool,
  shouldPreferCurrentDocumentRead,
  shouldRecoverLongSkillCheckpoint,
  shouldRequireLocalDocumentExcerpt,
  shouldRequireLocalDocumentWriteOutput,
  shouldSuppressAskUserQuestionsForOpenConversation,
  shouldSuppressSkillAskUserForArtifactDelivery,
  shouldSuppressVisibleTextOnToolCall,
  shouldUseLocalDocumentToolSet,
  skillAuthorizationTextCandidates,
  skillContextMessagesToInstruction,
  splitNativeTextBufferForSafeFlush,
  stringField,
  stringifyToolResult,
  stripMediaBlocksForLocalSendIm,
  summarizeChildResume,
  summarizeLongSkillCheckpoint,
  supplementAuthorizedSkillPrimitiveDefinitions,
  taskBudgetDiagnostics,
  toOpenAIToolSchemas,
  toSdkInput,
  validatePreservedDocumentMutation,
} from './agent-sdk-utils'
import {
  log,
  resolveAgentSdkProvider,
  runWithOpenAIAgentsSdk,
} from './agent-sdk-provider'
import { AgentSdkIntentTracker } from './agent-sdk-intent-tracker'
import { AgentSdkCompactor } from './agent-sdk-compactor'
import { AgentSdkRunLifecycle, createInitiatorAbort } from './agent-sdk-run-lifecycle'
import { AgentSdkToolExecutor } from './agent-sdk-tool-executor'
import { AgentSdkTurnOrchestrator } from './agent-sdk-turn-orchestrator'
import { DynamicDeliveryCoordinator } from './dynamic-delivery/dynamic-delivery-coordinator'
import { DynamicDeliveryTaskStore } from './dynamic-delivery/dynamic-delivery-task-store'
import { AgentSdkSessionManager } from './agent-sdk-session'


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
    this.loadAIConfig = deps.loadAIConfig || (() =>
      readAIConfigDetailed(() => settingsRepository.getSetting('ai_model_config')))
    this.runAgent = deps.runAgent || runWithOpenAIAgentsSdk
    this.executeToolCall = deps.executeToolCall || executeReadyToolCall
    this.fetchWithTimeout = deps.fetchWithTimeout || defaultFetchWithTimeout
    this.skillContextOrchestrator = deps.skillContextOrchestrator || null
    this.resumeSkillChildRun = deps.resumeSkillChildRun || defaultResumeSkillChildRun
    this.waitForSkillChildRunClose = deps.waitForSkillChildRunClose || defaultWaitForSkillChildRunClose
    this.getScopeTaskRefs = deps.getScopeTaskRefs || null
    this.listToolDefinitionsForTurn = deps.listToolDefinitions || ((params) =>
      this.toolExecutor.listDefaultToolDefinitionsForTurn(params))
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
      hasPendingTaskProjection: (scopeId) => self.hasPendingTaskProjection(scopeId),
      learnSiteCardFromToolFailure: (toolName, args, output) =>
        self.learnSiteCardFromToolFailure(toolName, args, output),
      learnSiteCardsFromCheckIn: (input) => self.learnSiteCardsFromCheckIn(input),
      newSession: (name, systemPrompt) => self.newSession(name, systemPrompt),
      resolveMapPlaceAmbiguityIfNeeded: (params) => self.resolveMapPlaceAmbiguityIfNeeded(params),
      resolveSkillAuthorizationForTurn: (message, sessionId, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn) =>
        self.resolveSkillAuthorizationForTurn(message, sessionId, requestEnvelope, forceLocalSendImIntent, skillHintRelevantForTurn),
      resolveTaskTypeFromTools: (usedTools) => self.resolveTaskTypeFromTools(usedTools),
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
    configureActivePlanPersistence({
      load: (scope) => runtime.getPersistedActivePlan(scope),
      save: (scope, plan) => runtime.persistActivePlan(scope, plan),
      remove: (scope) => runtime.persistActivePlan(scope, null),
    })
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

  private writeSiteCardLearningSignal(
    signal: Parameters<typeof learnSiteCardFromFailure>[1],
    source: 'checkin' | 'tool_error',
  ): void {
    try {
      const store = this.runtime?.getBeliefCardStore?.()
      if (!store) return
      const result = learnSiteCardFromFailure(store, signal)
      if (result.status === 'written') {
        logAgentMetric('site_card_learning_written', {
          source,
          domain: signal.domain,
          failureKind: signal.failureKind,
          relPath: result.relPath,
          mode: result.mode,
        })
      }
    } catch (error) {
      logAgentMetric('site_card_learning_failed', {
        source,
        domain: signal.domain,
        failureKind: signal.failureKind,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private learnSiteCardsFromCheckIn(input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }): void {
    this.stageSpecialistTaskEvolutionFromCheckIn(input)
    if (input.checkIn.blockers.length === 0) return
    const continuationRef = input.projection.continuationRef && typeof input.projection.continuationRef === 'object'
      ? input.projection.continuationRef
      : null
    const signals = siteCardLearningSignalsFromCheckIn({
      url: continuationRef?.targetUrl ?? null,
      blockers: input.checkIn.blockers,
      now: input.now,
    })
    for (const signal of signals) this.writeSiteCardLearningSignal(signal, 'checkin')
  }

  private stageSpecialistTaskEvolutionFromCheckIn(input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }): void {
    try {
      const store = this.runtime?.getBeliefCardStore?.()
      const registry = this.runtime?.getAgentRegistry?.()
      const proposalStore = this.runtime?.getSpecialistContentEditProposalStore?.()
      const runMetaRepository = this.runtime?.getRunMetaRepository?.()
      if (!store || !registry || !proposalStore || !runMetaRepository) return
      const result = stageSpecialistTaskEvolutionProposal({
        registry,
        store,
        proposalStore,
        getRunExecutionBinding: (runId) => runMetaRepository.get(runId)?.executionBinding ?? null,
        now: input.now,
      }, {
        projection: input.projection,
        checkIn: input.checkIn,
        terminalStatus: input.terminalStatus ?? null,
        terminalReason: input.terminalReason ?? null,
      })
      logAgentMetric('specialist_task_evolution_proposal', {
        taskId: input.projection.taskId,
        ownerAgentId: input.projection.ownerAgentId ?? null,
        status: result.status,
        reason: result.status === 'skipped' ? result.reason : null,
        proposalId: result.proposal?.proposalId ?? null,
      })
      for (const contribution of input.projection.deliveryState?.packages ?? []) {
        if (contribution.adoptedByOwner !== true || contribution.binding.kind !== 'registered_agent') continue
        const contributionProjection: TaskProjectionRecord = {
          ...input.projection,
          taskId: contribution.childTaskId,
          runId: contribution.binding.runId,
          ownerAgentId: contribution.binding.effectiveAgentId,
          executionBinding: contribution.binding,
          proofRefs: contribution.evidenceHandleIds.map((ref) => ({ kind: 'artifact', ref })),
          learningRefs: contribution.evidenceHandleIds.map((ref) => ({ kind: 'artifact', ref })),
        }
        const contributionResult = stageSpecialistTaskEvolutionProposal({
          registry,
          store,
          proposalStore,
          getRunExecutionBinding: (runId) => runId === contribution.binding.runId
            ? contribution.binding
            : runMetaRepository.get(runId)?.executionBinding ?? null,
          now: input.now,
        }, {
          projection: contributionProjection,
          checkIn: input.checkIn,
          terminalStatus: input.terminalStatus ?? null,
          terminalReason: input.terminalReason ?? null,
          allowWorkflowContribution: true,
        })
        logAgentMetric('dynamic_delivery_contribution_learning', {
          taskId: input.projection.taskId,
          childTaskId: contribution.childTaskId,
          agentId: contribution.binding.effectiveAgentId,
          status: contributionResult.status,
          reason: contributionResult.status === 'skipped' ? contributionResult.reason : null,
          proposalId: contributionResult.proposal?.proposalId ?? null,
        })
      }
    } catch (error) {
      logAgentMetric('specialist_task_evolution_proposal_failed', {
        taskId: input.projection.taskId,
        ownerAgentId: input.projection.ownerAgentId ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private learnSiteCardFromToolFailure(
    toolName: string,
    args: Record<string, unknown> | undefined,
    output: ToolExecutionOutput,
  ): void {
    const normalized = normalizeToolExecutionOutput(output)
    const data = readStructuredResultRecord(normalized)
    const errorKind = typeof data.errorKind === 'string' && data.errorKind
      ? data.errorKind
      : typeof data.errorCode === 'string' && data.errorCode ? data.errorCode : null
    if (!errorKind && data.ok !== false) return
    // G1 — resolve the page URL so a collection tool failure that carries no URL
    // in args/data still yields a domain (see resolveToolFailurePageUrl).
    const pageUrl = resolveToolFailurePageUrl(this.browserController, args)
    const signal = siteCardLearningSignalFromToolFailure({
      toolName,
      errorKind,
      args,
      data,
      text: normalized.text,
      pageUrl,
    })
    if (signal) this.writeSiteCardLearningSignal(signal, 'tool_error')
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
    requestEnvelope?: unknown,
    forceLocalSendImIntent = false,
    skillHintRelevantForTurn = false,
  ): SkillToolAuthorization {
    const localSendImIntent = forceLocalSendImIntent || hasLocalSendImIntentForTurn(message, requestEnvelope)
    const orchestrator = this.skillContextOrchestrator
    if (!orchestrator) {
      return localSendImIntent
        ? buildLocalSendImSkillAuthorization('local_send_im_intent')
        : buildExplicitNoSkillAuthorization('no_skill_signal')
    }
    const userTextCandidates = skillAuthorizationTextCandidates(message, requestEnvelope)
    // P1-2 — typed envelope skill_reference 是授权第一信源：命中即以 typed_ref 直接构造 selected 授权，
    //   正则文本候选降为兜底。localSendImIntent 轮不走此快路（保留既有 send-im 合成）。
    //   最小传话铁律不受影响：typed ref 只把"技能识别"从正则扫文本换成结构化 refs；工具面/交付意图
    //   推导仍吃全量用户文本（userTextCandidates），因此不丢失 target-folder delivery 等语义。
    if (!localSendImIntent) {
      // typed ref 是本轮显式结构化引用，不消费任何 stale reference hint（后者仍由文本兜底路径按
      //   skillHintRelevantForTurn 裁决）；因此这里绝不 eager 调 getCurrentReferenceSkillHint。
      for (const skillName of readSkillReferenceNames(requestEnvelope)) {
        const syntheticMention = `@[${skillName}]`
        const matchedSkill = (orchestrator.findExplicitlyRequestedSkills?.(syntheticMention) || [])
          .find((skill) => skill && (skill.id || skill.skillId))
        const typedRefSkillId = matchedSkill?.id || matchedSkill?.skillId
        if (!matchedSkill || !typedRefSkillId) continue
        try {
          orchestrator.rememberExplicitReferenceSkillHint?.(syntheticMention, sessionId)
        } catch (error) {
          log(`rememberExplicitReferenceSkillHint failed: ${errorMessage(error)}`)
        }
        const typedRefPreferredTexts = [...userTextCandidates, syntheticMention]
        const typedRefActionNames = new Set(
          typedRefPreferredTexts
            .flatMap((text) => orchestrator.buildPreferredSkillToolNames?.(text, sessionId) || [])
            .filter((toolName) => toolName.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(toolName)),
        )
        if (typedRefSkillId === 'video-expert-analyzer') {
          typedRefActionNames.add('skill_video_expert_pipeline')
          typedRefActionNames.add('skill_video_expert_ai_analyze')
        }
        const typedRefActions = Array.from(typedRefActionNames)
        // P3-2 — shell only when the skill has scripts AND (embedded OR user-consented).
        const typedRefAllowRunShell = resolveSkillShellAllowed({
          hasScripts: explicitReferenceSkillHasScripts(matchedSkill, typedRefActions),
          isEmbedded: isEmbeddedSkill(typedRefSkillId),
          hasConsent: getSkillShellConsent(typedRefSkillId),
        })
        const typedRefAllowAskUser = !shouldSuppressSkillAskUserForArtifactDelivery(typedRefPreferredTexts)
        log(`[skill_authorization] source=typed_ref skill=${typedRefSkillId}`)
        return buildSelectedSkillToolAuthorization({
          skillId: typedRefSkillId,
          allowedTypedActions: typedRefActions,
          allowedPrimitives: allowedPrimitiveToolsForSdkSkillTurn({
            allowRunShell: typedRefAllowRunShell,
            allowAskUser: typedRefAllowAskUser,
          }),
          source: 'explicit',
          reason: 'typed_ref:explicit_user_mention',
        })
      }
    }
    if (userTextCandidates.length === 0) return buildExplicitNoSkillAuthorization('no_skill_signal')
    const explicitSkillMatches: Array<{
      text: string
      skill: { id?: string; skillId?: string; name?: string; managedPath?: string }
    }> = []
    for (const text of userTextCandidates) {
      const skills = orchestrator.findExplicitlyRequestedSkills?.(text) || []
      for (const skill of skills) {
        if (!skill) continue
        const skillId = skill.id || skill.skillId
        if (!skillId) continue
        if (explicitSkillMatches.some((entry) => (entry.skill.id || entry.skill.skillId) === skillId)) continue
        explicitSkillMatches.push({ text, skill })
      }
    }
    const explicitSkillEntry = explicitSkillMatches[0] || null
    const explicitSkill = explicitSkillEntry?.skill || null
    const explicitSkillId = explicitSkill?.id || explicitSkill?.skillId || (localSendImIntent ? 'send-im' : null)
    if (explicitSkillId) {
      try {
        orchestrator.rememberExplicitReferenceSkillHint?.(explicitSkillEntry?.text || userTextCandidates[0], sessionId)
      } catch (error) {
        log(`rememberExplicitReferenceSkillHint failed: ${errorMessage(error)}`)
      }
    }
    if (!localSendImIntent && !explicitSkillId && !skillHintRelevantForTurn) {
      return buildExplicitNoSkillAuthorization('no_skill_signal')
    }

    const referenceHint = orchestrator.getCurrentReferenceSkillHint?.(sessionId) || null
    const preferredToolNames = userTextCandidates.flatMap((text) =>
      orchestrator.buildPreferredSkillToolNames?.(text, sessionId) || [],
    )
    const typedActionNames = new Set(preferredToolNames
      .filter((name) => name.startsWith('skill_') && !PRIMITIVE_TOOL_NAME_SET.has(name)))
    if (localSendImIntent) {
      typedActionNames.add('skill_send_im_file')
    }
    if (explicitSkillId === 'video-expert-analyzer' || referenceHint?.id === 'video-expert-analyzer') {
      typedActionNames.add('skill_video_expert_pipeline')
      typedActionNames.add('skill_video_expert_ai_analyze')
    }
    const typedActions = Array.from(typedActionNames)
    const skillId = explicitSkillId || (skillHintRelevantForTurn ? referenceHint?.id || null : null)
    if (!skillId) return buildExplicitNoSkillAuthorization('no_skill_signal')
    // P3-2 — shell only when the skill has scripts AND (embedded OR user-consented).
    const allowRunShell = resolveSkillShellAllowed({
      hasScripts: explicitReferenceSkillHasScripts(explicitSkill, typedActions),
      isEmbedded: isEmbeddedSkill(skillId),
      hasConsent: getSkillShellConsent(skillId),
    })
    const allowAskUser = !shouldSuppressSkillAskUserForArtifactDelivery(userTextCandidates)

    // P1-2 — 文本候选（正则启发式）是兜底信源；typed ref 未命中才走到这里。
    log(`[skill_authorization] source=text_fallback skill=${skillId}`)
    return buildSelectedSkillToolAuthorization({
      skillId,
      allowedTypedActions: typedActions,
      allowedPrimitives: allowedPrimitiveToolsForSdkSkillTurn({ allowRunShell, allowAskUser }),
      source: explicitSkillId ? 'explicit' : 'active_task',
      reason: explicitSkillId ? 'explicit_user_mention' : 'reference_hint',
    })
  }


  private resolveTaskTypeFromTools(usedTools: string[]): TaskType {
    if (usedTools.length === 0) return 'direct_answer'
    if (usedTools.some((name) =>
      name.startsWith('web_')
      || name === 'present_file'
      || name === 'browser_research_topic'
      || name === 'browser_search',
    )) {
      return 'research'
    }
    return 'multi_step_task'
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
