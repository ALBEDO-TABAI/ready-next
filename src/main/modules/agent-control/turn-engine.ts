import { createHash, randomUUID } from 'crypto'
import { buildRequestEnvelope } from './request-envelope'

/**
 * skill-resume C1 — pure helper for tool-repetition detection.
 * Exported for direct unit testing.
 *
 * Returns the count of identical (name, argsHash) entries matching the LAST
 * entry in the ring buffer. Caller compares to a threshold to decide whether
 * to fire the ask-user nudge.
 *
 * Used inline in the tool loop after each iteration's tool batch executes.
 */
export function countToolRepetitions(ring: ReadonlyArray<{ name: string; argsHash: string }>): number {
  if (ring.length === 0) return 0
  const last = ring[ring.length - 1]
  return ring.filter(c => c.name === last.name && c.argsHash === last.argsHash).length
}

/**
 * skill-resume C3 — pure helper computing the 70% iteration warning threshold.
 * Returns the iteration count at which the once-per-run warning should fire.
 *
 * Floor + min-1 ensures even tiny budgets (e.g. direct_answer max=8) still
 * have a single warning trigger.
 */
export function computeBudgetWarningThreshold(maxIterations: number): number {
  return Math.max(1, Math.floor(Math.max(0, maxIterations) * 0.7))
}

export function shouldInjectBudgetWarning(params: {
  warned: boolean
  iteration: number
  warningThreshold: number
  lastLongTypedSkillActionIteration?: number | null
}): boolean {
  if (params.warned) return false
  if (params.iteration < params.warningThreshold) return false
  if (
    typeof params.lastLongTypedSkillActionIteration === 'number'
    && params.iteration - params.lastLongTypedSkillActionIteration <= 1
  ) {
    return false
  }
  return true
}

// Phase 3.2 + post-screenshot hotfix — TOOL_CALL_TEXT_PATTERN, sanitizeAssistantText,
// pushAssistantTextSafely all live in `tool-call-text-guard.ts` so
// `turn-transcript.ts` (the actual user-visible emit point) can import them
// without creating a turn-engine ↔ turn-transcript circular dep. Re-exporting
// the public surface here so the existing test imports from turn-engine
// keep working.
export {
  TOOL_CALL_TEXT_PATTERN,
  sanitizeAssistantText,
  pushAssistantTextSafely,
} from './tool-call-text-guard'
export type {
  SanitizeAssistantTextOptions,
  SanitizeAssistantTextOptions as PushAssistantTextSafelyOptions,
} from './tool-call-text-guard'
import {
  pushAssistantTextSafely,
  sanitizeAssistantText,
} from './tool-call-text-guard'

/**
 * Phase 3.3 — budget-warning copy that doesn't sabotage long skill flows.
 *
 * The previous 70%/90% nudges literally told the model to "总结当前进度并
 * 询问用户是否继续" — a reverse instruction for staged pipelines like VEA
 * which need to keep running without asking. Audit Phase 3 §D3/D4.
 *
 * `isLongSkillContext` is the gate: when the run is on the long-skill
 * budget OR a typed skill action is in the preferred-tools list, we send
 * a "keep going, prefer typed actions, only ask on real blockers" message
 * instead of the convergence/summarize nudge. Returns plain string so the
 * caller can wrap it in any role (currently `user` per the existing IPC
 * shape).
 */
export function buildBudgetWarningMessage(params: {
  iterations: number
  effectiveMaxIterations: number
  level: 'converge' | 'warning'
  isLongSkillContext: boolean
}): string {
  if (params.isLongSkillContext) {
    if (params.level === 'converge') {
      return `系统提醒：长任务接近预算上限（${params.iterations}/${params.effectiveMaxIterations}）。继续用 typed skill action 推进剩余步骤；只有遇到真实 blocker（如等待用户确认）才用 skill_ask_user。不要在这一步停下来总结。`
    }
    return `系统提醒：长任务进度 ${params.iterations}/${params.effectiveMaxIterations}。继续推进当前 skill 流程，优先 typed skill action 而不是 skill_run_shell；如果 run_state 表明在等某个文件，先用 skill_read_artifact 看清楚再推进，不需要在这一步问用户。`
  }
  if (params.level === 'converge') {
    return '系统提醒：当前预算已接近上限，请在剩余轮次内收敛并优先给出可交付结果。'
  }
  return `系统提醒：已用 ${params.iterations}/${params.effectiveMaxIterations} 次工具调用。请总结当前进度并询问用户是否继续，或在确认下一步方向后再继续调用工具。`
}

import { buildContinuationStateFromProjection } from './continuation-state'
import { matchesConfigRepairIntent, matchesResumeIntent } from './resume-lexicon'
import { classifyIntent, type IntentClassification } from './intent-classifier'
import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'
import {
  rememberActiveSkillContext,
  resolveActiveSkillContext,
  summarizeActiveSkillContext,
  type ActiveSkillContext,
} from './active-skill-context'
import { applySupervisorRuntimeToTurnFrame, resolveTurnFrame } from './turn-frame-resolver'
import { summarizeTurnFrame, type TurnFrame, type TurnTerminalReason } from './turn-frame'
import { resolveExecutionIntentContext } from './execution-intent-resolver'
import {
  buildSkillDetectionInputs,
  collectRecentAssistantSkillToolUses,
  isConfigRepairTurn,
  isRetryOnlyTurn,
} from './skill-detection-inputs'
import {
  getLatestSkillRun,
  resolveSkillRunForResume,
  type SkillRunRecord,
} from './session-continuity'
import { prepareInitialRun, reconcileAfterBrowserDecision } from './run-capability-controller'
import { defaultToolRegistry } from './tool-registry'
import {
  selectDomainAdapter,
  type DomainAdapter,
  type DomainAdapterApplyResult,
  type DomainAdapterPrepareResult,
} from './domain-adapter'
import {
  applyLongSkillTaskBudgetSeed,
  applyRunBudgetHint,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createContinuationRunBudgetSeed,
  createRunBudgetSeed,
  createStepBudgetState,
  createTaskBudgetRuntime,
  getRemainingToolCallBudget,
} from './run-budget-policy'
import { resolveTaskExecutionRoute } from './task-execution-router'
import { resolveTaskType } from './task-type-resolver'
import { buildToolRuntimeContext } from './tool-runtime-context-builder'
import {
  buildTextToolBridgeCorrectionMessage,
  buildToolGuidance,
  type ToolPolicy,
} from './execution-tool-config'
import { buildToolDispatchDecision } from './execution-tool-policy'
import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  parseTextToolBridgeResponse,
  shouldEnforceBrowserToolRetry,
} from '../claude-bridge/tool-bridge'
import { compressHistoryForPrompt } from './context-compression'
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import {
  advanceTaskStepProgress,
  detectTaskStepCompletionCue,
  initializeTaskStepProgress,
} from './task-step-runtime'
import { detectGenericInteractionState } from './interaction-state-detector'
import { inspectDocumentToolCall } from '../claude-bridge/document-tool-flow'
import { deriveAgentErrorContract } from '../claude-bridge/error-contract'
import {
  normalizeToolExecutionOutput,
  serializeToolExecutionOutput,
  type ToolExecutionOutput,
} from './tool-result-types'
import { TurnState } from './turn-state'
import { TurnTranscript } from './turn-transcript'
import { buildLongSkillRunningProjection } from './skill-running-projection'
import { buildSkillTaskLifecycleSignal } from './skill-task-lifecycle'
import { inspectLatestSkillTask } from './skill-task-supervisor'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import { recordSkillParentTaskLifecycleEvent } from './skill-task-tracker'
import {
  createSkillBudgetLeaseState,
  evaluateSkillBudgetLease,
} from './skill-budget-lease-controller'
import { scoreSkillProgress, type SkillProgressScore } from './progress-scorer'
import { scoreSkillWaste, type SkillWasteScore } from './waste-scorer'
import { buildAgentSpawnContextFromAIConfig } from '../skills-runtime/agent-context-source'
import type {
  RunBudgetHint,
  SkillBudgetLeaseState,
  SkillTaskLifecycleSignal,
  StepBudgetState,
  ToolSnapshot,
  TurnEngineRequest,
  TurnEngineHost,
  TurnEngineSession,
  TurnEngineSessionMessage,
  TurnModelResponse,
  TurnSimpleResponse,
  TurnToolBatchResult,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnTranscriptEvent,
} from './run-contracts'
import { resolveAIConfigCapabilities } from '../../../shared/ai-providers'

const LONG_TYPED_SKILL_ACTION_MIN_TIMEOUT_MS = 5 * 60 * 1000
const LONG_TYPED_SKILL_ACTION_HEARTBEAT_MS = 30 * 1000

function isLongTypedSkillActionName(toolName: string): boolean {
  if (!toolName.startsWith('skill_')) return false
  const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
  return definition?.domain === 'skill'
    && typeof definition.executionTimeoutMs === 'number'
    && definition.executionTimeoutMs >= LONG_TYPED_SKILL_ACTION_MIN_TIMEOUT_MS
}

function hasLongTypedSkillAction(toolNames: string[] | null | undefined): boolean {
  return Boolean(toolNames?.some((toolName) => isLongTypedSkillActionName(toolName)))
}

interface SkillContextOrchestratorLike {
  shouldKeepToolsWithVideo: (userText: string, sessionId?: string) => boolean
  findExplicitlyRequestedSkills: (userText: string) => Array<{ skillId?: string; id?: string; name?: string }>
  hasActiveSkillExecution: (sessionId?: string) => boolean
  buildPreferredSkillToolNames: (userText: string, sessionId?: string) => string[] | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  rememberExplicitReferenceSkillHint?: (userText: string, sessionId?: string) => boolean
  // skill-resume G2/G3 — reverse-resolve `skill_*` tool names from prior
  // assistant tool_use blocks back to a reference-like skill and arm the
  // hint, so a bare retry intent ("继续") can re-expose internal/primitive
  // tools even when the user didn't name the skill.
  rememberReferenceSkillFromPriorToolUses?: (
    priorToolNames: string[],
    sessionId?: string,
  ) => { armed: boolean; skillId?: string; skillName?: string }
  maybeInjectExplicitSkillContext: (params: Record<string, unknown>) => Promise<void>
  listRegisteredSkillTokens?: () => string[]
}

interface DesignToolLoopOrchestratorLike {
  createState: () => any
  getBudgetHint: (params: Record<string, unknown>) => RunBudgetHint | null
  filterToolCalls: (params: Record<string, unknown>) => {
    toolCalls: TurnToolCall[]
    droppedCount: number
    nextUserMessage: string | null
  }
  applySourceInput: (toolCall: TurnToolCall, toolPolicy: unknown) => TurnToolCall
  recordToolResult: (params: Record<string, unknown>) => {
    state: any
    isPrimaryArtifact: boolean
  }
  buildCompletionText: (state: any) => string | null
  buildStructuredTaskPayload: (payload: Record<string, unknown>) => Record<string, unknown>
}

interface HostCapabilityDispatcherLike {
  dispatch: (params: Record<string, unknown>) => Promise<{
    handled: boolean
    toolUseText?: string
    outputText?: string
  }>
}

function cloneSession<TSession extends TurnEngineSession>(session: TSession): TSession {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
  }
}

function extractIncomingText(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text || ''))
    .join('\n')
}

function extractTaskIdFromText(text: string): string | null {
  return String(text || '').match(/^Task ID:\s*(.+)$/m)?.[1]?.trim() || null
}

function compressSessionMessagesForRetry<TSession extends TurnEngineSession>(session: TSession): boolean {
  if (session.messages.length <= 6) return false
  const earlierMessages = session.messages
    .slice(0, -6)
    .map((message) => ({
      role: message.role,
      content: extractIncomingText(message.content as string | Array<Record<string, unknown>>).trim(),
    }))
    .filter((message) => message.content.length > 0)
  if (earlierMessages.length === 0) return false

  const compressed = compressHistoryForPrompt(earlierMessages, {
    keepRecent: 2,
    maxChars: 900,
  })
  if (!compressed.compressed) return false

  session.messages = [
    { role: 'system', content: `更早对话已压缩以继续执行：\n${compressed.text}` },
    ...session.messages.slice(-6),
  ]
  return true
}

function normalizeToolBatchResult(result: TurnToolBatchResult): {
  results: TurnToolExecutionResult[]
  budgetLimited: boolean
  recoveryHistory: TurnToolBatchResult['recoveryHistory']
} {
  return {
    results: result.results.map((item) => ({
      ...item,
      result: normalizeToolExecutionOutput(item.result as ToolExecutionOutput),
    })),
    budgetLimited: result.budgetLimited,
    recoveryHistory: result.recoveryHistory,
  }
}

function normalizeStepBudgetState(stepBudget: {
  stepId?: string | null
  maxIterations: number
  remainingIterations?: number
} | null | undefined): StepBudgetState | null {
  if (!stepBudget) return null
  const maxIterations = Math.max(1, Number(stepBudget.maxIterations || 0))
  const remainingIterations = typeof stepBudget.remainingIterations === 'number'
    ? stepBudget.remainingIterations
    : maxIterations
  return {
    stepId: stepBudget.stepId || null,
    maxIterations,
    remainingIterations: Math.max(0, Number(remainingIterations || 0)),
  }
}

function applyRuntimeBudgetHint(runtime: NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>>, hint: RunBudgetHint | null): NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>> {
  return applyRunBudgetHint(runtime, hint) as NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>>
}

function appendSessionMessages<TSession extends TurnEngineSession>(
  session: TSession,
  messages: TurnEngineSessionMessage[] | null | undefined,
): void {
  if (!messages || messages.length === 0) return
  session.messages.push(...messages)
}

type RecentSkillRunForResume = SkillRunRecord
const SUPERVISOR_SNAPSHOT_TOOL_NAME = '__skill_task_supervisor_snapshot__'

function skillRunFromSupervisorSnapshot(
  snapshot: SkillTaskSupervisorSnapshot | null | undefined,
): SkillRunRecord | null {
  if (!snapshot?.skillId) return null
  const updatedAt = Number.isFinite(Date.parse(snapshot.observedAt))
    ? Date.parse(snapshot.observedAt)
    : Date.now()
  const summary = [
    snapshot.blockers[0],
    snapshot.progress.currentStage ? `阶段：${snapshot.progress.currentStage}` : null,
    snapshot.outputDir ? `输出目录：${snapshot.outputDir}` : null,
  ].filter(Boolean).join(' · ') || snapshot.status
  return {
    toolName: snapshot.action || SUPERVISOR_SNAPSHOT_TOOL_NAME,
    skillId: snapshot.skillId,
    action: snapshot.action || '',
    success: snapshot.closeAllowed && snapshot.status === 'done',
    status: snapshot.status,
    runKind: snapshot.detachedTaskId ? 'detached' : 'typed_action',
    taskRunId: snapshot.taskRunId || undefined,
    detachedTaskId: snapshot.detachedTaskId || undefined,
    outputDir: snapshot.outputDir || undefined,
    runStatePath: snapshot.runStatePath || undefined,
    pauseReason: snapshot.pauseReason || undefined,
    resumePayload: snapshot.resumePayload || undefined,
    summary,
    updatedAt,
  }
}

function skillRunFromActiveSkillContext(
  context: ActiveSkillContext | null | undefined,
): SkillRunRecord | null {
  if (!context?.skillId) return null
  const updatedAt = Number.isFinite(Date.parse(context.observedAt))
    ? Date.parse(context.observedAt)
    : Date.now()
  const summary = [
    context.staleBlockerReason,
    context.outputDir ? `输出目录：${context.outputDir}` : null,
    context.runStatePath ? `run_state：${context.runStatePath}` : null,
  ].filter(Boolean).join(' · ') || context.status || context.skillId
  return {
    toolName: context.action || SUPERVISOR_SNAPSHOT_TOOL_NAME,
    skillId: context.skillId,
    action: context.action || '',
    success: context.status === 'done',
    status: context.status || undefined,
    runKind: context.detachedTaskId ? 'detached' : 'typed_action',
    taskRunId: context.taskRunId || undefined,
    detachedTaskId: context.detachedTaskId || undefined,
    outputDir: context.outputDir || undefined,
    runStatePath: context.runStatePath || undefined,
    pauseReason: context.staleBlockerReason || undefined,
    summary,
    updatedAt,
  }
}

function isSameSkillRunForResume(left: SkillRunRecord | null | undefined, right: SkillRunRecord | null | undefined): boolean {
  if (!left || !right) return false
  if (left.taskRunId && right.taskRunId && left.taskRunId === right.taskRunId) return true
  if (left.detachedTaskId && right.detachedTaskId && left.detachedTaskId === right.detachedTaskId) return true
  if (left.jobId && right.jobId && left.jobId === right.jobId) return true
  if (left.toolName === SUPERVISOR_SNAPSHOT_TOOL_NAME || right.toolName === SUPERVISOR_SNAPSHOT_TOOL_NAME) return false
  return left.skillId === right.skillId
    && left.action === right.action
    && left.toolName === right.toolName
    && Number(left.updatedAt || 0) === Number(right.updatedAt || 0)
}

function buildSkillResumeContextPrompt(params: {
  skillName: string
  skillId: string
  action?: string | null
  summary?: string | null
  userText: string
}): string {
  return [
    `系统补充：这是一次 skill 恢复请求。优先恢复 skill "${params.skillName}" (${params.skillId})。`,
    params.action ? `上一轮技能动作：${params.action}` : '',
    params.summary ? `上次摘要/目标、输出目录或 artifact、失败原因：${params.summary}` : '',
    `用户本轮补充内容：${params.userText || '继续当前任务。'}`,
    '请沿用上次目标继续，不要把这轮补充当成新的普通问答。',
  ].filter(Boolean).join('\n')
}

function buildProjectionTruthSnapshot(events: TurnTranscriptEvent[]) {
  let projectionPatch: Record<string, unknown> | null = null
  for (const event of events) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    projectionPatch = {
      ...(projectionPatch || {}),
      ...event.projectionPatch,
    }
  }
  return {
    projectionPatch,
    transcriptEvents: events.slice(),
  }
}

function buildHostToolSnapshot(params: {
  stage: ToolSnapshot['stage']
  iteration: number
  host: TurnEngineHost<any>
  hasTools: boolean
  allowBrowserTools: boolean
  browserDecisionMode?: string | null
  browserHostAvailable?: boolean | null
  visibleCapabilityGroupIds?: ToolSnapshot['visibleCapabilityGroupIds']
  suppressedCapabilityGroupIds?: ToolSnapshot['suppressedCapabilityGroupIds']
  allowedToolNames?: string[] | null
  preferTextToolBridge: boolean
}): ToolSnapshot {
  const capabilities = resolveAIConfigCapabilities(params.host.providerContext.config)
  const dispatchDecision = buildToolDispatchDecision({
    supportsToolCalls: capabilities?.supportsToolCalls ?? params.host.providerContext.supportsToolCalls,
    supportsNativeToolCalls: capabilities?.supportsNativeToolCalls
      ?? capabilities?.supportsToolCalls
      ?? params.host.providerContext.supportsToolCalls,
    toolCallTransport: capabilities?.toolCallTransport || null,
    preferTextToolBridge: params.preferTextToolBridge,
  })
  return {
    stage: params.stage,
    source: 'host',
    iteration: Math.max(0, Number(params.iteration || 0)),
    provider: params.host.providerContext.config.provider,
    baseUrl: params.host.providerContext.baseUrl,
    model: params.host.providerContext.config.model,
    wireApi: capabilities?.wireApi === 'responses' || capabilities?.wireApi === 'chat/completions'
      ? capabilities.wireApi
      : null,
    browserDecisionMode: params.browserDecisionMode || null,
    browserHostAvailable: typeof params.browserHostAvailable === 'boolean'
      ? params.browserHostAvailable
      : null,
    hasTools: params.hasTools,
    allowBrowserTools: params.allowBrowserTools,
    visibleCapabilityGroupIds: [...(params.visibleCapabilityGroupIds || [])],
    suppressedCapabilityGroupIds: [...(params.suppressedCapabilityGroupIds || [])],
    allowedToolNames: [...(params.allowedToolNames || [])],
    requestedTransport: dispatchDecision.transport,
    effectiveTransport: dispatchDecision.transport,
    supportsNativeTools: dispatchDecision.supportsNativeTools,
    preferTextToolBridge: params.preferTextToolBridge,
    fallbackReason: null,
    toolCallsCount: null,
  }
}

function appendLoggedToolSnapshot(
  state: TurnState,
  host: TurnEngineHost<any>,
  snapshot: ToolSnapshot,
): void {
  state.appendToolSnapshots([snapshot])
  host.log(`[tool_snapshot] ${JSON.stringify(snapshot)}`)
}

function appendLoggedToolResolution(params: {
  state: TurnState
  host: TurnEngineHost<any>
  stage: string
  resolution: NonNullable<ReturnType<TurnState['buildExecutionDiagnostics']>['toolResolution']>
  visibleCapabilityGroupIds: CapabilityGroupId[]
  allowBrowserTools: boolean
  allowedToolNames: string[]
}): void {
  params.state.setToolResolution(params.resolution)
  for (const groupId of params.visibleCapabilityGroupIds) {
    params.host.log(`[tool_group_resolution] ${JSON.stringify({
      stage: params.stage,
      groupId,
      visible: true,
      toolCount: params.resolution.visibleGroupToolCounts?.[groupId] ?? 0,
      schemaError: params.resolution.groupSchemaErrors?.[groupId] || null,
      usedStaticFallback: Boolean(params.resolution.usedStaticFallbackGroups?.includes(groupId)),
    })}`)
  }
  if ((params.resolution.invariantViolations || []).length > 0) {
    params.host.log(`[tool_resolution_error] ${JSON.stringify({
      stage: params.stage,
      invariantViolations: params.resolution.invariantViolations,
      allowBrowserTools: params.allowBrowserTools,
      visibleCapabilityGroupIds: params.visibleCapabilityGroupIds,
      allowedToolNames: params.allowedToolNames,
    })}`)
  }
}

function buildBrowserToolInvariantViolation(params: {
  allowBrowserTools: boolean
  visibleCapabilityGroupIds: CapabilityGroupId[]
  allowedToolNames: string[]
}): string | null {
  const browserGroupsVisible = params.visibleCapabilityGroupIds.filter((groupId) =>
    groupId === 'browser_interaction' || groupId === 'browser_content_tasks')
  if (!params.allowBrowserTools && browserGroupsVisible.length === 0) return null
  if (params.allowedToolNames.some((name) => name.startsWith('browser_'))) return null
  return [
    'browser_tools_missing',
    `visibleGroups=${browserGroupsVisible.join('|') || 'none'}`,
    `allowBrowserTools=${params.allowBrowserTools}`,
  ].join(',')
}

function assertNoToolResolutionViolation(params: {
  state: TurnState
  host: TurnEngineHost<any>
  stage: string
  resolution: NonNullable<ReturnType<TurnState['buildExecutionDiagnostics']>['toolResolution']> | null | undefined
  allowBrowserTools: boolean
  visibleCapabilityGroupIds: CapabilityGroupId[]
  allowedToolNames: string[]
}): void {
  // Metric-only post-arbitration. The arbitration layer in
  // run-capability-controller.ts is the single authority for resolving
  // forceDocumentTool × browser_workflow and related conflicts. If a violation
  // still reaches this checkpoint, it signals an arbitration regression —
  // surface it as telemetry + warn log, but never throw at the user.
  const invariantViolations = new Set(params.resolution?.invariantViolations || [])
  const requestStageViolation = buildBrowserToolInvariantViolation({
    allowBrowserTools: params.allowBrowserTools,
    visibleCapabilityGroupIds: params.visibleCapabilityGroupIds,
    allowedToolNames: params.allowedToolNames,
  })
  if (requestStageViolation) {
    invariantViolations.add(requestStageViolation)
  }
  if (invariantViolations.size === 0) return

  const mergedResolution = {
    ...(params.resolution || {}),
    invariantViolations: Array.from(invariantViolations),
  }
  params.state.setToolResolution(mergedResolution)
  params.host.log(`[tool_resolution_warning] ${JSON.stringify({
    stage: params.stage,
    invariantViolations: mergedResolution.invariantViolations,
    allowBrowserTools: params.allowBrowserTools,
    visibleCapabilityGroupIds: params.visibleCapabilityGroupIds,
    allowedToolNames: params.allowedToolNames,
    note: 'post_arbitration_violation — arbitration layer regression',
  })}`)
  try {
    logAgentMetric(TOOL_ERROR_METRICS.resolutionViolation, {
      stage: params.stage,
      invariantViolations: mergedResolution.invariantViolations,
      allowBrowserTools: params.allowBrowserTools,
      visibleCapabilityGroupIds: params.visibleCapabilityGroupIds,
      allowedToolNames: params.allowedToolNames,
    })
  } catch {
    // metrics must never break the turn
  }
}

export class TurnEngine {
  async execute<TSession extends TurnEngineSession>(request: TurnEngineRequest<TSession>) {
    const host = request.host
    const transcript = new TurnTranscript(request.emitters, { sessionId: request.sessionId })
    const state = new TurnState({
      taskId: request.taskId,
      taskBudgetRuntime: request.taskBudgetRuntime,
      budget: request.budget,
      budgetState: request.budgetState,
    })
    const skillContextOrchestrator = host.skillContextOrchestrator as SkillContextOrchestratorLike
    const designToolLoopOrchestrator = host.designToolLoopOrchestrator as DesignToolLoopOrchestratorLike
    const hostCapabilityDispatcher = host.hostCapabilityDispatcher as HostCapabilityDispatcherLike
    const domainAdapters = Array.isArray(host.domainAdapters) ? host.domainAdapters as DomainAdapter[] : []
    const requestForAdapters = request as unknown as TurnEngineRequest
    const hostForAdapters = host as unknown as TurnEngineHost

    const emitStructuredTaskPayload = (payload: unknown): void => {
      transcript.emitStructuredPayload(payload)
    }
    let turnFrame: TurnFrame | null = null

    const buildHostToolContext = (allowedToolNames: string[] | null | undefined, scope?: unknown) => buildToolRuntimeContext({
      browserController: host.browserController as any,
      sidecarManager: host.sidecarManager as any,
      runtime: host.runtime as any,
      scope: scope as any,
      allowedToolNames: allowedToolNames || undefined,
      emitToolAction: (tool, args) => {
        transcript.emitToolAction(tool, args)
      },
      requestModuleToolAction: host.requestModuleToolAction,
      abortSignal: request.abortSignal,
      sessionId: request.sessionId,
      taskId: request.taskId,
      parentTaskId: request.taskId,
      parentStepId: request.parentStepId,
      taskProjectionId: request.taskId,
      frameSkillId: turnFrame?.skill?.skillId || null,
      registerRunCleanup: (cleanup) => {
        host.registerRunCleanup?.(cleanup)
      },
      agentContext: buildAgentSpawnContextFromAIConfig(host.providerContext.config, {
        baseUrl: host.providerContext.baseUrl,
      }),
    })

    const finish = (params: {
      success: boolean
      error?: string
      cancelled?: boolean
      status?: 'done' | 'error' | 'cancelled' | 'checkpoint'
      doneEventType?: 'done' | 'error'
      skillTaskLifecycle?: SkillTaskLifecycleSignal | null
      terminalReason?: TurnTerminalReason | null
    }) => {
      const projectionTruth = buildProjectionTruthSnapshot(transcript.listEvents())
      transcript.emitOutput('', params.doneEventType || 'done')
      const status = params.status || (params.cancelled ? 'cancelled' : params.success ? 'done' : 'error')
      const terminalReason = params.terminalReason
        || (status === 'done'
          ? 'done'
          : status === 'checkpoint'
            ? 'checkpoint_budget'
            : status === 'cancelled'
              ? 'cancelled_runtime'
              : 'infra_error')
      if (turnFrame) {
        turnFrame.terminalReason = terminalReason
      }
      transcript.emitStatus(status)
      return {
        ...state.buildResult({
          success: params.success,
          error: params.error,
          cancelled: params.cancelled,
          finalText: transcript.getFinalText(),
          usedTools: transcript.getUsedTools(),
        }),
        status,
        projectionTruth,
        skillTaskLifecycle: params.skillTaskLifecycle || null,
        terminalReason,
      }
    }

    try {
      const session = request.session
      const userText = extractIncomingText(request.content as string | Array<Record<string, unknown>>)
      const requestEnvelope = request.requestEnvelope || buildRequestEnvelope({ userText })
      const activeWidgetEditLease = host.resolveActiveWidgetEditLease?.() || null
      const registeredSkillTokens = skillContextOrchestrator.listRegisteredSkillTokens?.() || []
      const previousPureUserInputs = host.collectRecentPureUserInputs(session.messages.slice(0, -1), 40)
      const executionIntentContext = resolveExecutionIntentContext({
        requestEnvelope,
        previousInputs: previousPureUserInputs,
        lastDocumentContextInput: session.lastDocumentContextInput,
        intentClassification: request.intentClassification || classifyIntent(requestEnvelope, {
          registeredSkillTokens,
        }),
        activeWidgetEditLease,
        refreshWidgetEditLease: host.refreshActiveWidgetEditLease
          ? () => host.refreshActiveWidgetEditLease?.() || null
          : undefined,
        registeredSkillTokens,
      })
      const contextualUserInput = executionIntentContext.contextualUserInput
      const pureUserInput = requestEnvelope.pureUserText
      const currentTurnResumeText =
        executionIntentContext.requestEnvelope.primaryInstruction
        || executionIntentContext.requestEnvelope.pureUserText
        || userText
      const providedContinuationState = request.continuationState || null
      if (contextualUserInput !== pureUserInput) {
        host.log(`tool policy context reused previous user input: ${contextualUserInput.slice(0, 120)}`)
      }
      const hasVideoInputs = host.sessionHasVideoInputs(session.messages)
      const keepToolsWithVideo = skillContextOrchestrator.shouldKeepToolsWithVideo(contextualUserInput, request.sessionId)
      const incomingAttachmentHints = host.getIncomingAttachmentHints(request.content)
      let browserDecision = { mode: 'free_tool_loop', reason: 'browser_disabled' } as { mode: string; reason: string }

      // R1: explicit-skill detection must consider primaryInstruction + pureUserText
      // as well as contextualUserInput. contextualUserInput can inherit a previous
      // turn's widget attachment text (lastDocumentContextInput) that drops the
      // current-turn "按 X skill ..." phrasing, so relying on it alone silently
      // drops preferredSkillToolNames to null and the skill filter strips the
      // user's intended skill tools. primaryInstruction comes from the current
      // turn verbatim and is the correct primary signal.
      // skill-resume A2: scan recent assistant tool_use blocks for skill_*
      // names so a bare retry ("继续") can re-discover the skill the agent was
      // using before — even when the user's current text doesn't name it.
      const previousAssistantSkillToolUses = collectRecentAssistantSkillToolUses(
        session.messages.slice(0, -1) as Array<{ role?: string; content?: unknown }>,
        5,
      )
      const skillDetectionInputs = buildSkillDetectionInputs({
        contextualUserInput,
        primaryInstruction: requestEnvelope.primaryInstruction,
        pureUserText: requestEnvelope.pureUserText,
        previousPureUserInputs,
        previousAssistantSkillToolUses,
      })
      // D3: detect a bare retry/continue intent so narrowing domain adapters
      // (currently SkillDomainAdapter) can widen their prefix list to keep
      // file_/document_ tools accessible. Probe the same input channels as
      // skill detection so we don't miss a retry hidden under a widget
      // context inheritance.
      const isRetryOnlyTurnDetected = [
        requestEnvelope.primaryInstruction,
        requestEnvelope.pureUserText,
        contextualUserInput,
      ].some((text) => isRetryOnlyTurn(String(text || '')))
      const isConfigRepairTurnDetected = [
        requestEnvelope.primaryInstruction,
        requestEnvelope.pureUserText,
        contextualUserInput,
      ].some((text) => isConfigRepairTurn(String(text || '')) || matchesConfigRepairIntent(String(text || '')))
      const isSkillResumeTurnDetected = isRetryOnlyTurnDetected || isConfigRepairTurnDetected
      const explicitSkillMatches = skillDetectionInputs
        .map((text) => ({ text, skills: skillContextOrchestrator.findExplicitlyRequestedSkills(text) }))
      const firstSkillMatch = explicitSkillMatches.find((entry) => entry.skills.length > 0) || null
      let hasExplicitSkill = Boolean(firstSkillMatch)
      const hasActiveSkill = skillContextOrchestrator.hasActiveSkillExecution(request.sessionId)
      let skillContextInjectionText = firstSkillMatch ? firstSkillMatch.text : contextualUserInput
      let referenceSkillForMetrics: { id?: string; name?: string } | null = null
      let referenceSkillHintVia: 'explicit' | 'lookback' | 'current' | 'history' | null = null
      const hasStrongActiveSkillContext = (): boolean => {
        try {
          const supervisorSnapshot = host.skillTaskSupervisor?.inspectLatestSkillTask
            ? host.skillTaskSupervisor.inspectLatestSkillTask({
              sessionId: request.sessionId,
              scopeId: request.sessionId,
            })
            : null
          const context = resolveActiveSkillContext({
            sessionId: request.sessionId,
            supervisorSnapshot,
            inspectSupervisor: supervisorSnapshot ? false : undefined,
          })
          return Boolean(context && context.source !== 'reference_hint')
        } catch {
          return false
        }
      }
      // skill-resume G2/G3 — when the user fired a bare retry intent and the
      // substring-based skill match failed but the assistant recently used a
      // skill_* tool_use, reverse-resolve the tool name back to its skill and
      // re-arm the reference-skill hint. We then synthesize a context text so
      // the rest of the turn (preferredSkillToolNames, maybeInjectExplicitSkillContext)
      // flows naturally as if the user had named the skill.
      let lookbackRearmedSkill: { skillId?: string; skillName?: string } | null = null
      if (!hasExplicitSkill && !providedContinuationState && isSkillResumeTurnDetected && !isConfigRepairTurnDetected && previousAssistantSkillToolUses.length > 0 && !hasStrongActiveSkillContext()) {
        const rearmed = skillContextOrchestrator.rememberReferenceSkillFromPriorToolUses?.(
          previousAssistantSkillToolUses,
          request.sessionId,
        )
        if (rearmed?.armed && rearmed.skillName) {
          lookbackRearmedSkill = { skillId: rearmed.skillId, skillName: rearmed.skillName }
          referenceSkillForMetrics = { id: rearmed.skillId, name: rearmed.skillName }
          referenceSkillHintVia = 'lookback'
          skillContextInjectionText = `用户希望继续使用 skill "${rearmed.skillName}"`
          hasExplicitSkill = true
          host.log(
            `[skill_detection] reference_skill_rearmed_from_lookback skillId=${rearmed.skillId || ''} skillName=${rearmed.skillName}`,
          )
        }
      }
      if (!hasExplicitSkill && !providedContinuationState && isSkillResumeTurnDetected && !isConfigRepairTurnDetected && !hasStrongActiveSkillContext()) {
        const armedHint = skillContextOrchestrator.getCurrentReferenceSkillHint?.(request.sessionId)
        if (armedHint) {
          lookbackRearmedSkill = { skillId: armedHint.id, skillName: armedHint.name }
          referenceSkillForMetrics = { id: armedHint.id, name: armedHint.name }
          referenceSkillHintVia = 'current'
          skillContextInjectionText = `用户希望继续使用 skill "${armedHint.name}"`
          hasExplicitSkill = true
          host.log(
            `[skill_detection] reference_skill_rearmed_from_current_hint skillId=${armedHint.id} skillName=${armedHint.name}`,
          )
        }
      }
      const inspectLatestSkillTaskForHost = (params: {
        sessionId?: string | null
        scopeId?: string | null
        skillId?: string | null
      }): SkillTaskSupervisorSnapshot => {
        if (host.skillTaskSupervisor?.inspectLatestSkillTask) {
          return host.skillTaskSupervisor.inspectLatestSkillTask(params)
        }
        return inspectLatestSkillTask(params)
      }

      if (!hasExplicitSkill && !providedContinuationState && isSkillResumeTurnDetected) {
        const continuitySkillRun = getLatestSkillRun(request.sessionId)
        const supervisorSnapshot = inspectLatestSkillTaskForHost({
          sessionId: request.sessionId,
          scopeId: request.sessionId,
        })
        const supervisorSkillRun = skillRunFromSupervisorSnapshot(supervisorSnapshot)
        const activeSkillContext = resolveActiveSkillContext({
          sessionId: request.sessionId,
          supervisorSnapshot,
          inspectSupervisor: false,
        })
        const activeContextSkillRun = skillRunFromActiveSkillContext(activeSkillContext)
        const projectionSkillRun = host.resolveRecentSkillRun?.(request.sessionId) || null
        const taskRunSkillRun = (host as unknown as {
          resolveRecentSkillTaskRun?: (sessionId: string | undefined) => RecentSkillRunForResume | null
        }).resolveRecentSkillTaskRun?.(request.sessionId) || null
        const latestSkillRun = resolveSkillRunForResume({
          sessionId: request.sessionId,
          expectedTaskId: extractTaskIdFromText(currentTurnResumeText || contextualUserInput),
          candidates: [
            supervisorSkillRun,
            activeContextSkillRun,
            taskRunSkillRun,
            projectionSkillRun as RecentSkillRunForResume | null,
            continuitySkillRun,
          ],
        })
        const latestSkillRunSource = isSameSkillRunForResume(supervisorSkillRun, latestSkillRun)
          ? 'supervisor'
          : isSameSkillRunForResume(activeContextSkillRun, latestSkillRun)
          ? activeSkillContext?.source || 'active_context'
          : isSameSkillRunForResume(continuitySkillRun, latestSkillRun)
          ? 'session_continuity'
          : isSameSkillRunForResume(taskRunSkillRun, latestSkillRun)
            ? 'skill_task_run'
            : isSameSkillRunForResume(projectionSkillRun as RecentSkillRunForResume | null, latestSkillRun)
              ? 'task_projection'
              : 'none'
        if (latestSkillRun?.skillId) {
          const recoveredSkill = skillContextOrchestrator
            .findExplicitlyRequestedSkills(`skill ${latestSkillRun.skillId}`)
            .find((skill) => skill.id === latestSkillRun.skillId)
          const skillName = recoveredSkill?.name || latestSkillRun.skillId
          lookbackRearmedSkill = { skillId: latestSkillRun.skillId, skillName }
          referenceSkillForMetrics = { id: latestSkillRun.skillId, name: skillName }
          referenceSkillHintVia = 'history'
          skillContextInjectionText = buildSkillResumeContextPrompt({
            skillName,
            skillId: latestSkillRun.skillId,
            action: latestSkillRun.action,
            summary: latestSkillRun.summary,
            userText: currentTurnResumeText || contextualUserInput,
          })
          hasExplicitSkill = true
          if (activeSkillContext && isSameSkillRunForResume(activeContextSkillRun, latestSkillRun)) {
            rememberActiveSkillContext(request.sessionId, activeSkillContext)
          }
          host.log(
            `[skill_detection] reference_skill_rearmed_from_skill_history source=${latestSkillRunSource} skillId=${latestSkillRun.skillId} skillName=${skillName}`,
          )
        } else if (isConfigRepairTurnDetected) {
          const rearmed = previousAssistantSkillToolUses.length > 0
            ? skillContextOrchestrator.rememberReferenceSkillFromPriorToolUses?.(
              previousAssistantSkillToolUses,
              request.sessionId,
            )
            : null
          if (rearmed?.armed && rearmed.skillName) {
            lookbackRearmedSkill = { skillId: rearmed.skillId, skillName: rearmed.skillName }
            referenceSkillForMetrics = { id: rearmed.skillId, name: rearmed.skillName }
            referenceSkillHintVia = 'lookback'
            skillContextInjectionText = `用户希望继续使用 skill "${rearmed.skillName}"`
            hasExplicitSkill = true
            host.log(
              `[skill_detection] reference_skill_rearmed_from_lookback skillId=${rearmed.skillId || ''} skillName=${rearmed.skillName}`,
            )
          } else {
            const armedHint = skillContextOrchestrator.getCurrentReferenceSkillHint?.(request.sessionId)
            if (armedHint) {
              lookbackRearmedSkill = { skillId: armedHint.id, skillName: armedHint.name }
              referenceSkillForMetrics = { id: armedHint.id, name: armedHint.name }
              referenceSkillHintVia = 'current'
              skillContextInjectionText = `用户希望继续使用 skill "${armedHint.name}"`
              hasExplicitSkill = true
              host.log(
                `[skill_detection] reference_skill_rearmed_from_current_hint skillId=${armedHint.id} skillName=${armedHint.name}`,
              )
            } else {
              const clarification = '我看到了你更新配置，但这里没有可恢复的 skill 任务。请告诉我要继续哪一个技能任务。'
              host.log('[skill_detection] No recent skill task is available to resume after config repair turn')
              transcript.emitOutput(clarification, 'text')
              pushAssistantTextSafely(session, clarification, { sessionId: request.sessionId })
              return finish({ success: true, status: 'done' })
            }
          }
        }
      }
      const referenceSkillHintArmed = hasExplicitSkill
        ? Boolean(skillContextOrchestrator.rememberExplicitReferenceSkillHint?.(
          skillContextInjectionText,
          request.sessionId,
        )) || Boolean(lookbackRearmedSkill)
        : false
      if (referenceSkillHintArmed && !referenceSkillForMetrics) {
        const currentHint = skillContextOrchestrator.getCurrentReferenceSkillHint?.(request.sessionId)
        referenceSkillForMetrics = currentHint
          ? { id: currentHint.id, name: currentHint.name }
          : firstSkillMatch?.skills[0]
            ? { id: firstSkillMatch.skills[0].skillId, name: firstSkillMatch.skills[0].skillId }
            : null
        referenceSkillHintVia = 'explicit'
      }
      const legacyPreferredSkillToolNames = (hasExplicitSkill || hasActiveSkill)
        ? skillContextOrchestrator.buildPreferredSkillToolNames(
          skillContextInjectionText,
          request.sessionId,
        )
        : null
      let preferredSkillToolNames = legacyPreferredSkillToolNames
      let isLongSkillResumeTurn =
        isRetryOnlyTurnDetected
        && referenceSkillHintArmed
        && hasLongTypedSkillAction(preferredSkillToolNames)
      let activeSkillContextForTurn: ActiveSkillContext | null = null
      let currentReferenceHintForContext: { id: string; name: string; at?: number } | null = null
      try {
        currentReferenceHintForContext = skillContextOrchestrator.getCurrentReferenceSkillHint?.(request.sessionId) || null
        activeSkillContextForTurn = resolveActiveSkillContext({
          sessionId: request.sessionId,
          referenceHint: currentReferenceHintForContext
            ? { ...currentReferenceHintForContext, at: Date.now() }
            : null,
        })
      } catch {
        activeSkillContextForTurn = null
      }
      if (activeSkillContextForTurn && activeSkillContextForTurn.source !== 'reference_hint') {
        rememberActiveSkillContext(request.sessionId, activeSkillContextForTurn)
        if (!referenceSkillForMetrics) {
          referenceSkillForMetrics = {
            id: activeSkillContextForTurn.skillId,
            name: activeSkillContextForTurn.skillName || activeSkillContextForTurn.skillId,
          }
        }
      }
      turnFrame = resolveTurnFrame({
        sessionId: request.sessionId,
        requestId: request.runId,
        userIntent: isConfigRepairTurnDetected
          ? 'repair_config'
          : isRetryOnlyTurnDetected
            ? 'continue'
            : 'unknown',
        activeContext: activeSkillContextForTurn,
        referenceHint: currentReferenceHintForContext
          ? { ...currentReferenceHintForContext, at: Date.now() }
          : null,
      })
      if (turnFrame.skill && !referenceSkillForMetrics) {
        referenceSkillForMetrics = {
          id: turnFrame.skill.skillId,
          name: turnFrame.skill.skillName || turnFrame.skill.skillId,
        }
      }
      if (turnFrame.steering.preferredToolNames.length > 0) {
        preferredSkillToolNames = turnFrame.steering.preferredToolNames
      }
      isLongSkillResumeTurn = (
        turnFrame.mode === 'skill_resume'
        && hasLongTypedSkillAction(preferredSkillToolNames)
      ) || isLongSkillResumeTurn
      if (referenceSkillHintArmed) {
        logAgentMetric('skill_reference_hint_armed', {
          via: referenceSkillHintVia || 'explicit',
          sessionId: request.sessionId,
          skillId: referenceSkillForMetrics?.id || null,
          skillName: referenceSkillForMetrics?.name || null,
          retryOnly: isRetryOnlyTurnDetected,
        })
      }
      host.log(`[active_skill_context] ${JSON.stringify(summarizeActiveSkillContext(activeSkillContextForTurn))}`)
      host.log(`[turn_frame] ${JSON.stringify(summarizeTurnFrame(turnFrame))}`)
      logAgentMetric('turn_frame_resolved', summarizeTurnFrame(turnFrame) || {})
      if (turnFrame.skill && !referenceSkillForMetrics?.id) {
        logAgentMetric('turn_frame_resolution_mismatch', {
          sessionId: request.sessionId,
          skillId: turnFrame.skill.skillId,
          source: turnFrame.skill.source,
        })
      }
      if (preferredSkillToolNames?.length) {
        logAgentMetric('preferred_skill_tools', {
          sessionId: request.sessionId,
          count: preferredSkillToolNames.length,
          tools: preferredSkillToolNames,
          referenceSkillHintArmed,
          referenceSkillId: referenceSkillForMetrics?.id || null,
          longSkillResume: isLongSkillResumeTurn,
        })
      }
      host.log(
        `[skill_detection] primaryMatched=${
          explicitSkillMatches.find((entry) => entry.text === requestEnvelope.primaryInstruction)?.skills.length
            ? 'true' : 'false'
        } contextualMatched=${
          explicitSkillMatches.find((entry) => entry.text === contextualUserInput)?.skills.length
            ? 'true' : 'false'
        } pureMatched=${
          explicitSkillMatches.find((entry) => entry.text === requestEnvelope.pureUserText)?.skills.length
            ? 'true' : 'false'
        } activeExecution=${hasActiveSkill} referenceSkillHintArmed=${referenceSkillHintArmed} preferredSkillToolCount=${preferredSkillToolNames?.length || 0} preferredSkillTools=${preferredSkillToolNames?.join('|') || 'none'}`,
      )
      const runtimeAvailability = {
        browserHostAvailable: Boolean(host.browserController),
        feishuConnected: host.runtime?.isChannelTypeAvailable?.('feishu-app') ?? false,
      }
      const preparedRunCapabilities = prepareInitialRun({
        config: host.providerContext.config,
        capabilityProfile: 'local_chat',
        supportsToolCalls: host.providerContext.supportsToolCalls,
        hasVideoInputs,
        hasIncomingVideo: host.providerContext.hasRawVideoInIncoming,
        keepToolsWithVideo,
        preferredSkillToolNames,
        executionIntentContext,
        browserDecisionMode: browserDecision.mode as any,
        runtimeAvailability,
        hostContext: {
          userText: executionIntentContext.requestEnvelope.primaryInstruction
            || executionIntentContext.requestEnvelope.pureUserText
            || userText,
        },
        sessionId: request.sessionId,
      })
      const hasTools = preparedRunCapabilities.visibilityPlan.hasTools
      appendLoggedToolSnapshot(state, host, buildHostToolSnapshot({
        stage: 'host_prepared',
        iteration: 0,
        host,
        hasTools: preparedRunCapabilities.visibilityPlan.hasTools,
        allowBrowserTools: preparedRunCapabilities.toolPolicy.allowBrowserTools,
        browserDecisionMode: browserDecision.mode,
        browserHostAvailable: preparedRunCapabilities.runtimeSnapshot.environment.browserHostAvailable,
        visibleCapabilityGroupIds: preparedRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        suppressedCapabilityGroupIds: preparedRunCapabilities.visibilityPlan.suppressedCapabilityGroupIds || [],
        allowedToolNames: preparedRunCapabilities.allowedToolNames,
        preferTextToolBridge: false,
      }))
      host.log(`[tool_capability] stage=host_prepared ${preparedRunCapabilities.capabilityLogLine}`)
      appendLoggedToolResolution({
        state,
        host,
        stage: 'host_prepared',
        resolution: preparedRunCapabilities.toolResolution,
        visibleCapabilityGroupIds: preparedRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        allowBrowserTools: preparedRunCapabilities.toolPolicy.allowBrowserTools,
        allowedToolNames: preparedRunCapabilities.allowedToolNames,
      })
      assertNoToolResolutionViolation({
        state,
        host,
        stage: 'host_prepared',
        resolution: preparedRunCapabilities.toolResolution,
        allowBrowserTools: preparedRunCapabilities.toolPolicy.allowBrowserTools,
        visibleCapabilityGroupIds: preparedRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        allowedToolNames: preparedRunCapabilities.allowedToolNames,
      })
      let toolPolicy = preparedRunCapabilities.toolPolicy
      const shouldPersistDocumentContext =
        Boolean((toolPolicy as any).forceDocumentTool)
        || executionIntentContext.hasWidgetTargetContext
      if (shouldPersistDocumentContext) {
        session.lastDocumentContextInput = contextualUserInput
      }

      const continuationHintText =
        currentTurnResumeText
      const continuationLookupText =
        requestEnvelope.rawUserText
        || requestEnvelope.pureUserText
        || userText
      const effectiveProvidedContinuationState = hasExplicitSkill ? null : providedContinuationState
      const explicitTaskId = effectiveProvidedContinuationState?.taskId || extractTaskIdFromText(continuationLookupText)
      const shouldSuppressImplicitContinuation = hasExplicitSkill
        && !effectiveProvidedContinuationState
        && !explicitTaskId
        && !(isConfigRepairTurnDetected && referenceSkillHintVia === 'history')
      const shouldResolveContinuation =
        Boolean(effectiveProvidedContinuationState)
        || Boolean(explicitTaskId)
        // Phase 2.4 — use the unified resume lexicon's `anywhere` mode so
        // phrasings like "你需要从头跑一轮" / "重新跑一次" / "再跑一遍" are
        // recognized. Audit Phase 2 §B1/B2 — the previous inline regex
        // dropped these phrases on the floor, falling through to plain-
        // answer where the model could leak `<tool_call>` text into chat.
        || (!shouldSuppressImplicitContinuation && (
          matchesResumeIntent(continuationHintText, 'anywhere')
          || isConfigRepairTurnDetected
        ))
      if (shouldSuppressImplicitContinuation) {
        host.log('[skill_detection] suppressed implicit continuation because an explicit skill request was resolved')
      }
      const continuationProjection = effectiveProvidedContinuationState
        ? null
        : host.resolveContinuationProjection(request.sessionId, continuationLookupText, {
          explicitTaskId,
          allowImplicitContinuation: shouldResolveContinuation,
        })
      const continuationState = effectiveProvidedContinuationState
        || (continuationProjection ? buildContinuationStateFromProjection(continuationProjection) : null)
      const continuationTaskId = continuationState?.taskId || continuationProjection?.taskId || null
      const initialTaskTypeResolution = resolveTaskType({
        intent: executionIntentContext.intentClassification as IntentClassification,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: preparedRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId ? { continuationTaskId } : null,
      })
      const initialTaskExecutionRoute = resolveTaskExecutionRoute({
        taskId: request.taskId,
        resolution: initialTaskTypeResolution,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: preparedRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId
          ? {
            continuationTaskId,
            continuationProjection,
            continuationState,
          }
          : null,
      })

      if (hasTools) {
        const preparedToolContext = buildHostToolContext(preparedRunCapabilities.allowedToolNames)
        await skillContextOrchestrator.maybeInjectExplicitSkillContext({
          userText: skillContextInjectionText,
          session,
          sessionId: request.sessionId,
          emitOutput: (chunk: string, type: string) => transcript.emitOutput(chunk, type),
          emitToolAction: (tool: string, args: Record<string, unknown>) => transcript.emitToolAction(tool, args),
          executeTool: async (tool: string, args: Record<string, unknown>) => host.executeToolCall(tool, args, preparedToolContext),
        })
      }

      const browserDomainAdapter = domainAdapters.find((adapter) => adapter.id === 'browser') || null
      const browserPrepareResult = browserDomainAdapter
        ? await browserDomainAdapter.prepare({
          route: initialTaskExecutionRoute,
          request: requestForAdapters,
          host: hostForAdapters,
          session,
          userText,
          pureUserInput,
          requestEnvelope,
          executionIntentContext,
          hasTools,
          toolPolicy,
          allowedToolNames: preparedRunCapabilities.allowedToolNames,
          turnFrameSteering: turnFrame?.steering || null,
        })
        : null
      browserDecision = {
        mode: String((browserPrepareResult?.domainState as { preparedBrowserExecution?: { browserDecision?: { mode?: string } } } | undefined)
          ?.preparedBrowserExecution?.browserDecision?.mode || 'free_tool_loop'),
        reason: 'domain_adapter',
      }
      const reconciledRunCapabilities = reconcileAfterBrowserDecision({
        prepared: preparedRunCapabilities,
        browserDecisionMode: browserDecision.mode as any,
      })
      toolPolicy = reconciledRunCapabilities.toolPolicy
      appendLoggedToolSnapshot(state, host, buildHostToolSnapshot({
        stage: 'host_effective',
        iteration: 0,
        host,
        hasTools: reconciledRunCapabilities.visibilityPlan.hasTools,
        allowBrowserTools: reconciledRunCapabilities.toolPolicy.allowBrowserTools,
        browserDecisionMode: browserDecision.mode,
        browserHostAvailable: reconciledRunCapabilities.runtimeSnapshot.environment.browserHostAvailable,
        visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        suppressedCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.suppressedCapabilityGroupIds || [],
        allowedToolNames: reconciledRunCapabilities.allowedToolNames,
        preferTextToolBridge: false,
      }))
      host.log(`[tool_capability] stage=host_effective ${reconciledRunCapabilities.capabilityLogLine}`)
      appendLoggedToolResolution({
        state,
        host,
        stage: 'host_effective',
        resolution: reconciledRunCapabilities.toolResolution,
        visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        allowBrowserTools: reconciledRunCapabilities.toolPolicy.allowBrowserTools,
        allowedToolNames: reconciledRunCapabilities.allowedToolNames,
      })
      assertNoToolResolutionViolation({
        state,
        host,
        stage: 'host_effective',
        resolution: reconciledRunCapabilities.toolResolution,
        allowBrowserTools: reconciledRunCapabilities.toolPolicy.allowBrowserTools,
        visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        allowedToolNames: reconciledRunCapabilities.allowedToolNames,
      })
      if (
        activeSkillContextForTurn
        && !(reconciledRunCapabilities.allowedToolNames || []).some((name) =>
          name === 'skill_run_shell' || name === 'skill_patch_config')
      ) {
        logAgentMetric('skill_context_tool_mismatch', {
          sessionId: request.sessionId,
          skillId: activeSkillContextForTurn.skillId,
          source: activeSkillContextForTurn.source,
          visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
        })
        host.log(`[skill_context_tool_mismatch] ${JSON.stringify(summarizeActiveSkillContext(activeSkillContextForTurn))}`)
      }

      const resolvedTaskTypeForEffectiveRun = resolveTaskType({
        intent: executionIntentContext.intentClassification as IntentClassification,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: reconciledRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId ? { continuationTaskId } : null,
      })
      // Phase 4.1 — long-skill resume budget no longer requires `!continuationTaskId`.
      // Audit Phase 4 §C1: an explicit continuation that's still on a typed
      // long-skill action (e.g. resuming VEA pipeline at step 3 of 7) was
      // previously denied the 80-iter ceiling because the gate was AND'd with
      // "no continuationTaskId". Now: any turn where (a) it's a retry-only
      // intent OR (b) we have an explicit continuation pointing at a typed
      // long-skill action gets the upgrade. preferredSkillToolNames only
      // populates when the skill is in the active set, so this can't false-
      // positive on continuations to non-skill tasks.
      const shouldUseLongSkillResumeBudget =
        isLongSkillResumeTurn
        || (Boolean(continuationTaskId) && hasLongTypedSkillAction(preferredSkillToolNames))
      const taskTypeResolution = shouldUseLongSkillResumeBudget && resolvedTaskTypeForEffectiveRun.executionChain === 'direct'
        ? {
          ...resolvedTaskTypeForEffectiveRun,
          taskType: 'multi_step_task' as const,
          executionChain: 'domain_executor' as const,
          requiresPlanner: false,
          preferredExecutor: 'skill' as const,
        }
        : resolvedTaskTypeForEffectiveRun
      const taskExecutionRoute = resolveTaskExecutionRoute({
        taskId: request.taskId,
        resolution: taskTypeResolution,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: reconciledRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId
          ? {
            continuationTaskId,
            continuationProjection,
            continuationState,
          }
          : null,
      })
      state.continuationBudgetRestore = taskExecutionRoute.continuation?.budgetRestore || null
      const selectedDomainAdapter = selectDomainAdapter(domainAdapters, {
        route: taskExecutionRoute,
        userText,
        hasTools,
        executionIntentContext,
      })
      const selectedDomainPrepareResult: DomainAdapterPrepareResult | null =
        selectedDomainAdapter?.id === 'browser'
          ? browserPrepareResult
          : selectedDomainAdapter
            ? await selectedDomainAdapter.prepare({
              route: taskExecutionRoute,
              request: requestForAdapters,
              host: hostForAdapters,
              session,
              userText,
              pureUserInput,
              requestEnvelope,
              executionIntentContext,
              hasTools,
              toolPolicy,
              allowedToolNames: reconciledRunCapabilities.allowedToolNames,
              isRetryOnlyTurn: isRetryOnlyTurnDetected,
              turnFrameSteering: turnFrame?.steering || null,
            })
            : null
      const shouldHideBrowserProcessText =
        selectedDomainAdapter?.id === 'browser'
        && taskExecutionRoute.chain !== 'direct'
        && (
          taskExecutionRoute.executor === 'browser'
          || Boolean((selectedDomainPrepareResult?.domainState as { browserToolLoopState?: { isBrowserTask?: boolean } } | null | undefined)
            ?.browserToolLoopState?.isBrowserTask)
        )

      if (taskExecutionRoute.chain === 'continuation' && taskExecutionRoute.continuation?.budgetRuntime) {
        state.taskBudgetRuntime = {
          ...taskExecutionRoute.continuation.budgetRuntime,
          budget: { ...taskExecutionRoute.continuation.budgetRuntime.budget },
          usage: { ...taskExecutionRoute.continuation.budgetRuntime.usage },
          stepBudget: taskExecutionRoute.continuation.budgetRuntime.stepBudget
            ? { ...taskExecutionRoute.continuation.budgetRuntime.stepBudget }
            : null,
        }
        state.effectiveRunBudget = { ...state.taskBudgetRuntime.budget }
        Object.assign(state.runBudgetState, state.taskBudgetRuntime.usage)
        state.stepBudgetState = state.taskBudgetRuntime.stepBudget
          ? { ...state.taskBudgetRuntime.stepBudget }
          : null
      }
      state.adoptResolvedTaskTypeBudget(taskExecutionRoute.taskType)
      // Phase 4.2 — continuation inherits the budget seed from the original
      // task type instead of collapsing to the 24-iter `continuation` preset.
      // Audit Phase 4 §C4: a multi_step or media task resumed across processes
      // / after a Ready restart would otherwise hit the 70% warning at iter
      // 16, well before the original task's natural ceiling.
      //
      // RE-AUDIT FIX 4.2 — applies to BOTH fresh and restored continuations
      // (original Phase 4.2 only covered fresh; restored runtimes that lost
      // the long-skill budget cross-process were stuck at the saved value).
      //
      // SCREENSHOT-BUG follow-up — gate the override on the ORIGINAL task
      // type being long (multi_step / media). Don't override for short
      // task types because the saved budget there was likely a deliberate
      // small value (e.g. a turn-engine-route test saving 12 iter for a
      // short_task continuation that should remain 12, not get bumped to
      // the standard 24 just because that's the continuation preset).
      // Audit Phase 4 §C4 was specifically about long-task throttling,
      // not about uniformly forcing every continuation to the standard
      // preset.
      if (
        taskExecutionRoute.chain === 'continuation'
        && (
          continuationProjection?.taskType === 'multi_step_task'
          || continuationProjection?.taskType === 'media_task'
        )
      ) {
        const inheritedSeed = createContinuationRunBudgetSeed(continuationProjection.taskType)
        const previousMaxIterations = state.effectiveRunBudget?.maxIterations ?? null
        if (inheritedSeed.maxIterations > (previousMaxIterations ?? 0)) {
          state.effectiveRunBudget = { ...inheritedSeed }
          if (state.taskBudgetRuntime) {
            state.taskBudgetRuntime = {
              ...state.taskBudgetRuntime,
              budget: { ...inheritedSeed },
            }
          }
          logAgentMetric('continuation_budget_inherited', {
            sessionId: request.sessionId,
            originalTaskType: continuationProjection.taskType,
            previousMaxIterations,
            inheritedMaxIterations: inheritedSeed.maxIterations,
            hadRestoredRuntime: Boolean(taskExecutionRoute.continuation?.budgetRuntime),
          })
        }
      }
      let alignedRunBudget = state.effectiveRunBudget || createRunBudgetSeed(taskExecutionRoute.taskType)
      if (shouldUseLongSkillResumeBudget) {
        alignedRunBudget = applyLongSkillTaskBudgetSeed(alignedRunBudget)
        logAgentMetric('long_skill_task_budget_applied', {
          sessionId: request.sessionId,
          taskType: taskExecutionRoute.taskType,
          maxIterations: alignedRunBudget.maxIterations,
          maxToolCalls: alignedRunBudget.maxToolCalls,
          referenceSkillId: referenceSkillForMetrics?.id || null,
          preferredSkillTools: preferredSkillToolNames || [],
        })
      }
      state.effectiveRunBudget = alignedRunBudget
      state.degradationReason = taskExecutionRoute.degradationReason || null
      const routedAllowedToolNames = selectedDomainPrepareResult?.allowedToolNames || reconciledRunCapabilities.allowedToolNames
      logAgentMetric('turn_frame_tool_policy', {
        sessionId: request.sessionId,
        mode: turnFrame?.mode || null,
        skillId: turnFrame?.skill?.skillId || referenceSkillForMetrics?.id || null,
        liveness: turnFrame?.liveness || null,
        preferredToolNames: preferredSkillToolNames || [],
        allowedToolNames: routedAllowedToolNames,
        terminalReason: turnFrame?.terminalReason || null,
      })
      appendSessionMessages(session, selectedDomainPrepareResult?.sessionMessages)
      if (taskExecutionRoute.chain === 'continuation' && taskExecutionRoute.continuation) {
        state.interactionState = 'resuming'
      }
      state.stepBudgetState = normalizeStepBudgetState(taskExecutionRoute.continuation?.budgetRuntime?.stepBudget)
        || normalizeStepBudgetState(continuationState?.budgetRuntime?.stepBudget)
        || normalizeStepBudgetState(continuationState?.budget?.stepBudget)
        || normalizeStepBudgetState(continuationProjection?.budget?.stepBudget)
        || (
          taskExecutionRoute.steps.length > 0
            ? createStepBudgetState({
              stepId: taskExecutionRoute.steps[0]?.id || null,
              totalIterations: alignedRunBudget.maxIterations,
              stepCount: taskExecutionRoute.steps.length,
              suggestedMaxIterations: taskExecutionRoute.steps[0]?.budget,
            })
            : createStepBudgetState({
              stepId: null,
              totalIterations: alignedRunBudget.maxIterations,
              suggestedMaxIterations: alignedRunBudget.maxIterations,
            })
        )
      state.runtimeTaskSteps = taskExecutionRoute.steps.map((step) => ({ ...step }))
      state.runtimeCurrentStepId = taskExecutionRoute.currentStepId || taskExecutionRoute.steps[0]?.id || null
      if (taskExecutionRoute.chain === 'planner') {
        const initialPlannerProgress = initializeTaskStepProgress(taskExecutionRoute.steps)
        state.runtimeTaskSteps = initialPlannerProgress.steps
        state.runtimeCurrentStepId = initialPlannerProgress.currentStepId
      }
      const structuredModule =
        taskTypeResolution.preferredExecutor && taskTypeResolution.preferredExecutor !== 'none'
          ? taskTypeResolution.preferredExecutor
          : 'system'
      const emitRuntimeTaskPayload = (options: {
        summary: string
        waitingFor?: 'input' | 'confirmation' | 'agent_result' | 'background' | 'clarification' | 'none'
        resumableActions?: Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'>
        blockedReason?: string | null
      }) => {
        emitStructuredTaskPayload({
          module: structuredModule,
          message: options.summary,
          taskTitle: executionIntentContext.userInstructionText || '任务执行',
          taskSummary: options.summary,
          steps: state.runtimeTaskSteps.map((step) => ({
            id: step.id,
            title: step.title || step.description,
            status: step.status || 'pending',
            detail: step.detail || null,
            updatedAt: step.updatedAt || new Date().toISOString(),
          })),
          currentStepId: state.runtimeCurrentStepId,
          waitingFor: options.waitingFor || 'none',
          resumableActions: options.resumableActions || ['cancel'],
          blockedReason: options.blockedReason || null,
        })
      }
      const advancePlannerStep = (summary: string): boolean => {
        if (taskExecutionRoute.chain !== 'planner') return false
        const next = advanceTaskStepProgress({
          steps: state.runtimeTaskSteps,
          currentStepId: state.runtimeCurrentStepId,
          totalIterations: alignedRunBudget.maxIterations,
          summary,
        })
        state.runtimeTaskSteps = next.steps
        state.runtimeCurrentStepId = next.currentStepId
        state.stepBudgetState = next.stepBudget
          ? {
            stepId: next.stepBudget.stepId || null,
            maxIterations: next.stepBudget.maxIterations,
            remainingIterations: next.stepBudget.remainingIterations,
          }
          : null
        emitRuntimeTaskPayload({ summary })
        return next.advanced
      }
      const syncInteractionStateFromAssistantText = (text: string): boolean => {
        const detected = detectGenericInteractionState(text)
        if (!detected) return false
        state.interactionState = detected.interactionState
        emitRuntimeTaskPayload({
          summary: text,
          waitingFor: detected.waitingFor,
          resumableActions: detected.resumableActions,
          blockedReason: detected.blockedReason,
        })
        return true
      }
      let activeDomainState = selectedDomainPrepareResult?.domainState
      const emitDomainProjection = (projection: DomainAdapterApplyResult['projection'], domainStateForProjection: unknown): void => {
        if (!selectedDomainAdapter || !projection) return
        const patch = selectedDomainAdapter.buildProjectionPatch({
          route: taskExecutionRoute,
          request: requestForAdapters,
          executionIntentContext,
          toolPolicy,
          domainState: domainStateForProjection,
          projection,
        })
        if (patch) {
          emitStructuredTaskPayload(patch)
        }
      }
      state.syncBudgetWarning()
      if (taskExecutionRoute.chain === 'planner' && taskExecutionRoute.steps.length > 0) {
        emitRuntimeTaskPayload({ summary: '已拆分任务步骤，开始逐步执行' })
        session.messages.push({
          role: 'user',
          content: [
            '系统规划步骤：',
            ...state.runtimeTaskSteps.map((step, index) =>
              `${index + 1}. ${step.title || step.description}（预算 ${step.budget || 0} 轮）`
            ),
            '请严格按以上步骤推进，并在接近预算上限时主动收敛总结。',
          ].join('\n'),
        })
      }
      const hostToolContext = buildHostToolContext(routedAllowedToolNames)
      const hostShortcutResult = await hostCapabilityDispatcher.dispatch({
        decision: reconciledRunCapabilities.hostShortcutDecision,
        toolContext: hostToolContext,
      })
      if (hostShortcutResult.handled) {
        if (hostShortcutResult.toolUseText) {
          transcript.emitOutput(hostShortcutResult.toolUseText, 'tool_use')
        }
        if (hostShortcutResult.outputText) {
          transcript.emitOutput(hostShortcutResult.outputText.slice(0, 300), 'tool_result')
          transcript.emitOutput(hostShortcutResult.outputText, 'text')
          pushAssistantTextSafely(session, hostShortcutResult.outputText, { sessionId: request.sessionId })
        }
        return finish({ success: true, status: 'done' })
      }

      if (selectedDomainAdapter && taskExecutionRoute.chain !== 'direct') {
        const domainDispatchResult = await selectedDomainAdapter.dispatch({
          route: taskExecutionRoute,
          request: requestForAdapters,
          host: hostForAdapters,
          session,
          userText,
          pureUserInput,
          requestEnvelope,
          executionIntentContext,
          hasTools,
          toolPolicy,
          allowedToolNames: routedAllowedToolNames,
          domainState: activeDomainState,
          emitStructuredTaskPayload,
        })
        activeDomainState = typeof domainDispatchResult.domainState === 'undefined'
          ? activeDomainState
          : domainDispatchResult.domainState
        appendSessionMessages(session, domainDispatchResult.sessionMessages)
        emitDomainProjection(domainDispatchResult.projection || null, activeDomainState)
        if (domainDispatchResult.interactionState) {
          state.interactionState = domainDispatchResult.interactionState
        }
        if (domainDispatchResult.finalText) {
          transcript.emitOutput(domainDispatchResult.finalText, 'text')
          pushAssistantTextSafely(session, domainDispatchResult.finalText, { sessionId: request.sessionId })
        }
        if (domainDispatchResult.finish) {
          return finish({
            success: domainDispatchResult.finish.success,
            cancelled: domainDispatchResult.finish.cancelled,
            status: domainDispatchResult.finish.status,
          })
        }
      }

      if (!state.resolvedTaskType) {
        state.resolvedTaskType = hasTools ? 'short_task' : 'direct_answer'
      }
      if (!state.effectiveRunBudget) {
        state.effectiveRunBudget = createRunBudgetSeed(state.resolvedTaskType)
      }
      const shouldUseToolLoop = Boolean(hasTools && taskExecutionRoute.chain !== 'direct')

      if (!shouldUseToolLoop) {
        const hasMediaInputs = host.sessionHasMediaInputs(session.messages)
        const simpleResponse = await host.requestSimpleText({
          session,
          signal: request.abortSignal,
          providerContext: host.providerContext,
          enableKimiWebSearch: !hasMediaInputs,
        }) as TurnSimpleResponse
        if (simpleResponse.fallback) {
          state.latestFallback = simpleResponse.fallback
        }
        if (simpleResponse.text) {
          syncInteractionStateFromAssistantText(simpleResponse.text)
          if (taskExecutionRoute.chain === 'planner' && detectTaskStepCompletionCue(simpleResponse.text, state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId))) {
            advancePlannerStep(simpleResponse.text)
          }
          transcript.emitOutput(simpleResponse.text, 'text')
          pushAssistantTextSafely(session, simpleResponse.text, { sessionId: request.sessionId })
        }
        return finish({ success: true, status: 'done' })
      }

      let designToolLoopState = designToolLoopOrchestrator.createState()
      const hintedRuntimeBase = state.syncTaskBudgetRuntime() || state.taskBudgetRuntime
      if (!hintedRuntimeBase) {
        throw new Error('turn engine failed to initialize runtime budget')
      }
      state.taskBudgetRuntime = applyRuntimeBudgetHint(
        hintedRuntimeBase,
        selectedDomainPrepareResult?.budgetHint || null,
      )
      state.taskBudgetRuntime = applyRuntimeBudgetHint(
        state.taskBudgetRuntime,
        designToolLoopOrchestrator.getBudgetHint({
          forceDesignTool: (toolPolicy as any).forceDesignTool,
          primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
        }),
      )
      state.effectiveRunBudget = state.taskBudgetRuntime.budget
      state.stepBudgetState = state.taskBudgetRuntime.stepBudget
        ? { ...state.taskBudgetRuntime.stepBudget }
        : null
      state.budgetWarningLevel = state.taskBudgetRuntime.warningLevel
      let effectiveMaxToolIterations = state.effectiveRunBudget.maxIterations > 0
        ? state.effectiveRunBudget.maxIterations
        : host.maxToolIterations
      let iterations = 0
      let finishedBeforeLimit = false
      let textToolBridgeNudges = 0
      let budgetLimitedBeforeCompletion = false
      let convergencePromptInjected = false
      let preferTextToolBridgeOnce = false
      let lastLongTypedSkillActionIteration: number | null = null
      const longTypedSkillActionStartTimes = new Map<string, number>()
      // skill-resume C1: ring buffer of recent tool calls for repetition detection.
      // When the same tool is called with the same args ≥3 times in the last 5
      // iterations, we inject an ask-user nudge to break the loop.
      const recentToolCalls: Array<{ name: string; argsHash: string }> = []
      const RECENT_TOOL_CALLS_RING_SIZE = 5
      const REPETITION_THRESHOLD = 3
      // skill-resume C3: prepend a system warning when 70% of the iteration
      // budget is consumed, reminding the LLM to summarize and consult the user.
      let warned70Pct = false
      let warningThreshold = computeBudgetWarningThreshold(effectiveMaxToolIterations)
      const toolGuidance = buildToolGuidance(toolPolicy as any)
      const toolLoopSession = toolGuidance
        ? {
          ...session,
          systemPrompt: `${session.systemPrompt}\n\n${toolGuidance}`,
        }
        : session
      let skillBudgetLeaseState: SkillBudgetLeaseState | null = state.taskBudgetRuntime?.lease || null
      let previousLeaseSnapshot: SkillTaskSupervisorSnapshot | null = null
      let lastLeaseSnapshot: SkillTaskSupervisorSnapshot | null = null
      let lastLeaseProgress: SkillProgressScore = {
        score: 0,
        reasons: [],
        fingerprint: skillBudgetLeaseState?.lastFingerprint || null,
        fingerprintChanged: false,
        milestoneChanged: false,
      }
      let lastLeaseWaste: SkillWasteScore = {
        score: 0,
        reasons: [],
        repeatedUnchangedObservation: false,
        repeatedRecoverableError: false,
        repeatedToolCallStreak: 0,
        recoverableErrorKind: null,
        recoverableErrorCount: 0,
      }
      let leaseLifecycleReason: 'budget_exhausted' | 'background_running' | null = null
      const hasPlannedLeaseTrigger =
        shouldUseLongSkillResumeBudget
        || hasLongTypedSkillAction(preferredSkillToolNames)
      const sampleSkillLeaseSnapshot = (force = false): SkillTaskSupervisorSnapshot | null => {
        if (!force && !hasPlannedLeaseTrigger && !skillBudgetLeaseState) return null
        try {
          return inspectLatestSkillTaskForHost({
            sessionId: request.sessionId,
            scopeId: request.sessionId,
            skillId: referenceSkillForMetrics?.id || null,
          })
        } catch {
          return null
        }
      }
      const hasRecoverableSkillLeaseSnapshot = (snapshot: SkillTaskSupervisorSnapshot | null): boolean => {
        if (!snapshot) return false
        if (snapshot.closeAllowed && snapshot.status === 'done') return false
        return Boolean(
          snapshot.hasLiveWork
            || snapshot.hasRecentProgress
            || snapshot.runStatePath
            || snapshot.outputDir
            || snapshot.detachedTaskId
            || snapshot.taskRunId
            || snapshot.resumePayload,
        )
      }
      const observedLeaseSnapshot = hasPlannedLeaseTrigger || skillBudgetLeaseState
        ? null
        : sampleSkillLeaseSnapshot(true)
      const hasLeaseTrigger = hasPlannedLeaseTrigger || hasRecoverableSkillLeaseSnapshot(observedLeaseSnapshot)
      const publishSkillBudgetLease = (): void => {
        if (!skillBudgetLeaseState) return
        if (!state.effectiveRunBudget) state.effectiveRunBudget = createRunBudgetSeed('multi_step_task')
        const leaseEndIteration = Math.min(
          skillBudgetLeaseState.currentLeaseEndIteration,
          skillBudgetLeaseState.hardCapIteration,
        )
        const leaseIterationLimit = Math.max(iterations + 1, leaseEndIteration)
        state.effectiveRunBudget = {
          ...state.effectiveRunBudget,
          maxIterations: leaseIterationLimit,
          maxToolCalls: leaseIterationLimit,
        }
        effectiveMaxToolIterations = leaseIterationLimit
        warningThreshold = computeBudgetWarningThreshold(skillBudgetLeaseState.currentLeaseEndIteration)
        state.taskBudgetRuntime = {
          ...(state.syncTaskBudgetRuntime() || createTaskBudgetRuntime('multi_step_task', {
            budget: state.effectiveRunBudget,
            usage: state.runBudgetState,
            stepBudget: state.stepBudgetState,
          })),
          lease: skillBudgetLeaseState,
        }
        state.syncBudgetWarning()
      }
      const ensureSkillBudgetLease = (reason: 'planned' | 'observed_long_skill_action' | 'observed_supervisor_snapshot'): void => {
        if (skillBudgetLeaseState) return
        skillBudgetLeaseState = createSkillBudgetLeaseState({ iteration: iterations })
        logAgentMetric('skill_budget_lease_created', {
          sessionId: request.sessionId,
          leaseId: skillBudgetLeaseState.leaseId,
          leaseEndIteration: skillBudgetLeaseState.currentLeaseEndIteration,
          hardCapIteration: skillBudgetLeaseState.hardCapIteration,
          referenceSkillId: referenceSkillForMetrics?.id || null,
          reason,
        })
      }
      if (hasLeaseTrigger) {
        if (observedLeaseSnapshot) {
          const observedActiveSkillContext = resolveActiveSkillContext({
            sessionId: request.sessionId,
            supervisorSnapshot: observedLeaseSnapshot,
            inspectSupervisor: false,
          })
          if (observedActiveSkillContext) {
            activeSkillContextForTurn = observedActiveSkillContext
            rememberActiveSkillContext(request.sessionId, observedActiveSkillContext)
            if (!referenceSkillForMetrics?.id) {
              referenceSkillForMetrics = {
                id: observedActiveSkillContext.skillId,
                name: observedActiveSkillContext.skillName || observedActiveSkillContext.skillId,
              }
            }
            host.log(`[active_skill_context] ${JSON.stringify(summarizeActiveSkillContext(observedActiveSkillContext))}`)
            if (turnFrame) {
              turnFrame = applySupervisorRuntimeToTurnFrame(turnFrame, observedLeaseSnapshot)
            }
            host.log(`[turn_frame] ${JSON.stringify(summarizeTurnFrame(turnFrame))}`)
            logAgentMetric('turn_frame_resolved', summarizeTurnFrame(turnFrame) || {})
          }
        }
        ensureSkillBudgetLease(observedLeaseSnapshot ? 'observed_supervisor_snapshot' : 'planned')
        if (observedLeaseSnapshot) {
          previousLeaseSnapshot = observedLeaseSnapshot
          lastLeaseSnapshot = observedLeaseSnapshot
        }
      }
      publishSkillBudgetLease()

      while (iterations < effectiveMaxToolIterations) {
        request.ensureNotAborted()
        if (state.syncTaskBudgetRuntime()?.frozen) {
          state.interactionState = 'suspended'
          break
        }
        const leaseEvaluationIteration = skillBudgetLeaseState
          ? Math.max(0, skillBudgetLeaseState.currentLeaseEndIteration - 2)
          : Number.POSITIVE_INFINITY
        if (skillBudgetLeaseState && iterations >= leaseEvaluationIteration) {
          const evaluation = evaluateSkillBudgetLease({
            state: skillBudgetLeaseState,
            iteration: iterations,
            progress: lastLeaseProgress,
            waste: lastLeaseWaste,
            snapshot: lastLeaseSnapshot || sampleSkillLeaseSnapshot(),
          })
          skillBudgetLeaseState = evaluation.state
          publishSkillBudgetLease()
          logAgentMetric('skill_budget_lease_decision', {
            sessionId: request.sessionId,
            leaseId: skillBudgetLeaseState.leaseId,
            decision: evaluation.decision,
            reason: evaluation.reason,
            iteration: iterations,
            renewalsUsed: skillBudgetLeaseState.renewalsUsed,
            progressScore: skillBudgetLeaseState.progressScore,
            wasteScore: skillBudgetLeaseState.wasteScore,
          })
          if (evaluation.decision === 'renew' || evaluation.decision === 'active') {
            // Keep moving under the refreshed lease gate.
          } else if (evaluation.decision === 'close') {
            finishedBeforeLimit = true
            break
          } else {
            leaseLifecycleReason = evaluation.decision === 'handoff_background'
              ? 'background_running'
              : 'budget_exhausted'
            budgetLimitedBeforeCompletion = true
            break
          }
        }
        if (taskExecutionRoute.chain === 'planner' && (state.stepBudgetState?.remainingIterations || 0) <= 0) {
          const advanced = advancePlannerStep('当前步骤预算已耗尽，已切换到下一步继续推进。')
          if (advanced) {
            state.syncBudgetWarning()
            continue
          }
        }
        if (state.budgetWarningLevel === 'exhausted' || (state.stepBudgetState?.remainingIterations || 0) <= 0) {
          budgetLimitedBeforeCompletion = true
          break
        }
        if (state.budgetWarningLevel === 'converge' && !convergencePromptInjected) {
          // Phase 3.3 — skill-aware nudge. For long skill flows, "summarize
          // and ask user" is a reverse instruction; we send "keep going,
          // prefer typed actions" instead. Audit Phase 3 §D4.
          session.messages.push({
            role: 'user',
            content: buildBudgetWarningMessage({
              iterations,
              effectiveMaxIterations: effectiveMaxToolIterations,
              level: 'converge',
              isLongSkillContext: shouldUseLongSkillResumeBudget || (preferredSkillToolNames?.length || 0) > 0,
            }),
          })
          convergencePromptInjected = true
        }
        iterations += 1
        Object.assign(state.runBudgetState, consumeIterationBudget(state.runBudgetState))
        if (state.stepBudgetState) {
          state.stepBudgetState = {
            ...state.stepBudgetState,
            remainingIterations: Math.max(0, Number(state.stepBudgetState.remainingIterations || 0) - 1),
          }
        }
        state.syncBudgetWarning()

        // skill-resume C3: 70% iteration warning — fire ONCE per run.
        if (shouldInjectBudgetWarning({
          warned: warned70Pct,
          iteration: iterations,
          warningThreshold,
          lastLongTypedSkillActionIteration,
        })) {
          warned70Pct = true
          logAgentMetric('turn_budget_warning', {
            sessionId: request.sessionId,
            taskType: state.resolvedTaskType || null,
            iteration: iterations,
            maxIterations: effectiveMaxToolIterations,
            warningThreshold,
            referenceSkillId: referenceSkillForMetrics?.id || null,
            referenceSkillName: referenceSkillForMetrics?.name || null,
            preferredSkillTools: preferredSkillToolNames || [],
            longSkillResume: shouldUseLongSkillResumeBudget,
          })
          // Phase 3.3 — skill-aware 70% nudge. Audit Phase 3 §D3.
          session.messages.push({
            role: 'user',
            content: buildBudgetWarningMessage({
              iterations,
              effectiveMaxIterations: effectiveMaxToolIterations,
              level: 'warning',
              isLongSkillContext: shouldUseLongSkillResumeBudget || (preferredSkillToolNames?.length || 0) > 0,
            }),
          })
        }
        const scope = request.sessionId ? host.runtime?.getConversationScope?.(request.sessionId) : undefined
        const toolContext = buildHostToolContext(routedAllowedToolNames, scope)
        const toolLoopRequestSnapshot = buildHostToolSnapshot({
          stage: 'tool_loop_request',
          iteration: iterations,
          host,
          hasTools: reconciledRunCapabilities.visibilityPlan.hasTools,
          allowBrowserTools: toolPolicy.allowBrowserTools,
          browserDecisionMode: browserDecision.mode,
          browserHostAvailable: reconciledRunCapabilities.runtimeSnapshot.environment.browserHostAvailable,
          visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
          suppressedCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.suppressedCapabilityGroupIds || [],
          allowedToolNames: routedAllowedToolNames,
          preferTextToolBridge: preferTextToolBridgeOnce,
        })
        appendLoggedToolSnapshot(state, host, toolLoopRequestSnapshot)
        let response: TurnModelResponse
        try {
          response = await host.requestToolLoopResponse({
            session: toolLoopSession,
            signal: request.abortSignal,
            toolPolicy,
            allowedToolNames: routedAllowedToolNames,
            hasTools: reconciledRunCapabilities.visibilityPlan.hasTools,
            allowBrowserTools: toolPolicy.allowBrowserTools,
            providerContext: host.providerContext,
            hasVideoInputs,
            browserDecisionMode: browserDecision.mode,
            runtimeSnapshot: {
              browserHostAvailable: reconciledRunCapabilities.runtimeSnapshot.environment.browserHostAvailable,
              groups: reconciledRunCapabilities.runtimeSnapshot.groups,
            },
            visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
            suppressedCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.suppressedCapabilityGroupIds || [],
            capabilityLogLine: reconciledRunCapabilities.capabilityLogLine,
            iteration: iterations,
            requestedTransport: toolLoopRequestSnapshot.requestedTransport,
            supportsNativeTools: toolLoopRequestSnapshot.supportsNativeTools,
            preferTextToolBridgeOnce,
            compressContext: () => compressSessionMessagesForRetry(session),
          }) as TurnModelResponse
        } finally {
          preferTextToolBridgeOnce = false
        }
        if (response.fallback) {
          state.latestFallback = response.fallback
        }
        state.appendToolSnapshots(response.toolSnapshots)
        state.appendRecoveryHistory(response.recoveryHistory)

        if (response.toolCalls.length === 0) {
          const responseTextForRecovery = response.rawText || response.text || ''
          if (/<tool_call>|<function=|<parameter=|:::tool_call/i.test(responseTextForRecovery)) {
            const parsed = parseTextToolBridgeResponse(responseTextForRecovery)
            if (parsed.toolCalls.length > 0) {
              const allowedToolNameSet = new Set(routedAllowedToolNames)
              const disallowedToolNames = Array.from(new Set(
                parsed.toolCalls
                  .map((call) => call.name)
                  .filter((name) => !allowedToolNameSet.has(name)),
              ))
              if (disallowedToolNames.length === 0) {
                logAgentMetric(TOOL_ERROR_METRICS.xmlToolCallsRecoveredFromNative, {
                  route: 'turn_engine_tool_loop',
                  originalCallsCount: 0,
                  recoveredCallsCount: parsed.toolCalls.length,
                  recoveredToolNames: parsed.toolCalls.map((call) => call.name).slice(0, 5),
                  originalTextLen: responseTextForRecovery.length,
                  cleanedTextLen: parsed.visibleText.length,
                })
                host.log(
                  `[xml_recovery] turn_engine_tool_loop: recovered ${parsed.toolCalls.length} text tool_call(s) from provider text response.`,
                )
                response = {
                  ...response,
                  text: parsed.visibleText,
                  rawText: responseTextForRecovery,
                  toolCalls: parsed.toolCalls.map((call) => ({
                    id: `xmlrec_${randomUUID().replace(/-/g, '')}`,
                    name: call.name,
                    input: call.args,
                  })),
                  toolTransport: 'text',
                }
              } else if (textToolBridgeNudges < 2) {
                textToolBridgeNudges += 1
                if (responseTextForRecovery) {
                  pushAssistantTextSafely(session, responseTextForRecovery, {
                    sessionId: request.sessionId,
                    iteration: iterations,
                    toolTransport: response.toolTransport,
                  })
                }
                preferTextToolBridgeOnce = true
                session.messages.push({
                  role: 'user',
                  content: [
                    buildTextToolBridgeCorrectionMessage(toolPolicy as any),
                    `系统补充：你刚才输出了未允许的工具 ${disallowedToolNames.join(', ')}。请只调用当前 allowed tools 中的工具；如果没有合适工具，说明缺口而不要把 tool_call 当普通文本结束。`,
                  ].join('\n'),
                })
                continue
              }
            }
          }
        }

        if (response.toolCalls.length === 0) {
          const activeBrowserToolLoopState = (activeDomainState as { browserToolLoopState?: { isBrowserTask?: boolean } } | null | undefined)
            ?.browserToolLoopState
          const browserToolRetryNeeded = shouldEnforceBrowserToolRetry({
            isBrowserTask: Boolean(activeBrowserToolLoopState?.isBrowserTask),
            toolCallsCount: response.toolCalls.length,
            toolTransport: response.toolTransport,
            responseText: response.text || response.rawText || '',
          })
          if (browserToolRetryNeeded && textToolBridgeNudges < 2) {
            textToolBridgeNudges += 1
            const assistantHistoryText = response.rawText || response.text
            if (assistantHistoryText) {
              pushAssistantTextSafely(session, assistantHistoryText, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
            }
            preferTextToolBridgeOnce = true
            session.messages.push({
              role: 'user',
              content: [
                buildTextToolBridgeCorrectionMessage(toolPolicy as any),
                '系统补充：当前任务是浏览器任务，至少先调用一个 browser_* 工具（例如 browser_search、browser_navigate、browser_read_page），不要直接解释这轮工具列表。',
              ].join('\n'),
            })
            continue
          }
          if (response.toolTransport === 'text' && response.rawText) {
            pushAssistantTextSafely(session, response.rawText, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
            if (looksLikeMissingNativeToolsReply(response.text || response.rawText) && textToolBridgeNudges < 2) {
              textToolBridgeNudges += 1
              preferTextToolBridgeOnce = true
              session.messages.push({
                role: 'user',
                content: buildTextToolBridgeCorrectionMessage(toolPolicy as any),
              })
              continue
            }
          }
          const plannerStepCompleted = response.text
            ? detectTaskStepCompletionCue(response.text, state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId))
            : false
          if (selectedDomainAdapter) {
            const domainApplyResult = await selectedDomainAdapter.applyResult({
              route: taskExecutionRoute,
              request: requestForAdapters,
              host: hostForAdapters,
              session,
              userText,
              pureUserInput,
              requestEnvelope,
              executionIntentContext,
              hasTools,
              toolPolicy,
              allowedToolNames: routedAllowedToolNames,
              emitStructuredTaskPayload,
              domainState: activeDomainState,
              phase: 'no_tool_call',
              responseText: response.text,
              toolTransport: response.toolTransport,
            })
            activeDomainState = typeof domainApplyResult.domainState === 'undefined'
              ? activeDomainState
              : domainApplyResult.domainState
            emitDomainProjection(domainApplyResult.projection || null, activeDomainState)
            if (domainApplyResult.interactionState) {
              state.interactionState = domainApplyResult.interactionState
            }
            if (domainApplyResult.nextUserMessage) {
              if (domainApplyResult.preserveAssistantText && response.text && response.toolTransport !== 'text') {
                pushAssistantTextSafely(session, response.text, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
              }
              session.messages.push({
                role: 'user',
                content: domainApplyResult.nextUserMessage,
              })
              continue
            }
            if (domainApplyResult.finalText) {
              transcript.emitOutput(domainApplyResult.finalText, 'text')
              pushAssistantTextSafely(session, domainApplyResult.finalText, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
              advancePlannerStep(domainApplyResult.finalText)
              finishedBeforeLimit = true
              break
            }
          }
          if (response.text) {
            const genericInteractionDetected = syncInteractionStateFromAssistantText(response.text)
            if (!shouldHideBrowserProcessText || genericInteractionDetected) {
              transcript.emitOutput(response.text, 'text')
            }
            if (plannerStepCompleted) {
              const advanced = advancePlannerStep(response.text)
              if (advanced) {
                session.messages.push({
                  role: 'user',
                  content: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
                })
                continue
              }
            }
            if (genericInteractionDetected) {
              pushAssistantTextSafely(session, response.text, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
              finishedBeforeLimit = true
              break
            }
          }
          if (response.text && response.toolTransport !== 'text' && !shouldHideBrowserProcessText) {
            pushAssistantTextSafely(session, response.text, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
          }
          finishedBeforeLimit = true
          break
        }

        const designToolFilter = designToolLoopOrchestrator.filterToolCalls({
          toolCalls: response.toolCalls,
          policy: toolPolicy,
          primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
        })
        if (designToolFilter.nextUserMessage) {
          emitStructuredTaskPayload(designToolLoopOrchestrator.buildStructuredTaskPayload({
            taskTitle: '设计任务',
            taskSummary: designToolFilter.nextUserMessage,
            state: designToolLoopState,
            phase: 'blocked',
          }))
          session.messages.push({
            role: 'user',
            content: designToolFilter.nextUserMessage,
          })
          continue
        }
        const toolCallsForIteration = designToolFilter.toolCalls
          .map((toolCall) => designToolLoopOrchestrator.applySourceInput(toolCall, toolPolicy))
        const recentToolCallsBeforeIteration = [...recentToolCalls]
        const recordRecentToolCallsForIteration = (): void => {
          for (const toolCall of toolCallsForIteration) {
            const argsHash = createHash('sha1').update(JSON.stringify(toolCall.input ?? null)).digest('hex').slice(0, 16)
            recentToolCalls.push({ name: toolCall.name, argsHash })
            if (recentToolCalls.length > RECENT_TOOL_CALLS_RING_SIZE) recentToolCalls.shift()
          }
          const last = recentToolCalls[recentToolCalls.length - 1]
          if (!last) return
          const matchCount = countToolRepetitions(recentToolCalls)
          if (matchCount < REPETITION_THRESHOLD) return
          logAgentMetric(TOOL_ERROR_METRICS.toolLoopRepetitionDetected, {
            tool: last.name,
            repetitions: matchCount,
            sessionId: request.sessionId,
          })
          session.messages.push({
            role: 'user',
            content: `系统提醒：你已经连续 ${matchCount} 次以相同参数调用 ${last.name}。请改用 skill_ask_user 询问用户下一步该怎么做，或换一种方法（不同参数 / 不同工具）。`,
          })
          recentToolCalls.length = 0
        }
        if (toolCallsForIteration.some((toolCall) => isLongTypedSkillActionName(toolCall.name))) {
          ensureSkillBudgetLease('observed_long_skill_action')
          publishSkillBudgetLease()
        }
        const remainingToolCallBudget = getRemainingToolCallBudget(state.effectiveRunBudget, state.runBudgetState)
        if (remainingToolCallBudget < toolCallsForIteration.length) {
          budgetLimitedBeforeCompletion = true
          break
        }

        let executedDocActionCount = 0
        let executedMutatingDocActionCount = 0
        let executedInspectionDocActionCount = 0
        let executedSaveDocActionCount = 0
        let executedBrowserToolsThisIteration = 0
        let browserToolResultsThisIteration: Array<{ toolName: string; resultText: string }> = []
        let executedPrimaryDesignToolThisIteration = false
        let documentToolResultsThisIteration: string[] = []
        let documentToolInspectionsThisIteration: unknown[] = []
        let executedToolsThisIteration: Array<{
          id: string
          name: string
          input: Record<string, unknown>
          result: ToolExecutionOutput
        }> = []

        const longTypedSkillActionHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
        const emitLongTypedSkillRunningProjection = (toolCall: TurnToolCall, startedAt: number): void => {
          transcript.emitStructuredPayload(buildLongSkillRunningProjection({
            sessionId: request.sessionId,
            toolName: toolCall.name,
            toolInput: toolCall.input,
            startedAt,
            now: Date.now(),
          }))
        }
        const clearLongTypedSkillHeartbeat = (toolCallId: string): void => {
          const timer = longTypedSkillActionHeartbeatTimers.get(toolCallId)
          if (timer) clearInterval(timer)
          longTypedSkillActionHeartbeatTimers.delete(toolCallId)
        }
        const clearAllLongTypedSkillHeartbeats = (): void => {
          for (const timer of longTypedSkillActionHeartbeatTimers.values()) {
            clearInterval(timer)
          }
          longTypedSkillActionHeartbeatTimers.clear()
        }

        const executeBatch = async () => {
          try {
            return normalizeToolBatchResult(await host.executeToolBatch({
              toolCalls: toolCallsForIteration,
              context: toolContext,
              budget: state.effectiveRunBudget || undefined,
              budgetState: state.runBudgetState,
              signal: request.abortSignal,
              hooks: {
                onToolStart: ({ toolCall }) => {
                  transcript.emitToolUse(toolCall.name, toolCall.input)
                  if (isLongTypedSkillActionName(toolCall.name)) {
                    const startedAt = Date.now()
                    longTypedSkillActionStartTimes.set(toolCall.id, startedAt)
                    emitLongTypedSkillRunningProjection(toolCall, startedAt)
                    longTypedSkillActionHeartbeatTimers.set(
                      toolCall.id,
                      setInterval(() => {
                        emitLongTypedSkillRunningProjection(toolCall, startedAt)
                      }, LONG_TYPED_SKILL_ACTION_HEARTBEAT_MS),
                    )
                  }
                },
                onToolResult: ({ toolCall }) => {
                  if (!isLongTypedSkillActionName(toolCall.name)) return
                  clearLongTypedSkillHeartbeat(toolCall.id)
                  const startedAt = longTypedSkillActionStartTimes.get(toolCall.id)
                  if (typeof startedAt !== 'number') return
                  longTypedSkillActionStartTimes.delete(toolCall.id)
                  logAgentMetric('skill_typed_action_duration_ms', {
                    sessionId: request.sessionId,
                    toolName: toolCall.name,
                    iteration: iterations,
                    durationMs: Math.max(0, Date.now() - startedAt),
                    referenceSkillId: referenceSkillForMetrics?.id || null,
                    referenceSkillName: referenceSkillForMetrics?.name || null,
                  })
                },
                onToolRecovered: ({ toolCall, recoveryHistory }) => {
                  const lastRecovery = recoveryHistory[recoveryHistory.length - 1]
                  if (!lastRecovery) return
                  host.log(`tool recover: ${toolCall.name}, kind=${lastRecovery.kind}, recovered=${lastRecovery.recovered}`)
                },
                onBatchInterrupted: ({ startedToolCallIds, skippedToolCalls }) => {
                  clearAllLongTypedSkillHeartbeats()
                  host.log(`tool batch interrupted: started=${startedToolCallIds.join('|') || 'none'}, skipped=${skippedToolCalls.map((toolCall) => toolCall.name).join('|') || 'none'}`)
                },
              },
              onGroupStart: (group) => {
                if (group.mode === 'parallel') {
                  Object.assign(state.runBudgetState, consumeParallelGroupBudget(state.runBudgetState))
                }
              },
            }))
          } finally {
            clearAllLongTypedSkillHeartbeats()
          }
        }

        const consumeExecutedToolBatch = (executedToolBatch: Awaited<ReturnType<typeof executeBatch>>, params: {
          onResult: (payload: {
            executedTool: typeof executedToolBatch.results[number]
            serializedResult: string
          }) => void
        }) => {
          state.appendRecoveryHistory(executedToolBatch.recoveryHistory)
          Object.assign(state.runBudgetState, consumeToolCallBudget(state.runBudgetState, executedToolBatch.results.length))
          const batchHasLongTypedSkillAction = executedToolBatch.results.some((executedTool) =>
            isLongTypedSkillActionName(executedTool.name),
          )
          if (executedToolBatch.budgetLimited || getRemainingToolCallBudget(state.effectiveRunBudget || alignedRunBudget, state.runBudgetState) <= 0) {
            budgetLimitedBeforeCompletion = true
          }

          for (const executedTool of executedToolBatch.results) {
            const result = executedTool.result as ToolExecutionOutput
            const resultText = result.text
            const serializedResult = serializeToolExecutionOutput(result)
            const toolName = executedTool.name
            if (isLongTypedSkillActionName(toolName)) {
              lastLongTypedSkillActionIteration = iterations
            }
            executedToolsThisIteration.push({
              id: executedTool.id,
              name: executedTool.name,
              input: executedTool.input,
              result,
            })
            host.log(`tool execute: ${toolName}, result=${resultText.slice(0, 140)}`)
            const documentToolInspection = inspectDocumentToolCall(toolName, resultText)
            if (documentToolInspection.isDocumentTool) {
              documentToolInspectionsThisIteration.push(documentToolInspection)
              documentToolResultsThisIteration.push(resultText)
              executedDocActionCount += documentToolInspection.executedDocActionCount
              executedMutatingDocActionCount += documentToolInspection.executedMutatingDocActionCount
              executedInspectionDocActionCount += documentToolInspection.executedInspectionDocActionCount
              executedSaveDocActionCount += documentToolInspection.executedSaveDocActionCount
            }
            if (toolName.startsWith('browser_')) {
              executedBrowserToolsThisIteration += 1
              browserToolResultsThisIteration.push({
                toolName,
                resultText,
              })
            }
            const designResult = designToolLoopOrchestrator.recordToolResult({
              state: designToolLoopState,
              toolName,
              rawResult: resultText,
              policy: toolPolicy,
            })
            if ((result as any).interactionHint === 'awaiting_confirmation') {
              state.interactionState = 'awaiting_confirmation'
            } else if ((result as any).interactionHint === 'awaiting_clarification') {
              state.interactionState = 'awaiting_clarification'
            }
            if (designResult.isPrimaryArtifact) {
              executedPrimaryDesignToolThisIteration = true
              designToolLoopState = designResult.state
            }
            if (result.projectionPatch) {
              transcript.emitStructuredPayload(result.projectionPatch)
            } else {
              transcript.emitOutput(serializedResult.slice(0, 200), 'tool_result')
            }
            params.onResult({
              executedTool,
              serializedResult,
            })
          }
          if (skillBudgetLeaseState) {
            const currentSnapshot = sampleSkillLeaseSnapshot()
            const currentFingerprint = currentSnapshot?.progressFingerprint || skillBudgetLeaseState.lastFingerprint
            lastLeaseProgress = scoreSkillProgress({
              previousFingerprint: skillBudgetLeaseState.lastFingerprint,
              previousSnapshot: previousLeaseSnapshot,
              currentSnapshot,
              executedTools: executedToolBatch.results.map((executedTool) => ({
                name: executedTool.name,
                result: executedTool.result as ToolExecutionOutput,
              })),
            })
            lastLeaseWaste = scoreSkillWaste({
              toolCalls: toolCallsForIteration,
              recentToolCalls: recentToolCallsBeforeIteration,
              executedTools: executedToolBatch.results.map((executedTool) => ({
                name: executedTool.name,
                input: executedTool.input,
                result: executedTool.result as ToolExecutionOutput,
              })),
              recoveryHistory: executedToolBatch.recoveryHistory,
              previousFingerprint: skillBudgetLeaseState.lastFingerprint,
              currentFingerprint,
              preferredTypedSkillToolName: preferredSkillToolNames?.find((name) => isLongTypedSkillActionName(name)) || null,
            })
            previousLeaseSnapshot = currentSnapshot || previousLeaseSnapshot
            lastLeaseSnapshot = currentSnapshot || lastLeaseSnapshot
            skillBudgetLeaseState.progressScore = lastLeaseProgress.score
            skillBudgetLeaseState.wasteScore = lastLeaseWaste.score
            if (lastLeaseProgress.fingerprint) {
              skillBudgetLeaseState.lastFingerprint = lastLeaseProgress.fingerprint
            }
            publishSkillBudgetLease()
            if (lastLeaseWaste.repeatedToolCallStreak >= REPETITION_THRESHOLD || lastLeaseWaste.repeatedRecoverableError) {
              const evaluation = evaluateSkillBudgetLease({
                state: skillBudgetLeaseState,
                iteration: iterations,
                progress: lastLeaseProgress,
                waste: lastLeaseWaste,
                snapshot: currentSnapshot || lastLeaseSnapshot || sampleSkillLeaseSnapshot(),
              })
              skillBudgetLeaseState = evaluation.state
              publishSkillBudgetLease()
              logAgentMetric('skill_budget_lease_decision', {
                sessionId: request.sessionId,
                leaseId: skillBudgetLeaseState.leaseId,
                decision: evaluation.decision,
                reason: evaluation.reason,
                iteration: iterations,
                renewalsUsed: skillBudgetLeaseState.renewalsUsed,
                progressScore: skillBudgetLeaseState.progressScore,
                wasteScore: skillBudgetLeaseState.wasteScore,
              })
              if (evaluation.decision === 'pause' || evaluation.decision === 'handoff_background') {
                leaseLifecycleReason = evaluation.decision === 'handoff_background'
                  ? 'background_running'
                  : 'budget_exhausted'
                budgetLimitedBeforeCompletion = true
              } else if (evaluation.decision === 'close') {
                finishedBeforeLimit = true
              }
            }
          }
          recordRecentToolCallsForIteration()
        }

        if (host.providerContext.useAnthropicProtocol) {
          const assistantContent: Array<Record<string, unknown>> = []
          if (response.text) {
            if (!shouldHideBrowserProcessText) {
              transcript.emitOutput(response.text, 'text')
            }
            // Phase 3.2 — Anthropic protocol path uses a multimodal content
            // array, so we can't reuse pushAssistantTextSafely directly.
            // Sanitize the text block here and only emit it when non-empty
            // so a fully-leaked turn doesn't pollute the assistant message.
            const cleanedText = sanitizeAssistantText(response.text, {
              sessionId: request.sessionId,
              iteration: iterations,
              toolTransport: response.toolTransport,
            })
            if (cleanedText) {
              assistantContent.push({ type: 'text', text: cleanedText })
            }
          }
          for (const toolCall of toolCallsForIteration) {
            assistantContent.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input })
          }
          session.messages.push({ role: 'assistant', content: assistantContent })
          const executedToolBatch = await executeBatch()
          const toolResults: Array<Record<string, unknown>> = []
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool, serializedResult }) => {
              toolResults.push({ type: 'tool_result', tool_use_id: executedTool.id, content: serializedResult })
            },
          })
          session.messages.push({ role: 'user', content: toolResults })
        } else if (response.toolTransport === 'text') {
          const historyText = response.rawText || response.text
          if (historyText) {
            pushAssistantTextSafely(session, historyText, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
          }
          if (response.text) {
            if (!shouldHideBrowserProcessText) {
              transcript.emitOutput(response.text, 'text')
            }
          }
          const textBridgeResults: Array<{ id: string; name: string; result: ToolExecutionOutput }> = []
          const executedToolBatch = await executeBatch()
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool }) => {
              textBridgeResults.push({ id: executedTool.id, name: executedTool.name, result: executedTool.result as ToolExecutionOutput })
            },
          })
          if (textBridgeResults.length > 0) {
            session.messages.push({ role: 'user', content: buildTextToolResultMessage(textBridgeResults as any) })
          }
          state.syncBudgetWarning()
        } else {
          const assistantMsg: Record<string, unknown> = {
            role: 'assistant',
            content: response.text || null,
            tool_calls: toolCallsForIteration.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
            })),
          }
          if (response.providerResponseId) {
            assistantMsg.response_id = response.providerResponseId
          }
          if (response.reasoningContent !== undefined || host.providerContext.isKimiCoding) {
            assistantMsg.reasoning_content = response.reasoningContent ?? ''
          }
          session.messages.push(assistantMsg as any)
          if (response.text) {
            if (!shouldHideBrowserProcessText) {
              transcript.emitOutput(response.text, 'text')
            }
          }
          const executedToolBatch = await executeBatch()
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool, serializedResult }) => {
              session.messages.push({
                role: 'tool',
                content: serializedResult,
                ...({ tool_call_id: executedTool.id } as Record<string, unknown>),
              } as any)
            },
          })
          state.syncBudgetWarning()
        }

        if (response.text) {
          const plannerStepCompleted = detectTaskStepCompletionCue(
            response.text,
            state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId),
          )
          if (plannerStepCompleted) {
            const advanced = advancePlannerStep(response.text)
            if (advanced) {
              session.messages.push({
                role: 'user',
                content: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
              })
              continue
            }
          }
          if (syncInteractionStateFromAssistantText(response.text)) {
            pushAssistantTextSafely(session, response.text, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
            finishedBeforeLimit = true
            break
          }
        }

        if (selectedDomainAdapter) {
          const domainApplyResult = await selectedDomainAdapter.applyResult({
                route: taskExecutionRoute,
                request: requestForAdapters,
                host: hostForAdapters,
                session,
            userText,
            pureUserInput,
            requestEnvelope,
            executionIntentContext,
            hasTools,
            toolPolicy,
            allowedToolNames: routedAllowedToolNames,
            emitStructuredTaskPayload,
            domainState: activeDomainState,
            phase: 'tool_batch',
            responseText: response.text,
            toolTransport: response.toolTransport,
            toolBatch: {
              executedTools: executedToolsThisIteration,
              executedDocActionCount,
              executedMutatingDocActionCount,
              executedInspectionDocActionCount,
              executedSaveDocActionCount,
              executedBrowserToolsThisIteration,
              browserToolResultsThisIteration,
              documentToolResultsThisIteration,
              documentToolInspections: documentToolInspectionsThisIteration,
            },
          })
          activeDomainState = typeof domainApplyResult.domainState === 'undefined'
            ? activeDomainState
            : domainApplyResult.domainState
          appendSessionMessages(session, domainApplyResult.sessionMessages)
          emitDomainProjection(domainApplyResult.projection || null, activeDomainState)
          if (domainApplyResult.interactionState) {
            state.interactionState = domainApplyResult.interactionState
          }
          if (domainApplyResult.nextUserMessage) {
            session.messages.push({
              role: 'user',
              content: domainApplyResult.nextUserMessage,
            })
            continue
          }
          if (domainApplyResult.finalText) {
            transcript.emitOutput(domainApplyResult.finalText, 'text')
            pushAssistantTextSafely(session, domainApplyResult.finalText, { sessionId: request.sessionId, iteration: iterations, toolTransport: response.toolTransport })
            advancePlannerStep(domainApplyResult.finalText)
            finishedBeforeLimit = true
            break
          }
        }

        if ((toolPolicy as any).forceDesignTool && !(toolPolicy as any).allowMultipleDesignArtifacts && executedPrimaryDesignToolThisIteration) {
          const completionText = designToolLoopOrchestrator.buildCompletionText(designToolLoopState)
          if (completionText) {
            emitStructuredTaskPayload(designToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: '设计任务',
              taskSummary: completionText,
              state: designToolLoopState,
              phase: 'done',
            }))
            transcript.emitOutput(completionText, 'text')
            pushAssistantTextSafely(session, completionText, { sessionId: request.sessionId, iteration: iterations })
            advancePlannerStep(completionText)
          }
          finishedBeforeLimit = true
          break
        }

        if (budgetLimitedBeforeCompletion) {
          break
        }
      }

      if (state.interactionState === 'suspended') {
        return finish({ success: true, cancelled: true, status: 'cancelled' })
      }

      if (!finishedBeforeLimit && (iterations >= effectiveMaxToolIterations || budgetLimitedBeforeCompletion)) {
        logAgentMetric('turn_budget_exhausted', {
          sessionId: request.sessionId,
          taskType: state.resolvedTaskType || null,
          iterations,
          maxIterations: effectiveMaxToolIterations,
          budgetLimitedBeforeCompletion,
          referenceSkillId: referenceSkillForMetrics?.id || null,
          referenceSkillName: referenceSkillForMetrics?.name || null,
          preferredSkillTools: preferredSkillToolNames || [],
          longSkillResume: shouldUseLongSkillResumeBudget,
        })
        if (selectedDomainAdapter) {
          const limitResult = await selectedDomainAdapter.applyResult({
                route: taskExecutionRoute,
                request: requestForAdapters,
                host: hostForAdapters,
                session,
            userText,
            pureUserInput,
            requestEnvelope,
            executionIntentContext,
            hasTools,
            toolPolicy,
            allowedToolNames: routedAllowedToolNames,
            emitStructuredTaskPayload,
            domainState: activeDomainState,
            phase: 'budget_limit',
          })
          activeDomainState = typeof limitResult.domainState === 'undefined'
            ? activeDomainState
            : limitResult.domainState
          appendSessionMessages(session, limitResult.sessionMessages)
        }
        const skillTaskSnapshot = sampleSkillLeaseSnapshot(true)
        const budgetTerminalReason: TurnTerminalReason =
          skillTaskSnapshot && (
            skillTaskSnapshot.hasLiveWork
            || skillTaskSnapshot.status === 'background_running'
            || skillTaskSnapshot.status === 'running'
          )
            ? 'checkpoint_background'
            : 'checkpoint_budget'
        if (turnFrame) {
          turnFrame.budget = {
            ...turnFrame.budget,
            exhausted: true,
          }
          turnFrame.terminalReason = budgetTerminalReason
        }
        logAgentMetric('turn_terminal_reason', {
          sessionId: request.sessionId,
          reason: budgetTerminalReason,
          skillId: turnFrame?.skill?.skillId || referenceSkillForMetrics?.id || null,
        })
        host.log(`[turn_terminal_reason] ${budgetTerminalReason}`)
        const skillTaskLifecycle = buildSkillTaskLifecycleSignal({
          snapshot: skillTaskSnapshot,
          reason: leaseLifecycleReason || 'budget_exhausted',
        })
        if (skillTaskLifecycle && skillTaskSnapshot) {
          state.interactionState = skillTaskLifecycle.interactionState
          state.syncBudgetWarning()
          const lifecycleSummary =
            skillTaskLifecycle.blockedReason || '本轮预算已用完，技能任务已暂停，可继续执行'
          const lifecycleStepId =
            skillTaskLifecycle.taskContinuation?.stepId
            || state.runtimeCurrentStepId
            || 'skill_lifecycle'
          const lifecycleSteps = state.runtimeTaskSteps.length > 0
            ? state.runtimeTaskSteps.map((step) => ({
              id: step.id,
              title: step.title || step.description,
              status: step.id === lifecycleStepId ? 'blocked' : step.status || 'pending',
              detail: step.detail || null,
              updatedAt: step.updatedAt || new Date().toISOString(),
            }))
            : [{
              id: lifecycleStepId,
              title: '技能任务状态',
              status: 'blocked' as const,
              detail: lifecycleSummary,
              updatedAt: new Date().toISOString(),
            }]
          emitStructuredTaskPayload({
            module: 'skill',
            phase: skillTaskLifecycle.phase,
            taskTitle: referenceSkillForMetrics?.name
              ? `技能执行 · ${referenceSkillForMetrics.name}`
              : '技能任务',
            taskSummary: lifecycleSummary,
            steps: lifecycleSteps,
            currentStepId: lifecycleStepId,
            waitingFor: skillTaskLifecycle.waitingFor,
            resumableActions: skillTaskLifecycle.resumableActions,
            blockedReason: skillTaskLifecycle.blockedReason,
            taskContinuation: skillTaskLifecycle.taskContinuation,
          })
          if (skillTaskSnapshot.skillId) {
            recordSkillParentTaskLifecycleEvent({
              scopeId: request.sessionId,
              sessionId: request.sessionId,
              runId: request.runId,
              agent: request.agentName,
              skillId: skillTaskSnapshot.skillId,
              skillName: referenceSkillForMetrics?.name || skillTaskSnapshot.skillId,
              action: skillTaskSnapshot.action || undefined,
              state: skillTaskLifecycle.state,
              reason: skillTaskLifecycle.reason,
              message: lifecycleSummary,
              outputDir: skillTaskSnapshot.outputDir,
              runStatePath: skillTaskSnapshot.runStatePath,
              sceneScoresPath: skillTaskSnapshot.sceneScoresPath,
              deliveryReportPath: skillTaskSnapshot.deliveryReportPath,
              detachedTaskId: skillTaskSnapshot.detachedTaskId,
              taskRunId: skillTaskSnapshot.taskRunId,
              progressFingerprint: skillTaskSnapshot.progressFingerprint,
              resumePayload: skillTaskLifecycle.taskContinuation ? { ...skillTaskLifecycle.taskContinuation } : undefined,
            })
          }
          return finish({
            success: true,
            status: skillTaskLifecycle.phase === 'done' ? 'done' : 'checkpoint',
            skillTaskLifecycle,
            terminalReason: budgetTerminalReason,
          })
        }
        if (
          hasLeaseTrigger
          || shouldUseLongSkillResumeBudget
          || Boolean(referenceSkillForMetrics)
          || (preferredSkillToolNames?.length || 0) > 0
        ) {
          state.interactionState = 'suspended'
          state.syncBudgetWarning()
          emitStructuredTaskPayload({
            module: 'skill',
            phase: 'checkpoint',
            taskTitle: referenceSkillForMetrics?.name
              ? `技能执行 · ${referenceSkillForMetrics.name}`
              : '技能任务',
            taskSummary: '本轮预算已用完，技能任务状态需要重新检查',
            waitingFor: 'background',
            resumableActions: ['retry', 'cancel'],
            blockedReason: '本轮预算已用完，技能任务状态检查失败或暂时不可用',
          })
          return finish({
            success: true,
            status: 'checkpoint',
            terminalReason: budgetTerminalReason,
          })
        }
        transcript.emitOutput(
          budgetLimitedBeforeCompletion
            ? '\n[已达到本轮工具预算上限，请总结当前进度并建议下一步重试方式]'
            : '\n[已达到最大工具调用次数，请尝试让助手使用 browser_run_workflow 或 browser_download_urls 批量执行后重试]',
          'text',
        )
        return finish({
          success: true,
          status: 'checkpoint',
          terminalReason: 'checkpoint_budget',
        })
      }

      return finish({ success: true, status: 'done' })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        state.interactionState = 'suspended'
        state.syncBudgetWarning()
        return finish({ success: true, cancelled: true, status: 'cancelled' })
      }
      const message = error instanceof Error ? error.message : String(error)
      host.log(`Error: ${message}`)
      // Phase 3: recoverable runtime errors surface in the soft-failure capsule;
      // don't duplicate them as a red transcript line. Terminal errors keep the
      // old "API 请求失败: ..." transcript line so the fallback system-message
      // path still has readable context.
      const contract = deriveAgentErrorContract(error)
      if (!contract.recoverable) {
        transcript.emitOutput(`API 请求失败: ${message}`, 'error')
      }
      transcript.emitRuntimeError(error)
      return finish({ success: false, error: message, status: 'error', doneEventType: 'done' })
    }
  }
}
