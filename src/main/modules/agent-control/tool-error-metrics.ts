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
  /** Reference-skill hint TTL sweep 完成一次（Phase 4 — 替换原 `skill_executions_ttl_swept`，因为 skill_executions 状态机已退役） */
  skillReferenceHintTtlSwept: 'skill_reference_hint_ttl_swept',
  /**
   * Skill child-runtime feature-flag observability. Emitted when the
   * `READY_SKILL_CHILD_RESUME_ENABLED` rollback flag is set to `'0'` and
   * the TurnEngine skips its automatic child-resume branch, falling
   * through to the normal model turn instead of calling
   * `resumeSkillChildRun`. The runner's resume API itself is unaffected.
   */
  childResumeDisabledByFlag: 'skill_child_resume_disabled_by_flag',
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
  /**
   * Domain adapter 的二段 prefix narrowing 实际丢弃了工具时打点（附 domain /
   * droppedCount / droppedSample 维度）。pass-through（输入为空或全部保留）不发，
   * 否则会淹没仪表盘。配合 `[domain_adapter_prefix_narrowing] ...` host.log 行使用。
   */
  domainToolNarrowingApplied: 'domain_tool_narrowing_applied',
  /**
   * Turn-engine 检测到模型在主工具循环里以相同参数连续调用同一个工具达到阈值
   * （默认：最近 5 次里出现 ≥3 次）。emit 时附 `{ tool, repetitions, sessionId }`，
   * 同时往 session.messages 注入一段系统提醒，引导模型改用 skill_ask_user 或换路径。
   * 触发后 ring buffer 会被清空，避免每一轮都重复 emit / 重复注入提醒。
   */
  toolLoopRepetitionDetected: 'tool_loop_repetition_detected',
  /**
   * skill-resume E1 — runtime 在用户发起 bare retry intent（"继续 / 接着 ..."）且
   * 当前 scope 没有手动附加的 sessionRecallContext 时，自动按 lineage_root 回挂
   * top-N 历史 capsule。emit 时附 `{ scopeId, attachedCount, attachedConversationIds }`，
   * 让用户在 UI 与日志里都能看到这次"自动回挂"动作。无候选 / 已有手动附加 → 不 emit。
   */
  sessionRecallAutoAttached: 'session_recall_auto_attached',
  /**
   * skill-resume G4 — last-recourse hint recovery for OLD conversations:
   * meta_json 没有 `lastReferenceSkill`、session.messages 是空（重启后），
   * 但 auto-attach 的 capsule 文本里出现了规范化的 `skill_<id>_<action>` tool
   * 名。runtime 反向解析回 reference-like skill 并 arm hint 时打这条。emit 附
   * `{ scopeId, skillId, skillName }`。无匹配 / 不是 reference-like → 不 emit。
   */
  skillReferenceHintRecoveredFromCapsule: 'skill_reference_hint_recovered_from_capsule',
  /**
   * Phase 1.4 — `parseScopeMeta` 发现 conversation_scope.meta_json 不是合法 JSON
   * 时打这条。以前默默吞成 `{}`，会让 `lastReferenceSkill` 之类的字段无声丢失。
   * emit 附 `{ scopeId, sample }`（sample 截前 80 字符防爆）。
   */
  metaParseCorrupted: 'meta_parse_corrupted',
  /**
   * Phase 3.2 — turn-engine 在把模型 assistant 文本写入 session.messages
   * 之前，检测到残留的 tool_call 标记（`<tool_call>` / `<function=` /
   * `<parameter=` / `:::tool_call`）。命中后 helper 会用 parseTextToolBridge
   * 重解析、剥离标记、emit 该 metric，避免污染 chat panel + chat_messages 表。
   * 出现该 metric 即说明上游 tool-bridge 解析没拦住或 native transport 漏出了
   * 模型自造的工具调用文本。emit 附 `{ sessionId, iteration, transport,
   * extractedToolCalls, originalLen, cleanedLen }`。审计 Phase 3 §D2。
   */
  toolCallTextIntercepted: 'tool_call_text_intercepted',
  /**
   * Screenshot-bug ROOT FIX — openai-execution-client 在 native 路径检测到
   * 模型 text 含 `<tool_call>` XML 但 provider 返回 toolCalls=[] 的协议
   * mismatch（mimo / qwen 等 OpenAI 兼容方常见），用 parseTextToolBridgeResponse
   * 解析 XML 把 calls 挂回 toolCalls 让 dispatch 链照常推进。出现该 metric
   * 即说明本会话的 model+provider 组合在 tool-calling 协议上有偏差。emit 附
   * `{ originalCallsCount, recoveredCallsCount, recoveredToolNames, route }`。
   */
  xmlToolCallsRecoveredFromNative: 'xml_tool_calls_recovered_from_native',
  /**
   * A1 SubAgent skeleton — lifecycle cleanup drain failed. The runner logs this
   * but preserves the original terminal result because cleanup telemetry must
   * not rewrite the SubAgent contract outcome.
   */
  subagentCleanupDrainFailed: 'subagent_cleanup_drain_failed',
} as const

export type ToolErrorMetricName = (typeof TOOL_ERROR_METRICS)[keyof typeof TOOL_ERROR_METRICS]
