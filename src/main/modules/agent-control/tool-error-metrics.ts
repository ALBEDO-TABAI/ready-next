/**
 * Phase 4 — central registry of tool-error metric names.
 *
 * `logAgentMetric` is a plain string write with no name validation, so it's
 * trivial for a rename or typo to silently fragment observability. This object
 * is the single source of truth for every error-adjacent metric the tool
 * error contract emits. Adding a new one? Add the entry here FIRST, then
 * reference it at the emit site.
 *
 * Rules:
 *   - `key` is a camelCase code symbol (refactors touch one file).
 *   - `value` is the snake_case metric string actually written to the log —
 *     KEEP THESE STABLE across renames so historical log aggregation queries
 *     stay valid.
 *   - Non-error metrics (e.g. `tool_group_blocked_rate`, `policy_conflict_resolved`)
 *     belong to different observability surfaces and intentionally stay out
 *     of this registry.
 */
export const TOOL_ERROR_METRICS = {
  /** dispatch 层把 handler 抛错吞成结构化 ToolExecutionOutput（Phase 1） */
  surfaced: 'tool_error_surfaced',
  /** tool-runtime 捕到 unknown-kind 错误，仍然 surface 给模型（Phase 1） */
  unknownSurfaced: 'tool_error_unknown_surfaced',
  /** dispatch 入口 Zod safeParse 拒绝模型输入（Phase 2/2.5） */
  inputValidation: 'tool_input_validation_failed',
  /** 工具策略裁决后仍出现 invariant 违规（残留遥测） */
  resolutionViolation: 'tool_resolution_violation_post_arbitration',
  // B Phase 4 PR2: `skillExecutionMissing` retired alongside the 6
  // `skill_submit_*` / `skill_get_state` / restart / cancel tools.
  // B Phase 4 PR3: `ttlSwept` retired — the `skill_executions` state
  // machine + its TTL sweep are gone. The only periodic in-memory sweep
  // that survives is reference-skill hints, and it emits via its own
  // metric in `skill-reference-hints.ts` (not this registry).
  /**
   * openai-execution-client 发现模型看到的 allowedToolNames 与上游 preparedRunCapabilities
   * 记录的 expectedAllowedToolNames 不一致（Round 2 R4）。出现该 metric 即说明
   * 策略在 turn-engine 构建 bundle 和 openai-client 重算 bundle 之间发生了漂移，
   * 是 "Tool not allowed" 假阳性的强信号。
   */
  toolSnapshotMismatch: 'tool_snapshot_mismatch',
  /** B Phase 1 — Skill primitive 成功调用（附 primitive 维度） */
  skillPrimitiveUsed: 'skill_primitive_used',
  /**
   * B Phase 1 — Skill primitive 被沙箱 / 白名单 / 上限拒绝（附 reason 维度，Patch B
   * 后扩展）：
   *   path_escape | reserved_path | symlink_escape | absolute_path | empty_path |
   *   cmd_not_allowlisted | command_empty | command_parse_failed | timeout |
   *   missing_skill | size_limit | overflow_artifact_write_failed | aborted |
   *   not_found | not_a_file
   */
  skillPrimitiveRejected: 'skill_primitive_rejected',
} as const

export type ToolErrorMetricName = (typeof TOOL_ERROR_METRICS)[keyof typeof TOOL_ERROR_METRICS]
