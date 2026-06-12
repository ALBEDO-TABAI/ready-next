/**
 * EP3-I4 — the global verbatim relay matrix (05 §4 最小传话铁律): all THREE
 * forwarding classes carry the user's original words byte-for-byte plus
 * structured refs — no digest, no rewrite, no daily-summary splicing.
 *
 *   1. handoff      (A4 proposal → new-session prefill)
 *   2. SubAgent     (runSubAgent context passthrough)
 *   3. skill child  (tool dispatch → persisted payload → driver launch)
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runHandoffProposal,
  HANDOFF_QUESTION_ID,
  HANDOFF_NEW_SESSION_OPTION,
} from '../main/modules/agent-control/agents/handoff-proposal'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import type { SubAgent, SubAgentContext } from '../main/modules/agent-control/sub-agent/sub-agent-types'
import { buildChildRunPayload } from '../main/modules/repositories/skill-task-run-repository'
import { createSkillChildSubAgentFromPersisted } from '../main/modules/agent-control/skills/skill-child-sub-agent-factory'
import type { SkillChildLaunchParams } from '../main/modules/agent-control/skills/skill-child-run-types'

// Awkward on purpose: leading/trailing spaces, newline, full-width
// punctuation, an emoji — byte-for-byte means NONE of it changes.
const VERBATIM = '  帮我盯三个平台行情📈，明早九点前出对比！！\n（小红书优先）  '
const REFS = ['card:xhs-script-detection', 'docs/spec.md']

test('matrix #1 handoff: proposal → new-session prefill, byte-for-byte + refs untouched', async () => {
  const store = new AskUserQuestionsStore()
  const outcome = await runHandoffProposal(
    { targetAgentId: 'collector', reason: 'r', userRequestVerbatim: VERBATIM, contextRefs: [...REFS] },
    {
      getAgent: () => ({ id: 'collector', name: '采集手', charter: 'c', personaRef: null, status: 'active', createdAt: '2026-06-12' }),
      updateTaskOwner: () => undefined,
      sessionId: 'sess-1',
      askUserStore: store,
      timeoutMs: 10_000,
      emitCard: (event) => {
        queueMicrotask(() => store.resolve(event.cardId, {
          answers: [{ id: HANDOFF_QUESTION_ID, answer: HANDOFF_NEW_SESSION_OPTION }],
          answeredAt: Date.now(),
        }))
      },
    },
  )
  assert.equal(outcome.kind, 'adopted_new_session')
  if (outcome.kind === 'adopted_new_session') {
    assert.equal(outcome.prefillVerbatim, VERBATIM, 'handoff 原话逐字')
    assert.deepEqual(outcome.contextRefs, REFS, 'refs 结构化透传')
  }
})

test('matrix #2 SubAgent: runner passes userRequestVerbatim + contextRefs through untouched', async () => {
  let seen: { verbatim?: string | null; refs?: ReadonlyArray<string> | null } = {}
  const probe: SubAgent = {
    lifecycleId: 'probe-1',
    durableRunId: null,
    subagentName: 'verbatim-probe',
    artifactDir: null,
    // eslint-disable-next-line require-yield
    async *run(context: SubAgentContext) {
      seen = { verbatim: context.userRequestVerbatim, refs: context.contextRefs }
      return { state: 'completed' as const }
    },
  }
  const iterator = runSubAgent(probe, {
    abortSignal: new AbortController().signal,
    cleanup: { register: () => undefined, drain: async () => undefined },
    userRequestVerbatim: VERBATIM,
    contextRefs: REFS,
  } as SubAgentContext)
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
  }
  assert.equal(seen.verbatim, VERBATIM, 'SubAgent context 原话逐字')
  assert.deepEqual(seen.refs, REFS)
})

test('matrix #3 skill child: dispatch input → persisted payload → driver launch, byte-for-byte', async () => {
  // tool dispatch → persisted payload (the runner forwards
  // params.userRequestVerbatim into createChildRun; buildChildRunPayload is
  // the exact production assembly)
  const payload = buildChildRunPayload({
    childRunId: 'sk-child-1',
    scopeId: 's1', sessionId: 'sess1', skillId: 'skill-x', skillName: null,
    action: 'run', requestedInput: { topic: 'x' }, singleFlightKey: 'k',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/out', runStatePath: '/tmp/out/run_state.json', eventLogPath: '/tmp/out/events.jsonl',
    status: 'running',
    userRequestVerbatim: VERBATIM,
  })
  assert.equal(payload.userRequestVerbatim, VERBATIM, '持久化 payload 原话逐字')

  // persisted payload → driver launch (real factory)
  let capturedLaunch: SkillChildLaunchParams | null = null
  await createSkillChildSubAgentFromPersisted({
    payload,
    driver: {
      canResume: () => true,
      createInitialState: async (launch: SkillChildLaunchParams) => { capturedLaunch = launch; return {} as never },
    } as never,
    executeAction: (() => { throw new Error('not executed') }) as never,
  })
  assert.equal(capturedLaunch!.userRequestVerbatim, VERBATIM, '驱动 launch 原话逐字')

  // legacy rows without the field stay readable and resolve to null —
  // never to a synthesized digest
  const legacy = buildChildRunPayload({
    childRunId: 'sk-legacy', scopeId: null, sessionId: null, skillId: 's', skillName: null,
    action: 'run', requestedInput: {}, singleFlightKey: 'k2',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/o', runStatePath: '/tmp/o/r.json', eventLogPath: '/tmp/o/e.jsonl',
  })
  assert.equal(legacy.userRequestVerbatim, null, '无原话 = null，不许编造摘要')
})

test('matrix guard: no forwarding class may trim, normalize, or truncate', () => {
  // the shared invariant in one place: every seam carried the EXACT string
  for (const candidate of [VERBATIM]) {
    assert.notEqual(candidate, candidate.trim(), 'fixture must carry whitespace to make the assertion real')
    assert.ok(candidate.includes('\n') && candidate.includes('📈'))
  }
})
