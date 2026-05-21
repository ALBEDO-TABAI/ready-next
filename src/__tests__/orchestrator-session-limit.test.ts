/**
 * Stage V V3.5 — ReadyAgentOrchestrator main-side session-limit enforcement.
 *
 * Locks the 3-session hard cap (`MAX_CONCURRENT_SESSIONS = 3`) at the
 * main-process entry, independent of the renderer's V3.4a UI disable
 * (plan §10 R12 — "session 上限绕过": main must reject even if a
 * developer bypasses the renderer disable via devtools).
 *
 * Contract under test (mirrored from `runtime-core/orchestrator.ts`):
 *   1. Under limit (live count < 3): novel sessionId is admitted.
 *   2. At limit (live count == 3): novel sessionId throws a structured
 *      `session_limit_exceeded` error (with `code: 'SESSION_LIMIT'`,
 *      `maxSessions: 3`, `liveCount`).
 *   3. Reuse: at the limit, REUSING an already-tracked sessionId is
 *      allowed — it is not a "new" admission.
 *   4. After close: closing one of three live sessions drops the live
 *      count below the cap, so a subsequent newSession with a novel id
 *      is admitted.
 *
 * As with `orchestrator-close-session.test.ts` and
 * `orchestrator-list-all-sessions.test.ts`, the real orchestrator
 * cannot be instantiated under `node --test` (electron-only imports).
 * Per CLAUDE.md §6 "minimal stand-in", we drive the real
 * `AgentSessionManager` directly and mirror the limit-check logic
 * verbatim. A paired source-grep at the end of the file locks the
 * production guard to its 3-cap structure so the stand-in cannot drift.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.5, §10 R12
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentSessionManager } from '../main/modules/agent-control/session/session-manager'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const MAX_CONCURRENT_SESSIONS = 3

function toTaskKey(agent: string, sessionId?: string): string {
  return sessionId ? `${agent}::${sessionId}` : agent
}

/**
 * Local test double that mirrors the orchestrator's V3.5 limit guard
 * for the slice of behavior we can exercise under Node. The real
 * `ReadyAgentOrchestrator` adds the same check inside `send()` and
 * `newSession()` against the same `AgentSessionManager`; here we
 * isolate the guard so the four cases drive deterministic state.
 *
 * Engine stubs are minimal — the limit check fires BEFORE any engine
 * call, so we only need them to no-op for the close path in case (d).
 */
class SessionLimitTestSubject {
  readonly sessions = new AgentSessionManager()
  readonly descriptors = new Map<string, { agent: string; sessionId?: string }>()

  private toInternalSessionKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private toTaskKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  // Mirror of `ReadyAgentOrchestrator.countLiveSessions()`.
  private countLiveSessions(): number {
    let count = 0
    for (const snap of this.sessions.listStatesEnriched()) {
      if (
        snap.state !== 'done' &&
        snap.state !== 'failed' &&
        snap.state !== 'cancelled' &&
        snap.state !== 'closed'
      ) {
        count += 1
      }
    }
    return count
  }

  // Mirror of `ReadyAgentOrchestrator.isKnownSession()`.
  private isKnownSession(agent: string, sessionId?: string): boolean {
    return this.sessions.has(this.toTaskKey(agent, sessionId))
  }

  // Mirror of `ReadyAgentOrchestrator.buildSessionLimitError()`.
  private buildSessionLimitError(liveCount: number): Error & {
    code: 'SESSION_LIMIT'
    maxSessions: number
    liveCount: number
  } {
    const err = new Error('session_limit_exceeded') as Error & {
      code: 'SESSION_LIMIT'
      maxSessions: number
      liveCount: number
    }
    err.code = 'SESSION_LIMIT'
    err.maxSessions = MAX_CONCURRENT_SESSIONS
    err.liveCount = liveCount
    return err
  }

  // Mirror of `ReadyAgentOrchestrator.newSession()` with V3.5 guard.
  newSession(agent: string, sessionId?: string): void {
    if (!this.isKnownSession(agent, sessionId)) {
      const live = this.countLiveSessions()
      if (live >= MAX_CONCURRENT_SESSIONS) {
        throw this.buildSessionLimitError(live)
      }
    }
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.sessions.setState(this.toTaskKey(agent, sessionId), 'done')
  }

  // Minimal mirror of `closeSession` — just the slice case (d) needs:
  // mark the session 'closed' so it stops counting as live.
  closeSession(agent: string, sessionId?: string): void {
    const taskKey = this.toTaskKey(agent, sessionId)
    const prior = this.sessions.getState(taskKey)
    if (prior && prior.state !== 'closed') {
      this.sessions.setState(taskKey, 'closed')
    }
  }

  // Helper for tests: directly seed a live session at an arbitrary
  // non-terminal state. Mirrors what would happen after a `send()`
  // call drove the session to `queued` / `responding` / `tool_running`.
  seedLiveSession(agent: string, sessionId: string, state: 'queued' | 'planning' | 'tool_running' | 'responding' = 'tool_running'): void {
    this.sessions.setState(this.toTaskKey(agent, sessionId), state)
    this.descriptors.set(this.toInternalSessionKey(agent, sessionId), { agent, sessionId })
  }
}

// Case (a): under limit — 2 live sessions, novel id is admitted.
test('V3.5 newSession with novel id succeeds when live count is under the cap', () => {
  const subj = new SessionLimitTestSubject()
  subj.seedLiveSession('agent-A', 'sess-1', 'tool_running')
  subj.seedLiveSession('agent-A', 'sess-2', 'responding')

  // live count = 2 < 3 cap; novel sess-3 must be admitted.
  assert.doesNotThrow(() => {
    subj.newSession('agent-A', 'sess-3')
  }, 'newSession must succeed when live count (2) is below the cap (3)')

  // The new session is now tracked (terminal 'done' from newSession's
  // post-call setState). Total tracked entries grew to 3.
  assert.equal(subj.sessions.getState('agent-A::sess-3')?.state, 'done')
})

// Case (b): at limit — 3 live sessions, novel id is rejected.
test('V3.5 newSession with novel id throws session_limit_exceeded when live count is at the cap', () => {
  const subj = new SessionLimitTestSubject()
  subj.seedLiveSession('agent-A', 'sess-1', 'tool_running')
  subj.seedLiveSession('agent-A', 'sess-2', 'responding')
  subj.seedLiveSession('agent-A', 'sess-3', 'queued')

  // live count = 3 == cap; novel sess-4 must throw structured error.
  let caught: unknown = null
  try {
    subj.newSession('agent-A', 'sess-4')
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof Error, 'must throw an Error subclass')
  assert.equal(caught.message, 'session_limit_exceeded', 'error message must be the structured tag')
  const structured = caught as Error & { code?: string; maxSessions?: number; liveCount?: number }
  assert.equal(structured.code, 'SESSION_LIMIT', 'error must carry code: SESSION_LIMIT')
  assert.equal(structured.maxSessions, 3, 'error must echo the cap (3)')
  assert.equal(structured.liveCount, 3, 'error must report the live count at rejection time')

  // The rejected session must NOT have been admitted into the
  // session manager — i.e. no side effect from a failed admit.
  assert.equal(
    subj.sessions.getState('agent-A::sess-4'),
    null,
    'rejected session must not leak into the session manager',
  )
})

// Case (c): reuse — 3 live sessions, reusing existing id is allowed.
test('V3.5 newSession reusing an already-tracked sessionId is admitted even at the cap', () => {
  const subj = new SessionLimitTestSubject()
  subj.seedLiveSession('agent-A', 'sess-1', 'tool_running')
  subj.seedLiveSession('agent-A', 'sess-2', 'responding')
  subj.seedLiveSession('agent-A', 'sess-3', 'queued')

  // live count = 3 == cap; reusing sess-2 is NOT a new admission, so
  // the guard must bypass even though we are at the cap.
  assert.doesNotThrow(() => {
    subj.newSession('agent-A', 'sess-2')
  }, 'reusing an existing sessionId must bypass the limit (not a new session)')

  // After reset, sess-2 is now 'done' (newSession's post-call
  // setState). sess-1 and sess-3 are unchanged.
  assert.equal(subj.sessions.getState('agent-A::sess-2')?.state, 'done')
  assert.equal(subj.sessions.getState('agent-A::sess-1')?.state, 'tool_running')
  assert.equal(subj.sessions.getState('agent-A::sess-3')?.state, 'queued')
})

// Case (d): after close — count drops, novel id is admitted again.
test('V3.5 newSession with novel id succeeds after one of three live sessions is closed', () => {
  const subj = new SessionLimitTestSubject()
  subj.seedLiveSession('agent-A', 'sess-1', 'tool_running')
  subj.seedLiveSession('agent-A', 'sess-2', 'responding')
  subj.seedLiveSession('agent-A', 'sess-3', 'queued')

  // Sanity: at the cap to start.
  assert.throws(
    () => subj.newSession('agent-A', 'sess-4-pre-close'),
    /session_limit_exceeded/,
    'baseline — at-cap rejection still in force',
  )

  // Close one — drops live count from 3 to 2.
  subj.closeSession('agent-A', 'sess-2')
  assert.equal(subj.sessions.getState('agent-A::sess-2')?.state, 'closed', 'closed session marked terminal')

  // Now a NEW novel id is admitted because the closed session no
  // longer counts as live (terminal state filtered out by guard).
  assert.doesNotThrow(() => {
    subj.newSession('agent-A', 'sess-4-post-close')
  }, 'novel session must be admitted after closing one live session drops count below the cap')

  assert.equal(subj.sessions.getState('agent-A::sess-4-post-close')?.state, 'done')
})

// Paired structural gate: lock the production guard to its 3-cap
// structure so the stand-in cannot silently drift away from the
// orchestrator. Behavior is proven against the stand-in above; this
// just prevents a future edit from quietly removing the cap.
test('V3.5 orchestrator source declares MAX_CONCURRENT_SESSIONS cap + countLiveSessions guard', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage V §0.7 paired structural gate: lock the V3.5 main-side cap to its 3-cap + terminal-state filter shape. Behavior is proven above against a faithful stand-in; this guards drift on the production guard (cap value, terminal set, send/newSession call sites).
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/main/modules/agent-control/runtime-core/orchestrator.ts'),
    'utf8',
  )

  // Cap declared as a static readonly = 3.
  assert.match(
    source,
    /private static readonly MAX_CONCURRENT_SESSIONS\s*=\s*3/,
    'MAX_CONCURRENT_SESSIONS must be a private static readonly with value 3',
  )

  // countLiveSessions present and backed by listStatesEnriched + terminal filter.
  assert.match(source, /private countLiveSessions\(\): number/, 'countLiveSessions helper must exist')
  assert.match(source, /this\.sessions\.listStatesEnriched\(\)/, 'countLiveSessions must consume listStatesEnriched')
  for (const terminal of ["'done'", "'failed'", "'cancelled'", "'closed'"]) {
    assert.ok(
      source.includes(`snap.state !== ${terminal}`),
      `countLiveSessions must exclude terminal state ${terminal}`,
    )
  }

  // Structured error carries code + maxSessions.
  assert.match(source, /code:\s*'SESSION_LIMIT'/, 'structured error must carry code: SESSION_LIMIT')
  assert.match(source, /maxSessions:\s*number/, 'structured error must carry maxSessions field')
  assert.match(source, /new Error\('session_limit_exceeded'\)/, 'error message must be the structured tag')

  // Both call sites enforce the cap.
  const sendGuard = /async send\([\s\S]*?if \(!this\.isKnownSession\(agent, effectiveSessionId\)\)[\s\S]*?MAX_CONCURRENT_SESSIONS[\s\S]*?throw this\.buildSessionLimitError\(live\)/
  assert.match(source, sendGuard, 'send() must guard novel sessions against the cap')

  const newSessionGuard = /newSession\(agent: string, sessionId\?: string\)[\s\S]*?if \(!this\.isKnownSession\(agent, sessionId\)\)[\s\S]*?MAX_CONCURRENT_SESSIONS[\s\S]*?throw this\.buildSessionLimitError\(live\)/
  assert.match(source, newSessionGuard, 'newSession() must guard novel sessions against the cap')
})

// Paired structural gate for the IPC surfacing — confirm the
// agent-lifecycle-group catches the structured error and echoes it
// as `{ success: false, error: 'session_limit_exceeded', code:
// 'SESSION_LIMIT', maxSessions: 3 }` in the IPCResponse.
test('V3.5 agent-lifecycle-group surfaces session_limit_exceeded with structured IPC response', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage V §0.7 paired structural gate: lock the IPC echo shape ({ success: false, error: 'session_limit_exceeded', code: 'SESSION_LIMIT', maxSessions }) so the renderer can pattern-match on `code` without parsing `error`.
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts'),
    'utf8',
  )

  assert.match(source, /isSessionLimitError/, 'narrow predicate must exist')
  assert.match(
    source,
    /error\.message === 'session_limit_exceeded'/,
    'predicate must check the structured message tag',
  )
  assert.match(
    source,
    /error:\s*'session_limit_exceeded'/,
    'IPC response must echo error: session_limit_exceeded',
  )
  assert.match(source, /code:\s*'SESSION_LIMIT'/, 'IPC response must echo code: SESSION_LIMIT')
  assert.match(
    source,
    /maxSessions:\s*error\.maxSessions/,
    'IPC response must echo maxSessions from the structured error',
  )
})
