/**
 * Stage V V3.1 — ReadyAgentOrchestrator.listAllSessions() session listing.
 *
 * The production `listAllSessions()` is a pure transform over
 * `AgentSessionManager.listStatesEnriched()`. We cannot instantiate the
 * real `ReadyAgentOrchestrator` under `node --test` because its
 * constructor pulls in `DirectChatEngine` which transitively imports
 * the `electron` runtime module — Node cannot resolve the renderer
 * exports (`BrowserWindow`, `dialog`, …) outside Electron.
 *
 * Strategy (CLAUDE.md §6 "minimal stand-in"):
 *   - Drive the underlying `AgentSessionManager` directly with
 *     production composite keys (`agent::sessionId` form, identical to
 *     `ReadyAgentOrchestrator.toTaskKey()`).
 *   - Apply the exact transform the orchestrator method declares,
 *     mirroring `listAllSessions()`'s source verbatim.
 *   - Assert the resulting `SessionSummary[]` shape matches what an
 *     IPC consumer / renderer tab UI would see.
 *
 * To keep the test honest (i.e. detect drift if the production
 * transform changes), we *also* source-grep the orchestrator to lock
 * the listAllSessions implementation to the descriptor-based map.
 * Paired structural gate per CLAUDE.md §6.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.1
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentSessionManager,
  parseSessionKey,
  type AgentTaskSnapshotEnriched,
} from '../main/modules/agent-control/session/session-manager'
import type { AgentTaskState } from '../main/modules/agent-control/contracts/types'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Mirror of the orchestrator's composite key composer
// (`runtime-core/orchestrator.ts::toTaskKey`).
function toTaskKey(agent: string, sessionId?: string): string {
  return sessionId ? `${agent}::${sessionId}` : agent
}

// Mirror of the orchestrator's listAllSessions() body. If the production
// implementation diverges, the source-grep below catches it.
interface SessionSummary {
  agent: string
  sessionId: string | null
  state: AgentTaskState
  lastTurnAt: string
  error?: string
}

function listAllSessionsLikeOrchestrator(sm: AgentSessionManager): SessionSummary[] {
  return sm.listStatesEnriched().map((snap: AgentTaskSnapshotEnriched) => ({
    agent: snap.descriptor.agent,
    sessionId: snap.descriptor.sessionId,
    state: snap.state,
    lastTurnAt: snap.updatedAt,
    error: snap.error,
  }))
}

test('V3.1 listAllSessions returns descriptors for multi-(agent, sessionId) state', async () => {
  const sm = new AgentSessionManager()
  // Two agents, two sessions each, plus one legacy bare-key agent.
  sm.setState(toTaskKey('agent-A', 'sess-1'), 'queued')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState(toTaskKey('agent-A', 'sess-2'), 'tool_running')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState(toTaskKey('agent-B', 'sess-1'), 'responding')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState(toTaskKey('agent-B', 'sess-2'), 'done')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState('legacy-agent', 'done')

  const summaries = listAllSessionsLikeOrchestrator(sm)
  assert.equal(summaries.length, 5)

  // All five sessions must be addressable by their (agent, sessionId)
  // tuple — never by raw composite. Construct a lookup keyed by tuple.
  const byTuple = new Map<string, SessionSummary>()
  for (const s of summaries) {
    const k = `${s.agent}|${s.sessionId ?? '<null>'}`
    assert.equal(byTuple.has(k), false, `duplicate tuple emitted for ${k}`)
    byTuple.set(k, s)
  }

  // Agent-A sessions are separate.
  assert.equal(byTuple.get('agent-A|sess-1')!.state, 'queued')
  assert.equal(byTuple.get('agent-A|sess-2')!.state, 'tool_running')
  // Agent-B sessions are separate from agent-A.
  assert.equal(byTuple.get('agent-B|sess-1')!.state, 'responding')
  assert.equal(byTuple.get('agent-B|sess-2')!.state, 'done')
  // Legacy bare-key entry: descriptor sessionId must be null (the V3.1
  // fix — previously the raw composite would have been mistaken for
  // the agent id with no sessionId info available).
  assert.equal(byTuple.get('legacy-agent|<null>')!.sessionId, null)
  assert.equal(byTuple.get('legacy-agent|<null>')!.agent, 'legacy-agent')
})

test('V3.1 listAllSessions sorts most-recently-updated first', async () => {
  const sm = new AgentSessionManager()
  sm.setState(toTaskKey('agent-A', 'first'), 'queued')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState(toTaskKey('agent-A', 'second'), 'queued')
  await new Promise((r) => setTimeout(r, 5))
  sm.setState(toTaskKey('agent-A', 'third'), 'queued')

  const summaries = listAllSessionsLikeOrchestrator(sm)
  assert.equal(summaries[0].sessionId, 'third', 'most-recent (latest updatedAt) must lead')
  assert.equal(summaries[1].sessionId, 'second')
  assert.equal(summaries[2].sessionId, 'first', 'oldest must trail')
})

test('V3.1 listAllSessions includes terminal entries (caller filters via isLiveSession)', () => {
  const sm = new AgentSessionManager()
  sm.setState(toTaskKey('agent-A', 'live'), 'tool_running')
  sm.setState(toTaskKey('agent-A', 'finished'), 'done')
  sm.setState(toTaskKey('agent-A', 'killed'), 'cancelled')
  sm.setState(toTaskKey('agent-A', 'broken'), 'failed')
  sm.setState(toTaskKey('agent-A', 'shut'), 'closed')

  const summaries = listAllSessionsLikeOrchestrator(sm)
  assert.equal(summaries.length, 5, 'all 5 entries surfaced; renderer applies isLiveSession filter')
  const states = new Set(summaries.map((s) => s.state))
  for (const expected of ['tool_running', 'done', 'cancelled', 'failed', 'closed'] as const) {
    assert.ok(states.has(expected), `state ${expected} must surface from listAllSessions`)
  }
})

test('V3.1 listAllSessions error field is propagated for failed sessions', () => {
  const sm = new AgentSessionManager()
  sm.setState(toTaskKey('agent-A', 'sess-1'), 'failed', 'tool_host_unreachable')
  const summaries = listAllSessionsLikeOrchestrator(sm)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].state, 'failed')
  assert.equal(
    summaries[0].error,
    'tool_host_unreachable',
    'error string must propagate through descriptor enrichment',
  )
})

test('V3.1 descriptor parse is consistent between standalone parser and listAllSessions emission', () => {
  const sm = new AgentSessionManager()
  sm.setState(toTaskKey('agent-A', 'sess-1'), 'queued')
  sm.setState('legacy-agent', 'done')

  const summaries = listAllSessionsLikeOrchestrator(sm)
  for (const summary of summaries) {
    const composite = summary.sessionId
      ? `${summary.agent}::${summary.sessionId}`
      : summary.agent
    const reparsed = parseSessionKey(composite)
    assert.deepEqual(
      { agent: summary.agent, sessionId: summary.sessionId },
      { agent: reparsed.agent, sessionId: reparsed.sessionId },
      `summary for composite ${composite} must roundtrip cleanly through parseSessionKey`,
    )
  }
})

test('V3.1 orchestrator source declares listAllSessions backed by listStatesEnriched', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage V §0.7 paired structural gate: lock listAllSessions to the descriptor-based map. Behavior is proven above; this prevents silent divergence of the production transform.
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/main/modules/agent-control/runtime-core/orchestrator.ts'),
    'utf8',
  )
  assert.match(
    source,
    /listAllSessions\(\)\s*:\s*SessionSummary\[\]\s*\{[\s\S]*this\.sessions\.listStatesEnriched\(\)/,
    'listAllSessions must remain backed by AgentSessionManager.listStatesEnriched()',
  )
  // SessionSummary fields must match what this test asserts.
  assert.match(source, /agent:\s*snap\.descriptor\.agent/, 'agent field must come from descriptor')
  assert.match(source, /sessionId:\s*snap\.descriptor\.sessionId/, 'sessionId field must come from descriptor')
})
