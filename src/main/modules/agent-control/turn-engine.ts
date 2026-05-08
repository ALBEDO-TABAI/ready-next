import { randomUUID } from 'crypto'
import { buildRequestEnvelope } from './request-envelope'
import { hashToolCallArgs } from './tool-call-args-hash'

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
  buildToolCallOnlyFallbackText,
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
/**
 * Stage 7 — pure helper for the `turn_frame_summary` metric's
 * `allowedPreferredMismatch` flag. Returns true when at least one preferred
 * tool name is not present in the allowed-tools surface for this turn —
 * a useful diagnostic for "frame says steer toward X, but X isn't even on
 * the model's tool surface" mismatches that previously took root-cause
 * digging through scattered logs.
 *
 * Empty preferred list is never a mismatch (no preference == no mismatch).
 */
export function detectAllowedPreferredMismatch(
  allowedToolNames: ReadonlyArray<string>,
  preferredToolNames: ReadonlyArray<string>,
): boolean {
  if (preferredToolNames.length === 0) return false
  const allowedSet = new Set(allowedToolNames)
  return preferredToolNames.some((name) => !allowedSet.has(name))
}

function areStringArraysEqual(
  left: ReadonlyArray<string> | null | undefined,
  right: ReadonlyArray<string> | null | undefined,
): boolean {
  const a = left || []
  const b = right || []
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

function isSkillSurfaceToolName(name: string): boolean {
  return name.startsWith('skill_') || name === 'system_run_embedded_python'
}

function reconcileAllowedToolNamesWithPreferredSkillTools(
  baseAllowedToolNames: ReadonlyArray<string>,
  preferredSkillToolNames: ReadonlyArray<string>,
): string[] {
  const preferred = Array.from(new Set(preferredSkillToolNames))
  const preferredSet = new Set(preferred)
  const out: string[] = []
  const seen = new Set<string>()
  const append = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  for (const name of baseAllowedToolNames) {
    if (isSkillSurfaceToolName(name) && !preferredSet.has(name)) continue
    append(name)
  }
  for (const name of preferred) {
    append(name)
  }
  return out
}

function shouldAdoptTurnFramePreferredSkillTools(frame: TurnFrame | null): boolean {
  if (!frame?.skill) return false
  if (frame.mode === 'skill_start' && !frame.skill.action && frame.liveness === 'unknown') {
    return false
  }
  if (frame.skill.source === 'reference_hint') {
    return hasLongTypedSkillAction(frame.steering.preferredToolNames)
  }
  return frame.steering.preferredToolNames.length > 0
}

function isPreferredSkillActionToolName(name: string): boolean {
  return name.startsWith('skill_') && !SKILL_PRIMITIVE_TOOL_NAMES.has(name)
}

function choosePreferredSkillToolNamesFromFrame(
  frame: TurnFrame | null,
  currentPreferredToolNames: string[] | null | undefined,
): string[] | null {
  if (!shouldAdoptTurnFramePreferredSkillTools(frame)) return currentPreferredToolNames || null
  const framePreferred = [...(frame?.steering.preferredToolNames || [])]
  const frameHasAction = framePreferred.some(isPreferredSkillActionToolName)
  const currentHasAction = (currentPreferredToolNames || []).some(isPreferredSkillActionToolName)
  const currentHasParentForceForbiddenAction = (currentPreferredToolNames || []).some(isParentForceForbiddenByManifest)
  if (currentHasAction && !frameHasAction && !currentHasParentForceForbiddenAction) return currentPreferredToolNames || null
  return framePreferred
}

function matchesSkillProgressFollowupIntent(text: string): boolean {
  const normalized = String(text || '')
    .replace(/\bhttps?:\/\/[^\s"'`<>,，。)）]+/gi, ' ')
    .trim()
  if (!normalized) return false
  return /(?:跟进|追踪|进度|状态|汇报|持续|一直|直到(?:跑|做|执行|完成|结束)|跑完整个任务|monitor|progress|status|watch)/i.test(normalized)
}

function hasUrlSourceSignal(text: string): boolean {
  return /\bhttps?:\/\/[^\s"'`<>,，。)）]+/i.test(String(text || ''))
}

function inferExplicitSkillStartAction(
  skill: (Partial<SkillState> & { skillId?: string; id?: string; name?: string }) | null | undefined,
  texts: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!skill || !texts.some((text) => hasUrlSourceSignal(String(text || '')))) return null
  const actions = Array.isArray(skill.actions) ? skill.actions : []
  const urlActions = actions.filter((action) => {
    const params = Array.isArray(action.params) ? action.params : []
    return params.some((param) => {
      const name = typeof param?.name === 'string' ? param.name.toLowerCase() : ''
      return (name === 'url' || name === 'source') && param.required === true
    })
  })
  if (urlActions.length === 0) return null
  const preferred = urlActions.find((action) => /pipeline|analy[sz]e|分析/i.test(action.name))
    || urlActions[0]
  return typeof preferred?.name === 'string' && preferred.name.trim()
    ? preferred.name.trim()
    : null
}

export function buildBudgetWarningMessage(params: {
  iterations: number
  effectiveMaxIterations: number
  level: 'converge' | 'warning'
  isLongSkillContext: boolean
}): string {
  if (params.isLongSkillContext) {
    if (params.level === 'converge') {
      return `系统提醒：长任务接近预算上限（${params.iterations}/${params.effectiveMaxIterations}）。继续沿用当前 skill 流程推进剩余步骤；只有遇到真实 blocker（如等待用户确认）才用 skill_ask_user。不要在这一步停下来总结。`
    }
    return `系统提醒：长任务进度 ${params.iterations}/${params.effectiveMaxIterations}。继续推进当前 skill 流程，避免用 skill_run_shell 反复诊断；如果 run_state 表明在等某个文件，先用 skill_read_artifact 看清楚再推进，不需要在这一步问用户。`
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
import { snapshotTurnFeatureFlags } from './turn-feature-flags'
import { classifyRestartIntent, type RestartIntentClass } from './restart-intent-classifier'
import {
  rememberActiveSkillContext,
  resolveActiveSkillContext,
  summarizeActiveSkillContext,
  type ActiveSkillContext,
} from './active-skill-context'
import { clearLastReferenceSkill } from './skill-reference-hints'
import { applySupervisorRuntimeToTurnFrame, resolveTurnFrame } from './turn-frame-resolver'
import { applySteeringToTurnFrame } from './turn-frame-steering'
import {
  applyTurnFramePatch,
  mergeTurnFramePatches,
  summarizeTurnFrame,
  type TurnFrame,
  type TurnFramePatch,
  type TurnTerminalReason,
} from './turn-frame'
import { resolveExecutionIntentContext } from './execution-intent-resolver'
import {
  buildSkillDetectionInputs,
  collectRecentAssistantSkillToolUses,
  isConfigRepairTurn,
  isRetryOnlyTurn,
} from './skill-detection-inputs'
import {
  resolveExplicitRunStateResource,
  resolveRunStateResourceFromSessionText,
  type ExplicitRunStateResourceCandidate,
} from './run-state-resource-resolver'
import {
  getLatestSkillRun,
  resolveSkillRunForResume,
  type SkillRunRecord,
} from './session-continuity'
import { prepareInitialRun, reconcileAfterBrowserDecision } from './run-capability-controller'
import { defaultToolRegistry, resolveToolInputSchemaForExecution } from './tool-registry'
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
import { resolveTaskOperationIntent } from './task-operation-intent'
import { resolveTaskType } from './task-type-resolver'
import { shouldEnforcePetToolRetry } from './pet-tool-loop-policy'
import {
  buildActiveFrameContextFromTurnFrame,
  buildToolRuntimeContext,
} from './tool-runtime-context-builder'
import {
  buildTextToolBridgeCorrectionMessage,
  buildToolGuidance,
  collectAllowedToolNames,
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
import { createSystemReminderRegistry, type ReminderEntry } from './system-reminder-registry'
import { createLayeredCompactor, type LayeredCompactorMetricName } from './layered-compactor'
import type { HookRegistry } from './hook-registry'
import { buildLongSkillRunningProjection } from './skill-running-projection'
import { buildSkillTaskLifecycleSignal } from './skill-task-lifecycle'
import { inspectLatestSkillTask } from './skill-task-supervisor'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import { recordSkillParentTaskLifecycleEvent } from './skill-task-tracker'
// Stage 4 W1 — pure-read SkillTurnIdentity shadow.
import { collectIdentityReadSnapshot } from './skill-turn-identity-snapshot'
import { applySkillTurnIdentity, resolveSkillTurnIdentity } from './skill-turn-identity'
import { SKILL_TURN_IDENTITY_METRICS } from './skill-turn-identity-metrics'
// Stage 4 W3b — derive per-turn skill tool authorization from identity.
import {
  buildAuthorizationFromIdentity,
  type SkillToolAuthorization,
} from './skill-tool-authorization'
import { PRIMITIVE_TOOL_DEFS } from '../tools/skill-primitives/tool-defs'
import {
  createSkillBudgetLeaseState,
  evaluateSkillBudgetLease,
  produceBudgetPatch,
} from './skill-budget-lease-controller'
import { scoreSkillProgress, type SkillProgressScore } from './progress-scorer'
import { scoreSkillWaste, type SkillWasteScore } from './waste-scorer'
import { buildAgentSpawnContextFromAIConfig } from '../skills-runtime/agent-context-source'
import type { SkillState } from '../skills-runtime/runtime-manager'
import {
  shouldParentForceLongSkillTool,
  isParentForceForbiddenByManifest,
} from './run-contracts'
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../tools/child-loop-skill-actions'
import {
  cancelSkillChildRun,
  getSkillChildRunCloseEvent,
  resumeSkillChildRun,
  type StartSkillChildRunResult,
} from './skill-child-runner'
import {
  isBlockedChildCloseStatus,
  isCompletedChildCloseStatus,
  isFailedChildCloseStatus,
  isKilledChildCloseStatus,
  isTerminalChildCloseStatus,
  type SkillChildCloseEvent,
} from './skill-child-run-types'
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
const CHILD_SELF_AWAIT_TIMEOUT_MS = 1_500
const LAYERED_COMPACTOR_METRIC_MAP: Record<LayeredCompactorMetricName, string> = {
  compactionCircuitBreak: TOOL_ERROR_METRICS.compactionCircuitBreak,
  compactionL2Failed: TOOL_ERROR_METRICS.compactionL2Failed,
}
const layeredCompactor = createLayeredCompactor({
  metric: (name, payload) => {
    try {
      logAgentMetric(LAYERED_COMPACTOR_METRIC_MAP[name], { ...payload })
    } catch {
      // Metrics must never break a turn.
    }
  },
})
const NOOP_HOOK_REGISTRY: Pick<HookRegistry, 'fire'> = {
  fire: async () => {},
}
const SKILL_PRIMITIVE_TOOL_NAMES = new Set(PRIMITIVE_TOOL_DEFS.map((definition) => definition.name))

export function isLongTypedSkillActionName(toolName: string): boolean {
  if (!toolName.startsWith('skill_')) return false
  const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
  return definition?.domain === 'skill'
    && typeof definition.executionTimeoutMs === 'number'
    && definition.executionTimeoutMs >= LONG_TYPED_SKILL_ACTION_MIN_TIMEOUT_MS
}

function hasLongTypedSkillAction(toolNames: string[] | null | undefined): boolean {
  return Boolean(toolNames?.some((toolName) => isLongTypedSkillActionName(toolName)))
}

type ChildCloseWaiter = (childRunId: string, timeoutMs: number) => Promise<SkillChildCloseEvent | null>

function isTurnTerminalReason(value: unknown): value is TurnTerminalReason {
  return value === 'done'
    || value === 'checkpoint_budget'
    || value === 'checkpoint_background'
    || value === 'checkpoint_user_input'
    || value === 'blocked_config'
    || value === 'blocked_external'
    || value === 'blocked_tool_error'
    || value === 'failed_skill'
    || value === 'resume_launch_failed'
    || value === 'persistence_failed'
    || value === 'cancelled_user'
    || value === 'cancelled_runtime'
}

function mapChildCloseToTurnTerminalReason(close: SkillChildCloseEvent): TurnTerminalReason {
  if (isCompletedChildCloseStatus(close.status)) return 'done'
  if (isKilledChildCloseStatus(close.status)) return 'cancelled_user'
  if (isTurnTerminalReason(close.terminalReason)) {
    return close.terminalReason
  }
  if (isFailedChildCloseStatus(close.status)) return 'persistence_failed'
  return 'checkpoint_user_input'
}

function statusFromTerminalReason(
  reason: TurnTerminalReason,
): 'done' | 'error' | 'cancelled' | 'checkpoint' {
  if (reason === 'done') return 'done'
  if (reason === 'cancelled_user' || reason === 'cancelled_runtime') return 'cancelled'
  if (
    reason === 'failed_skill'
    || reason === 'resume_launch_failed'
    || reason === 'persistence_failed'
  ) {
    return 'error'
  }
  return 'checkpoint'
}

function decisionFromChildClose(
  childRunId: string,
  close: SkillChildCloseEvent,
): Extract<ChildContinuationDecision, { kind: 'terminal' | 'checkpoint_paused' }> {
  if (isTerminalChildCloseStatus(close.status)) {
    return { kind: 'terminal', childRunId, closeEvent: close }
  }
  return { kind: 'checkpoint_paused', childRunId, closeEvent: close }
}

async function defaultWaitForChildCloseEvent(
  childRunId: string,
  timeoutMs: number,
): Promise<SkillChildCloseEvent | null> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs))
  return getSkillChildRunCloseEvent(childRunId)
}

/**
 * Phase 6 (Wave 3 — T5) — child-loop continuation routing decision.
 *
 * The parent turn engine no longer synthesizes typed VEA tool_use for
 * skills that the child runner owns. When a frame carries
 * `runContract.childRunId` we route through the child runner's status:
 *
 *   - `terminal`        — close event with `status` in
 *                         `{completed | failed | killed}`. The engine
 *                         surfaces the close event onto the frame patch
 *                         and stops the child short-circuit cleanly.
 *
 *   - `checkpoint_paused` — close event with `status` in
 *                         `{recoverable_paused | budget_paused | blocked}`.
 *                         Checkpoint without dispatching anything; the
 *                         user picks whether to resume.
 *
 *   - `wait`            — no close event (child is still running).
 *                         Engine emits `parentNextHint='wait_for_close_event'`
 *                         on the frame patch and does NOT ask the model
 *                         to choose a typed VEA action. Steering already
 *                         excludes typed actions for child-owned frames
 *                         (see `turn-frame-steering.isChildOwnedFrame`).
 *
 *   - `none`            — frame is not child-owned. Caller falls through
 *                         to the legacy parent-force path.
 *
 * Pure helper: takes the frame and an injectable close-event lookup so
 * tests can stub the child runner without configuring the singleton.
 */
export type ChildContinuationDecision =
  | { kind: 'none' }
  | { kind: 'wait'; childRunId: string }
  | { kind: 'checkpoint_paused'; childRunId: string; closeEvent: SkillChildCloseEvent }
  | { kind: 'terminal'; childRunId: string; closeEvent: SkillChildCloseEvent }

export function computeChildContinuationDecision(
  frame: TurnFrame | null,
  getCloseEvent: (childRunId: string) => SkillChildCloseEvent | null,
): ChildContinuationDecision {
  const contract = frame?.skill?.runContract || null
  // Single source of truth for child ownership — same predicate the
  // engine uses elsewhere (`shouldParentForceLongSkillTool`).
  if (shouldParentForceLongSkillTool(contract)) return { kind: 'none' }
  const childRunId = (contract?.childRunId || '').trim()
  if (!childRunId) return { kind: 'none' }
  // Prefer the runner's durable lookup (T4 wave 2 added a persistence-backed
  // fallback). Fall back to whatever was stamped on the contract — the
  // loader copies the close event off the repository row if it exists.
  const live = getCloseEvent(childRunId) ?? contract?.childCloseEvent ?? null
  if (live && typeof live === 'object') {
    if (isTerminalChildCloseStatus(live.status)) {
      return { kind: 'terminal', childRunId, closeEvent: live }
    }
    return { kind: 'checkpoint_paused', childRunId, closeEvent: live }
  }
  return { kind: 'wait', childRunId }
}

export function applyChildResumeFreshContractFields(
  frame: TurnFrame | null,
  freshContractFields: StartSkillChildRunResult['freshContractFields'],
): TurnFrame | null {
  if (!frame?.skill?.runContract || !freshContractFields) return frame
  return applyTurnFramePatch(frame, {
    runContract: {
      skillId: frame.skill.runContract.skillId,
      ...freshContractFields,
    },
  })
}

function matchesChildCancelIntent(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => {
    const normalized = String(text || '').trim()
    if (!normalized) return false
    return /^(?:取消|停止|中止|终止|别跑了|不要继续|cancel|stop|abort)$/i.test(normalized)
      || /(?:取消|停止|中止|终止|cancel|stop|abort)(?:这个|当前|child|任务|运行|run)/i.test(normalized)
  })
}

function isDirectlyResumableChildStatus(status: SkillChildCloseEvent['status']): boolean {
  return status === 'recoverable_paused' || status === 'budget_paused'
}

/**
 * D3 — shared renderer for the user-visible outcome of a child-run command
 * (`cancel` / `resume`). Centralizes the message + terminalReason mapping
 * so cancel and resume cannot drift; in particular ensures resume's
 * synchronous failure path (`closeEvent.status === 'failed'`) surfaces a
 * "恢复失败" message + `terminalReason: 'failed'` instead of the legacy
 * "已继续" / `'done'` lie.
 *
 * Inputs:
 *   - `command: 'cancel'` — close MUST be non-null (cancelSkillChildRun
 *     always returns a close).
 *   - `command: 'resume'` — close MAY be null (resume launched the child
 *     and the next close will arrive asynchronously) or non-null (resume
 *     produced an immediate close: running heartbeat, completed, killed,
 *     failed, or — defensively — a still-paused state).
 *
 * Output is consumed by turn-engine's resume/cancel branches to:
 *   - `transcript.emitOutput(message, 'text')`
 *   - `pushAssistantTextSafely(session, message, ...)`
 *   - `finish({ status, terminalReason, success: status !== 'error',
 *       cancelled: status === 'cancelled' })`
 */
export type ChildCommandKind = 'cancel' | 'resume'

/**
 * `terminalReason` is constrained to `TurnTerminalReason` so callers can
 * pass it straight to `finish({ terminalReason })` without coercion. Resume
 * failure maps to `'resume_launch_failed'` (not the bare `'failed'` literal in the
 * source plan, which isn't a valid `TurnTerminalReason` member).
 */
export interface ChildCommandOutcome {
  message: string
  terminalReason: TurnTerminalReason
  status: 'done' | 'cancelled' | 'error' | 'checkpoint'
}

export function renderChildCommandOutcome(args: {
  childRunId: string
  command: ChildCommandKind
  close: SkillChildCloseEvent | null
}): ChildCommandOutcome {
  const { childRunId, command, close } = args
  if (command === 'cancel') {
    return {
      message: `已取消 child run ${childRunId}。`,
      terminalReason: 'cancelled_user',
      status: 'cancelled',
    }
  }
  // command === 'resume'
  if (!close) {
    return {
      message: `已继续同一个 child run ${childRunId}，后台仍在运行。`,
      terminalReason: 'checkpoint_background',
      status: 'checkpoint',
    }
  }
  // Note: `SkillChildCloseEvent['status']` excludes 'queued' / 'running',
  // so the "resume launched and is running" case is represented by a null
  // close (handled above), not a non-null close with status='running'.
  switch (close.status) {
    case 'completed':
      return {
        message: `child run ${childRunId} 已完成。`,
        terminalReason: 'done',
        status: 'done',
      }
    case 'failed': {
      const detail = close.error?.message || close.terminalReason
      return {
        message: `恢复 child run ${childRunId} 失败：${detail}`,
        terminalReason: mapChildCloseToTurnTerminalReason(close),
        status: 'error',
      }
    }
    case 'killed':
      return {
        message: `恢复 child run ${childRunId} 时被取消。`,
        terminalReason: 'cancelled_user',
        status: 'cancelled',
      }
    default: {
      const terminalReason = mapChildCloseToTurnTerminalReason(close)
      return {
        message: `child run ${childRunId} 仍在等待：${close.terminalReason}`,
        terminalReason,
        status: statusFromTerminalReason(terminalReason),
      }
    }
  }
}

interface SkillContextOrchestratorLike {
  shouldKeepToolsWithVideo: (userText: string, sessionId?: string) => boolean
  findExplicitlyRequestedSkills: (userText: string) => Array<Partial<SkillState> & { skillId?: string; id?: string; name?: string }>
  // Stage Q (Stage 11) — `hasActiveSkillExecution` removed from interface.
  buildPreferredSkillToolNames: (userText: string, sessionId?: string) => string[] | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  rememberExplicitReferenceSkillHint?: (userText: string, sessionId?: string) => boolean
  rememberReferenceSkillFromRunStateResource?: (
    skillId: string,
    sessionId?: string,
  ) => { armed: boolean; skillId?: string; skillName?: string }
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

function buildModelInputSession<TSession extends TurnEngineSession>(session: TSession): TSession {
  if (session.messages.some((message) => typeof message.content !== 'string')) {
    return cloneSession(session)
  }

  const compactedMessages = layeredCompactor.maybeCompact(
    session.messages.map((message) => ({
      role: message.role,
      content: message.content as string,
    })),
  )

  return {
    ...session,
    messages: compactedMessages.map((message) => ({
      role: message.role as TurnEngineSessionMessage['role'],
      content: message.content,
    })),
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

function pushSystemReminderMessage<TSession extends TurnEngineSession>(
  session: TSession,
  entry: ReminderEntry,
): void {
  const content = composeSystemReminderText(entry)
  if (!content) return
  session.messages.push({ role: 'user', content })
}

function composeSystemReminderText(entry: ReminderEntry): string | null {
  const registry = createSystemReminderRegistry()
  registry.register(entry)
  return registry.compose()
}

function pushProviderToolArgumentsCorruptReminder<TSession extends TurnEngineSession>(
  session: TSession,
  response: Pick<TurnModelResponse, 'toolCallParseErrors'>,
): boolean {
  const count = response.toolCallParseErrors?.length ?? 0
  if (count <= 0) return false
  pushSystemReminderMessage(session, {
    topic: 'provider-tool-arguments-corrupt',
    priority: 82,
    text: `系统补充：上一轮有 ${count} 个工具调用因参数损坏被丢弃，请重新调用并使用合法 JSON 参数。`,
  })
  return true
}

async function fireUserPromptSubmitHook(
  registry: Pick<HookRegistry, 'fire'>,
  payload: { userText: string; sessionId: string | null; timestamp: number },
): Promise<void> {
  try {
    await registry.fire('user_prompt_submit', payload)
  } catch (error) {
    try {
      logAgentMetric(TOOL_ERROR_METRICS.hookHandlerFailed, {
        hookName: 'user_prompt_submit',
        handlerName: 'hookRegistry.fire',
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // Metrics must never break a turn.
    }
  }
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
    success: snapshot.closeAllowed && snapshot.status === 'completed',
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
  // Stage 4 W2 — route through SystemReminderRegistry topic
  // `skill-resume-context-prompt`. The registry is a no-op pass-through
  // when called via `composeSystemReminderText` with a single entry (the
  // assembler joins entry texts with '\n' and adds no envelope), so the
  // produced string is byte-identical to the legacy inline form. The
  // routing exists so the topic taxonomy includes this reminder and
  // future conflict resolution can apply if other topics are added.
  const text = [
    `系统补充：这是一次 skill 恢复请求。优先恢复 skill "${params.skillName}" (${params.skillId})。`,
    params.action ? `上一轮技能动作：${params.action}` : '',
    params.summary ? `上次摘要/目标、输出目录或 artifact、失败原因：${params.summary}` : '',
    `用户本轮补充内容：${params.userText || '继续当前任务。'}`,
    '请沿用上次目标继续，不要把这轮补充当成新的普通问答。',
  ].filter(Boolean).join('\n')
  return composeSystemReminderText({
    topic: 'skill-resume-context-prompt',
    priority: 90,
    text,
  }) ?? text
}

function buildProjectionTruthSnapshot(
  events: TurnTranscriptEvent[],
  turnFrame?: TurnFrame | null,
) {
  let projectionPatch: Record<string, unknown> | null = null
  for (const event of events) {
    if (event.kind !== 'structured_payload' || !event.projectionPatch) continue
    projectionPatch = {
      ...(projectionPatch || {}),
      ...event.projectionPatch,
    }
  }
  // Stage 6 wiring — surface the live TurnFrame skill slice so
  // task-projection-sync's auto-clear-stale-blocker / supersede paths can read
  // `frame.skill.staleBlockerReason` and identity. Inlined to the structural
  // shape declared in run-contracts.ts (no TurnFrameSkillSlice import needed
  // by the consumer).
  //
  // Stage F1 (Zeta) — additionally surface the durable `runContract` from
  // `turnFrame.skill.runContract` so projection sync can prefer contract
  // truth (status / liveness / progress / artifact paths / stable identity)
  // over the older summary+artifact heuristics.
  const skillSlice = turnFrame?.skill || null
  const contract = skillSlice?.runContract || null
  const frameSnapshot = turnFrame
    ? {
      skill: skillSlice
        ? {
          skillId: skillSlice.skillId,
          skillName: skillSlice.skillName,
          source: String(skillSlice.source || ''),
          detachedTaskId: skillSlice.detachedTaskId,
          runStatePath: skillSlice.runStatePath,
          outputDir: skillSlice.outputDir,
          action: skillSlice.action,
          staleBlockerReason: skillSlice.staleBlockerReason,
          runContract: contract
            ? {
              skillId: contract.skillId,
              action: contract.action,
              toolName: contract.toolName,
              actionInput: contract.actionInput,
              originalInput: contract.originalInput,
              sourceUrl: contract.sourceUrl,
              taskRunId: contract.taskRunId,
              detachedTaskId: contract.detachedTaskId,
              jobId: contract.jobId,
              outputDir: contract.outputDir,
              runStatePath: contract.runStatePath,
              artifactPaths: { ...contract.artifactPaths },
              status: contract.status,
              liveness: contract.liveness,
              progress: {
                stage: contract.progress?.stage ?? null,
                totalUnits: contract.progress?.totalUnits ?? null,
                completedUnits: contract.progress?.completedUnits ?? null,
                coverageRatio: contract.progress?.coverageRatio ?? null,
              },
              blocker: { ...contract.blocker },
              projectionIdentity: {
                stableKey: contract.projectionIdentity?.stableKey ?? null,
              },
            }
            : null,
        }
        : null,
      terminalReason: turnFrame.terminalReason,
    }
    : null
  return {
    projectionPatch,
    transcriptEvents: events.slice(),
    frameSnapshot,
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

function readPreparedBrowserDecisionMode(result: DomainAdapterPrepareResult | null | undefined): string | null {
  const mode = (result?.domainState as {
    preparedBrowserExecution?: { browserDecision?: { mode?: unknown } }
  } | null | undefined)?.preparedBrowserExecution?.browserDecision?.mode
  return typeof mode === 'string' && mode ? mode : null
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
    const waitForChildCloseEvent: ChildCloseWaiter =
      (host as unknown as { waitForSkillChildCloseEvent?: ChildCloseWaiter }).waitForSkillChildCloseEvent
      || defaultWaitForChildCloseEvent
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
    const turnFeatureFlags = snapshotTurnFeatureFlags()

    const emitStructuredTaskPayload = (payload: unknown): void => {
      transcript.emitStructuredPayload(payload)
    }
    let turnFrame: TurnFrame | null = null

    const buildAgentContextForSkillSpawn = () => buildAgentSpawnContextFromAIConfig(host.providerContext.config, {
      baseUrl: host.providerContext.baseUrl,
    })

    // Per-turn skill tool authorization. Initialized to null; assigned
    // below once identity has been resolved + applied. The closure
    // `buildHostToolContext` captures this `let` binding by reference and
    // asserts non-null on entry, so any unexpected pre-rearm invocation
    // throws a structural invariant error rather than silently passing
    // an indeterminate authorization to downstream filters.
    let __authorization: SkillToolAuthorization | null = null

    const buildHostToolContext = (allowedToolNames: string[] | null | undefined, scope?: unknown) => {
      if (!__authorization) {
        throw new Error('Stage 10 invariant: authorization read before identity rearm — buildHostToolContext called pre-rearm')
      }
      return buildToolRuntimeContext({
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
        agentContext: buildAgentContextForSkillSpawn(),
        turnFeatureFlags,
        // Phase 3 (Team T7) — seed `activeFrame` from the live `TurnFrame`
        // snapshot BEFORE any same-batch `contextModifier` runs. The first
        // tool dispatched in this turn must already see the frame's durable
        // active artifact roots and `runContract` (without needing an
        // earlier tool to publish them via contextModifier first). Earlier
        // same-batch tools' contextModifier patches still apply on TOP of
        // this seed — `applyContextModifier` unions roots + last-write-wins
        // the contract, so freshly-discovered state always wins on overlap.
        activeFrame: buildActiveFrameContextFromTurnFrame(turnFrame),
        // Stage 4 W3b — captures the outer `__authorization` binding by
        // reference so the value at call time is the cutover-computed
        // authorization (post-applier). All invocation sites run AFTER
        // `__authorization` is assigned from `__identity` (invariant
        // checked above).
        authorization: __authorization,
      })
    }

    const finish = (params: {
      success: boolean
      error?: string
      cancelled?: boolean
      status?: 'done' | 'error' | 'cancelled' | 'checkpoint'
      skillTaskLifecycle?: SkillTaskLifecycleSignal | null
      terminalReason?: TurnTerminalReason | null
    }) => {
      const projectionTruth = buildProjectionTruthSnapshot(transcript.listEvents(), turnFrame)
      const status = params.status || (params.cancelled ? 'cancelled' : params.success ? 'done' : 'error')
      transcript.emitOutput('', status === 'error' ? 'error' : 'done')
      const terminalReason = params.terminalReason
        || (status === 'done'
          ? 'done'
          : status === 'checkpoint'
            ? 'checkpoint_budget'
            : status === 'cancelled'
              ? 'cancelled_runtime'
              : 'persistence_failed')
      if (turnFrame) {
        // Stage M (M2a) — terminalReason now flows through the framePatch
        // contract (priority-ranked merge in `applyTurnFramePatch`). No
        // steering refresh needed — this site runs at terminal exit, the
        // turn is returning. See plan §2.3 for the migration manifest.
        turnFrame = applyTurnFramePatch(turnFrame, { terminalReason })
      }
      // Stage 7 — single per-turn diagnostic. Emit exactly once per turn at
      // closure so logs carry one structured row that explains the whole
      // turn (skill identity, liveness, allowed/preferred mismatch, terminal
      // reason). Existing scattered metrics stay for telemetry; this is the
      // diagnostic-friendly aggregate.
      try {
        const summaryAllowed = Array.isArray(turnSummaryAllowedToolNames)
          ? turnSummaryAllowedToolNames
          : []
        const preferredFromFrame = turnFrame?.steering?.preferredToolNames || []
        const allowedPreferredMismatch = detectAllowedPreferredMismatch(summaryAllowed, preferredFromFrame)
        logAgentMetric('turn_frame_summary', {
          sessionId: request.sessionId,
          requestId: request.runId,
          skillId: turnFrame?.skill?.skillId || null,
          source: turnFrame?.skill?.source || null,
          liveness: turnFrame?.liveness || 'unknown',
          action: turnFrame?.skill?.action || null,
          mode: turnFrame?.steering?.mode || 'ask_model',
          allowedToolNames: summaryAllowed,
          preferredToolNames: preferredFromFrame,
          allowedPreferredMismatch,
          terminalReason,
          budgetExhausted: Boolean(turnFrame?.budget?.exhausted),
          longSkillResume: Boolean(turnSummaryLongSkillResume),
          iterations: turnSummaryIterations,
        })
      } catch {
        // metrics must never break the control path
      }
      transcript.emitStatus(status, terminalReason)
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
    // Stage 7 — captured at terminal closure for the `turn_frame_summary`
    // metric. `turnSummaryAllowedToolNames` is rebound after the run-policy
    // resolves `routedAllowedToolNames`. `turnSummaryIterations` is updated
    // by the iteration loop. `turnSummaryLongSkillResume` snapshots whether
    // this turn was on the long-skill resume budget.
    let turnSummaryAllowedToolNames: string[] = []
    let turnSummaryIterations = 0
    let turnSummaryLongSkillResume = false

    try {
      const session = request.session
      const userText = extractIncomingText(request.content as string | Array<Record<string, unknown>>)
      const requestEnvelope = request.requestEnvelope || buildRequestEnvelope({ userText })
      const hookRegistry = host.hookRegistry || NOOP_HOOK_REGISTRY
      await fireUserPromptSubmitHook(hookRegistry, {
        userText,
        sessionId: request.sessionId ?? null,
        timestamp: Date.now(),
      })
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
      const isSkillProgressFollowupTurnDetected = [
        requestEnvelope.primaryInstruction,
        requestEnvelope.pureUserText,
        contextualUserInput,
      ].some((text) => matchesSkillProgressFollowupIntent(String(text || '')))
      const taskOperationIntent = resolveTaskOperationIntent({
        texts: [
          requestEnvelope.primaryInstruction,
          requestEnvelope.pureUserText,
          contextualUserInput,
        ],
        retryOnlyTurnDetected: isRetryOnlyTurnDetected,
        configRepairTurnDetected: isConfigRepairTurnDetected,
        progressFollowupTurnDetected: isSkillProgressFollowupTurnDetected,
      })
      const isSkillRestartTurnDetected = taskOperationIntent.kind === 'restart_same_goal'
      const isSkillResumeTurnDetected = (isRetryOnlyTurnDetected && !isSkillRestartTurnDetected) || isConfigRepairTurnDetected
      // Stage Q (Stage 11) — `restartIntentClass` is computed below, AFTER
      // `explicitRunStateResourceForTurn` is resolved. See comment near
      // its definition for the contract.
      const explicitSkillMatches = skillDetectionInputs
        .map((text) => ({ text, skills: skillContextOrchestrator.findExplicitlyRequestedSkills(text) }))
      const firstSkillMatch = explicitSkillMatches.find((entry) => entry.skills.length > 0) || null
      let hasExplicitSkill = Boolean(firstSkillMatch)
      // Stage Q (Stage 11) — the legacy active-execution boolean is
      // gone (Phase 4 retired the upstream signal entirely). Downstream
      // consumers have been folded: `(... || activeExecution)` collapsed
      // to its left operand, and the log field hardcoded to `false`.
      let skillContextInjectionText = firstSkillMatch ? firstSkillMatch.text : contextualUserInput
      let referenceSkillForMetrics: { id?: string; name?: string } | null = null
      let referenceSkillHintVia: 'explicit' | 'lookback' | 'current' | 'history' | 'resource' | 'resource_history' | null = null
      const firstExplicitSkillId = firstSkillMatch?.skills[0]?.id || firstSkillMatch?.skills[0]?.skillId || null
      const currentRunStateResourceResolution = resolveExplicitRunStateResource(
        requestEnvelope.resources,
        requestEnvelope.referencedResources,
      )
      const historicalRunStateResourceResolution = currentRunStateResourceResolution.status === 'none' && isSkillResumeTurnDetected
        ? resolveRunStateResourceFromSessionText(
          session.messages
            .slice(-12, -1)
            .map((message) => extractIncomingText(message.content as string | Array<Record<string, unknown>>)),
        )
        : { status: 'none' as const }
      const runStateResourceResolution = currentRunStateResourceResolution.status !== 'none'
        ? currentRunStateResourceResolution
        : historicalRunStateResourceResolution
      const runStateResourceVia = currentRunStateResourceResolution.status !== 'none'
        ? 'resource'
        : historicalRunStateResourceResolution.status !== 'none'
          ? 'resource_history'
          : null
      let explicitRunStateResourceForTurn: ExplicitRunStateResourceCandidate | null =
        runStateResourceResolution.status === 'resolved' ? runStateResourceResolution.candidate : null
      if (
        explicitRunStateResourceForTurn
        && firstExplicitSkillId
        && firstExplicitSkillId !== explicitRunStateResourceForTurn.skillId
      ) {
        host.log(`[run_state_resource] ignored skill mismatch explicitSkillId=${firstExplicitSkillId} resourceSkillId=${explicitRunStateResourceForTurn.skillId}`)
        logAgentMetric('run_state_resource_resolution', {
          sessionId: request.sessionId,
          status: 'ignored_skill_mismatch',
          explicitSkillId: firstExplicitSkillId,
          resourceSkillId: explicitRunStateResourceForTurn.skillId,
        })
        explicitRunStateResourceForTurn = null
      } else if (runStateResourceResolution.status !== 'none' && isSkillResumeTurnDetected) {
        host.log(`[run_state_resource] ${JSON.stringify({
          status: runStateResourceResolution.status,
          reason: 'reason' in runStateResourceResolution ? runStateResourceResolution.reason : null,
          via: runStateResourceVia,
          skillId: explicitRunStateResourceForTurn?.skillId || null,
          hasSceneScores: Boolean(explicitRunStateResourceForTurn?.sceneScoresPath),
          explicitAction: explicitRunStateResourceForTurn?.explicitAction || null,
        })}`)
        logAgentMetric('run_state_resource_resolution', {
          sessionId: request.sessionId,
          status: runStateResourceResolution.status,
          reason: 'reason' in runStateResourceResolution ? runStateResourceResolution.reason : null,
          via: runStateResourceVia,
          skillId: explicitRunStateResourceForTurn?.skillId || null,
          hasSceneScores: Boolean(explicitRunStateResourceForTurn?.sceneScoresPath),
          explicitAction: explicitRunStateResourceForTurn?.explicitAction || null,
          candidateCount: 'candidateCount' in runStateResourceResolution ? runStateResourceResolution.candidateCount : null,
        })
      }
      let freshSkillForStart = firstSkillMatch?.skills[0] || null
      let freshSkillStartSkillId = firstExplicitSkillId
      const providedContinuationStateForInitialExplicitSkill = hasExplicitSkill
        ? null
        : providedContinuationState
      let explicitFreshSkillStart = Boolean(
        hasExplicitSkill
        && freshSkillForStart
        && !providedContinuationStateForInitialExplicitSkill
        && !isSkillResumeTurnDetected
        && !explicitRunStateResourceForTurn
        && skillDetectionInputs.some((text) => hasUrlSourceSignal(text)),
      )
      let explicitFreshStartAction = explicitFreshSkillStart
        ? inferExplicitSkillStartAction(freshSkillForStart, skillDetectionInputs)
        : null
      if (explicitFreshSkillStart) {
        logAgentMetric('explicit_skill_fresh_start_detected', {
          sessionId: request.sessionId,
          skillId: freshSkillStartSkillId,
          action: explicitFreshStartAction,
        })
      }
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
      // Stage 4 W2 — single mutator entry. The 5 parallel rearm sections
      // (Points B-E per v6 plan §9) and the config-repair fallback that
      // previously lived inline at turn-engine.ts:1453-1646 are collapsed
      // into `applySkillTurnIdentity`. The resolver's identity is the
      // priority hint; the applier internally honours legacy cascade
      // order so a resolver branch that can't actually arm falls
      // through to the next legacy candidate.
      //
      // `shouldBindSkillContextForTurn` predicate (turn-engine.ts:~1716
      // post-edit) and the `clearLastReferenceSkill` gate stay below in
      // turn-engine — Point F's `rememberExplicitReferenceSkillHint` and
      // the hint-clear conditions still depend on local turn state that
      // the applier doesn't see.
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

      const __identitySnapshot = collectIdentityReadSnapshot({
        request: {
          sessionId: request.sessionId,
          primaryInstruction: requestEnvelope.primaryInstruction,
          pureUserText: requestEnvelope.pureUserText,
        },
        contextualUserInput,
        currentTurnResumeText: currentTurnResumeText || '',
        explicitRunStateResourceForTurn,
        providedContinuationState,
        isSkillResumeTurnDetected,
        isSkillRestartTurnDetected,
        isConfigRepairTurnDetected,
        previousAssistantSkillToolUses,
        firstSkillMatch,
        firstExplicitSkillId,
        runStateResourceVia,
        skillContextOrchestrator,
        inspectLatestSkillTask: (params) =>
          host.skillTaskSupervisor?.inspectLatestSkillTask
            ? host.skillTaskSupervisor.inspectLatestSkillTask(params)
            : inspectLatestSkillTask(params),
        resolveRecentSkillRun: host.resolveRecentSkillRun,
        // Stage Q (Stage 11) — `resolveRecentSkillTaskRun` is now a
        // formal field on `TurnEngineHost` (run-contracts.ts:805+).
        // The earlier `(host as unknown as { ... })` puncture is
        // retired.
        resolveRecentSkillTaskRun: host.resolveRecentSkillTaskRun,
        getLatestSkillRun,
      })
      const __identity = resolveSkillTurnIdentity(__identitySnapshot)

      const __applied = applySkillTurnIdentity(__identity, {
        sessionId: request.sessionId,
        providedContinuationState,
        isSkillResumeTurnDetected,
        isConfigRepairTurnDetected,
        previousAssistantSkillToolUses,
        explicitRunStateResourceForTurn,
        runStateResourceVia,
        firstExplicitSkillId,
        contextualUserInput,
        currentTurnResumeText: currentTurnResumeText || '',
        initialHasExplicitSkill: hasExplicitSkill,
        initialSkillContextInjectionText: skillContextInjectionText,
        skillContextOrchestrator,
        inspectLatestSkillTaskForHost,
        // Stage Q (Stage 11) — `resolveActiveSkillContextLive` field
        // renamed to `resolveActiveSkillContext` (the misleading `Live`
        // suffix suggested host-injectable; in fact it's a direct
        // function reference passed through to the apply phase).
        resolveActiveSkillContext,
        rememberActiveSkillContext,
        getLatestSkillRun,
        resolveSkillRunForResume,
        skillRunFromSupervisorSnapshot,
        skillRunFromActiveSkillContext,
        isSameSkillRunForResume,
        extractTaskIdFromText,
        buildSkillResumeContextPrompt,
        resolveRecentSkillRun: host.resolveRecentSkillRun,
        // Stage Q (Stage 11) — second of two former type punctures
        // replaced by formal field; see comment at the first call site
        // for the run-contracts.ts:805+ field declaration.
        resolveRecentSkillTaskRun: host.resolveRecentSkillTaskRun,
        log: (line) => host.log(line),
      })

      hasExplicitSkill = __applied.hasExplicitSkill
      skillContextInjectionText = __applied.skillContextInjectionText
      const lookbackRearmedSkill = __applied.lookbackRearmedSkill
      referenceSkillForMetrics = __applied.referenceSkillForMetrics
      referenceSkillHintVia = __applied.referenceSkillHintVia

      // Config-repair clarification finish (legacy turn-engine.ts:1641-1647).
      // The resolver flags `mode:'none' / reason:'config_repair_no_recoverable_task'`
      // for this case but does not own turn termination; the applier sets
      // `shouldFinishWithClarification` and turn-engine performs the legacy
      // emit + finish here.
      if (__applied.shouldFinishWithClarification && __applied.clarificationText) {
        transcript.emitOutput(__applied.clarificationText, 'text')
        pushAssistantTextSafely(session, __applied.clarificationText, { sessionId: request.sessionId })
        return finish({ success: true, status: 'done' })
      }

      // Stage 4 W2 observability — record applied identity. The W1
      // shadow-mismatch metric is removed in this commit because the
      // legacy A-F cascade is no longer running side-by-side; mismatch
      // is undefined post-cutover. `modeApplied` is the post-W2 signal
      // for operators auditing identity decisions.
      logAgentMetric(SKILL_TURN_IDENTITY_METRICS.modeApplied, {
        sessionId: request.sessionId,
        mode: __identity.mode,
        source: __identity.mode === 'skill' ? __identity.source : __identity.reason,
        appliedReferenceSkillHintVia: __applied.referenceSkillHintVia,
      })

      // Point F (legacy turn-engine.ts:1651-1665) — explicit reference hint
      // registration. Stays inline because it depends on `firstSkillMatch`
      // (Point A) and the applied locals.
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

      // Stage Q (Stage 11) — classify the restart intent into one of three
      // mutually-exclusive classes BEFORE the structure layer loads any
      // supervisor snapshot. `fresh` and `restart_from_existing` both
      // suppress stale-supervisor liveness in the frame; only `resume`
      // walks the legacy path. Audit §C-9 / plan §3.6 contract C8+C9.
      // `continuationRef: null` here because we don't have a projection
      // loaded yet — `restart_from_existing` is determined by EXPLICIT
      // user input (run-state resource or provided continuation state),
      // NOT by the projection's stale continuationRef (which is the
      // exact thing the bug case showed we should ignore).
      const restartIntentClass: RestartIntentClass = classifyRestartIntent({
        userIntent: isSkillRestartTurnDetected
          ? 'start'
          : isSkillResumeTurnDetected
            ? 'continue'
            : isConfigRepairTurnDetected
              ? 'repair_config'
              : isRetryOnlyTurnDetected
                ? 'continue'
                : 'unknown',
        explicitRunStateResource: explicitRunStateResourceForTurn,
        providedContinuationState,
        continuationRef: null,
      })
      // Stage Q — this predicate is the remaining skill-context binding
      // gate for preferred tool selection, active-context lookup, and frame
      // identity. Fresh/restart liveness suppression is handled in
      // `resolveTurnFrame` via `restartIntentClass`.
      const shouldBindSkillContextForTurn = Boolean(
        hasExplicitSkill
        || explicitFreshSkillStart
        || explicitRunStateResourceForTurn
        || isSkillResumeTurnDetected
        || isSkillRestartTurnDetected
        || isSkillProgressFollowupTurnDetected
        || matchesChildCancelIntent(
          requestEnvelope.primaryInstruction,
          requestEnvelope.pureUserText,
          requestEnvelope.rawUserText,
        )
      )
      if (!shouldBindSkillContextForTurn && request.sessionId) {
        clearLastReferenceSkill(request.sessionId)
        logAgentMetric('skill_reference_hint_cleared_for_unrelated_turn', {
          sessionId: request.sessionId,
          primaryDomain: executionIntentContext.intentClassification.primaryDomain,
        })
      }
      const legacyPreferredSkillToolNames = (shouldBindSkillContextForTurn && hasExplicitSkill)
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
      if (shouldBindSkillContextForTurn) {
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
      }
      if (activeSkillContextForTurn && activeSkillContextForTurn.source !== 'reference_hint') {
        // Stage Q (Stage 11) — only `resume` class re-remembers active
        // context. `fresh` and `restart_from_existing` must not pin the
        // stale context onto the session (audit §E / plan §3.6 contract C9).
        // `explicitFreshSkillStart` retains its pre-Q behavior (URL-bearing
        // explicit fresh start also doesn't remember).
        if (!explicitFreshSkillStart && restartIntentClass === 'resume') {
          rememberActiveSkillContext(request.sessionId, activeSkillContextForTurn)
        }
        if (!referenceSkillForMetrics && !explicitFreshSkillStart && restartIntentClass === 'resume') {
          referenceSkillForMetrics = {
            id: activeSkillContextForTurn.skillId,
            name: activeSkillContextForTurn.skillName || activeSkillContextForTurn.skillId,
          }
        }
      }
      // Stage E — fetch supervisor snapshot so the resolver can hand it to
      // `loadSkillRunContract`. Without this the contract's `actionInput` /
      // `originalInput` (read from snapshot.resumePayload) stay null and
      // forced-action input synthesis can't dispatch with valid input.
      //
      // Stage Q (Stage 11) — supervisor snapshot is still loaded for
      // ALL restart classes so frame.skill carries identity (skillId /
      // skillName) for the model. The fix for the "重新开始 / immediate
      // checkpoint_budget" bug is at the LIVENESS layer:
      // `turn-frame-resolver.inferLiveness` early-returns 'unknown' on
      // userIntent='start', so stale liveness/status from the snapshot
      // does NOT leak into the frame. Audit §E / plan §3.6 contract C9.
      let supervisorSnapshotForFrame: SkillTaskSupervisorSnapshot | null = null
      if (shouldBindSkillContextForTurn) {
        try {
          supervisorSnapshotForFrame = inspectLatestSkillTaskForHost({
            sessionId: request.sessionId,
            scopeId: request.sessionId,
          })
        } catch {
          supervisorSnapshotForFrame = null
        }
      }
      const hasNonHintSkillContextForTurn = Boolean(
        explicitRunStateResourceForTurn
        || supervisorSnapshotForFrame?.skillId
        || (
          activeSkillContextForTurn
          && activeSkillContextForTurn.source !== 'reference_hint'
        ),
      )
      const explicitSkillIdForFrame = explicitRunStateResourceForTurn?.skillId
        || (explicitFreshSkillStart ? freshSkillStartSkillId : null)
        || (hasExplicitSkill ? firstExplicitSkillId : null)
      const explicitSkillNameForFrame = explicitRunStateResourceForTurn?.skillName
        || (explicitFreshSkillStart ? (freshSkillForStart?.name || freshSkillStartSkillId) : null)
        || (hasExplicitSkill && firstSkillMatch?.skills[0]
          ? (firstSkillMatch.skills[0].name || firstExplicitSkillId)
          : null)
      turnFrame = resolveTurnFrame({
        sessionId: request.sessionId,
        requestId: request.runId,
        userIntent: explicitFreshSkillStart
          ? 'start'
          : isSkillRestartTurnDetected
            ? 'start'
          : isConfigRepairTurnDetected
          ? 'repair_config'
          : isRetryOnlyTurnDetected || (
            isSkillProgressFollowupTurnDetected
            && hasNonHintSkillContextForTurn
          )
            ? 'continue'
            : 'unknown',
        explicitSkillId: explicitSkillIdForFrame,
        explicitSkillName: explicitSkillNameForFrame,
        explicitAction: explicitRunStateResourceForTurn?.explicitAction || (explicitFreshSkillStart ? explicitFreshStartAction : null),
        explicitOutputDir: explicitRunStateResourceForTurn?.outputDir || null,
        explicitRunStatePath: explicitRunStateResourceForTurn?.runStatePath || null,
        explicitSceneScoresPath: explicitRunStateResourceForTurn?.sceneScoresPath || null,
        activeContext: activeSkillContextForTurn,
        supervisorSnapshot: supervisorSnapshotForFrame,
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
      preferredSkillToolNames = choosePreferredSkillToolNamesFromFrame(turnFrame, preferredSkillToolNames)
      isLongSkillResumeTurn = (
        turnFrame.mode === 'skill_resume'
        && hasLongTypedSkillAction(preferredSkillToolNames)
      ) || isLongSkillResumeTurn

      // Stage 4 W3b — derive per-turn skill tool authorization from the
      // resolver's identity. Mirrors `preferredSkillToolNames`: when the
      // turn binds skill context (mode:'skill' from identity), authorization
      // is `mode:'selected'` with the same typed-action allowlist; otherwise
      // it's `mode:'none'` with the identity reason. The closure
      // `buildHostToolContext` (declared above) captures `__authorization`
      // by reference, so the cutover takes effect at the next call site.
      __authorization = buildAuthorizationFromIdentity(
        __identity.mode === 'skill'
          ? { mode: 'skill', skillId: __identity.skillId, source: __identity.source }
          : { mode: 'none', reason: __identity.reason },
        {
          preferredSkillToolNames: preferredSkillToolNames || [],
          allPrimitiveToolNames: PRIMITIVE_TOOL_DEFS.map((d) => d.name),
        },
      )

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
        } activeExecution=false referenceSkillHintArmed=${referenceSkillHintArmed} preferredSkillToolCount=${preferredSkillToolNames?.length || 0} preferredSkillTools=${preferredSkillToolNames?.join('|') || 'none'}`,
      )
      let childCommand = computeChildContinuationDecision(
        turnFrame,
        getSkillChildRunCloseEvent,
      )
      const childRunIdForCommand = childCommand.kind === 'none' ? null : childCommand.childRunId
      const isChildCancelTurn = Boolean(childRunIdForCommand) && matchesChildCancelIntent(
        requestEnvelope.primaryInstruction,
        requestEnvelope.pureUserText,
        requestEnvelope.rawUserText,
      )
      if (childCommand.kind === 'wait' && !isChildCancelTurn) {
        const close = await waitForChildCloseEvent(childCommand.childRunId, CHILD_SELF_AWAIT_TIMEOUT_MS)
        if (close) {
          childCommand = decisionFromChildClose(childCommand.childRunId, close)
        }
      }
      if (turnFrame?.skill?.runContract && childCommand.kind !== 'none') {
        // Stage M (M2a) — child-command resolution patch (first cluster).
        // Anchored on the existing contract.skillId so applyTurnFramePatch
        // routes through the merge-partials path. See plan §2.3.
        const anchorSkillId = turnFrame.skill.runContract.skillId
        if (childCommand.kind === 'terminal' || childCommand.kind === 'checkpoint_paused') {
          turnFrame = applyTurnFramePatch(turnFrame, {
            runContract: {
              skillId: anchorSkillId,
              childCloseEvent: childCommand.closeEvent,
              childStatus: childCommand.closeEvent.status,
              parentNextHint: 'continue_other_work',
            },
          })
        } else if (childCommand.kind === 'wait') {
          turnFrame = applyTurnFramePatch(turnFrame, {
            runContract: {
              skillId: anchorSkillId,
              parentNextHint: 'wait_for_close_event',
            },
          })
        }
      }
      if (isChildCancelTurn && childRunIdForCommand) {
        const cancelChild = (host as unknown as {
          cancelSkillChildRun?: typeof cancelSkillChildRun
        }).cancelSkillChildRun || cancelSkillChildRun
        const close = await cancelChild(childRunIdForCommand, { reason: 'cancelled_user', source: 'nlp' })
        if (turnFrame?.skill?.runContract) {
          // Stage M (M2a) — cancel-branch contract update (second cluster).
          // Followed by the terminalReason patch below; we keep them as two
          // separate calls so the "cancelled_user > anything" priority in
          // applyTurnFramePatch fires correctly even if a prior patch in
          // this turn had already set terminalReason.
          const anchorSkillId = turnFrame.skill.runContract.skillId
          turnFrame = applyTurnFramePatch(turnFrame, {
            runContract: {
              skillId: anchorSkillId,
              childCloseEvent: close,
              childStatus: close.status,
              parentNextHint: 'continue_other_work',
            },
          })
        }
        if (turnFrame) {
          turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'cancelled_user' })
        }
        const outcome = renderChildCommandOutcome({
          childRunId: childRunIdForCommand,
          command: 'cancel',
          close,
        })
        transcript.emitOutput(outcome.message, 'text')
        pushAssistantTextSafely(session, outcome.message, { sessionId: request.sessionId })
        logAgentMetric('turn_child_run_user_cancelled', {
          sessionId: request.sessionId,
          childRunId: childRunIdForCommand,
          childStatus: close.status,
          terminalReason: close.terminalReason,
        })
        return finish({
          success: true,
          cancelled: outcome.status === 'cancelled',
          status: outcome.status,
          terminalReason: outcome.terminalReason,
        })
      }
      if (
        childCommand.kind === 'terminal'
        && (isSkillResumeTurnDetected || isSkillProgressFollowupTurnDetected)
        && !isConfigRepairTurnDetected
      ) {
        const outcome = renderChildCommandOutcome({
          childRunId: childCommand.childRunId,
          command: 'resume',
          close: childCommand.closeEvent,
        })
        transcript.emitOutput(outcome.message, 'text')
        pushAssistantTextSafely(session, outcome.message, { sessionId: request.sessionId })
        return finish({
          success: outcome.status !== 'error',
          cancelled: outcome.status === 'cancelled',
          status: outcome.status,
          terminalReason: outcome.terminalReason,
        })
      }
      if (
        childCommand.kind === 'wait'
        && (isSkillResumeTurnDetected || isSkillProgressFollowupTurnDetected)
        && !isConfigRepairTurnDetected
      ) {
        const outcome = renderChildCommandOutcome({
          childRunId: childCommand.childRunId,
          command: 'resume',
          close: null,
        })
        transcript.emitOutput(outcome.message, 'text')
        pushAssistantTextSafely(session, outcome.message, { sessionId: request.sessionId })
        return finish({
          success: true,
          status: 'checkpoint',
          terminalReason: outcome.terminalReason,
        })
      }
      if (
        childCommand.kind === 'checkpoint_paused'
        && isSkillProgressFollowupTurnDetected
        && !isSkillResumeTurnDetected
        && !isConfigRepairTurnDetected
      ) {
        const outcome = renderChildCommandOutcome({
          childRunId: childCommand.childRunId,
          command: 'resume',
          close: childCommand.closeEvent,
        })
        transcript.emitOutput(outcome.message, 'text')
        pushAssistantTextSafely(session, outcome.message, { sessionId: request.sessionId })
        return finish({
          success: outcome.status !== 'error',
          cancelled: outcome.status === 'cancelled',
          status: outcome.status,
          terminalReason: outcome.terminalReason,
        })
      }
      if (
        childCommand.kind === 'checkpoint_paused'
        && isSkillResumeTurnDetected
        && !isConfigRepairTurnDetected
      ) {
        if (!turnFeatureFlags.childResumeEnabled) {
          // Production rollback path: when the operator sets
          // READY_SKILL_CHILD_RESUME_ENABLED='0' we emit observability and
          // fall through to the normal model turn so the assistant can
          // describe the paused state without invoking the resume command.
          // The runner's `resumeSkillChildRun` API itself is unaffected —
          // only the parent loop's automatic resume branch is gated.
          logAgentMetric(TOOL_ERROR_METRICS.childResumeDisabledByFlag, {
            sessionId: request.sessionId,
            childRunId: childCommand.childRunId,
            childStatus: childCommand.closeEvent.status,
            terminalReason: childCommand.closeEvent.terminalReason,
          })
          // Intentional fallthrough — do NOT call finish() here.
        } else {
          const childStatus = childCommand.closeEvent.status
          const canDelegateBlockedResume = isBlockedChildCloseStatus(childStatus)
            && childCommand.closeEvent.terminalReason === 'blocked_external'
          if (!isDirectlyResumableChildStatus(childStatus) && !canDelegateBlockedResume) {
            const detail = childCommand.closeEvent.error?.message
              || childCommand.closeEvent.terminalReason
              || 'child run blocked'
            const message = `当前 child run ${childCommand.childRunId} 处于 blocked，不能直接继续；需要先处理阻塞原因：${detail}。`
            transcript.emitOutput(message, 'text')
            pushAssistantTextSafely(session, message, { sessionId: request.sessionId })
            logAgentMetric('turn_child_run_resume_rejected', {
              sessionId: request.sessionId,
              childRunId: childCommand.childRunId,
              childStatus,
              terminalReason: childCommand.closeEvent.terminalReason,
            })
            const terminalReason = mapChildCloseToTurnTerminalReason(childCommand.closeEvent)
            return finish({
              success: true,
              status: statusFromTerminalReason(terminalReason),
              terminalReason,
            })
          }
          const resumeChild = (host as unknown as {
            resumeSkillChildRun?: typeof resumeSkillChildRun
          }).resumeSkillChildRun || resumeSkillChildRun
          const resumed = await resumeChild(childCommand.childRunId, {
            agentContext: buildAgentContextForSkillSpawn(),
          })
          // Stage M (M2a) — resume's freshContractFields are applied through
          // the framePatch contract, not by mutating the live contract object.
          turnFrame = applyChildResumeFreshContractFields(turnFrame, resumed.freshContractFields)
          const resumedClose = resumed.closeEvent
            || await waitForChildCloseEvent(resumed.childRunId, CHILD_SELF_AWAIT_TIMEOUT_MS)
          const outcome = renderChildCommandOutcome({
            childRunId: resumed.childRunId,
            command: 'resume',
            close: resumedClose,
          })
          transcript.emitOutput(outcome.message, 'text')
          pushAssistantTextSafely(session, outcome.message, { sessionId: request.sessionId })
          logAgentMetric('turn_child_run_resumed', {
            sessionId: request.sessionId,
            childRunId: resumed.childRunId,
            childStatus: resumed.status,
            previousStatus: childStatus,
            outcomeStatus: outcome.status,
            outcomeTerminalReason: outcome.terminalReason,
          })
          return finish({
            success: outcome.status !== 'error',
            cancelled: outcome.status === 'cancelled',
            status: outcome.status,
            terminalReason: outcome.terminalReason,
          })
        }
      }
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
        // Stage 4 W3b.2 fix — thread authorization into the capability
        // controller so allowedToolNames + toolResolution snapshot are
        // computed with the same filter the model-visible list uses.
        // Stage 10 — non-null assertion: `__authorization` is unconditionally
        // assigned by `buildAuthorizationFromIdentity` above (line ~1792)
        // before this consumer runs.
        authorization: __authorization!,
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
      // Stage 4 W3b.2 — sync per-turn authorization onto ToolPolicy so
      // `getPolicyAnthropicTools` / `getPolicyOpenAIToolBundle` thread it
      // through gateway → registry's 4 model-visible list resolvers.
      // Mutating the local toolPolicy is intentional and safe — the
      // object is local turn state and not retained beyond this turn.
      toolPolicy.authorization = __authorization
      const initialCoordinatorArbitrations = domainAdapters
        .map((adapter) => adapter.arbitrateRunCapabilities?.({
          route: null,
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
        }))
        .filter((arbitration): arbitration is NonNullable<typeof arbitration> => Boolean(arbitration))
      const shouldPersistDocumentContext =
        initialCoordinatorArbitrations.some((arbitration) => arbitration.forceTool === 'document')
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
        || (!isSkillRestartTurnDetected && !shouldSuppressImplicitContinuation && (
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

      let reconciledRunCapabilities = reconcileAfterBrowserDecision({
        prepared: preparedRunCapabilities,
        browserDecisionMode: browserDecision.mode as any,
      })
      toolPolicy = reconciledRunCapabilities.toolPolicy
      // W3b.2 — re-sync after reconcile (toolPolicy reference may differ).
      toolPolicy.authorization = __authorization
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
      const shouldUseActiveSkillResumeRoute =
        turnFrame?.mode === 'skill_resume'
        && Boolean(turnFrame.skill)
        && turnFrame.liveness !== 'unknown'
      const shouldUseActiveSkillStartRoute =
        turnFrame?.mode === 'skill_start'
        && Boolean(turnFrame.skill)
        && hasLongTypedSkillAction(preferredSkillToolNames)
      const shouldForceRunStateSkillResume =
        Boolean(explicitRunStateResourceForTurn) && shouldUseLongSkillResumeBudget
      const taskTypeResolution = (shouldUseLongSkillResumeBudget || shouldUseActiveSkillResumeRoute || shouldUseActiveSkillStartRoute) && (
        resolvedTaskTypeForEffectiveRun.executionChain === 'direct'
        || shouldForceRunStateSkillResume
        || shouldUseActiveSkillStartRoute
      )
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
        continuationContext: continuationTaskId
          ? {
            state: continuationState ?? null,
            projection: continuationProjection ?? null,
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
      const selectedDomainPrepareResult: DomainAdapterPrepareResult | null = selectedDomainAdapter
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
      const preparedBrowserDecisionMode = readPreparedBrowserDecisionMode(selectedDomainPrepareResult)
      if (preparedBrowserDecisionMode && preparedBrowserDecisionMode !== browserDecision.mode) {
        browserDecision = {
          mode: preparedBrowserDecisionMode,
          reason: 'domain_adapter',
        }
        reconciledRunCapabilities = reconcileAfterBrowserDecision({
          prepared: preparedRunCapabilities,
          browserDecisionMode: browserDecision.mode as any,
        })
        toolPolicy = reconciledRunCapabilities.toolPolicy
        // W3b.2 — re-sync after second reconcile.
        toolPolicy.authorization = __authorization
        appendLoggedToolResolution({
          state,
          host,
          stage: 'host_effective_after_domain_prepare',
          resolution: reconciledRunCapabilities.toolResolution,
          visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
          allowBrowserTools: reconciledRunCapabilities.toolPolicy.allowBrowserTools,
          allowedToolNames: reconciledRunCapabilities.allowedToolNames,
        })
        assertNoToolResolutionViolation({
          state,
          host,
          stage: 'host_effective_after_domain_prepare',
          resolution: reconciledRunCapabilities.toolResolution,
          allowBrowserTools: reconciledRunCapabilities.toolPolicy.allowBrowserTools,
          visibleCapabilityGroupIds: reconciledRunCapabilities.visibilityPlan.visibleCapabilityGroupIds || [],
          allowedToolNames: reconciledRunCapabilities.allowedToolNames,
        })
      }
      const selectedCoordinatorArbitration = selectedDomainAdapter?.arbitrateRunCapabilities?.({
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
        domainState: selectedDomainPrepareResult?.domainState,
      } as Parameters<DomainAdapter['arbitrateRunCapabilities']>[0] & { domainState?: unknown }) || null
      const shouldHideBrowserProcessText = Boolean(selectedCoordinatorArbitration?.hideAssistantProcessText)

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
      let routedAllowedToolNames = selectedDomainPrepareResult?.allowedToolNames || reconciledRunCapabilities.allowedToolNames
      const refreshToolPolicyFromTurnFrame = (reason: string) => {
        if (!turnFrame?.skill) return
        const nextPreferredSkillToolNames = choosePreferredSkillToolNamesFromFrame(turnFrame, preferredSkillToolNames) || []
        // Stage 4 W3b.2 fix — recompute authorization with the refreshed
        // preferredSkillToolNames BEFORE building nextToolPolicy, so
        // `collectAllowedToolNames(nextToolPolicy)` sees the same filter
        // the model-visible list will use.
        const nextAuthorization = buildAuthorizationFromIdentity(
          __identity.mode === 'skill'
            ? { mode: 'skill', skillId: __identity.skillId, source: __identity.source }
            : { mode: 'none', reason: __identity.reason },
          {
            preferredSkillToolNames: nextPreferredSkillToolNames,
            allPrimitiveToolNames: PRIMITIVE_TOOL_DEFS.map((d) => d.name),
          },
        )
        const nextToolPolicy: ToolPolicy = {
          ...toolPolicy,
          preferredSkillToolNames: nextPreferredSkillToolNames,
          authorization: nextAuthorization,
        }
        const policyAllowedToolNames = reconcileAllowedToolNamesWithPreferredSkillTools(
          collectAllowedToolNames(nextToolPolicy),
          nextPreferredSkillToolNames,
        )
        const domainAllowedToolNames = Array.isArray(selectedDomainPrepareResult?.allowedToolNames)
          ? selectedDomainPrepareResult.allowedToolNames
          : null
        const nextAllowedToolNames = domainAllowedToolNames
          ? reconcileAllowedToolNamesWithPreferredSkillTools(domainAllowedToolNames, nextPreferredSkillToolNames)
          : policyAllowedToolNames
        const preferredChanged = !areStringArraysEqual(preferredSkillToolNames, nextPreferredSkillToolNames)
        const allowedChanged = !areStringArraysEqual(routedAllowedToolNames, nextAllowedToolNames)
        if (!preferredChanged && !allowedChanged) return
        preferredSkillToolNames = nextPreferredSkillToolNames
        toolPolicy = nextToolPolicy
        __authorization = nextAuthorization
        reconciledRunCapabilities = {
          ...reconciledRunCapabilities,
          toolPolicy,
          allowedToolNames: nextAllowedToolNames,
        }
        routedAllowedToolNames = nextAllowedToolNames
        turnSummaryAllowedToolNames = [...routedAllowedToolNames]
        logAgentMetric('turn_frame_tool_policy_refreshed', {
          sessionId: request.sessionId,
          reason,
          mode: turnFrame.mode,
          skillId: turnFrame.skill.skillId,
          liveness: turnFrame.liveness,
          preferredToolNames: preferredSkillToolNames,
          allowedToolNames: routedAllowedToolNames,
          steeringMode: turnFrame.steering.mode,
          requiredToolName: turnFrame.steering.requiredToolName,
        })
      }
      refreshToolPolicyFromTurnFrame('initial')
      // Stage 7 — capture the allowed-tool surface and long-skill flag so
      // `finish()` can include them in the per-turn `turn_frame_summary` log.
      turnSummaryAllowedToolNames = Array.isArray(routedAllowedToolNames)
        ? [...routedAllowedToolNames]
        : []
      turnSummaryLongSkillResume = Boolean(shouldUseLongSkillResumeBudget)
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
        const modelSession = buildModelInputSession(session)
        const simpleResponse = await host.requestSimpleText({
          session: modelSession,
          signal: request.abortSignal,
          providerContext: host.providerContext,
          enableKimiWebSearch: !hasMediaInputs,
        }) as TurnSimpleResponse
        if (simpleResponse.fallback) {
          state.latestFallback = simpleResponse.fallback
        }
        if (simpleResponse.text) {
          const toolCallOnlyFallback = buildToolCallOnlyFallbackText(simpleResponse.text)
          if (toolCallOnlyFallback) {
            logAgentMetric(TOOL_ERROR_METRICS.directToolCallTextBlocked, {
              sessionId: request.sessionId,
              toolNames: toolCallOnlyFallback.toolNames.slice(0, 5),
              originalLen: simpleResponse.text.length,
            })
            transcript.emitOutput(toolCallOnlyFallback.text, 'text')
            pushAssistantTextSafely(session, toolCallOnlyFallback.text, { sessionId: request.sessionId })
            return finish({ success: true, status: 'done' })
          }
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
      // Stage 7 — force-tool dispatch tracking. When the steering layer marks
      // the frame as `mode='force_tool'`, the next iteration synthesizes a
      // tool batch directly instead of calling the model. We:
      //   1. cap force_tool dispatches to 1 per turn (no chaining; if the
      //      user wants chained resume they can do it via model in the next
      //      turn);
      //   2. set `recentForceToolDispatched=true` after a force_tool fires so
      //      the steering layer's next evaluation falls back to ask_model and
      //      we cannot loop on the same forced tool.
      let forceToolDispatchedThisTurn = false
      let recentForceToolDispatched = false
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
        // Stage Q (Stage 11) — Codex round 1 ❌#2/4: even when the
        // initial frame liveness is suppressed via `inferLiveness`
        // (userIntent='start' → 'unknown'), the lease-sampling path
        // would still reload supervisor and re-apply its liveness via
        // `applySupervisorRuntimeToTurnFrame` (turn-frame-resolver.ts:
        // 212-221), undoing the suppression. Gate this sampler by
        // `restartIntentClass === 'resume'` so `fresh` and
        // `restart_from_existing` turns never observe stale liveness.
        if (restartIntentClass !== 'resume') return null
        if (!shouldBindSkillContextForTurn) return null
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
        if (snapshot.closeAllowed && snapshot.status === 'completed') return false
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
        : shouldBindSkillContextForTurn
          ? sampleSkillLeaseSnapshot(true)
          : null
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
      // Stage M (M2b) — sync `frame.budget` with the current lease state
      // after every lease mutation. Uses the named `produceBudgetPatch`
      // producer (skill-budget-lease-controller.ts) so the M3 gate's "every
      // lease mutation must be followed by produceBudgetPatch" rule is
      // satisfied by symbol-name match. Also see plan §2.4.
      const syncBudgetPatchToFrame = (): void => {
        if (!turnFrame) return
        const patch = produceBudgetPatch({
          lease: skillBudgetLeaseState,
          budgetWarningLevel: state.budgetWarningLevel ?? null,
          stepBudgetRemainingIterations: state.stepBudgetState?.remainingIterations ?? null,
        })
        turnFrame = applyTurnFramePatch(turnFrame, patch)
      }
      const ensureSkillBudgetLease = (reason: 'planned' | 'observed_long_skill_action' | 'observed_supervisor_snapshot'): void => {
        if (skillBudgetLeaseState) return
        skillBudgetLeaseState = createSkillBudgetLeaseState({ iteration: iterations })
        // Stage M (M2b) — emit the budget patch immediately after lease
        // creation so the next steering read sees the new lease window.
        syncBudgetPatchToFrame()
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
        } else if (turnFrame?.skill) {
          // Stage 7 — when `hasPlannedLeaseTrigger` is true the engine has
          // already committed to long-skill resume (preferredSkillToolNames
          // contains the typed action OR shouldUseLongSkillResumeBudget is
          // set), but `observedLeaseSnapshot` is null so the frame's
          // liveness has never been reconciled against the supervisor.
          // Sample once now so the steering layer can decide between
          // force_tool and ask_model with a real liveness signal instead
          // of `unknown`. If the sample fails (no DB / no live task) the
          // frame stays as `unknown` and steering falls back to ask_model.
          try {
            const plannedSnapshot = sampleSkillLeaseSnapshot(true)
            if (plannedSnapshot && plannedSnapshot.skillId === turnFrame.skill.skillId) {
              turnFrame = applySupervisorRuntimeToTurnFrame(turnFrame, plannedSnapshot)
              previousLeaseSnapshot = plannedSnapshot
              lastLeaseSnapshot = plannedSnapshot
              host.log(`[turn_frame] ${JSON.stringify(summarizeTurnFrame(turnFrame))}`)
              logAgentMetric('turn_frame_resolved', summarizeTurnFrame(turnFrame) || {})
            }
          } catch {
            // sampling errors must never break the turn
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
          // Stage M (M2b) — sync after lease replacement.
          syncBudgetPatchToFrame()
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
          pushSystemReminderMessage(session, {
            topic: 'budget',
            priority: 80,
            text: buildBudgetWarningMessage({
              iterations,
              effectiveMaxIterations: effectiveMaxToolIterations,
              level: 'converge',
              isLongSkillContext: shouldUseLongSkillResumeBudget || (preferredSkillToolNames?.length || 0) > 0,
            }),
          })
          convergencePromptInjected = true
        }
        iterations += 1
        // Stage 7 — keep the per-turn diagnostic snapshot in sync so the
        // terminal `turn_frame_summary` metric reports the actual iteration
        // count regardless of which closure path fires.
        turnSummaryIterations = iterations
        Object.assign(state.runBudgetState, consumeIterationBudget(state.runBudgetState))
        if (state.stepBudgetState) {
          state.stepBudgetState = {
            ...state.stepBudgetState,
            remainingIterations: Math.max(0, Number(state.stepBudgetState.remainingIterations || 0) - 1),
          }
        }
        state.syncBudgetWarning()

        // Phase 6 (T5 wave 3) — child-loop continuation routing.
        //
        // When the active frame's runContract carries a childRunId, the
        // child runner owns "what runs next". Before any model invocation
        // or force-tool decision, ask the child runner for its current
        // close event (durable lookup, post-T4) and route accordingly:
        //
        //   - terminal       — completed/failed/killed: stamp the close
        //                      onto the contract, set the matching turn
        //                      terminal reason, finish the turn.
        //   - checkpoint_paused — recoverable_paused/budget_paused/blocked:
        //                      stamp the close, set the turn to
        //                      checkpoint_user_input so the parent waits
        //                      for the user (or background runner) to
        //                      resume; never re-derive a typed action.
        //   - wait           — child still running: stamp parentNextHint
        //                      so steering / contract summary stay in
        //                      sync; fall through to the model so it can
        //                      talk to the user about the in-flight work.
        //   - none           — frame isn't child-owned; existing flow.
        const childContinuation = computeChildContinuationDecision(
          turnFrame,
          getSkillChildRunCloseEvent,
        )
        if (turnFrame?.skill?.runContract && childContinuation.kind !== 'none') {
          // Stage M (M2a) — child-continuation contract patch (third cluster).
          const anchorSkillId = turnFrame.skill.runContract.skillId
          if (childContinuation.kind === 'terminal'
              || childContinuation.kind === 'checkpoint_paused') {
            turnFrame = applyTurnFramePatch(turnFrame, {
              runContract: {
                skillId: anchorSkillId,
                childCloseEvent: childContinuation.closeEvent,
                childStatus: childContinuation.closeEvent.status,
                parentNextHint: 'continue_other_work',
              },
            })
          } else if (childContinuation.kind === 'wait') {
            turnFrame = applyTurnFramePatch(turnFrame, {
              runContract: {
                skillId: anchorSkillId,
                parentNextHint: 'wait_for_close_event',
              },
            })
          }
        }
        if (childContinuation.kind === 'terminal') {
          // Map child-close status to the parent turn's terminal vocabulary.
          // Child 'completed' is the only "natural done"; failed/killed
          // surface as the same parent reasons the supervisor uses.
          const childStatus = childContinuation.closeEvent.status
          const turnTerminalReason = mapChildCloseToTurnTerminalReason(childContinuation.closeEvent)
          const status = statusFromTerminalReason(turnTerminalReason)
          if (turnFrame) {
            // Stage M (M2a) — terminal site, no steering refresh needed.
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: turnTerminalReason })
          }
          logAgentMetric('turn_child_run_terminal_routed', {
            sessionId: request.sessionId,
            childRunId: childContinuation.childRunId,
            childStatus,
            turnTerminalReason,
            iteration: iterations,
          })
          return finish({
            success: status !== 'error',
            cancelled: status === 'cancelled',
            status,
            terminalReason: turnTerminalReason,
          })
        }
        if (childContinuation.kind === 'checkpoint_paused') {
          const turnTerminalReason = mapChildCloseToTurnTerminalReason(childContinuation.closeEvent)
          if (turnFrame) {
            // Stage M (M2a) — terminal site, no steering refresh needed.
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: turnTerminalReason })
          }
          logAgentMetric('turn_child_run_checkpoint_routed', {
            sessionId: request.sessionId,
            childRunId: childContinuation.childRunId,
            childStatus: childContinuation.closeEvent.status,
            turnTerminalReason,
            iteration: iterations,
          })
          return finish({
            success: true,
            status: 'checkpoint',
            terminalReason: turnTerminalReason,
          })
        }
        if (childContinuation.kind === 'wait') {
          const close = await waitForChildCloseEvent(childContinuation.childRunId, CHILD_SELF_AWAIT_TIMEOUT_MS)
          if (turnFrame?.skill?.runContract) {
            // Stage M (M2a) — child-wait contract patch (fourth cluster).
            const anchorSkillId = turnFrame.skill.runContract.skillId
            if (close) {
              turnFrame = applyTurnFramePatch(turnFrame, {
                runContract: {
                  skillId: anchorSkillId,
                  childCloseEvent: close,
                  childStatus: close.status,
                  parentNextHint: 'continue_other_work',
                },
              })
            } else {
              turnFrame = applyTurnFramePatch(turnFrame, {
                runContract: {
                  skillId: anchorSkillId,
                  parentNextHint: 'wait_for_close_event',
                },
              })
            }
          }
          const outcome = renderChildCommandOutcome({
            childRunId: childContinuation.childRunId,
            command: 'resume',
            close,
          })
          if (turnFrame) {
            // Stage M (M2a) — terminal site (just before finish()).
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: outcome.terminalReason })
          }
          transcript.emitOutput(outcome.message, 'text')
          pushAssistantTextSafely(session, outcome.message, {
            sessionId: request.sessionId,
            iteration: iterations,
          })
          logAgentMetric('turn_child_run_wait_routed', {
            sessionId: request.sessionId,
            childRunId: childContinuation.childRunId,
            childStatus: close?.status || 'running',
            terminalReason: outcome.terminalReason,
            iteration: iterations,
          })
          return finish({
            success: outcome.status !== 'error',
            cancelled: outcome.status === 'cancelled',
            status: outcome.status,
            terminalReason: outcome.terminalReason,
          })
        }

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
          pushSystemReminderMessage(session, {
            topic: 'budget',
            priority: 80,
            text: buildBudgetWarningMessage({
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
        // Stage 7 — deterministic typed-action dispatch. When the steering
        // layer flagged the frame as `mode='force_tool'` AND we haven't
        // already force-dispatched this turn AND the typed tool is in the
        // allowed set, skip the model call and synthesize a tool batch
        // directly. The synthesized response flows through the existing
        // post-batch pipeline (consumeExecutedToolBatch) so framePatch +
        // projection commits + lease evaluation all run as usual. We cap at
        // one force_tool dispatch per turn — chaining a second resume must
        // come from the model in the next user turn.
        //
        // Stage E — force-tool dispatch decision. The steering layer publishes
        // an explicit `FrameAction` carrying tool name, validated input, and
        // an `inputDigest` keyed for cross-turn dedup. We never dispatch
        // `{}`: missing required fields surface in `action.missingInputs[]`
        // and route to a checkpoint instead.
        //
        // Stage N (2026-05-07) closed the parent-loop ownership retirement
        // for child-loop skills. The legacy "parent pretends to be the child
        // runner via forced typed-action synthesis" path is now fenced by
        // two independent gates (contract + manifest) and an invariant belt
        // at the `forceLoopGuard` write site. The dispatch path below still
        // exists for non-child-loop skills (lets-go-rss, future skills
        // without a `child_loop` declaration). Child-loop skills (VEA today)
        // never reach the synthesis branch — they go through
        // `dispatchChildLoopSkillAction` in `skills-tools.ts` instead. See
        // `docs/architecture/skill-child-loop-boundary.md` §0 + §5.4 +
        // §6 for the migration history and the closure table.
        const steeringAction = turnFrame?.steering?.action || null
        // Stage N (Phase 1.2) — the contract fence is one of two independent
        // gates. The other is the manifest fence: any tool name that
        // resolves to a `child_loop.actions[]` entry of an embedded skill
        // must NEVER be force-synthesized, regardless of contract state.
        // Both gates must be consulted. We split "candidate" from
        // "actual force tool" so the manifest fence has a non-null tool
        // name to emit metrics against.
        const candidateForceToolName = (
          turnFrame
            && turnFrame.steering?.mode === 'force_tool'
            && !forceToolDispatchedThisTurn
            && typeof turnFrame.steering.requiredToolName === 'string'
            && turnFrame.steering.requiredToolName
            && Array.isArray(routedAllowedToolNames)
            && routedAllowedToolNames.includes(turnFrame.steering.requiredToolName)
        ) ? turnFrame.steering.requiredToolName : null

        const childOwnedByContract = !shouldParentForceLongSkillTool(turnFrame?.skill?.runContract || null)
        const childOwnedByManifest = isParentForceForbiddenByManifest(candidateForceToolName)
        const childOwnedSkill = childOwnedByContract || childOwnedByManifest
        const forceToolName = (!childOwnedSkill) ? candidateForceToolName : null

        // Stage N (Phase 1.2) — manifest fence early-break. When the contract
        // fence does not fire (no `childRunId` yet) but the manifest says the
        // tool is child-owned, surface a checkpoint instead of falling
        // through to the model. Catches the adoption-state case where a
        // contract has not yet been stamped with `childRunId`.
        if (
          candidateForceToolName
          && !childOwnedByContract
          && childOwnedByManifest
        ) {
          logAgentMetric('turn_force_tool_blocked_child_owned', {
            sessionId: request.sessionId,
            skillId: turnFrame?.skill?.skillId || null,
            toolName: candidateForceToolName,
            reason: 'manifest_child_loop',
            iteration: iterations,
          })
          pushSystemReminderMessage(session, {
            topic: 'force-tool-blocked-child-owned',
            priority: 92,
            text: [
              `系统补充：本轮 force_tool 已被 child-loop 边界挡板（tool=${candidateForceToolName}）。`,
              '该 skill 的长任务由 child runner 拥有，父循环不再合成 typed tool_use。',
              '请等待 child 运行的 close event 或在下一轮明确指示 cancel/resume。',
            ].join('\n'),
          })
          host.log(
            `[turn_force_tool_blocked_child_owned] tool=${candidateForceToolName} skillId=${turnFrame?.skill?.skillId || 'null'} iteration=${iterations}`,
          )
          budgetLimitedBeforeCompletion = true
          if (turnFrame) {
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'checkpoint_user_input' })
          }
          break
        }
        // Cross-turn force-loop guard: when `runContract.forceLoopGuard`
        // recorded the same `(toolName, inputDigest)` from a prior turn AND
        // we are about to dispatch the same `(toolName, inputDigest)` again,
        // checkpoint instead of forcing to break the loop deterministically.
        // Phase 6 — `forceLoopGuard` is migration-only; child-owned skills
        // bypass it because the child runner has its own per-run budget +
        // launch-stuck guard, and a child's parentNextHint='wait_for_close_event'
        // is not a "force same tool again" signal.
        const priorGuard = childOwnedSkill
          ? null
          : (turnFrame?.skill?.runContract?.forceLoopGuard || null)
        const wouldRepeat = Boolean(
          forceToolName
            && steeringAction
            && steeringAction.mode === 'force_tool'
            && steeringAction.toolName === forceToolName
            && priorGuard
            && priorGuard.lastForceToolName === forceToolName
            && priorGuard.lastForceInputDigest != null
            && priorGuard.lastForceInputDigest === steeringAction.inputDigest
            && (priorGuard.consecutiveForceCount || 0) >= 1,
        )
        // Schema preflight: same registry + Zod path tool-executor uses.
        // When the FrameAction's mode is already 'checkpoint' (steering
        // surfaced missing inputs at frame-build time), skip preflight; we
        // already know we cannot dispatch.
        let preflightFailureReason: string | null = null
        let preflightMissingInputs: string[] = []
        if (forceToolName && steeringAction && steeringAction.mode === 'force_tool') {
          const definition = defaultToolRegistry.getToolDefinitionForExecution(forceToolName)
          if (!definition) {
            preflightFailureReason = 'tool_not_registered'
          } else {
            const schema = resolveToolInputSchemaForExecution(forceToolName)
            if (schema) {
              const parsed = schema.safeParse(steeringAction.input || {})
              if (!parsed.success) {
                preflightMissingInputs = Array.from(new Set(
                  parsed.error.issues.map((issue) => Array.isArray(issue.path) && issue.path.length > 0
                    ? issue.path.map((segment) => String(segment)).join('.')
                    : '(root)'),
                ))
                preflightFailureReason = preflightMissingInputs.length > 0
                  ? `missing_${preflightMissingInputs[0]}`
                  : 'input_validation_failed'
              }
            }
          }
        }
        const shouldCheckpointInsteadOfForce = Boolean(
          forceToolName
            && (
              wouldRepeat
              || (steeringAction && steeringAction.mode === 'checkpoint')
              || (steeringAction && steeringAction.missingInputs.length > 0)
              || preflightFailureReason
            ),
        )
        let response: TurnModelResponse
        if (forceToolName && shouldCheckpointInsteadOfForce) {
          // Tag the per-turn flag so the next iteration's steering re-eval
          // doesn't immediately try to force again, then break to the
          // post-iteration checkpoint path. We do NOT increment
          // `forceToolDispatchedThisTurn` because no dispatch occurred.
          recentForceToolDispatched = true
          const checkpointReason = wouldRepeat
            ? 'force_loop_guard'
            : preflightFailureReason
              || (steeringAction?.reason || 'missing_input')
          const reminderTokens: string[] = [
            `系统补充：本轮 force_tool 已挡板（reason=${checkpointReason}）。`,
          ]
          if (preflightMissingInputs.length > 0 || (steeringAction?.missingInputs.length || 0) > 0) {
            const missing = preflightMissingInputs.length > 0
              ? preflightMissingInputs
              : (steeringAction?.missingInputs || [])
            reminderTokens.push(`缺少必需输入：${missing.join(', ')}。`)
          }
          if (wouldRepeat) {
            reminderTokens.push('上一轮已用相同输入强制调用过同一工具，避免死循环，请变更输入或换工具。')
          }
          reminderTokens.push('请补齐参数或换路径，再继续。')
          // Stage 4 W2 — dedicated topic for the force_tool mid-loop
          // checkpoint, distinct from generic 'missing-input'. Lets the
          // taxonomy distinguish "force_tool was blocked this iteration"
          // from "user message lacked required inputs".
          pushSystemReminderMessage(session, {
            topic: 'force-tool-checkpoint-blocked',
            priority: 90,
            text: reminderTokens.join('\n'),
          })
          logAgentMetric('turn_force_tool_checkpoint', {
            sessionId: request.sessionId,
            skillId: turnFrame?.skill?.skillId || null,
            toolName: forceToolName,
            reason: checkpointReason,
            missingInputs: preflightMissingInputs.length > 0
              ? preflightMissingInputs
              : (steeringAction?.missingInputs || []),
            iteration: iterations,
          })
          host.log(
            `[turn_force_tool_checkpoint] tool=${forceToolName} reason=${checkpointReason} iteration=${iterations}`,
          )
          // Mid-iteration checkpoint: surface the standard budget-limited
          // termination path so the existing post-loop machinery (lifecycle,
          // task projection, transcript) closes the turn with one structured
          // event. Counts as a single close — never an unresolved tool_use.
          budgetLimitedBeforeCompletion = true
          if (turnFrame) {
            // Stage M (M2a) — provisional checkpoint marker. Plan §2.2:
            // priority rank 10 (lowest among checkpoints) so a later
            // budget-close patch (rank 20) correctly overrides this.
            // Fixes the v2-flagged silent-drop case.
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'checkpoint_user_input' })
          }
          break
        } else if (forceToolName) {
          forceToolDispatchedThisTurn = true
          recentForceToolDispatched = true
          // FrameAction.input is guaranteed non-null/object here because
          // steering only emits mode='force_tool' when validateForcedActionInput
          // returned ok. Belt: if action somehow missing, fall back to {}.
          const forcedInput: Record<string, unknown> = (steeringAction && steeringAction.input)
            ? { ...steeringAction.input }
            : {}
          const forcedToolCall: TurnToolCall = {
            id: `force_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            name: forceToolName,
            input: forcedInput,
          }
          response = {
            text: '',
            toolCalls: [forcedToolCall],
            stopReason: 'tool_calls',
            toolTransport: 'native',
          } as TurnModelResponse
          // Stage E — write back the cross-turn force-loop guard so the next
          // turn's contract knows what (toolName, inputDigest) was just
          // dispatched. We materialise this on the active turn frame as a
          // synthetic framePatch.runContract; consumeExecutedToolBatch will
          // merge this with whatever framePatch the typed action returns,
          // and `applyTurnFramePatch` persists it on `frame.skill.runContract`.
          if (turnFrame && turnFrame.skill) {
            // Stage N (Phase 1.3) — invariant belt. Phase 1.2's manifest
            // fence early-breaks before reaching this branch for child-loop
            // skills, so this branch should NEVER run with a forceToolName
            // that maps to a manifest-declared child_loop action. If a
            // future refactor regresses, fail closed: skip the guard write
            // and route to checkpoint via `budgetLimitedBeforeCompletion`.
            if (isParentForceForbiddenByManifest(forceToolName)) {
              logAgentMetric('turn_force_tool_invariant_violation', {
                sessionId: request.sessionId,
                skillId: turnFrame.skill.skillId,
                toolName: forceToolName,
                reason: 'guard_write_for_child_owned',
                iteration: iterations,
              })
              host.log(
                `[turn_force_tool_invariant_violation] tool=${forceToolName} skillId=${turnFrame.skill.skillId} iteration=${iterations}`,
              )
              budgetLimitedBeforeCompletion = true
              turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'checkpoint_user_input' })
              break
            }
            const dispatchedAt = new Date().toISOString()
            const newDigest = steeringAction?.inputDigest || null
            const sameAsPrior = Boolean(
              priorGuard
                && priorGuard.lastForceToolName === forceToolName
                && priorGuard.lastForceInputDigest === newDigest,
            )
            const guardPatch: TurnFramePatch = {
              runContract: {
                ...(turnFrame.skill.runContract ? {
                  // Preserve the contract anchor when we already have one so
                  // mergeRunContractPartials can update without re-creating.
                  skillId: turnFrame.skill.runContract.skillId,
                } : {}),
                forceLoopGuard: {
                  lastForceToolName: forceToolName,
                  lastForceInputDigest: newDigest,
                  lastForceToolDispatchedAt: dispatchedAt,
                  consecutiveForceCount: sameAsPrior
                    ? (priorGuard?.consecutiveForceCount || 0) + 1
                    : 1,
                },
              },
            }
            turnFrame = applyTurnFramePatch(turnFrame, guardPatch)
          }
          logAgentMetric('turn_force_tool_dispatched', {
            sessionId: request.sessionId,
            skillId: turnFrame?.skill?.skillId || null,
            toolName: forceToolName,
            iteration: iterations,
            inputDigest: steeringAction?.inputDigest || null,
            consecutiveForceCount: turnFrame?.skill?.runContract?.forceLoopGuard?.consecutiveForceCount || 1,
          })
          host.log(`[turn_force_tool_dispatched] tool=${forceToolName} iteration=${iterations} digest=${steeringAction?.inputDigest || 'null'}`)
          preferTextToolBridgeOnce = false
        } else {
          try {
            const modelSession = buildModelInputSession(toolLoopSession as TSession)
            response = await host.requestToolLoopResponse({
              session: modelSession,
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
                const reminderText = composeSystemReminderText({
                  topic: 'checkpoint',
                  priority: 80,
                  text: `系统补充：你刚才输出了未允许的工具 ${disallowedToolNames.join(', ')}。请只调用当前 allowed tools 中的工具；如果没有合适工具，说明缺口而不要把 tool_call 当普通文本结束。`,
                })
                const correctionText = [
                  buildTextToolBridgeCorrectionMessage(toolPolicy as any),
                  reminderText,
                ].filter(Boolean).join('\n')
                session.messages.push({ role: 'user', content: correctionText })
                continue
              }
            }
          }
        }

        if (response.toolCalls.length === 0) {
          if (response.toolCallParseErrors && response.toolCallParseErrors.length > 0) {
            const assistantHistoryText = response.rawText || response.text
            if (assistantHistoryText) {
              pushAssistantTextSafely(session, assistantHistoryText, {
                sessionId: request.sessionId,
                iteration: iterations,
                toolTransport: response.toolTransport,
              })
            }
            pushProviderToolArgumentsCorruptReminder(session, response)
            continue
          }
          const petToolRetryNeeded = shouldEnforcePetToolRetry({
            intent: executionIntentContext.intentClassification,
            allowedToolNames: routedAllowedToolNames,
            toolCallsCount: response.toolCalls.length,
          })
          if (petToolRetryNeeded && textToolBridgeNudges < 2) {
            textToolBridgeNudges += 1
            const assistantHistoryText = response.rawText || response.text
            if (assistantHistoryText) {
              pushAssistantTextSafely(session, assistantHistoryText, {
                sessionId: request.sessionId,
                iteration: iterations,
                toolTransport: response.toolTransport,
              })
            }
            preferTextToolBridgeOnce = true
            const reminderText = composeSystemReminderText({
              topic: 'checkpoint',
              priority: 80,
              text: '系统补充：当前任务是宠物便利贴任务，必须调用 pet_show_sticky_note 把内容贴到猫猫旁边；不要写入文档，也不要只用文字说“贴好了”。',
            })
            const correctionText = [
              buildTextToolBridgeCorrectionMessage(toolPolicy as any),
              reminderText,
            ].filter(Boolean).join('\n')
            session.messages.push({ role: 'user', content: correctionText })
            continue
          }
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
            const reminderText = composeSystemReminderText({
              topic: 'checkpoint',
              priority: 80,
              text: '系统补充：当前任务是浏览器任务，至少先调用一个 browser_* 工具（例如 browser_search、browser_navigate、browser_read_page），不要直接解释这轮工具列表。',
            })
            const correctionText = [
              buildTextToolBridgeCorrectionMessage(toolPolicy as any),
              reminderText,
            ].filter(Boolean).join('\n')
            session.messages.push({ role: 'user', content: correctionText })
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
                pushSystemReminderMessage(session, {
                  topic: 'checkpoint',
                  priority: 60,
                  text: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
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
            // Stage R W2.1 — stable args hash via shared helper (sorts object keys
            // recursively before JSON stringify so semantically-identical args with
            // different key order compare equal in the repetition ring buffer).
            const argsHash = hashToolCallArgs(toolCall.input)
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
          pushSystemReminderMessage(session, {
            topic: 'checkpoint',
            priority: 85,
            text: `系统提醒：你已经连续 ${matchCount} 次以相同参数调用 ${last.name}。请改用 skill_ask_user 询问用户下一步该怎么做，或换一种方法（不同参数 / 不同工具）。`,
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

        // Stage N (2026-05-07) — heartbeat + duration bookkeeping below
        // remains for legacy non-child-loop typed actions. Child-loop skills
        // (VEA today) launch via `dispatchChildLoopSkillAction` and emit
        // their own heartbeat / duration through the child runner; the
        // parent only sees the `child_launched` envelope and the eventual
        // close event. The Phase 3 fence at the
        // `lastLongTypedSkillActionIteration` write site (below) skips the
        // budget-warning suppression for child-loop names so this code path
        // stays correct for both worlds. See
        // `docs/architecture/skill-child-loop-boundary.md` §5.1.
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
              // Stage N (Phase 3) — child-loop typed actions launch a child
              // run via dispatchChildLoopSkillAction; the typed-action result
              // is a `child_launched` placeholder, NOT a real long-action
              // completion. Treating them as "long-skill-completed" silences
              // the next iteration's budget-warning suppression
              // (`shouldInjectBudgetWarning` consults
              // `lastLongTypedSkillActionIteration`), which would mute a
              // legitimate budget warning during a child-owned run. Fence.
              const childLoopEntry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName] || null
              const isChildLoopExecution = !!childLoopEntry
                && isConfiguredChildLoopSkillAction(childLoopEntry.skillId, childLoopEntry.actionName)
              if (!isChildLoopExecution) {
                lastLongTypedSkillActionIteration = iterations
              }
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
          // Stage 5 — collect any structured `framePatch` payloads returned
          // by tools in this batch and apply them to the live TurnFrame so
          // the next iteration's steering / dispatch sees the updated skill
          // slice (newly-discovered task handles, validated config, liveness
          // upgrades). Patches do NOT cross turns — each new user turn
          // rebuilds the frame from the resolver.
          const framePatches: TurnFramePatch[] = []
          for (const executedTool of executedToolBatch.results) {
            const result = executedTool.result as ToolExecutionOutput
            if (result && result.framePatch) {
              framePatches.push(result.framePatch)
            }
          }
          if (framePatches.length > 0 && turnFrame) {
            const merged = mergeTurnFramePatches(framePatches)
            turnFrame = applyTurnFramePatch(turnFrame, merged)
            const patchKeys = Object.keys(merged).filter((key) => {
              const value = (merged as Record<string, unknown>)[key]
              if (value == null) return false
              if (Array.isArray(value)) return value.length > 0
              if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
              return true
            })
            if (patchKeys.length > 0) {
              try {
                logAgentMetric('turn_frame_patch_applied', {
                  sessionId: request.sessionId,
                  iteration: iterations,
                  patchKeys,
                  skillId: turnFrame?.skill?.skillId || null,
                  liveness: turnFrame?.liveness || null,
                })
              } catch {
                // metrics must never break the turn
              }
            }
          }
          // Stage 7 — after each batch the next iteration's steering decision
          // must see the freshly-patched frame AND the recent-force flag so
          // we cannot infinite-loop on the same forced typed action. Re-runs
          // `applySteeringToTurnFrame` (idempotent) with the updated extras.
          if (turnFrame) {
            turnFrame = applySteeringToTurnFrame(turnFrame, {
              recentForceToolDispatched,
            })
            refreshToolPolicyFromTurnFrame('frame_patch')
          }
          // The recent-force flag only suppresses the IMMEDIATELY-following
          // iteration's force_tool re-issue; once we've consumed it for one
          // steering re-evaluation, clear it so a later iteration that
          // legitimately needs force_tool again (different liveness path)
          // can use it. Combined with `forceToolDispatchedThisTurn`, the
          // overall cap is still 1 force_tool dispatch per turn.
          recentForceToolDispatched = false
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
              // Stage M (M2b) — sync after lease replacement (post-batch).
              syncBudgetPatchToFrame()
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

        const routePatchedChildRunAfterBatch = async (): Promise<ReturnType<typeof finish> | null> => {
          const initialDecision = computeChildContinuationDecision(
            turnFrame,
            getSkillChildRunCloseEvent,
          )
          if (initialDecision.kind === 'none') return null

          let childDecision = initialDecision
          if (childDecision.kind === 'wait') {
            const close = await waitForChildCloseEvent(childDecision.childRunId, CHILD_SELF_AWAIT_TIMEOUT_MS)
            if (close) {
              childDecision = decisionFromChildClose(childDecision.childRunId, close)
            }
          }

          if (turnFrame?.skill?.runContract) {
            // Stage M (M2a) — child-decision contract patch (fifth cluster).
            const anchorSkillId = turnFrame.skill.runContract.skillId
            if (childDecision.kind === 'terminal' || childDecision.kind === 'checkpoint_paused') {
              turnFrame = applyTurnFramePatch(turnFrame, {
                runContract: {
                  skillId: anchorSkillId,
                  childCloseEvent: childDecision.closeEvent,
                  childStatus: childDecision.closeEvent.status,
                  parentNextHint: 'continue_other_work',
                },
              })
            } else if (childDecision.kind === 'wait') {
              turnFrame = applyTurnFramePatch(turnFrame, {
                runContract: {
                  skillId: anchorSkillId,
                  parentNextHint: 'wait_for_close_event',
                },
              })
            }
          }

          const close = childDecision.kind === 'terminal' || childDecision.kind === 'checkpoint_paused'
            ? childDecision.closeEvent
            : null
          const outcome = renderChildCommandOutcome({
            childRunId: childDecision.childRunId,
            command: 'resume',
            close,
          })
          if (turnFrame) {
            // Stage M (M2a) — terminal site (just before finish()).
            turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: outcome.terminalReason })
          }
          transcript.emitOutput(outcome.message, 'text')
          pushAssistantTextSafely(session, outcome.message, {
            sessionId: request.sessionId,
            iteration: iterations,
          })
          logAgentMetric('turn_child_run_post_batch_routed', {
            sessionId: request.sessionId,
            childRunId: childDecision.childRunId,
            childDecision: childDecision.kind,
            childStatus: close?.status || null,
            terminalReason: outcome.terminalReason,
            iteration: iterations,
          })
          return finish({
            success: outcome.status !== 'error',
            cancelled: outcome.status === 'cancelled',
            status: outcome.status,
            terminalReason: outcome.terminalReason,
          })
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
          const childRouteResult = await routePatchedChildRunAfterBatch()
          if (childRouteResult) return childRouteResult
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
          const childRouteResult = await routePatchedChildRunAfterBatch()
          if (childRouteResult) return childRouteResult
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
          const childRouteResult = await routePatchedChildRunAfterBatch()
          if (childRouteResult) return childRouteResult
          state.syncBudgetWarning()
        }

        pushProviderToolArgumentsCorruptReminder(session, response)

        if (response.text) {
          const plannerStepCompleted = detectTaskStepCompletionCue(
            response.text,
            state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId),
          )
          if (plannerStepCompleted) {
            const advanced = advancePlannerStep(response.text)
            if (advanced) {
              pushSystemReminderMessage(session, {
                topic: 'checkpoint',
                priority: 60,
                text: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
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
            || skillTaskSnapshot.liveness === 'background'
            || skillTaskSnapshot.status === 'running'
          )
            ? 'checkpoint_background'
            : 'checkpoint_budget'
        if (turnFrame) {
          // Stage M (M2a + M2b) — budget exhaustion + terminal reason
          // routed through one applyTurnFramePatch call. Preserves the
          // existing leaseEndIteration / hardCapIteration scalars
          // because applyTurnFramePatch's budget merge coalesces missing
          // patch fields with current frame values. M2b's
          // produceBudgetPatch can replace this with the helper if a
          // lease snapshot is available; for now the inline patch is
          // correct because we're at terminal exit.
          turnFrame = applyTurnFramePatch(turnFrame, {
            budget: { exhausted: true },
            terminalReason: budgetTerminalReason,
          })
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
      return finish({ success: false, error: message, status: 'error' })
    }
  }
}
