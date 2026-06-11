/**
 * EP2-Q3 — five proof sources, rolling governance, response digest semantics,
 * and the bridge listener. The finalizer ordering (digest proof lands before
 * the verdict) is asserted in Q4a's run-finalizer-checkin tests; here we
 * prove the collector primitives those tests build on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectToolResultProof,
  collectArtifactProof,
  collectTaskEventProof,
  collectRunStateProof,
  collectResponseDigestProof,
  appendProofRefs,
  isValidProofRef,
  createTaskProofSink,
  createTaskEventProofListener,
  type ProofRef,
} from '../main/modules/agent-control/quality/proof-collector'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')

test('each of the five sources produces a structurally valid proof row', () => {
  const proofs = [
    collectToolResultProof('web_search', 'results=3', NOW),
    collectArtifactProof('outputs/report.md', NOW),
    collectTaskEventProof({ taskId: 'task-1', status: 'completed' }, NOW),
    collectRunStateProof('outputs/run_state.json', NOW),
    collectResponseDigestProof('这是最终回复全文，应当只存摘要与哈希。', NOW),
  ]
  const kinds = proofs.map((row) => row && row.kind)
  assert.deepEqual(kinds, ['tool_result', 'artifact', 'task_event', 'run_state', 'assistant_response'])
  for (const row of proofs) {
    assert.ok(row && isValidProofRef(row), `${row?.kind} row must validate`)
    assert.equal(row!.ts, NOW.toISOString())
  }
})

test('response digest: sha256 + truncated excerpt, never the full text; empty reply yields null', () => {
  const long = '答'.repeat(500)
  const row = collectResponseDigestProof(long, NOW)
  assert.ok(row)
  assert.equal(row!.ref.length, 120, 'excerpt truncated to 120 chars')
  assert.match(row!.digest, /^[0-9a-f]{64}$/)
  assert.equal(collectResponseDigestProof('', NOW), null)
  assert.equal(collectResponseDigestProof('   \n', NOW), null)
  assert.equal(collectResponseDigestProof(null, NOW), null)
})

test('appendProofRefs: malformed additions rejected loudly; overflow rolls oldest into the archive', () => {
  assert.throws(
    () => appendProofRefs([], [{ kind: 'tool_result', ref: '', ts: 'bad', digest: 'nope' } as ProofRef]),
    /malformed proof ref/,
  )

  const mk = (i: number) => collectToolResultProof(`tool_${i}`, String(i), NOW)
  const archived: ProofRef[][] = []
  let rows: ProofRef[] = []
  for (let i = 0; i < 7; i += 1) {
    rows = appendProofRefs(rows, [mk(i)], { limit: 5, archive: (overflow) => archived.push(overflow) })
  }
  assert.equal(rows.length, 5, 'kept at the limit')
  assert.equal(rows[0].ref, 'tool_2', 'newest survive, oldest rolled')
  assert.deepEqual(archived.flat().map((row) => row.ref), ['tool_0', 'tool_1'])
})

test('store sink appends through the repository path and never throws into the caller', () => {
  const records = new Map<string, { proofRefs?: unknown[] }>()
  records.set('task-1', { proofRefs: [] })
  const sink = createTaskProofSink({
    get: (taskId) => (records.get(taskId) ?? null) as never,
    update: (taskId, patch) => {
      records.set(taskId, { ...records.get(taskId)!, ...patch as object })
    },
  })
  assert.equal(sink.append('task-1', [collectArtifactProof('a.md', NOW)]), true)
  assert.equal((records.get('task-1')!.proofRefs as ProofRef[]).length, 1)
  assert.equal(sink.append('missing-task', [collectArtifactProof('a.md', NOW)]), false)
  assert.equal(sink.append(null, [collectArtifactProof('a.md', NOW)]), false)

  // a throwing store degrades to a metric, not an exception
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const broken = createTaskProofSink({
      get: () => { throw new Error('db gone') },
      update: () => {},
    })
    assert.equal(broken.append('task-1', [collectArtifactProof('a.md', NOW)]), false)
    assert.ok(events.some((event) => event.metric === 'proof_collect_failed'))
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('bridge listener turns terminal task events into task_event proofs (additive, bridge untouched)', () => {
  const records = new Map<string, { proofRefs?: unknown[] }>()
  records.set('task-9', { proofRefs: [] })
  const sink = createTaskProofSink({
    get: (taskId) => (records.get(taskId) ?? null) as never,
    update: (taskId, patch) => { records.set(taskId, { ...records.get(taskId)!, ...patch as object }) },
  })
  const listener = createTaskEventProofListener(sink, () => NOW)
  listener({ taskId: 'task-9', status: 'completed' })
  const rows = records.get('task-9')!.proofRefs as ProofRef[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'task_event')
  assert.equal(rows[0].ref, 'task-9|completed')
})
