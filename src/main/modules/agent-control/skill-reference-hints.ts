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

export interface ReferenceSkillHint {
  id: string
  name: string
  at: number
}

const lastReferenceSkillBySession = new Map<string, ReferenceSkillHint>()

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
    at: Date.now(),
  })
}

export function getLastReferenceSkill(
  sessionId: string | undefined,
): ReferenceSkillHint | null {
  if (!sessionId) return null
  return lastReferenceSkillBySession.get(sessionId) || null
}

export function clearLastReferenceSkill(sessionId: string | undefined): void {
  if (!sessionId) return
  lastReferenceSkillBySession.delete(sessionId)
}

// Exposed for tests only — do not call from production code paths.
export function _resetLastReferenceSkillHintsForTests(): void {
  lastReferenceSkillBySession.clear()
}
