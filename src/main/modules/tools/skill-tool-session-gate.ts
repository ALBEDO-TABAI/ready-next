/**
 * Pure gating logic for skill primitive tool exposure.
 *
 * B Phase 4 PR2 retired the execution-control gating branch (the 5
 * `skill_submit_*` / restart / cancel tools are deleted from the tool
 * surface entirely). This module now only hosts the Phase 1 primitive
 * gate — exposed because tests import it directly.
 *
 * No electron imports; caller threads in the `hasActiveExecution` and
 * `hasReferenceSkillHint` predicates so boot-time / fallback callers
 * without a runtime manager still get sensible defaults.
 */

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
 *
 * PR3 will rewire `hasActiveExecution` to always return false at the
 * caller (the state machine is retired), which is why the parameter
 * survives PR2 unchanged.
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
