/**
 * Pure gating logic for skill_* tools.
 *
 * Phase 4: the 6 execution-control tools retired along with the
 * skill_executions state machine. Only the 4 skill primitives need
 * session-aware gating now — they're exposed only when the session has a
 * reference-skill hint armed by the orchestrator.
 *
 * Separate from `skills-tools.ts` so that:
 *   - Tests can import this without pulling in electron / runtime-manager via
 *     the skills-tools → runtime-manager chain.
 *   - The logic lives in exactly one place; both getSkillToolDefs and any
 *     future skill_* tool surface can reuse the same gate.
 */

/**
 * B Phase 1 — skill primitives gating.
 *
 * Primitives (`skill_ask_user` / `skill_run_shell` / `skill_write_artifact` /
 * `skill_read_artifact`) are only exposed to the LLM when the session has a
 * reference-skill hint registered by the orchestrator (i.e. a reference skill
 * was inlined in this session recently). Legacy sessionId-less callers
 * (boot-time introspection, static fallback) keep the full list so the tool
 * surface inventory stays stable.
 *
 * Phase 4 simplification: `hasActiveExecution` is permanently false since
 * skill_executions no longer exists, so the primitive gate is driven entirely
 * by the reference-skill hint. The parameter is retained for call-site
 * compatibility in case a future gate wants to layer additional signals.
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
