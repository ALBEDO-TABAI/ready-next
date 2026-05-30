import type { ScopeRunState } from '../../../../modules/agent/types'

// Status-dot semantics for a history-panel session row:
//   active  (green)  — just-completed task, or the active/foreground scope
//   working (orange) — a run is in flight
//   error   (red)    — the run failed
//   off     (gray)   — pure history / no live activity
export type SessionDotStatus = 'active' | 'working' | 'error' | 'off'

type RunPhase = ScopeRunState['phase']

// Phases that mean "a run is currently in flight" (orange).
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
// (unless flagged `isActive`, i.e. the foreground scope, which reads green).
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
  active: '#22c55e',
  working: '#f97316',
  error: '#ef4444',
  off: '#d1d5db',
}
