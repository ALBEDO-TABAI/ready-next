/**
 * EP3-PK4 — child-failure three-way settlement (redispatch ≤1 / degrade
 * with reason / block module_waiting), silent swallow = red, the Matrix
 * upstream report contract, and the parent CheckIn landing through the
 * SAME Q4a shadow adjudication channel as ordinary tasks.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  settleChildFailure,
  buildParentPacketAdjudication,
  validateUpstreamReport,
  REDISPATCH_RETRY_CAP,
  UPSTREAM_SUMMARY_MAX_LINES,
  type ChildPacketOutcome,
  type PacketUpstreamReport,
} from '../main/modules/agent-control/quality/packet-failure'
import { appendCheckIns } from '../main/modules/agent-control/quality/task-adjudicator'

const NOW = new Date('2026-06-12T12:00:00.000Z')

const report = (over: Partial<PacketUpstreamReport> = {}): PacketUpstreamReport => ({
  summaryLines: ['采集完成 120 条', '高赞集中在穿搭话题'],
  artifactRefs: ['/out/collect-1/result.json'],
  openQuestions: [],
  ...over,
})

const completedChild = (id: string): ChildPacketOutcome =>
  ({ childTaskId: id, title: `子包${id}`, state: 'completed', report: report() })

const failedChild = (id: string): ChildPacketOutcome =>
  ({ childTaskId: id, title: `子包${id}`, state: 'failed', failure: { kind: 'collection_failed', message: '0 条' } })

test('three-way settlement: redispatch capped at 1, degrade needs a reason, block is module_waiting', () => {
  assert.equal(settleChildFailure({ childTaskId: 'c1', requested: 'redispatch', retriesUsed: 0 }).action, 'redispatch')
  assert.throws(
    () => settleChildFailure({ childTaskId: 'c1', requested: 'redispatch', retriesUsed: REDISPATCH_RETRY_CAP }),
    /cap.*exhausted.*降级或阻塞/,
    '重派上限 1 次',
  )
  assert.throws(
    () => settleChildFailure({ childTaskId: 'c1', requested: 'degrade', retriesUsed: 0 }),
    /reason.*静默吞|降级不写理由/,
    '降级必须写 not_applicable 理由',
  )
  const degraded = settleChildFailure({ childTaskId: 'c1', requested: 'degrade', retriesUsed: 1, degradeReason: '站点风控' })
  assert.equal(degraded.notApplicableReason, '站点风控')
  const blocked = settleChildFailure({ childTaskId: 'c1', requested: 'block', retriesUsed: 1 })
  assert.equal(blocked.blockerCategory, 'module_waiting')
  assert.throws(() => settleChildFailure({ childTaskId: 'c1', requested: 'vanish' as never, retriesUsed: 0 }), /unknown settlement/)
})

test('silent swallow is RED: a failed child without a settlement throws the aggregation', () => {
  assert.throws(
    () => buildParentPacketAdjudication({
      parentTaskId: 'p1', now: NOW,
      children: [completedChild('c1'), failedChild('c2')],
      settlements: [],
    }),
    /静默吞|NO settlement/,
  )
})

test('degrade path: gap declared in open questions (c3), parent still adjudicates done', () => {
  const result = buildParentPacketAdjudication({
    parentTaskId: 'p1', now: NOW,
    children: [completedChild('c1'), failedChild('c2')],
    settlements: [settleChildFailure({ childTaskId: 'c2', requested: 'degrade', retriesUsed: 1, degradeReason: '站点风控，本轮放弃' })],
  })
  assert.equal(result.checkIn.terminalStatus, 'done')
  assert.ok(result.openQuestions.some((entry) => entry.includes('降级') && entry.includes('站点风控')), 'c3 声明缺口')
  assert.ok(result.proofs.some((proof) => proof.kind === 'task_event' && proof.ref.includes('degraded')))
})

test('block path: parent goes blocked/module_waiting and waits for the user', () => {
  const result = buildParentPacketAdjudication({
    parentTaskId: 'p1', now: NOW,
    children: [completedChild('c1'), failedChild('c2')],
    settlements: [settleChildFailure({ childTaskId: 'c2', requested: 'block', retriesUsed: 1 })],
  })
  assert.equal(result.checkIn.terminalStatus, 'blocked')
  assert.equal(result.checkIn.terminalReason, 'module_waiting')
  assert.ok(result.openQuestions.some((entry) => entry.includes('阻塞等待用户')))
})

test('redispatch path: parent stays open (blocked on pending retry), nothing is swallowed', () => {
  const result = buildParentPacketAdjudication({
    parentTaskId: 'p1', now: NOW,
    children: [completedChild('c1'), failedChild('c2')],
    settlements: [settleChildFailure({ childTaskId: 'c2', requested: 'redispatch', retriesUsed: 0 })],
  })
  assert.equal(result.checkIn.terminalStatus, 'blocked')
  assert.equal(result.checkIn.terminalReason, 'child_redispatch_pending')
})

test('upstream report contract: ≤5 summary lines, refs not retellings, full-text dumping rejected', () => {
  assert.doesNotThrow(() => validateUpstreamReport(report()))
  assert.throws(
    () => validateUpstreamReport(report({ summaryLines: Array.from({ length: UPSTREAM_SUMMARY_MAX_LINES + 1 }, () => '行') })),
    /5 lines|摘要不是正文/,
  )
  assert.throws(() => validateUpstreamReport(report({ summaryLines: ['长'.repeat(201)] })), /全文塞回/)
  assert.throws(() => validateUpstreamReport(report({ artifactRefs: ['引'.repeat(301)] })), /short path/)
  assert.throws(
    () => buildParentPacketAdjudication({
      parentTaskId: 'p1', now: NOW,
      children: [{ childTaskId: 'c1', title: '子包', state: 'completed', report: null }],
      settlements: [],
    }),
    /no upstream report/,
    '完成的子包没报告同样是红',
  )
})

test('parent CheckIn lands through the SHARED Q4a shadow channel and appends like any task', () => {
  const result = buildParentPacketAdjudication({
    parentTaskId: 'p1', now: NOW,
    children: [completedChild('c1'), completedChild('c2')],
    settlements: [],
  })
  assert.equal(result.checkIn.kind, 'shadow', '不碰终态——enforce 随 Q4b 自动升级')
  assert.equal(result.checkIn.terminalStatus, 'done')
  assert.ok(result.checkIn.proofCount >= 2, '子包报告与产物引用成为父包 proofs')
  assert.equal(result.verdict, result.checkIn.verdict)
  // c1 child reports satisfy steps_complete via task_event; c2 artifact refs
  // satisfy the artifact criterion — the aggregation template adjudicates
  // through CRITERIA_PROOF_MAP with no special path.
  const merged = appendCheckIns([], result.checkIn)
  assert.equal((merged as unknown[]).length, 1, '落账走 appendCheckIns 同一治理（limit 50 + archive）')
})
