import assert from 'node:assert/strict'
import test from 'node:test'

import { assertWorkerReport, parseWorkerReportJson } from '../main/modules/agent-control/quality/worker-report'

function validReport(): Record<string, unknown> {
  return {
    version: 1,
    packageId: 'pkg-a',
    attempt: 0,
    summaryLines: ['找到一项可核对事实。'],
    deliverable: { resourceRefId: 'resource:a' },
    criterionObservations: [{ criterionId: 'c1', observation: '资料中明确出现该事实。' }],
    evidenceHandles: ['ev-a'],
    unverifiedClaims: [],
    openQuestions: [],
    confidence: 'high',
  }
}

test('worker report accepts a strict bounded report and fenced JSON', () => {
  const report = validReport()
  assert.doesNotThrow(() => assertWorkerReport(report))
  assert.deepEqual(parseWorkerReportJson(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``), report)
})

test('worker report requires one to five summary lines and a deliverable', () => {
  assert.throws(() => assertWorkerReport({ ...validReport(), summaryLines: [] }), /1\.\.5/)
  assert.throws(() => assertWorkerReport({ ...validReport(), summaryLines: ['1', '2', '3', '4', '5', '6'] }), /1\.\.5/)
  assert.throws(() => assertWorkerReport({ ...validReport(), deliverable: {} }), /inline or resourceRefId/)
})

test('worker report rejects model-authored usage, proof and acceptance fields', () => {
  for (const forbidden of ['usage', 'proofRefs', 'satisfied', 'not_applicable']) {
    assert.throws(() => assertWorkerReport({ ...validReport(), [forbidden]: true }), /forbidden field/)
  }
  assert.throws(() => assertWorkerReport({
    ...validReport(),
    criterionObservations: [{ criterionId: 'c1', observation: 'ok', satisfied: true }],
  }), /forbidden field/)
})
