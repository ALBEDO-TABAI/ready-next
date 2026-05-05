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
  /**
   * Stage 3 W3 — `deriveHandlesWithOrigins` had to fall back to either
   * `artifact_path` regex inference (parsing handles out of an artifact's
   * filename) or `run_state_enrichment` (reading run_state.json and
   * promoting its fields to handles). Healthy origins (continuationRef,
   * skill_task_run, child_payload, artifact_meta) are NOT emitted.
   *
   * Throttled by `taskId × field × origin` at 5min — reconciler runs on
   * every projection batch, so a single chronically late-fallback record
   * would otherwise dominate the dashboard. Out-of-the-box behavior of
   * the function itself is byte-identical to the legacy chain; this is
   * pure observability.
   */
  projectionHandleLegacyOriginUsed: 'projection_handle_legacy_origin_used',
  /**
   * Stage 4 W4 — dynamic skill-tool lookup fell back because the runtime
   * manager threw or a boot-safe static tool was absent from dynamic
   * manifests. Payloads are deliberately tiny and keyed by the concrete
   * lookup target so forged tool names do not become high-cardinality metric
   * labels.
   */
  skillToolDynamicLookupFailed: 'skill_tool_dynamic_lookup_failed',
} as const

export type ProjectionObservabilityMetricName =
  (typeof PROJECTION_OBSERVABILITY_METRICS)[keyof typeof PROJECTION_OBSERVABILITY_METRICS]
