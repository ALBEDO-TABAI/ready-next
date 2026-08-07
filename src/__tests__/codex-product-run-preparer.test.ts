import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexProductRunPreparer,
  isPreparedCodexProductRun,
  preparedCodexProductRunMatchesIngress,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'

const preparer = new CodexProductRunPreparer()
const base = {
  taskId: 'task-1',
  runId: 'run-1',
  requestId: 'request-1',
  scopeId: 'scope-1',
  aliasId: 'alias-1',
  aliasGeneration: 1,
  taskOrigin: 'user_root',
  runOrigin: 'initial',
  originUserMessageId: 'message-1',
  reservationSetId: 'reservation-set-1',
  reservationEvidenceDigest: 'reservation-evidence-1',
  currentInput: [textUserInput('hello')],
  explicitResourceEnvelope: { input: [], resourceRefs: [] },
  resourceAdditionalContext: [],
  readyToolSurface: {
    surfaceId: 'surface-1',
    toolSurfaceDigest: 'surface-digest',
    toolNames: ['ready_read'],
  },
  readyTurnToolAuthorization: {
    authorizationId: 'authorization-1',
    authorizationDigest: 'authorization-digest',
  },
  authorizationOwnerId: 'owner-1',
  resourceOwnerId: 'resource-owner-1',
  productBudgetSeed: {
    maxIterations: 8,
    maxToolCalls: 4,
    maxParallelToolGroups: 1,
  },
} as const

test('product run preparer produces a neutral user-root payload with no prompt assembly fields', () => {
  const result = preparer.prepare(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.ingress.kind, 'user_ingress')
  assert.equal(result.prepared.neutralProjectionSeed.taskTitle, '正在理解需求')
  for (const forbidden of [
    'systemPrompt',
    'persona',
    'memoryRefs',
    'triggerHits',
    'compression',
    'deliveryMode',
    'parentTaskId',
    'workflow',
    'preparedMessage',
  ]) {
    assert.equal(forbidden in result.prepared, false, forbidden)
  }
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(preparedCodexProductRunMatchesIngress(result.prepared, {
    scopeId: base.scopeId,
    aliasId: base.aliasId,
    aliasGeneration: base.aliasGeneration,
    requestId: base.requestId,
    originUserMessageId: base.originUserMessageId,
    reservationSetId: base.reservationSetId,
    reservationEvidenceDigest: base.reservationEvidenceDigest,
  }), true)
})

test('product run preparer rejects scheduled, handoff, workflow child, and unknown extensions', () => {
  assert.deepEqual(preparer.prepare({ ...base, taskOrigin: 'system_background', runOrigin: 'scheduled_task' }), {
    ok: false,
    code: 'unsupported_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, runOrigin: 'handoff_takeover' }), {
    ok: false,
    code: 'unsupported_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, taskOrigin: 'workflow_child' }), {
    ok: false,
    code: 'unsupported_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, systemPrompt: 'forbidden' }), {
    ok: false,
    code: 'invalid_product_ingress',
  })
})

test('product run preparer rejects conflicting resource versions before persistence', () => {
  const currentResource = {
    logicalResourceId: 'document-1',
    currentVersion: 'v2',
    currentDigest: 'digest-v2',
    supersedesVersion: 'v1',
    policyEpoch: 2,
  }
  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [currentResource],
    },
    resourceAdditionalContext: [{
      ...currentResource,
      currentDigest: 'conflicting-digest-v2',
    }],
  }), {
    ok: false,
    code: 'invalid_product_ingress',
  })

  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [currentResource, {
        ...currentResource,
        currentVersion: 'v3',
        currentDigest: 'digest-v3',
        supersedesVersion: 'v2',
        policyEpoch: 3,
      }],
    },
    resourceAdditionalContext: [currentResource],
  }), {
    ok: false,
    code: 'invalid_product_ingress',
  })
})

test('prepared product run binding rejects every other send identity', () => {
  const result = preparer.prepare(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expected = {
    scopeId: base.scopeId,
    aliasId: base.aliasId,
    aliasGeneration: base.aliasGeneration,
    requestId: base.requestId,
    originUserMessageId: base.originUserMessageId,
    reservationSetId: base.reservationSetId,
    reservationEvidenceDigest: base.reservationEvidenceDigest,
  }
  for (const mismatch of [
    { scopeId: 'scope-other' },
    { aliasId: 'alias-other' },
    { aliasGeneration: 2 },
    { requestId: 'request-other' },
    { originUserMessageId: 'message-other' },
    { reservationSetId: 'reservation-other' },
    { reservationEvidenceDigest: 'reservation-evidence-other' },
  ]) {
    assert.equal(preparedCodexProductRunMatchesIngress(result.prepared, {
      ...expected,
      ...mismatch,
    }), false)
  }
})
