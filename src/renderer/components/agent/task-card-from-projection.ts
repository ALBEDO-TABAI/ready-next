/**
 * Stage 6 L6 — task-card single-source helper.
 *
 * Owns the `TaskCardRun` type and the only legitimate constructor functions.
 * The `__brand` symbol is module-private; downstream code can import the type
 * (to annotate state, props, etc.) but cannot construct a `TaskCardRun` value
 * without going through one of the exported helpers.
 *
 * Combined with the `ready/no-task-card-run-cast` lint rule (defined in
 * `eslint-rules/index.mjs`), this prevents:
 *  - `as TaskCardRun` / `<TaskCardRun>x` casts
 *  - container casts (`as TaskCardRun[]`, `as Array<TaskCardRun>`, etc.)
 *  - `import('...').TaskCardRun` inline import-type casts
 *  - aliased imports (`import { TaskCardRun as TCR }`)
 *  - local interface/type declarations of the name `TaskCardRun`
 *
 * Acknowledged remaining gaps (deliberate laundering, out of scope):
 *   `Pick<TaskCardRun, 'taskId'>`, `TaskCardRun & {}`, `TaskCardRun | null`,
 *   `as any as TaskCardRun`. These require active intent to bypass.
 *
 * The IPC event `agent:taskProjectionsChanged` and the elimination of
 * `agent:listActiveChildRuns` polling for primary card display are tracked
 * separately as a Stage 7 follow-up; this module is the type seal alone.
 */

import type {
  ActiveChildRunSummaryData,
  TaskProjectionRecordData,
} from '../../types/electron'
import type { TaskCardRunLike } from '../../modules/agent/taskCardViewModel'

const TASK_CARD_BRAND: unique symbol = Symbol('TaskCardRun')

export interface TaskCardRun extends TaskCardRunLike {
  /**
   * Module-private brand. Required field — TS rejects any `{ ... }`-style
   * literal that does not include the brand symbol, and the symbol itself
   * is not exported, so the only way to obtain a `TaskCardRun` value is to
   * call `taskProjectionToTaskCardRun(...)` or
   * `buildPlaceholderProjectionFromActiveChildRun(...)` from this module.
   */
  readonly __brand: typeof TASK_CARD_BRAND
  responseMessageId?: string | null
  responseSegmentToolTraceStart?: number | null
}

function brand(value: Omit<TaskCardRun, '__brand'>): TaskCardRun {
  return { ...value, __brand: TASK_CARD_BRAND } as TaskCardRun
}

/**
 * Construct a `TaskCardRun` from a persisted task-projection record. This is
 * the canonical view-truth path; renderer task-card surfaces should use
 * this helper or the `buildPlaceholderProjectionFromActiveChildRun` bridge
 * (debug/control fallback) instead of synthesizing rows directly.
 *
 * The current Stage 6 implementation accepts a partial shape because the
 * projection-to-card mapping is still split across ChatPanel's existing
 * `mergedTaskRuns` logic. Full re-architecture is Stage 7+ scope; the
 * brand exists today so casts cannot proliferate while the migration runs.
 */
export function taskProjectionToTaskCardRun(
  base: Omit<TaskCardRun, '__brand'>,
  // Reserved for Stage 7 IPC-driven path:
  _projection?: TaskProjectionRecordData | null,
  _run?: unknown,
): TaskCardRun {
  return brand(base)
}

/**
 * Stage 6 L6 — debug/control-only synthesis bridge from the
 * `agent:listActiveChildRuns` polling feed. The renderer guards the call
 * site with `projectionsCoverChildRunId(...)` so a synthesized row only
 * survives until the persisted projection backfills.
 *
 * In Stage 7+ this bridge can be removed once the projection IPC event
 * (`agent:taskProjectionsChanged`) eliminates the active-child-run polling
 * path entirely.
 */
export function buildPlaceholderProjectionFromActiveChildRun(
  base: Omit<TaskCardRun, '__brand'>,
  _row: ActiveChildRunSummaryData,
): TaskCardRun {
  return brand(base)
}
