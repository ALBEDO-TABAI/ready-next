import type { ScopeRunState } from '../../../../modules/agent/types'
import type { SessionRecallSessionStatus } from '../../../../../shared/session-recall'

// Status-dot semantics for a history-panel session row:
//   active  (ok)     — just-completed task, or the active/foreground scope
//   working (signal) — a run is in flight; running is what the signal colour means (W1 DL5)
//   error   (bad)    — the run failed
//   off     (ink)    — pure history / no live activity
export type SessionDotStatus = 'active' | 'working' | 'error' | 'off'

type RunPhase = ScopeRunState['phase']

// Phases that mean "a run is currently in flight" (the signal colour).
const WORKING_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'queued',
  'planning',
  'tool_running',
  'checkpoint',
  'takeover',
  'resuming',
  'responding',
])

// Map a scope's live run phase to its dot status. Only currently-open scopes
// carry a phase; pure-history rows pass `undefined` and fall through to 'off'
// (unless flagged `isActive`, i.e. the foreground scope, which reads ok).
export function resolveSessionDotStatus(
  phase: RunPhase | null | undefined,
  opts?: { isActive?: boolean; isStreaming?: boolean },
): SessionDotStatus {
  if (opts?.isStreaming) return 'working'
  if (phase === 'error') return 'error'
  if (phase && WORKING_PHASES.has(phase)) return 'working'
  if (phase === 'done') return 'active'
  return opts?.isActive ? 'active' : 'off'
}

export const SESSION_DOT_COLOR: Record<SessionDotStatus, string> = {
  active: 'var(--rn-ok)',
  working: 'var(--rn-accent)',
  error: 'var(--rn-bad)',
  off: 'var(--rn-ink-4)',
}

// P0-1 — history rows: map the main-derived session status to a dot. Live
// statuses (open scopes) are resolved separately and take precedence; this
// covers pure-history rows that previously always fell to gray.
export function recallStatusToDot(status: SessionRecallSessionStatus | null | undefined): SessionDotStatus {
  switch (status) {
    case 'working': return 'working'
    case 'blocked':
    case 'check_in_pending':
      return 'working' // needs attention — the signal colour, same as in-flight
    case 'done': return 'active'
    case 'error': return 'error'
    default: return 'off'
  }
}
