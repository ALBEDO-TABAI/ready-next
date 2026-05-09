/**
 * Stage T PR-T5 — MCP deferred-tool promotion (per-turn).
 *
 * Plan v18 §6.2 — some MCP tools are advertised but kept "deferred"
 * (not exposed to the model) until a turn-gap signal indicates they
 * should be promoted. Promotion still goes through
 * `registry.isAuthorized` — never bypassing OAuth — which is what
 * `check-deferred-tool-promotion-after-authorization.cjs` enforces.
 *
 * Per-turn lifecycle:
 *   - At the start of each turn, deferred tools are NOT in the
 *     model-visible list.
 *   - During the turn, the host (e.g. NLP intent or a UI action) may
 *     call `markDeferredToolActive(toolName)` to flag the tool for
 *     promotion. Promotion is gated by `registry.isAuthorized` so
 *     unauthorized tools never appear.
 *   - At turn-end, `deferredRegistry.reset()` clears the active set
 *     so the next turn starts cold.
 */

import { isAuthorized } from './registry'

export interface DeferredToolPromotionContext {
  sessionId?: string
  scopeId?: string
}

class DeferredToolRegistry {
  private readonly active = new Set<string>()

  /** Mark a deferred tool as active for the current turn-gap. */
  markActive(toolName: string): void {
    this.active.add(toolName)
  }

  /**
   * Promote eligible deferred tools to "model-visible" for this turn.
   * Promotion goes through `registry.isAuthorized` — required by the
   * gate `check-deferred-tool-promotion-after-authorization.cjs`.
   */
  promoteActive(context: DeferredToolPromotionContext): string[] {
    const promoted: string[] = []
    for (const toolName of this.active) {
      if (isAuthorized(toolName, context.sessionId, context.scopeId)) {
        promoted.push(toolName)
      }
    }
    return promoted
  }

  /** Snapshot the current active set (read-only). */
  listActive(): string[] {
    return Array.from(this.active)
  }

  /**
   * Per-turn reset hook. `turn-engine.ts::finish` invokes this so the
   * next turn starts with an empty active set.
   *
   * Required by `check-deferred-registry-per-turn-reset.cjs`.
   */
  reset(): void {
    this.active.clear()
  }
}

export const deferredRegistry = new DeferredToolRegistry()

/** Convenience wrapper used by NLP / UI to mark a tool active. */
export function markDeferredToolActive(toolName: string): void {
  deferredRegistry.markActive(toolName)
}
