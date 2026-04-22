/**
 * Phase 3 — agent:error IPC contract derivation.
 *
 * Purpose: at the runtime-error emit boundary (direct-chat.ts / turn-engine.ts
 * catch), project an arbitrary thrown value into a small JSON-friendly shape
 * that lets the renderer route:
 *
 *   - recoverable: boolean — renderer puts this in a soft-failure capsule and
 *     leaves scopeRunState.phase alone. UI does not show a "system error".
 *   - errorKind: string   — used by telemetry + capsule UI ("工具 xxx 暂时失败").
 *   - toolName?: string   — supplied either by the caller or recovered from a
 *     ToolHostUnavailableError instance.
 *
 * Pure module — only imports tool-errors (pure) and error-classifier (pure).
 */

import { errorKindFor } from '../tools/tool-errors'
import { classifyExecutionError, type ExecutionErrorKind } from './error-classifier'

export type AgentErrorKind = ExecutionErrorKind | 'aborted' | 'tool_handler_failure' | string

export interface AgentErrorContract {
  errorKind: AgentErrorKind
  recoverable: boolean
  toolName?: string
}

const RECOVERABLE_KINDS: ReadonlySet<string> = new Set([
  'rate_limit',
  'timeout_model',
  'timeout_tool',
  'transient',
  'tool_handler_failure',
])

const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'auth',
  'context_overflow',
  'host_unavailable',
  'aborted',
  'unknown',
])

function readToolNameFromError(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'toolName' in error) {
    const raw = (error as { toolName?: unknown }).toolName
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return undefined
}

export function deriveAgentErrorContract(
  error: unknown,
  options?: { toolName?: string },
): AgentErrorContract {
  const toolName = options?.toolName || readToolNameFromError(error)

  const baseKind = errorKindFor(error)

  // tool_handler_failure is the tool-layer fallback for "anything that reached
  // the dispatch catch-all". Tool handler throws are already eaten by Phase 1
  // before they can reach emitRuntimeError, so when this derivation sees
  // tool_handler_failure the error must have come from orchestration /
  // model-request code — defer to the text classifier (which may resolve to
  // rate_limit/timeout/auth/etc., or 'unknown' when nothing matches).
  let resolvedKind: string = baseKind
  if (baseKind === 'tool_handler_failure') {
    resolvedKind = classifyExecutionError(error).kind
  }

  let recoverable: boolean
  if (RECOVERABLE_KINDS.has(resolvedKind)) {
    recoverable = true
  } else if (TERMINAL_KINDS.has(resolvedKind)) {
    recoverable = false
  } else {
    // Unknown domain errorKind coming from a ToolDomainError throw — the model
    // should see it as a recoverable tool_result. Defaults align with Phase 1
    // contract: only the narrow terminal whitelist kills the turn.
    recoverable = true
  }

  return toolName ? { errorKind: resolvedKind, recoverable, toolName } : { errorKind: resolvedKind, recoverable }
}
