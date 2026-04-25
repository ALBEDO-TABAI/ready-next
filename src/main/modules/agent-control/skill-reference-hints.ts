/**
 * Session-scoped memory of the most recent reference-skill injected into a
 * conversation. The orchestrator writes to this map whenever it inlines a
 * reference-runtime skill (no execution_state is created). The
 * skill-execution-missing error builder reads from this map so that, if the
 * LLM still fabricates a `skill_submit_*` call, the returned error can
 * specifically tell it "you just read a reference skill — don't submit".
 *
 * Intentionally kept to a tiny, dependency-free module so both
 * skill-context-orchestrator.ts (writer) and skills-tools.ts (reader) can
 * import it without cross-wiring orchestrator instances through the tool
 * dispatch path.
 *
 * State is in-memory only: no persistence, no compaction, no IPC. Lifetime
 * is the main-process lifetime.
 *
 * B plan Phase 0 — P0-T3.
 */

import { logAgentMetric } from './metrics'
import { TOOL_ERROR_METRICS } from './tool-error-metrics'

export interface ReferenceSkillHint {
  id: string
  name: string
  at: number
}

/**
 * Idle TTL for a reference-skill hint. A session that hasn't reloaded its
 * reference skill in this window is assumed to have moved on — the hint is
 * purged so the skill-execution-missing error branch falls back to the generic
 * "tool not applicable" message instead of lying about a stale skill.
 */
export const REFERENCE_SKILL_HINT_TTL_MS = 30 * 60 * 1000 // 30 min

const lastReferenceSkillBySession = new Map<string, ReferenceSkillHint>()

function now(): number {
  return Date.now()
}

function isExpired(hint: ReferenceSkillHint, at: number): boolean {
  return at - hint.at > REFERENCE_SKILL_HINT_TTL_MS
}

export function rememberLastReferenceSkill(
  sessionId: string | undefined,
  info: { id: string; name: string },
): void {
  if (!sessionId) return
  const id = typeof info.id === 'string' ? info.id.trim() : ''
  const name = typeof info.name === 'string' ? info.name.trim() : ''
  if (!id) return
  lastReferenceSkillBySession.set(sessionId, {
    id,
    name: name || id,
    at: now(),
  })
}

export function getLastReferenceSkill(
  sessionId: string | undefined,
): ReferenceSkillHint | null {
  if (!sessionId) return null
  const hint = lastReferenceSkillBySession.get(sessionId)
  if (!hint) return null
  if (isExpired(hint, now())) {
    lastReferenceSkillBySession.delete(sessionId)
    return null
  }
  return hint
}

export function clearLastReferenceSkill(sessionId: string | undefined): void {
  if (!sessionId) return
  lastReferenceSkillBySession.delete(sessionId)
}

/**
 * Purge any hint whose last-write is older than `REFERENCE_SKILL_HINT_TTL_MS`.
 * Safe to call eagerly; returns the number of entries removed so callers can
 * log or emit a telemetry counter.
 */
export function sweepExpiredReferenceSkillHints(): number {
  const at = now()
  let removed = 0
  for (const [sessionId, hint] of lastReferenceSkillBySession) {
    if (isExpired(hint, at)) {
      lastReferenceSkillBySession.delete(sessionId)
      removed += 1
    }
  }
  // Phase 4: emit a dedicated metric — this sweep used to piggyback on
  // `skill_executions_ttl_swept`, but that table + metric were retired along
  // with the state machine. `skill_reference_hint_ttl_swept` is the replacement
  // and is registered in TOOL_ERROR_METRICS.
  logAgentMetric(TOOL_ERROR_METRICS.skillReferenceHintTtlSwept, {
    removed,
    ttlMs: REFERENCE_SKILL_HINT_TTL_MS,
    cutoffAt: at,
  })
  return removed
}

/**
 * Forget hints for every session. Callers wire this up to the runtime
 * lifecycle: `AgentRuntimeManager.dispose` (app shutdown) and
 * `ConversationScope` retire hooks. Idempotent.
 */
export function clearAllReferenceSkillHints(): void {
  lastReferenceSkillBySession.clear()
}

// Exposed for tests only — do not call from production code paths.
export function _resetLastReferenceSkillHintsForTests(): void {
  lastReferenceSkillBySession.clear()
}
