import { MemorySession, type AgentInputItem } from '@openai/agents'
import type { FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import type { AIConfigLoad } from '../../claude-bridge/direct-chat-ai-config'
import { normalizeSessionSnapshotForSeed } from '../compaction/compact-agent-input'
import type {
  RunMessage,
  TaskProjectionRecord,
  TurnTranscriptEvent,
} from '../contracts/run-contracts'
import type { CheckInRecord } from '../quality/task-adjudicator'
import { loadScopeSessionSnapshot } from '../session/scope-session-snapshot'
import { isSafeMessageVisibilityEpoch, readScopeContextEpoch } from '../session/scope-context-epoch'
import type {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose
} from '../skills/skill-child-runner'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { SkillTurnIdentity } from '../skills/skill-turn-identity'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { sanitizeAssistantText } from '../tools-runtime/tool-call-text-guard'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { errorMessage } from './agent-sdk-execution-utils'
import type { AgentSdkIntentTracker } from './agent-sdk-intent-tracker'
import type { AgentSdkRunLifecycle } from './agent-sdk-run-lifecycle'
import type { AgentSdkSessionManager } from './agent-sdk-session'
import type { AgentSdkToolExecutor } from './agent-sdk-tool-executor'
import type {
  AgentSdkRuntimeDeps,
  CompactReason,
  CompactSessionResult,
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle,
  RunMetaRepositoryLike,
  SkillContextOrchestratorLike,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { AgentControlRuntime } from './runtime'
import type { DynamicDeliveryCoordinator } from './dynamic-delivery/dynamic-delivery-coordinator'
import type { VerifiedBrowserWorkflowEvidence } from '../../browser-engine/browser-workflow-evidence'
import type { TurnTerminalReason } from './turn-frame'

export interface TurnOrchestratorHost {
  readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  readonly fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  readonly getScopeTaskRefs: ((scopeId: string) => FollowupTaskRef[]) | null
  readonly intentTracker: AgentSdkIntentTracker
  readonly listToolDefinitionsForTurn: NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>
  readonly loadAIConfig: () => AIConfigLoad
  readonly resumeSkillChildRun: typeof defaultResumeSkillChildRun
  readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  readonly setActiveToolUseMode: NonNullable<AgentSdkRuntimeDeps['setActiveToolUseMode']>
  readonly dispatchToolConsentRetry: NonNullable<AgentSdkRuntimeDeps['dispatchToolConsentRetry']>
  readonly dynamicDelivery: DynamicDeliveryCoordinator
  readonly runLifecycle: AgentSdkRunLifecycle
  readonly runtime: AgentControlRuntime | null
  readonly sessionManager: AgentSdkSessionManager
  readonly skillContextOrchestrator: SkillContextOrchestratorLike | null
  readonly toolExecutor: AgentSdkToolExecutor
  readonly waitForSkillChildRunClose: typeof defaultWaitForSkillChildRunClose
  compactCapturedSession(
    name: string,
    runHandle: RunHandle,
    baseItems: AgentInputItem[] | undefined,
    reason: CompactReason,
    windowTokens: number
  ): Promise<CompactSessionResult>
  getRunMetaRepositoryForFinalize(): RunMetaRepositoryLike | null
  hasBrowserController(): boolean
  readVerifiedBrowserWorkflowEvidence(browserTaskId: string): VerifiedBrowserWorkflowEvidence | null
  hasPendingTaskProjection(scopeId?: string): boolean
  learnSiteCardFromToolFailure(
    toolName: string,
    args: Record<string, unknown> | undefined,
    output: ToolExecutionOutput
  ): void
  learnSiteCardsFromCheckIn(input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }): void
  newSession(name: string, systemPrompt?: string): void
  resolveMapPlaceAmbiguityIfNeeded(params: {
    bridgeResults: ToolBridgeResultItem[]
    definitionByName: Map<string, ToolDefinition>
    runtimeContext: ToolBridgeRuntimeContext
  }): Promise<boolean>
  resolveSkillAuthorizationForTurn(
    message: RunMessage,
    sessionId?: string,
    messageVisibilityEpoch?: number,
    requestEnvelope?: unknown,
    forceLocalSendImIntent?: boolean,
    skillHintRelevantForTurn?: boolean
  ): SkillToolAuthorization
  resolvePreparedSkillTurnForTurn(
    message: RunMessage,
    sessionId?: string,
    messageVisibilityEpoch?: number,
    requestEnvelope?: unknown,
    forceLocalSendImIntent?: boolean,
    skillHintRelevantForTurn?: boolean
  ): { authorization: SkillToolAuthorization; identity: SkillTurnIdentity }
  resolveSavedSkillAuthorizationForResume(saved: PreparedSkillTurnTruth): SkillToolAuthorization
  emit(event: string | symbol, ...args: unknown[]): boolean
}

export function isCurrentAgentSdkVisibilityContext(input: {
  host: TurnOrchestratorHost
  sessionId?: string
  messageVisibilityEpoch?: number
}): boolean {
  if (!input.sessionId) return true
  const durableScope = readScopeContextEpoch(input.sessionId)
  if (durableScope.kind === 'closed' || durableScope.kind === 'unavailable') return false
  if (durableScope.kind === 'open') {
    return isSafeMessageVisibilityEpoch(input.messageVisibilityEpoch)
      && durableScope.messageVisibilityEpoch === input.messageVisibilityEpoch
  }
  const runtimeScope = typeof input.host.runtime?.getConversationScope === 'function'
    ? input.host.runtime.getConversationScope(input.sessionId)
    : null
  return !runtimeScope || (
    isSafeMessageVisibilityEpoch(input.messageVisibilityEpoch)
    && runtimeScope.messageVisibilityEpoch === input.messageVisibilityEpoch
  )
}

export function prepareAgentSdkScopeSession(input: {
  host: TurnOrchestratorHost
  name: string
  sessionId?: string
  messageVisibilityEpoch?: number
}): { rejectionError: string | null; sessionRestoreNotice: string | null } {
  if (!isCurrentAgentSdkVisibilityContext(input)) {
    return {
      rejectionError: 'Conversation context identity is stale.',
      sessionRestoreNotice: null,
    }
  }
  const effectiveMessageVisibilityEpoch = isSafeMessageVisibilityEpoch(input.messageVisibilityEpoch)
    ? Number(input.messageVisibilityEpoch)
    : 0
  const existingSession = input.host.sessionManager.get(input.name)
  const contextChanged = Boolean(
    existingSession
    && existingSession.messageVisibilityEpoch !== effectiveMessageVisibilityEpoch,
  )
  if (contextChanged && existingSession?.currentRun) {
    return {
      rejectionError: 'Conversation context identity changed while the prior run is still active.',
      sessionRestoreNotice: null,
    }
  }
  if (existingSession && !contextChanged) {
    return { rejectionError: null, sessionRestoreNotice: null }
  }
  input.host.newSession(input.name, existingSession?.systemPrompt)
  const seeded = input.host.sessionManager.get(input.name)
  if (seeded) seeded.messageVisibilityEpoch = effectiveMessageVisibilityEpoch
  const restored = loadScopeSessionSnapshot(input.name, effectiveMessageVisibilityEpoch)
  if (restored.ok && restored.items.length > 0 && seeded) {
    seeded.sdkSession = new MemorySession({
      sessionId: input.name,
      initialItems: normalizeSessionSnapshotForSeed(restored.items as never[]),
    })
    return {
      rejectionError: null,
      sessionRestoreNotice: '已恢复上次会话上下文（应用此前重启过）。如与当前请求无关可忽略。',
    }
  }
  return {
    rejectionError: null,
    sessionRestoreNotice: !restored.ok && restored.reason !== 'missing'
      ? '上次会话快照不属于当前上下文，会话已重置（未恢复早前上下文）。'
      : null,
  }
}

export function createAgentSdkTurnEventPublishers(input: {
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  messageVisibilityEpoch?: number
  runGeneration: number
  transcriptEvents: TurnTranscriptEvent[]
  onStatus: (status: string, terminalReason?: TurnTerminalReason | null) => void
}) {
  const isCurrentRun = (): boolean => {
    const latest = input.host.sessionManager.get(input.name)
    return Boolean(
      latest
      && latest.generation === input.runGeneration
      && latest.currentRun?.runId === input.runId
    )
  }
  const isCurrentVisibilityContext = (): boolean => isCurrentAgentSdkVisibilityContext(input)
  const emitOutputForRun = (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null,
    canonicalReceipt?: CanonicalAssistantMessageReceipt,
  ): void => {
    if (!isCurrentVisibilityContext()) return
    const safeChunk = type === 'text'
      ? sanitizeAssistantText(chunk, {
          sessionId: input.sessionId || undefined,
          source: 'transcript_emit',
        })
      : chunk
    if (type === 'text' && !safeChunk) return
    input.transcriptEvents.push({
      kind: 'output',
      type,
      chunk: safeChunk,
      projectionPatch: projectionPatch || null,
    })
    input.host.emit('output', {
      agent: input.name,
      sessionId: input.sessionId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      runId: input.runId,
      taskId: input.taskId,
      chunk: safeChunk,
      type,
      projectionPatch: projectionPatch || null,
      ...(canonicalReceipt || {}),
    })
  }
  const nativeTextToolBoundaryFlush: { current: (() => void) | null } = { current: null }
  const emitOutput = (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null,
  ): void => {
    if (!isCurrentRun()) return
    if (type === 'tool_use') nativeTextToolBoundaryFlush.current?.()
    emitOutputForRun(chunk, type, projectionPatch)
  }
  const emitHeartbeat = (text: string): void => {
    if (!isCurrentRun() || !input.sessionId) return
    input.host.runtime?.publishScopeRunEvent?.({
      type: 'updated',
      scopeId: input.sessionId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      visibilityOwnerKind: 'context_background',
      visibilityOwnerLedger: { kind: 'run_meta', id: input.runId },
      agent: input.name,
      ownerAgentId: input.name,
      taskOrigin: 'user_root',
      runId: input.runId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      phase: 'planning',
      latestText: text,
      timestamp: new Date().toISOString(),
    })
  }
  const emitStatusForRun = (
    status: string,
    terminalReason?: TurnTerminalReason | null,
  ): void => {
    if (!isCurrentVisibilityContext()) return
    input.onStatus(status, terminalReason)
    input.transcriptEvents.push({ kind: 'status', status, terminalReason: terminalReason || null })
    input.host.emit('status', {
      agent: input.name,
      sessionId: input.sessionId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      runId: input.runId,
      status,
      ...(typeof terminalReason === 'undefined' ? {} : { terminalReason }),
      isMock: false,
    })
  }
  const emitStatus = (status: string, terminalReason?: TurnTerminalReason | null): void => {
    if (!isCurrentRun()) return
    emitStatusForRun(status, terminalReason)
  }
  const emitRuntimeError = (error: unknown, terminalReason: TurnTerminalReason): void => {
    if (!isCurrentRun() || !isCurrentVisibilityContext()) return
    const message = errorMessage(error)
    input.transcriptEvents.push({ kind: 'error', error: message })
    input.host.emit('error', {
      agent: input.name,
      sessionId: input.sessionId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      runId: input.runId,
      error: message,
      type: 'runtime',
      errorKind: terminalReason,
      recoverable: false,
    })
  }
  return {
    isCurrentRun,
    isCurrentVisibilityContext,
    emitOutputForRun,
    emitOutput,
    emitHeartbeat,
    emitStatusForRun,
    emitStatus,
    emitRuntimeError,
    nativeTextToolBoundaryFlush,
  }
}
