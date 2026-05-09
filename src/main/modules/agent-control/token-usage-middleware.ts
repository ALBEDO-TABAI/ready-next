/**
 * Stage S (PR-S8 / W5.2) — Token usage attribution split.
 *
 * Provides a structured `TokenUsageRecord` shape and a fixed two-element
 * namespace registry. This is the "model_call" vs "task_card_step"
 * separation that downstream stages will use to attribute usage to the
 * correct timeline (raw model invocations vs. user-visible step rollups).
 *
 * Decoupling note (per §6.11):
 *   This module deliberately does NOT import from `tool-error-metrics.ts`
 *   and is NOT registered alongside the tool-error registry. Token
 *   attribution is an observability surface, not a tool-error surface;
 *   mixing the two would dilute the tool-error contract.
 *
 * Helper-only: no turn-engine wiring lives here. A later PR decides the
 * insertion point (likely `task-projection-sync` for step rollup +
 * `turn-engine` span emission for per-call records).
 */

export const TOKEN_ATTRIBUTION_NAMESPACES = ['model_call', 'task_card_step'] as const
export type TokenAttributionNamespace = (typeof TOKEN_ATTRIBUTION_NAMESPACES)[number]

export interface TokenUsageRecord {
  namespace: TokenAttributionNamespace
  inputTokens: number
  outputTokens: number
  totalTokens: number
  modelId?: string
  stepId?: string
  runId?: string
  timestamp: number
}

export function buildTokenUsageRecord(
  input: Partial<TokenUsageRecord> & Pick<TokenUsageRecord, 'namespace'>,
): TokenUsageRecord {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    timestamp: Date.now(),
    ...input,
  }
}
