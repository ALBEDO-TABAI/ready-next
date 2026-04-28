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
 * Serializable shape persisted to `chat_conversations.meta_json.lastReferenceSkill`
 * so the hint survives a Ready restart. Same field set as the in-memory
 * `ReferenceSkillHint`; kept under its own name to make the persistence
 * boundary explicit at call sites.
 */
export interface PersistedReferenceSkillHint {
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

/**
 * Phase 5.3 — module-level change emitter so the renderer's `referenceSkillHint`
 * badge stays in sync with the in-memory map. Production wires this in
 * `setupAgentIPC` to push `agent:referenceSkillHintChanged`. Tests leave it
 * unset (default no-op). Audit Phase 5 §E3 — UI used to lag the backend by
 * one scope-run event; the badge could show "armed" after the hint had
 * already been swept, or vice versa.
 *
 * The emitter is intentionally fire-and-forget: errors in the IPC pipe
 * must never propagate back into the hint map mutation path.
 */
type HintChangeKind = 'armed' | 'cleared'
export type ReferenceHintChangeEmitter = (sessionId: string, change: HintChangeKind) => void
let hintChangeEmitter: ReferenceHintChangeEmitter | null = null

export function setReferenceHintChangeEmitter(fn: ReferenceHintChangeEmitter | null): void {
  hintChangeEmitter = fn
}

function emitHintChange(sessionId: string, change: HintChangeKind): void {
  if (!hintChangeEmitter) return
  try {
    hintChangeEmitter(sessionId, change)
  } catch (error) {
    // Swallow — emitter is observability, not correctness.
    console.warn('[skill-reference-hints] hint change emitter threw:', error)
  }
}

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
  // Phase 5.3 — notify renderer the badge state may have changed.
  emitHintChange(sessionId, 'armed')
}

export function getLastReferenceSkill(
  sessionId: string | undefined,
): ReferenceSkillHint | null {
  if (!sessionId) return null
  const hint = lastReferenceSkillBySession.get(sessionId)
  if (!hint) return null
  const at = now()
  if (isExpired(hint, at)) {
    lastReferenceSkillBySession.delete(sessionId)
    return null
  }
  // skill-resume G8 — bump `at` on every read so an active session keeps the
  // hint alive past the 30-min TTL window. Without this a long pipeline
  // (which can take 10-30+ min wall clock) loses the hint mid-flow, the
  // typed actions disappear from preferredSkillToolNames, and the LLM falls
  // back to forking python via skill_run_shell which then 10-min-times-out.
  // Persistence (chat_conversations.meta_json) still snapshots `at` after
  // each assistant message via persistReferenceHintToScope, so resume math
  // remains consistent across restarts.
  hint.at = at
  return hint
}

export function peekLastReferenceSkill(
  sessionId: string | undefined,
): ReferenceSkillHint | null {
  if (!sessionId) return null
  const hint = lastReferenceSkillBySession.get(sessionId)
  if (!hint) return null
  if (isExpired(hint, now())) {
    lastReferenceSkillBySession.delete(sessionId)
    return null
  }
  return { ...hint }
}

export function clearLastReferenceSkill(sessionId: string | undefined): void {
  if (!sessionId) return
  const existed = lastReferenceSkillBySession.delete(sessionId)
  if (existed) {
    emitHintChange(sessionId, 'cleared')
  }
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
      // Phase 5.3 — notify renderer so the badge stops claiming "armed"
      // the moment the sweep removes a stale hint.
      emitHintChange(sessionId, 'cleared')
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
  // Phase 5.3 — emit per session BEFORE clearing so observers can react
  // (e.g. renderer badges) without re-reading an empty map.
  for (const sessionId of lastReferenceSkillBySession.keys()) {
    emitHintChange(sessionId, 'cleared')
  }
  lastReferenceSkillBySession.clear()
}

/**
 * Patch A1 — return a serializable copy of the in-memory hint for a session,
 * or `null` if the session has no live hint (never armed, expired, or already
 * cleared). The returned object can be written to `chat_conversations.meta_json`
 * so the hint survives a Ready restart.
 */
export function snapshotLastReferenceSkill(
  sessionId: string | undefined,
): PersistedReferenceSkillHint | null {
  const hint = getLastReferenceSkill(sessionId)
  if (!hint) return null
  return { id: hint.id, name: hint.name, at: hint.at }
}

/**
 * Patch A1 — replay a previously persisted hint into the in-memory map. Used
 * on scope-load (`AgentControlRuntime.sendScoped`) to restore the hint after
 * a Ready restart. Stale hints (older than `REFERENCE_SKILL_HINT_TTL_MS`) are
 * rejected so we don't lie to skill detection about a long-since-abandoned
 * reference skill.
 *
 * Returns `true` when the hint was restored, `false` otherwise. Call sites do
 * not generally branch on the result — it's exposed for telemetry and tests.
 */
export function restoreLastReferenceSkill(
  sessionId: string | undefined,
  hint: PersistedReferenceSkillHint | null | undefined,
): boolean {
  if (!sessionId) return false
  if (!hint || typeof hint !== 'object') return false
  const id = typeof hint.id === 'string' ? hint.id.trim() : ''
  const name = typeof hint.name === 'string' ? hint.name.trim() : ''
  const at = typeof hint.at === 'number' && Number.isFinite(hint.at) ? hint.at : 0
  if (!id || !at) return false
  if (now() - at > REFERENCE_SKILL_HINT_TTL_MS) return false
  // Preserve the original `at` so TTL math survives across restarts; we
  // intentionally bypass `rememberLastReferenceSkill` because that one stamps
  // a fresh `at`.
  lastReferenceSkillBySession.set(sessionId, {
    id,
    name: name || id,
    at,
  })
  // Phase 5.3 — restore is functionally an arming, notify renderer.
  emitHintChange(sessionId, 'armed')
  return true
}

// Exposed for tests only — do not call from production code paths.
export function _resetLastReferenceSkillHintsForTests(): void {
  lastReferenceSkillBySession.clear()
  // RE-AUDIT bonus — also reset the change emitter so Phase 5.3 tests can't
  // leak a `setReferenceHintChangeEmitter(...)` callback into adjacent test
  // files when `tsx --test file1 file2` runs in a shared process. Without
  // this, a Phase 5 test that forgets to clear emitter would silently
  // intercept hint mutations from unrelated tests downstream.
  hintChangeEmitter = null
}

/**
 * Test-only peek that does NOT bump `at` (unlike the production
 * `getLastReferenceSkill` which refreshes TTL on every read per G8). Used by
 * persistence/snapshot tests that need to verify the in-memory `at` value
 * AFTER restoration but BEFORE any active read mutates it.
 */
export function _peekLastReferenceSkillForTests(
  sessionId: string | undefined,
): ReferenceSkillHint | null {
  if (!sessionId) return null
  return lastReferenceSkillBySession.get(sessionId) ?? null
}
