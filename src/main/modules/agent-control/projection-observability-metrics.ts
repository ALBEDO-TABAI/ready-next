/**
 * Stage 3 — central registry of state/projection observability metric names.
 *
 * Lives outside `tool-error-metrics.ts` because §6.11 reserves that registry
 * for the tool-executor error contract (errors that flow back to the model
 * as structured `ToolExecutionOutput`). Adding state-read observability there
 * would dilute the boundary.
 *
 * Adding a new metric? Declare it here first, then reference the constant
 * at the emit site — same discipline as `TOOL_ERROR_METRICS` keeps refactor
 * renames type-checked across the codebase.
 */
export const PROJECTION_OBSERVABILITY_METRICS = {
  /**
   * Stage 3 W1 — runtime's `task_projections` DB query threw. In-memory
   * child runs are still returned by `listActiveChildRunsWithDiagnostics`,
   * so the IPC contract is unchanged from the user's point of view; this
   * metric exists so operators can see DB jitter without seeing "active
   * runs disappeared" in the UI.
   */
  activeChildRunProjectionQueryFailed: 'active_child_run_projection_query_failed',
  /**
   * Stage 3 W2 — task-projection-reconciler tried to read
   * `run_state.json` / `delivery_report.json` and got either a JSON parse
   * error (`corrupt`), a permission denial (`denied`), or a parsed value
   * that is not a plain object (`not_object`). `missing` (file absent) is
   * a normal pre-completion state and intentionally NOT emitted. Same
   * `pathTag × reason` is throttled at 60s to avoid metric storms when
   * a single child-run keeps producing a malformed file.
   */
  taskProjectionJsonReadFailed: 'task_projection_json_read_failed',
} as const

export type ProjectionObservabilityMetricName =
  (typeof PROJECTION_OBSERVABILITY_METRICS)[keyof typeof PROJECTION_OBSERVABILITY_METRICS]
