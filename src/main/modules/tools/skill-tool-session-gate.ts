/**
 * Pure gating logic for skill execution-control tools.
 *
 * Separate from `skills-tools.ts` so that:
 *   - Tests can import this without pulling in electron / runtime-manager via
 *     the skills-tools → runtime-manager chain.
 *   - The logic lives in exactly one place; both getSkillToolDefs and any
 *     future skill_* tool surface (e.g. the primitives in Phase 1) can reuse
 *     the same gate.
 *
 * Behavior (B plan Phase 0 — P0-T1):
 *   - Legacy callers with no sessionId keep the full tool list. This preserves
 *     the static fallback path used during boot when the runtime manager is
 *     not yet available.
 *   - When a sessionId is supplied and the session has NO active execution,
 *     submit_* / restart_from_step / cancel_execution are filtered out of the
 *     tool list (LLM never sees them — stops it from fabricating
 *     `executionId: "new"`).
 *   - `skill_get_state` is NEVER gated — it is a read-only probe that stays
 *     safe in every state.
 */

export const SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'skill_submit_input',
  'skill_submit_confirmation',
  'skill_submit_agent_result',
  'skill_restart_from_step',
  'skill_cancel_execution',
])

export function shouldExposeExecutionControlTool(
  toolName: string,
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
): boolean {
  if (!sessionId) return true
  if (!SESSION_GATED_EXECUTION_CONTROL_TOOL_NAMES.has(toolName)) return true
  return hasActiveExecution(sessionId)
}

// Convenience: filter a caller-supplied list of tool definitions. `T` is the
// tool-def shape (SkillToolDef or any superset exposing `.name`).
export function filterExecutionControlToolsBySession<T extends { name: string }>(
  defs: readonly T[],
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
): T[] {
  return defs.filter((def) =>
    shouldExposeExecutionControlTool(def.name, sessionId, hasActiveExecution),
  )
}

/**
 * B Phase 1 — skill primitives gating.
 *
 * Primitives (`skill_ask_user` / `skill_run_shell` / `skill_write_artifact` /
 * `skill_read_artifact`) are only exposed to the LLM when one of:
 *   1. The session has an active skill execution (workflow in progress), OR
 *   2. The session has a `lastReferenceSkill` hint from the orchestrator
 *      (a reference skill was just inlined this turn).
 *
 * Rationale: these are powerful tools (shell exec, disk write) and we don't
 * want them surfaced to every generic chat. Legacy sessionId-less callers
 * (boot-time introspection, static fallback) keep the full list so the tool
 * surface inventory stays stable.
 */
export function shouldExposeSkillPrimitive(
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
  hasReferenceSkillHint: (sessionId: string) => boolean,
): boolean {
  if (!sessionId) return true
  if (hasActiveExecution(sessionId)) return true
  if (hasReferenceSkillHint(sessionId)) return true
  return false
}

export function filterSkillPrimitivesBySession<T extends { name: string }>(
  defs: readonly T[],
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
  hasReferenceSkillHint: (sessionId: string) => boolean,
): T[] {
  if (shouldExposeSkillPrimitive(sessionId, hasActiveExecution, hasReferenceSkillHint)) {
    return [...defs]
  }
  return []
}
