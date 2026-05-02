/**
 * Pure gating logic for skill_* tools.
 *
 * Phase 4: the 6 execution-control tools retired along with the
 * skill_executions state machine. Only skill primitives need
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
 * Primitives (`skill_ask_user` / `skill_run_shell` / artifact I/O /
 * detached-task controls) are only exposed to the LLM when the session has a
 * reference-skill hint registered by the orchestrator (i.e. a reference skill
 * was inlined in this session recently). Legacy sessionId-less callers
 * (boot-time introspection, static fallback) keep the full list so the tool
 * surface inventory stays stable.
 *
 * Phase 4 simplification: `hasActiveExecution` is permanently false since
 * skill_executions no longer exists, so the primitive gate is driven entirely
 * by the reference-skill hint. The parameter is retained for call-site
 * compatibility in case a future gate wants to layer additional signals.
 *
 * Phase 4.3 — `hasActiveSkillTaskProjection` is an OPTIONAL secondary signal
 * that surfaces primitives when the session has a recent skill task projection
 * (a `recordSkillTaskEvent` call landed for this session). Audit Phase 4 §C2:
 * a hint that expired or got cleared mid-flow used to nuke primitive access
 * entirely; the projection signal keeps primitives available while the user
 * is clearly still operating on a skill, even if the hint TTL passed.
 * Defense-in-depth — Phase 1's persistence work makes hint loss rare, but
 * this is the OR fallback when it does happen.
 *
 * Wave 2 parent-loop closure: an active child-run row is also a live skill
 * task signal. Child-owned frames must keep primitives visible for status
 * observation while the child runner owns resume/cancel.
 */
export function shouldExposeSkillPrimitive(
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
  hasReferenceSkillHint: (sessionId: string) => boolean,
  hasActiveSkillTaskProjection?: (sessionId: string) => boolean,
  hasActiveSkillTaskRun?: (sessionId: string) => boolean,
): boolean {
  if (!sessionId) return true
  if (hasActiveExecution(sessionId)) return true
  if (hasReferenceSkillHint(sessionId)) return true
  if (hasActiveSkillTaskProjection?.(sessionId)) return true
  if (hasActiveSkillTaskRun?.(sessionId)) return true
  return false
}

export function choosePrimitiveSkillId(params: {
  frameSkillId?: string | null
  activeContextSkillId?: string | null
  referenceHintSkillId?: string | null
  latestTaskRunSkillId?: string | null
}): string | null {
  return params.frameSkillId
    || params.activeContextSkillId
    || params.referenceHintSkillId
    || params.latestTaskRunSkillId
    || null
}

export function filterSkillPrimitivesBySession<T extends { name: string }>(
  defs: readonly T[],
  sessionId: string | undefined,
  hasActiveExecution: (sessionId: string) => boolean,
  hasReferenceSkillHint: (sessionId: string) => boolean,
  hasActiveSkillTaskProjection?: (sessionId: string) => boolean,
  hasActiveSkillTaskRun?: (sessionId: string) => boolean,
): T[] {
  if (shouldExposeSkillPrimitive(
    sessionId,
    hasActiveExecution,
    hasReferenceSkillHint,
    hasActiveSkillTaskProjection,
    hasActiveSkillTaskRun,
  )) {
    return [...defs]
  }
  return []
}
