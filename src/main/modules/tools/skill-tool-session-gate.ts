/**
 * Pure gating logic for skill primitive tool exposure.
 *
 * B Phase 4 PR2 retired the execution-control gating branch (the 5
 * `skill_submit_*` / restart / cancel tools are deleted from the tool
 * surface entirely). B Phase 4 PR5 follow-up dropped the
 * `hasActiveExecution` branch since the state machine is gone and the
 * predicate was permanently false.
 *
 * No electron imports; caller threads in `hasReferenceSkillHint` so
 * boot-time / fallback callers without a runtime manager still get
 * sensible defaults.
 */

/**
 * B Phase 1 — skill primitives gating.
 *
 * Primitives (`skill_ask_user` / `skill_run_shell` / `skill_write_artifact` /
 * `skill_read_artifact`) are only exposed to the LLM when the session has a
 * `lastReferenceSkill` hint from the orchestrator (a reference skill was
 * just inlined this turn).
 *
 * Rationale: these are powerful tools (shell exec, disk write) and we don't
 * want them surfaced to every generic chat. Legacy sessionId-less callers
 * (boot-time introspection, static fallback) keep the full list so the tool
 * surface inventory stays stable.
 */
export function shouldExposeSkillPrimitive(
  sessionId: string | undefined,
  hasReferenceSkillHint: (sessionId: string) => boolean,
): boolean {
  if (!sessionId) return true
  if (hasReferenceSkillHint(sessionId)) return true
  return false
}

export function filterSkillPrimitivesBySession<T extends { name: string }>(
  defs: readonly T[],
  sessionId: string | undefined,
  hasReferenceSkillHint: (sessionId: string) => boolean,
): T[] {
  if (shouldExposeSkillPrimitive(sessionId, hasReferenceSkillHint)) {
    return [...defs]
  }
  return []
}
