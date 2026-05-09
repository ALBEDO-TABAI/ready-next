/**
 * Stage S (PR-S8 / W5.3) — Token attribution dimensions.
 *
 * Six fixed dimensions over which `TokenUsageRecord` totals can be
 * partitioned for task-card / research-step level reporting:
 *
 *   - search        web/research search-style calls
 *   - fetch         web/file fetch-style calls
 *   - subagent      delegated subagent invocations
 *   - present       user-facing presentation rollups
 *   - clarification clarification-five-types prompt cycles
 *   - todo          todo-list scaffolding cycles
 *
 * Helper-only: no turn-engine wiring here. Maintained as a fixed-six
 * registry so dashboards / projections can rely on a stable shape.
 */

export const TOKEN_ATTRIBUTION_DIMENSIONS = [
  'search',
  'fetch',
  'subagent',
  'present',
  'clarification',
  'todo',
] as const
export type TokenAttributionDimension = (typeof TOKEN_ATTRIBUTION_DIMENSIONS)[number]

export type TokenAttributionByDimension = Record<TokenAttributionDimension, number>

export function emptyAttribution(): TokenAttributionByDimension {
  return {
    search: 0,
    fetch: 0,
    subagent: 0,
    present: 0,
    clarification: 0,
    todo: 0,
  }
}
