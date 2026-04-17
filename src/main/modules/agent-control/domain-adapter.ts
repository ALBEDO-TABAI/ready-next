import type { RequestEnvelope } from './request-envelope'
import type { ToolPolicy } from './execution-tool-config'
import type { ExecutionIntentContext } from './execution-intent-resolver'
import type {
  RunBudgetHint,
  TaskExecutionRoute,
  TaskInteractionState,
  TurnEngineHost,
  TurnEngineRequest,
  TurnEngineSession,
  TurnEngineSessionMessage,
} from './run-contracts'

export type DomainAdapterProjectionPhase = 'blocked' | 'done'
export type DomainAdapterApplyPhase = 'no_tool_call' | 'tool_batch' | 'budget_limit'

export interface DomainAdapterProjection {
  phase: DomainAdapterProjectionPhase
  summary: string
}

export interface DomainAdapterToolBatchSummary {
  executedDocActionCount?: number
  executedMutatingDocActionCount?: number
  executedInspectionDocActionCount?: number
  executedSaveDocActionCount?: number
  executedBrowserToolsThisIteration?: number
  documentToolResultsThisIteration?: string[]
  documentToolInspections?: unknown[]
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

export function selectDomainAdapter(
  adapters: DomainAdapter[] | null | undefined,
  params: DomainAdapterSelectionContext,
): DomainAdapter | null {
  if (!adapters || adapters.length === 0) {
    return null
  }
  return adapters.find((adapter) => adapter.shouldHandle(params)) || null
}
