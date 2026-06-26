// Stage V V2.0 — claude-bridge engine deps composition root.
//
// `EngineDeps` is the SUPERSET of everything any extracted IPC channel group
// might need. Each group declares its OWN per-group deps interface that is a
// SUBSET of `EngineDeps` (or, more precisely, of the fields the group's
// handlers actually touch).
//
// Why not pass `EngineDeps` straight into every group?
//   1. Tests for a group should stub only what the group needs — passing the
//      whole engine drags in db + runtime + mainWindow + metric for handlers
//      that just call one store method.
//   2. Group-local deps act as a contract: reading a group file shows you the
//      exact handler surface area without scanning the host's wiring.
//   3. Future moves (e.g. lifting a group out of claude-bridge entirely) are
//      mechanical — copy the group + its deps interface; no implicit coupling
//      via god-deps.
//
// As groups are extracted in V2.1b … V2.1n this file grows. V2.1a only needs
// the AskUserGroup surface.
import type { Database } from '../../database'
import type { EphemeralExecutionStore } from '../../tools/skill-primitives/ephemeral-execution-store'
import type { AskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'

/**
 * Minimal metric logger signature used by askUser handlers. Mirrors
 * `logAgentMetric(name, payload)` from `agent-control/metrics` so groups
 * don't have to depend on the metric module directly (lets tests inject a
 * spy without importing the real metric pipeline).
 */
export type AgentMetricLogger = (name: string, payload: Record<string, unknown>) => void

/**
 * Composition root. V2.1a populates only the askUser-relevant fields; later
 * V2.1 sub-stages extend this interface as their groups need new deps.
 *
 * Optional fields are FORBIDDEN here — if a future group can run without a
 * dep, that dep belongs in the group's per-group deps interface (also
 * optional there), NOT here.
 */
export interface EngineDeps {
  /** SQLite handle; askUser handlers read/write `chat_messages`. */
  getDatabase(): Database
  /** Ephemeral skill `ask_user` store (single-question). */
  getEphemeralExecutionStore(): EphemeralExecutionStore
  /** Reflection-card store (multi-question `ask_user_questions`). */
  getAskUserQuestionsStore(): AskUserQuestionsStore
  /** Metric pipeline; askUser groups emit submit/cancel counters. */
  logAgentMetric: AgentMetricLogger
  /** Refreshes the active run's no-progress clock after a user-input edge. */
  refreshActiveRunProgress(agent: string, sessionId: string | undefined, requestId?: string): boolean
}
