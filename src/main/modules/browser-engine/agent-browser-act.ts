/**
 * Target-resolution gating for `browser_act_on_target` (counterplan §5.4, WP3).
 *
 * One tool replaces Codex's click/expand/choose/expand_and_read four: the
 * action verb is a parameter. The hard contract this module enforces (pure,
 * so it is unit-testable independent of Electron):
 *
 *   1. The target's generation must equal the current page-map generation,
 *      else `stale_page_map` — this forces "fetch a fresh snapshot before
 *      acting" into CODE, not just into the prompt (counterplan §5.9).
 *   2. A target that resolves to >1 element is `ambiguous_target`; we return the
 *      candidates and refuse to blind-click the first.
 *   3. A target that resolves to 0 elements is `target_not_found`.
 *
 * Pure module — no Electron, no IO.
 */

import { agentBrowserError, type AgentBrowserStructuredError } from './agent-browser-errors'
import { parseTargetId } from './agent-browser-page-map'

export type AgentBrowserAction = 'click' | 'expand' | 'choose' | 'fill' | 'hover'
export type AgentBrowserReadBack = 'none' | 'delta' | 'map'

export interface ActOnTargetRequest {
  targetId: string
  action: AgentBrowserAction
  value?: string
  disambiguation?: string
  readBack?: AgentBrowserReadBack
  expectedChange?: string
  maxWaitMs?: number
}

export interface ResolvedTargetRef {
  generation: number
  frameId: string
  node: string
}

/**
 * Validate a target reference against the current generation and the number of
 * elements it resolves to. `matchCount` is supplied by the host after probing
 * the live DOM. Returns the resolved ref on success, or a structured error.
 */
export function gateActOnTarget(
  request: ActOnTargetRequest,
  context: {
    currentGeneration: number
    matchCount: number
    candidates?: unknown[]
    ambiguityGroup?: { role: string; name: string; targetIds: string[] } | null
  },
): ResolvedTargetRef | AgentBrowserStructuredError {
  const parsed = parseTargetId(request.targetId)
  if (!parsed) {
    return agentBrowserError('target_not_found', `Malformed target id: ${request.targetId}`)
  }
  if (parsed.generation !== context.currentGeneration) {
    return agentBrowserError(
      'stale_page_map',
      `Target ${request.targetId} was built against page map generation ${parsed.generation}, but the current generation is ${context.currentGeneration}. Re-read the page map first.`,
      { targetGeneration: parsed.generation, currentGeneration: context.currentGeneration },
    )
  }
  if ((request.action === 'choose' || request.action === 'fill') && !request.value) {
    return agentBrowserError(
      'target_not_found',
      `Action "${request.action}" requires a value.`,
      { action: request.action },
    )
  }
  if (context.ambiguityGroup && !String(request.disambiguation || '').trim()) {
    return agentBrowserError(
      'ambiguous_target',
      `Target ${request.targetId} belongs to an ambiguity group. Provide disambiguation before acting.`,
      { ambiguityGroup: context.ambiguityGroup },
    )
  }
  if (context.matchCount <= 0) {
    return agentBrowserError(
      'target_not_found',
      `Target ${request.targetId} no longer resolves to any element. Re-read the page map.`,
    )
  }
  if (context.matchCount > 1) {
    return agentBrowserError(
      'ambiguous_target',
      `Target ${request.targetId} resolves to ${context.matchCount} elements. Narrow to a container before acting.`,
      { matchCount: context.matchCount, candidates: context.candidates ?? [] },
    )
  }
  return parsed
}
