import { AgentTaskState } from '../contracts/types'

export interface AgentTaskSnapshot {
  agent: string
  state: AgentTaskState
  updatedAt: string
  error?: string
}

/**
 * Stage V V3.1 — parsed descriptor for the composite key
 * `${agent}::${sessionId}` that `ReadyAgentOrchestrator.toTaskKey()` writes
 * into `AgentSessionManager`. Consumers that need per-(agent, sessionId)
 * introspection must consume `listStatesEnriched()` — never re-parse the
 * raw composite from `AgentTaskSnapshot.agent` themselves (codex round-1
 * spotted that listing consumers were treating the composite as a bare
 * agent id, which is why the descriptor is the only sanctioned exit).
 */
export interface SessionDescriptor {
  readonly agent: string
  /**
   * `null` when the underlying composite key has no `::` suffix — i.e. a
   * legacy single-session entry written before per-session keys existed.
   */
  readonly sessionId: string | null
}

export interface AgentTaskSnapshotEnriched extends AgentTaskSnapshot {
  descriptor: SessionDescriptor
}

const COMPOSITE_KEY_DELIMITER = '::'

/**
 * Parse the composite session key into a `SessionDescriptor`.
 * Roundtrip contract: `parseSessionKey(buildKey(agent, sessionId))` returns
 * `{ agent, sessionId }`; legacy keys without the `::` delimiter return
 * `{ agent: key, sessionId: null }`.
 *
 * Edge: an agent id that itself contains `::` (currently disallowed by
 * upstream agent registration but defended here) splits at the **first**
 * delimiter so the sessionId tail is preserved verbatim.
 */
export function parseSessionKey(compositeKey: string): SessionDescriptor {
  const i = compositeKey.indexOf(COMPOSITE_KEY_DELIMITER)
  if (i < 0) return { agent: compositeKey, sessionId: null }
  return {
    agent: compositeKey.slice(0, i),
    sessionId: compositeKey.slice(i + COMPOSITE_KEY_DELIMITER.length),
  }
}

export class AgentSessionManager {
  private readonly tasks = new Map<string, AgentTaskSnapshot>()

  setState(agent: string, state: AgentTaskState, error?: string): AgentTaskSnapshot {
    const next: AgentTaskSnapshot = {
      agent,
      state,
      updatedAt: new Date().toISOString(),
      error,
    }
    this.tasks.set(agent, next)
    return next
  }

  getState(agent: string): AgentTaskSnapshot | null {
    return this.tasks.get(agent) || null
  }

  /**
   * Active = not in any terminal state. Stage V V3.1 added `'closed'` to
   * the terminal set; the negation form below means it is excluded
   * automatically — verified by the descriptor test in
   * `session-manager-descriptor.test.ts`.
   */
  getActiveCount(): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (
        task.state === 'queued' ||
        task.state === 'planning' ||
        task.state === 'tool_running' ||
        task.state === 'responding'
      ) {
        count += 1
      }
    }
    return count
  }

  listStates(): AgentTaskSnapshot[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * Stage V V3.1 — descriptor-enriched listing. Use this when the consumer
   * needs to address sessions by `(agent, sessionId)` rather than by the
   * raw composite string.
   */
  listStatesEnriched(): AgentTaskSnapshotEnriched[] {
    return this.listStates().map((snap) => ({
      ...snap,
      descriptor: parseSessionKey(snap.agent),
    }))
  }

  /**
   * Stage V V3.1 — check whether a composite-key entry exists. Used by
   * `ReadyAgentOrchestrator.closeSession()` to decide whether the
   * `{ closed: true | false }` return reflects an actually-tracked session
   * or a no-op idempotent call.
   */
  has(agent: string): boolean {
    return this.tasks.has(agent)
  }
}
