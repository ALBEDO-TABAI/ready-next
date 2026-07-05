/**
 * Stage V V3.1 — ReadyAgentOrchestrator.closeSession() behavior.
 *
 * Locks the `(agent, sessionId)` close contract:
 *   1. Returns `{ closed: true }` only when the session existed in the
 *      session manager beforehand; subsequent calls (idempotent) return
 *      `{ closed: false }`.
 *   2. Targets the correct composite key — closing `(agent-A, sess-1)`
 *      must not touch `(agent-A, sess-2)` or `(agent-B, sess-1)`.
 *   3. After close, the targeted composite key is marked `'closed'`
 *      (terminal — V3.3d `isLiveSession` excludes it).
 *   4. Other session entries remain unchanged.
 *
 * As with `orchestrator-list-all-sessions.test.ts`, we cannot
 * instantiate the real `ReadyAgentOrchestrator` under `node --test`
 * (electron-only imports). Per CLAUDE.md §6 "minimal stand-in", we
 * mirror the close logic against the real `AgentSessionManager`, then
 * source-grep the orchestrator to lock the production close sequence.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.1
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentSessionManager } from '../main/modules/agent-control/session/session-manager'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function toTaskKey(agent: string, sessionId?: string): string {
  return sessionId ? `${agent}::${sessionId}` : agent
}

/**
 * Local test double that mirrors `ReadyAgentOrchestrator.closeSession()`
 * for the slice of behavior we can exercise under Node. It calls into
 * the real `AgentSessionManager` (which is what the orchestrator
 * delegates to) plus minimal stubs for the engine `stopGeneration`
 * cleanup so we can assert the cleanup contract end-to-end.
 *
 * Engine `stopGeneration` stubs simply record the composite key they
 * were called with (same signature as the real
 * `AgentSdkRuntime.stopGeneration` / `DirectChatEngine.stopGeneration`,
 * both `(name: string) => void`).
 */
class CloseSessionTestSubject {
  readonly sessions = new AgentSessionManager()
  readonly domainAdapterStops: string[] = []
  readonly sdkStops: string[] = []
  readonly drainedRunIds: string[] = []
  readonly activeRunIds = new Map<string, string>()
  readonly descriptors = new Map<string, { agent: string; sessionId?: string }>()

  private readonly domainAdapterEngine = {
    stopGeneration: (name: string): void => {
      this.domainAdapterStops.push(name)
    },
  }

  private readonly sdkEngine = {
    stopGeneration: (name: string): void => {
      this.sdkStops.push(name)
    },
  }

  private toInternalSessionKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private toTaskKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private async drainRunCleanup(runId: string): Promise<void> {
    this.drainedRunIds.push(runId)
  }

  // Mirror of `ReadyAgentOrchestrator.closeSession()`.
  async closeSession(agent: string, sessionId?: string): Promise<{ closed: boolean }> {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    const taskKey = this.toTaskKey(agent, sessionId)
    const prior = this.sessions.getState(taskKey)
    const wasLive = !!prior && prior.state !== 'closed'
    try {
      this.domainAdapterEngine.stopGeneration(internalKey)
    } catch {
      // ignore in test double
    }
    try {
      this.sdkEngine.stopGeneration(internalKey)
    } catch {
      // ignore in test double
    }
    this.descriptors.delete(internalKey)
    const runId = this.activeRunIds.get(taskKey)
    if (runId) {
      this.activeRunIds.delete(taskKey)
      void this.drainRunCleanup(runId)
    }
    if (wasLive) {
      this.sessions.setState(taskKey, 'closed')
    }
    return { closed: wasLive }
  }
}

test('V3.1 closeSession returns { closed: true } when session existed, { closed: false } on idempotent re-call', async () => {
  const subj = new CloseSessionTestSubject()
  subj.sessions.setState(toTaskKey('agent-A', 'sess-1'), 'tool_running')
  subj.descriptors.set('agent-A::sess-1', { agent: 'agent-A', sessionId: 'sess-1' })

  const first = await subj.closeSession('agent-A', 'sess-1')
  assert.deepEqual(first, { closed: true }, 'first close must report closed: true')

  const second = await subj.closeSession('agent-A', 'sess-1')
  assert.deepEqual(second, { closed: false }, 'second close must report closed: false (idempotent)')

  const third = await subj.closeSession('agent-A', 'never-existed')
  assert.deepEqual(third, { closed: false }, 'close on unknown key must report closed: false')
})

test('V3.1 closeSession targets only the requested composite key', async () => {
  const subj = new CloseSessionTestSubject()
  subj.sessions.setState(toTaskKey('agent-A', 'sess-1'), 'tool_running')
  subj.sessions.setState(toTaskKey('agent-A', 'sess-2'), 'queued')
  subj.sessions.setState(toTaskKey('agent-B', 'sess-1'), 'responding')

  const result = await subj.closeSession('agent-A', 'sess-1')
  assert.equal(result.closed, true)

  // Closed session is marked 'closed' (terminal).
  assert.equal(subj.sessions.getState('agent-A::sess-1')!.state, 'closed')
  // Sibling session under the same agent is untouched.
  assert.equal(subj.sessions.getState('agent-A::sess-2')!.state, 'queued')
  // Cross-agent session with the same `sessionId` value is untouched.
  assert.equal(subj.sessions.getState('agent-B::sess-1')!.state, 'responding')

  // Engine cleanups targeted the composite key, not the bare agent name.
  assert.deepEqual(subj.domainAdapterStops, ['agent-A::sess-1'])
  assert.deepEqual(subj.sdkStops, ['agent-A::sess-1'])
})

test('V3.1 closeSession with no sessionId targets the legacy bare-key entry', async () => {
  const subj = new CloseSessionTestSubject()
  subj.sessions.setState('legacy-agent', 'done')
  subj.sessions.setState(toTaskKey('legacy-agent', 'sess-1'), 'queued')

  const result = await subj.closeSession('legacy-agent')
  assert.equal(result.closed, true)
  // Bare key marked closed, composite key untouched.
  assert.equal(subj.sessions.getState('legacy-agent')!.state, 'closed')
  assert.equal(subj.sessions.getState('legacy-agent::sess-1')!.state, 'queued')
  // Engine cleanups used the bare key.
  assert.deepEqual(subj.domainAdapterStops, ['legacy-agent'])
  assert.deepEqual(subj.sdkStops, ['legacy-agent'])
})

test('V3.1 closeSession drains active run cleanup if a runId is tracked at close time', async () => {
  const subj = new CloseSessionTestSubject()
  subj.sessions.setState(toTaskKey('agent-A', 'sess-1'), 'tool_running')
  subj.activeRunIds.set('agent-A::sess-1', 'run-xyz')

  await subj.closeSession('agent-A', 'sess-1')

  assert.equal(
    subj.activeRunIds.has('agent-A::sess-1'),
    false,
    'closeSession must clear the activeRunIds entry for the composite key',
  )
  assert.deepEqual(
    subj.drainedRunIds,
    ['run-xyz'],
    'closeSession must drain the in-flight run-id when one is tracked',
  )
})

test('V3.1 closeSession clears the descriptor cache for the composite key', async () => {
  const subj = new CloseSessionTestSubject()
  subj.sessions.setState(toTaskKey('agent-A', 'sess-1'), 'tool_running')
  subj.descriptors.set('agent-A::sess-1', { agent: 'agent-A', sessionId: 'sess-1' })
  subj.descriptors.set('agent-B::sess-1', { agent: 'agent-B', sessionId: 'sess-1' })

  await subj.closeSession('agent-A', 'sess-1')

  assert.equal(
    subj.descriptors.has('agent-A::sess-1'),
    false,
    'descriptor for the closed composite key must be removed',
  )
  assert.equal(
    subj.descriptors.has('agent-B::sess-1'),
    true,
    'descriptor for an unrelated key must be preserved',
  )
})

test('V3.1 orchestrator source declares closeSession with correct cleanup sequence', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage V §0.7 paired structural gate: lock the production closeSession to its 4-step cleanup sequence. Behavior is proven above against a faithful test double; this guards drift.
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/main/modules/agent-control/runtime-core/orchestrator.ts'),
    'utf8',
  )

  // Method signature.
  assert.match(
    source,
    /async closeSession\(agent: string, sessionId\?: string\)\s*:\s*Promise<\{\s*closed:\s*boolean\s*\}>/,
    'closeSession signature must take (agent, sessionId?) and return Promise<{ closed: boolean }>',
  )

  // Cleanup sequence presence.
  // 合同随实现同步（Phase C C3，2026-07-05）：域引擎停线随退役删除；
  // sdk 钉修到带 initiator 的真实调用形态（此钉在 HEAD 就因 initiator
  // 签名演进而红——本次一并归位，不变量=关会话必须停 SDK 活跑）。
  assert.match(source, /this\.sdkEngine\.stopGeneration\(internalKey, 'process_exit'\)/, 'must stop sdk engine generation on close')
  assert.match(source, /this\.descriptors\.delete\(internalKey\)/, 'must drop descriptor cache entry')
  assert.match(source, /this\.sessions\.setState\(taskKey,\s*'closed'\)/, 'must mark session state closed')

  // Idempotent return tied to prior state lookup (live vs. already-closed).
  assert.match(source, /this\.sessions\.getState\(taskKey\)/, 'must consult prior state for idempotency')
  assert.match(source, /!!prior && prior\.state !== 'closed'/, 'must treat already-`closed` state as a no-op')
  assert.match(source, /return\s*\{\s*closed:\s*wasLive\s*\}/, 'return value must reflect whether this call performed the close')
})

test('orchestrator compactSession maps public agent/sessionId before delegating to the SDK runtime', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- paired with agent-lifecycle handler behavior; the real orchestrator imports electron-only runtime deps under node tests
  const source = readFileSync(
    resolve(REPO_ROOT, 'src/main/modules/agent-control/runtime-core/orchestrator.ts'),
    'utf8',
  )

  assert.match(
    source,
    /async compactSession\(agent: string, sessionId\?: string\)/,
    'compactSession must be public on the orchestrator',
  )
  assert.match(
    source,
    /const internalKey = this\.toInternalSessionKey\(agent, sessionId\)/,
    'compactSession must map the public tuple inside the orchestrator',
  )
  assert.match(
    source,
    /compact\.call\(this\.sdkEngine, internalKey, 'manual'\)/,
    'compactSession must delegate with the internal key rather than making IPC compose it',
  )
})
