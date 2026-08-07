import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexTurnInputBuilder,
  textUserInput,
} from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'

const builder = new CodexTurnInputBuilder()
const context = {
  threadId: 'thread-1',
  turnRequestId: 'turn-request-1',
  readyRunId: 'run-1',
  toolSurfaceDigest: 'surface-digest',
  turnContractDigest: 'turn-digest',
  upstreamProfileSnapshotDigest: 'profile-digest',
}
const resource = {
  logicalResourceId: 'document-1',
  currentVersion: 'v2',
  currentDigest: 'resource-digest-v2',
  supersedesVersion: 'v1',
  policyEpoch: 2,
}

test('user ingress emits current canonical input once and thin resource references only', () => {
  const result = builder.build({
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: {
      messageId: 'message-1',
      input: [textUserInput('CURRENT_USER_TOKEN')],
    },
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [resource],
    },
    resourceAdditionalContext: [resource],
  }, context)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.params.input, [textUserInput('CURRENT_USER_TOKEN')])
  const encoded = result.params.additionalContext['ready-resource:document-1'].value
  assert.deepEqual(JSON.parse(encoded), resource)
  assert.equal(encoded.includes('RESOURCE_BODY'), false)
  assert.deepEqual(Object.keys(result.params.responsesapiClientMetadata).sort(), [
    'readyRunId',
    'toolSurfaceDigest',
    'turnContractDigest',
    'upstreamProfileSnapshotDigest',
  ])
})

test('user ingress rejects every successor cross-field and resource body extension', () => {
  const base = {
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: { messageId: 'message-1', input: [textUserInput('hello')] },
    explicitResourceEnvelope: { input: [], resourceRefs: [resource] },
    resourceAdditionalContext: [resource],
  }
  for (const [field, value] of [
    ['predecessorRunId', 'run-0'],
    ['signedContinuationContextRef', 'signed'],
    ['historyParityEvidenceDigest', 'digest'],
    ['currentThreadReadEvidenceDigest', 'digest'],
    ['continuationContractDigest', 'digest'],
  ] as const) {
    assert.deepEqual(builder.build({ ...base, [field]: value }, context), {
      ok: false,
      code: 'invalid_ingress',
    })
  }
  assert.deepEqual(builder.build({
    ...base,
    resourceAdditionalContext: [{ ...resource, resourceBody: 'RESOURCE_BODY' }],
  }, context), { ok: false, code: 'invalid_ingress' })
})

test('user ingress rejects duplicate versions for one logical resource', () => {
  const conflictingVersion = {
    ...resource,
    currentVersion: 'v3',
    currentDigest: 'resource-digest-v3',
    supersedesVersion: 'v2',
    policyEpoch: 3,
  }
  assert.deepEqual(builder.build({
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: {
      messageId: 'message-1',
      input: [textUserInput('hello')],
    },
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [resource, conflictingVersion],
    },
    resourceAdditionalContext: [resource, conflictingVersion],
  }, context), { ok: false, code: 'resource_reference_mismatch' })
})

test('resource identity includes supersedesVersion and a positive numeric policy epoch', () => {
  const base = {
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-1',
    canonicalCurrentInputRef: { messageId: 'message-1', input: [textUserInput('hello')] },
    explicitResourceEnvelope: { input: [], resourceRefs: [resource] },
    resourceAdditionalContext: [{ ...resource, supersedesVersion: 'v0' }],
  }
  assert.deepEqual(builder.build(base, context), {
    ok: false,
    code: 'resource_reference_mismatch',
  })
  for (const policyEpoch of ['2', 0, -1]) {
    assert.deepEqual(builder.build({
      ...base,
      explicitResourceEnvelope: {
        input: [],
        resourceRefs: [{ ...resource, policyEpoch }],
      },
      resourceAdditionalContext: [{ ...resource, policyEpoch }],
    }, context), { ok: false, code: 'invalid_ingress' })
  }
})

test('all three non-user successor variants are well-shaped but fail closed before native dispatch', () => {
  for (const attemptKind of [
    'recovery_successor',
    'checkpoint_successor',
    'explicit_retry',
  ] as const) {
    assert.deepEqual(builder.build({
      kind: 'non_user_successor',
      attemptKind,
      originUserMessageId: 'message-1',
      predecessorRunId: 'run-0',
      turnStartInput: [],
      signedContinuationContextRef: 'signed-continuation',
      historyParityEvidenceDigest: 'parity-digest',
      currentThreadReadEvidenceDigest: 'readback-digest',
      continuationContractDigest: 'continuation-digest',
    }, context), { ok: false, code: 'non_user_successor_unsupported' })
  }
})

test('successor branch rejects fake user input and user-ingress fields', () => {
  const base = {
    kind: 'non_user_successor',
    attemptKind: 'explicit_retry',
    originUserMessageId: 'message-1',
    predecessorRunId: 'run-0',
    turnStartInput: [],
    signedContinuationContextRef: 'signed-continuation',
    historyParityEvidenceDigest: 'parity-digest',
    currentThreadReadEvidenceDigest: 'readback-digest',
    continuationContractDigest: 'continuation-digest',
  }
  assert.deepEqual(builder.build({ ...base, turnStartInput: [textUserInput('fake')] }, context), {
    ok: false,
    code: 'invalid_ingress',
  })
  assert.deepEqual(builder.build({
    ...base,
    canonicalCurrentInputRef: { messageId: 'message-1', input: [textUserInput('fake')] },
  }, context), { ok: false, code: 'invalid_ingress' })
})
