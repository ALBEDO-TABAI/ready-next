import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createDeliveryEvidenceIssuer } from '../main/modules/agent-control/quality/delivery-evidence-issuer'
import { validateDeliveryEvidenceHandle } from '../main/modules/agent-control/quality/delivery-evidence-validator'
import { listUnsettledRequiredPackageIds, settleDeliveryFailure } from '../main/modules/agent-control/quality/delivery-settlement'

const digest = createHash('sha256').update('artifact bytes').digest('hex')
const issuer = createDeliveryEvidenceIssuer({
  secret: 'test-host-secret',
  now: () => new Date('2026-07-11T00:00:00.000Z'),
  idFactory: () => 'ev-1',
})

test('host-issued evidence preserves provenance and validates for its reachable child resource', () => {
  const handle = issuer.issue({
    childTaskId: 'child-a',
    canonicalRef: 'artifact:result-a',
    kind: 'artifact',
    digest,
    previewLocator: 'artifact:result-a#bytes=0-200',
  })
  assert.equal(validateDeliveryEvidenceHandle({
    handle,
    expectedChildTaskId: 'child-a',
    issuer,
    isCanonicalRefReachable: (ref) => ref === 'artifact:result-a',
  }), handle)
})

test('evidence validation rejects forgery, wrong-child reuse and unreachable references', () => {
  const handle = issuer.issue({
    childTaskId: 'child-a', canonicalRef: 'resource:source-a', kind: 'resource', digest, previewLocator: 'resource:source-a#excerpt=0',
  })
  assert.throws(() => validateDeliveryEvidenceHandle({
    handle: { ...handle, digest: createHash('sha256').update('tampered').digest('hex') },
    expectedChildTaskId: 'child-a', issuer, isCanonicalRefReachable: () => true,
  }), /forged or mutated/)
  assert.throws(() => validateDeliveryEvidenceHandle({
    handle, expectedChildTaskId: 'child-b', issuer, isCanonicalRefReachable: () => true,
  }), /ownership mismatch/)
  assert.throws(() => validateDeliveryEvidenceHandle({
    handle, expectedChildTaskId: 'child-a', issuer, isCanonicalRefReachable: () => false,
  }), /unreachable/)
})

test('failure settlement has exactly three exits with package and plan retry caps', () => {
  assert.equal(settleDeliveryFailure({
    packageId: 'pkg-a', requested: 'redispatch', currentAttempt: 0, planRedispatchesUsed: 0,
  }).nextAttempt, 1)
  assert.throws(() => settleDeliveryFailure({
    packageId: 'pkg-a', requested: 'redispatch', currentAttempt: 1, planRedispatchesUsed: 0,
  }), /attempt cap/)
  assert.throws(() => settleDeliveryFailure({
    packageId: 'pkg-b', requested: 'redispatch', currentAttempt: 0, planRedispatchesUsed: 1,
  }), /plan redispatch cap/)
  assert.throws(() => settleDeliveryFailure({
    packageId: 'pkg-a', requested: 'degrade', currentAttempt: 0, planRedispatchesUsed: 0,
  }), /explicit reason/)
  assert.equal(settleDeliveryFailure({
    packageId: 'pkg-a', requested: 'block', currentAttempt: 0, planRedispatchesUsed: 0,
  }).status, 'blocked')
})

test('required package settlement gaps are detectable without treating optional work as blocking', () => {
  assert.deepEqual(listUnsettledRequiredPackageIds([
    { packageId: 'required-running', criticality: 'required', status: 'running' },
    { packageId: 'required-done', criticality: 'required', status: 'completed' },
    { packageId: 'required-degraded', criticality: 'required', status: 'degraded' },
    { packageId: 'optional-running', criticality: 'optional', status: 'running' },
  ]), ['required-running'])
})
