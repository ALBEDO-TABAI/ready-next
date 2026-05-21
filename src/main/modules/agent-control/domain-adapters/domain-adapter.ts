import type { RequestEnvelope } from '../contracts/request-envelope'
import type { TurnFrame } from '../turn-frame'
import type { ToolPolicy } from '../execution-tool-config'
import type { ExecutionIntentContext } from '../execution-intent-resolver'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import { normalizeToolExecutionOutput, type ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type {
  RunBudgetHint,
  TaskExecutionRoute,
  TaskInteractionState,
  TurnEngineHost,
  TurnEngineRequest,
  TurnEngineSession,
  TurnEngineSessionMessage,
} from '../contracts/run-contracts'

/**
 * === Coordinator role (v3 stage C) ===
 *
 * Each DomainAdapter is one Coordinator role instance. It owns one product
 * surface end to end: mode selection, prompt fragments, tool filtering,
 * capability arbitration, user-text decoration, execution, and projection.
 * turn-engine.ts should schedule these adapters, not hard-code product
 * identities.
 */

export type DomainAdapterProjectionPhase = 'blocked' | 'done'
export type DomainAdapterApplyPhase = 'no_tool_call' | 'tool_batch' | 'budget_limit'

export interface CoordinatorPromptFragment {
  id: string
  label: string
  priority: number
  matches: (context: { userText: string; route: TaskExecutionRoute | null }) => boolean
  refs: Array<{ path: string; title: string; summary: string; sensitive?: boolean }>
  blocking: boolean
}

export interface CoordinatorCapabilityArbitration {
  forceTool?: 'document' | 'browser' | 'skill' | null
  hideAssistantProcessText?: boolean
  budgetMultiplier?: number
}

export type CoordinatorTextDecorationPhase = 'pre_dispatch' | 'post_dispatch'

export interface DomainAdapterProjection {
  phase: DomainAdapterProjectionPhase
  summary: string
  waitingFor?: 'none' | 'input' | 'confirmation' | 'agent_result' | 'background' | 'clarification'
  resumableActions?: Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'>
  blockedReason?: string | null
}

export interface DomainAdapterToolBatchSummary {
  executedTools?: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    result: ToolExecutionOutput
  }>
  executedDocActionCount?: number
  executedMutatingDocActionCount?: number
  executedInspectionDocActionCount?: number
  executedSaveDocActionCount?: number
  executedBrowserToolsThisIteration?: number
  browserToolResultsThisIteration?: Array<{
    toolName: string
    resultText: string
  }>
  documentToolResultsThisIteration?: string[]
  documentToolInspections?: unknown[]
}

function parseStructuredToolText(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function readToolProjectionPatch(result: ToolExecutionOutput | null | undefined): Record<string, unknown> | null {
  if (!result) return null
  const normalized = normalizeToolExecutionOutput(result)
  return normalized.projectionPatch && typeof normalized.projectionPatch === 'object'
    ? normalized.projectionPatch
    : null
}

export function readStructuredToolResultRecord(result: ToolExecutionOutput | null | undefined): Record<string, unknown> | null {
  if (!result) return null
  const normalized = normalizeToolExecutionOutput(result)
  if (normalized.data && typeof normalized.data === 'object') {
    return normalized.data
  }
  return parseStructuredToolText(normalized.text)
}

export interface DomainAdapterSelectionContext {
  route: TaskExecutionRoute
  userText: string
  hasTools: boolean
  executionIntentContext: ExecutionIntentContext
}

export interface DomainAdapterPrepareParams<TSession extends TurnEngineSession = TurnEngineSession> {
  route: TaskExecutionRoute | null
  request: TurnEngineRequest<TSession>
  host: TurnEngineHost<TSession>
  session: TSession
  userText: string
  pureUserInput: string
  requestEnvelope: RequestEnvelope
  executionIntentContext: ExecutionIntentContext
  hasTools: boolean
  toolPolicy: ToolPolicy
  allowedToolNames: string[] | null
  /**
   * D3: Indicates the current turn is a bare retry/continue intent (e.g.
   * "继续", "重试", "try again"). When true, narrowing domain adapters may
   * widen their prefix list to keep file_/document_ tools accessible so the
   * agent can re-discover prior context before re-attempting the action.
   * Computed by skill-detection-inputs.isRetryOnlyTurn.
   */
  isRetryOnlyTurn?: boolean
  turnFrameSteering?: TurnFrame['steering'] | null
}

export interface DomainAdapterPrepareResult {
  allowedToolNames?: string[] | null
  budgetHint?: RunBudgetHint | null
  sessionMessages?: TurnEngineSessionMessage[]
  domainState?: unknown
}

export interface DomainAdapterDispatchParams<TSession extends TurnEngineSession = TurnEngineSession>
  extends DomainAdapterPrepareParams<TSession> {
  route: TaskExecutionRoute
  emitStructuredTaskPayload: (payload: unknown) => void
  domainState: unknown
}

export interface DomainAdapterDispatchResult {
  sessionMessages?: TurnEngineSessionMessage[]
  domainState?: unknown
  interactionState?: TaskInteractionState | null
  finalText?: string | null
  projection?: DomainAdapterProjection | null
  finish?: {
    status: 'done' | 'error' | 'cancelled'
    success: boolean
    cancelled?: boolean
  } | null
}

export interface DomainAdapterApplyParams<TSession extends TurnEngineSession = TurnEngineSession>
  extends DomainAdapterDispatchParams<TSession> {
  phase: DomainAdapterApplyPhase
  responseText?: string | null
  toolTransport?: 'native' | 'text'
  toolBatch?: DomainAdapterToolBatchSummary | null
}

export interface DomainAdapterApplyResult {
  sessionMessages?: TurnEngineSessionMessage[]
  domainState?: unknown
  interactionState?: TaskInteractionState | null
  nextUserMessage?: string | null
  finalText?: string | null
  projection?: DomainAdapterProjection | null
  preserveAssistantText?: boolean
}

export interface DomainAdapterProjectionParams<TSession extends TurnEngineSession = TurnEngineSession> {
  route: TaskExecutionRoute
  request: TurnEngineRequest<TSession>
  executionIntentContext: ExecutionIntentContext
  toolPolicy: ToolPolicy
  domainState: unknown
  projection: DomainAdapterProjection
}

export interface DomainAdapter {
  id: string
  shouldHandle: (params: DomainAdapterSelectionContext) => boolean
  contributePromptFragment: () => CoordinatorPromptFragment[] | null
  arbitrateRunCapabilities: (
    params: DomainAdapterPrepareParams<TurnEngineSession>
  ) => CoordinatorCapabilityArbitration | null
  decorateUserText: (
    text: string,
    params: { phase: CoordinatorTextDecorationPhase }
  ) => string
  prepare: (
    params: DomainAdapterPrepareParams<TurnEngineSession>
  ) => DomainAdapterPrepareResult | Promise<DomainAdapterPrepareResult>
  dispatch: (
    params: DomainAdapterDispatchParams<TurnEngineSession>
  ) => DomainAdapterDispatchResult | Promise<DomainAdapterDispatchResult>
  applyResult: (
    params: DomainAdapterApplyParams<TurnEngineSession>
  ) => DomainAdapterApplyResult | Promise<DomainAdapterApplyResult>
  buildProjectionPatch: (
    params: DomainAdapterProjectionParams<TurnEngineSession>
  ) => Record<string, unknown> | null
}

export function filterAllowedToolNamesByPrefixes(
  allowedToolNames: string[] | null | undefined,
  prefixes: string[],
): string[] | null {
  if (!allowedToolNames || prefixes.length === 0) {
    return null
  }
  const filtered = allowedToolNames.filter((toolName) => prefixes.some((prefix) => toolName.startsWith(prefix)))
  return filtered.length > 0 ? filtered : null
}

/**
 * R2: Diagnostic log emitted by each narrowing domain adapter so production
 * logs make the prefix-narrowing step visible. Without this, a "Tool not
 * allowed" at runtime gives no signal as to whether the culprit was the
 * turn-engine bundle or the domain adapter's prefix narrowing.
 */
export function logPrefixNarrowing(
  log: (message: string) => void,
  domainId: string,
  inputAllowedToolNames: string[] | null | undefined,
  narrowedAllowedToolNames: string[] | null,
  prefixes: string[],
): void {
  const inputCount = inputAllowedToolNames?.length || 0
  const narrowedCount = narrowedAllowedToolNames?.length
  const outputDescription = narrowedAllowedToolNames === null
    ? 'unrestricted_passthrough'
    : `${narrowedCount}`
  const droppedAll = inputAllowedToolNames
    ? inputAllowedToolNames.filter((name) => !prefixes.some((prefix) => name.startsWith(prefix)))
    : []
  const droppedSample = droppedAll.slice(0, 3)
  log(
    `[domain_adapter_prefix_narrowing] domain=${domainId} inputCount=${inputCount} `
    + `outputCount=${outputDescription} prefixes=${prefixes.join('|')} `
    + `droppedSample=${droppedSample.join(',') || 'none'}`,
  )
  // Observability: only emit when narrowing actually dropped tools. A pass-through
  // narrowing (no input or every tool kept) is uninteresting noise for dashboards.
  if (droppedAll.length > 0) {
    logAgentMetric(TOOL_ERROR_METRICS.domainToolNarrowingApplied, {
      domain: domainId,
      droppedCount: droppedAll.length,
      droppedSample,
    })
  }
}

export function selectDomainAdapter(
  adapters: DomainAdapter[] | null | undefined,
  params: DomainAdapterSelectionContext,
): DomainAdapter | null {
  if (!adapters || adapters.length === 0) {
    return null
  }
  return adapters.find((adapter) => adapter.shouldHandle(params)) || null
}
