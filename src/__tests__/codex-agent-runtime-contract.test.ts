import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INGRESS_PERSISTENCE_ERROR_KINDS,
  PRE_PERSISTENCE_ERROR_KINDS,
  TERMINAL_ERROR_KINDS,
  mapSendScopedResponseToMessageResult,
  parseCreateSessionRequest,
  parseCreateSessionResult,
  parseIngressAdmittedEvent,
  parseLifecycleRequest,
  parseLifecycleResult,
  parseStopLifecycleRequest,
  parseSendScopedRequest,
  parseSendScopedResponse,
} from '../shared/ipc-contracts/agent-runtime'
import type { SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'

// @ts-expect-error terminal success cannot carry a failure-only field
const mixedSuccessResponse: SendScopedResponse = {
  success: true,
  disposition: 'terminal_success',
  ownerRunId: 'run-mixed',
  aliasGeneration: 2,
  shouldClearInput: true,
  preserveInput: false,
  retryableByUser: false,
  persistence: {
    scope: 'pre-existing',
    message: 'persisted',
    attachments: 'none',
    inputAttachments: 'none',
  },
  responseText: 'done',
  canonicalMessage: {
    id: 'assistant-mixed',
    conversationId: 'alias-mixed',
    role: 'assistant',
    content: 'done',
    timestamp: '2026-08-07T00:00:00.000Z',
    meta: {},
  },
  canonicalMessageDigest: 'mixed-digest',
  error: 'forbidden',
}

void mixedSuccessResponse

const persisted = {
  scope: 'pre-existing' as const,
  message: 'persisted' as const,
  attachments: 'none' as const,
  inputAttachments: 'none' as const,
}

const canonicalMessage = {
  id: 'assistant-1',
  conversationId: 'alias-1',
  role: 'assistant' as const,
  content: 'done',
  timestamp: '2026-08-07T00:00:00.000Z',
  meta: {},
}

const sendRequest = {
  scopeId: 'alias-1',
  requestId: 'request-1',
  expectedAliasGeneration: 1,
  expectedMessageVisibilityEpoch: 0,
  message: 'hello',
  userMessage: {
    id: 'message-1',
    content: 'hello',
    timestamp: '2026-08-07T00:00:00.000Z',
    meta: {},
    attachmentConfirmation: {
      selectedCount: 0,
      metadataCount: 0,
      inputIncludedCount: 0,
      inputFailedCount: 0,
    },
  },
}

test('sendScoped request is exact and rejects retired workflow fields', () => {
  assert.equal(parseSendScopedRequest(sendRequest).requestId, 'request-1')
  const { expectedAliasGeneration: _ignored, ...unboundFollowUp } = sendRequest
  assert.equal(parseSendScopedRequest(unboundFollowUp).expectedAliasGeneration, undefined)
  for (const forbidden of [
    'agent',
    'deliveryMode',
    'continuationIntent',
    'workspaceRoots',
    'taskId',
    'parentTaskId',
    'sessionIdOverride',
  ]) {
    assert.throws(() => parseSendScopedRequest({ ...sendRequest, [forbidden]: 'retired' }), forbidden)
  }
  assert.throws(() => parseSendScopedRequest({ ...sendRequest, requestId: undefined }))
  assert.throws(() => parseSendScopedRequest({
    ...sendRequest,
    message: [{ type: 'image', base64: 'encoded-without-mime' }],
  }))
})

test('sendScoped accepts only the body-free current-document anchor contract', () => {
  const digest = 'a'.repeat(64)
  const currentDocumentAnchor = {
    kind: 'current_document',
    logicalResourceId: 'ready-current-document:alias-1:doc-1',
    tabId: 'doc-1',
    title: 'Current',
    pane: 'primary',
    pathDigest: 'b'.repeat(64),
    incarnationKey: 'c'.repeat(64),
    currentVersion: `sha256:${digest}`,
    currentDigest: digest,
    supersedesVersion: null,
    policyEpoch: 1,
    readScope: { operation: 'read_section', maxChars: 30_000 },
  }
  assert.deepEqual(
    parseSendScopedRequest({ ...sendRequest, currentDocumentAnchor }).currentDocumentAnchor,
    currentDocumentAnchor,
  )
  assert.throws(() => parseSendScopedRequest({
    ...sendRequest,
    currentDocumentAnchor: { ...currentDocumentAnchor, resourceBody: 'forbidden' },
  }))
})

test('ingress admission carries the exact positive alias generation', () => {
  const event = {
    type: 'ingress_admitted' as const,
    requestId: 'request-1',
    scopeId: 'scope-1',
    originUserMessageId: 'user-1',
    aliasGeneration: 6,
    messageVisibilityEpoch: 3,
    ingressAdmittedRevision: 1,
    ingressAdmittedDigest: 'admission-digest',
    admittedAt: '2026-08-07T00:00:00.000Z',
  }
  assert.deepEqual(parseIngressAdmittedEvent(event), event)
  assert.throws(() => parseIngressAdmittedEvent({ ...event, aliasGeneration: 0 }))
  const { aliasGeneration: _aliasGeneration, ...missingGeneration } = event
  assert.throws(() => parseIngressAdmittedEvent(missingGeneration))
  const { messageVisibilityEpoch: _messageVisibilityEpoch, ...missingVisibilityEpoch } = event
  assert.throws(() => parseIngressAdmittedEvent(missingVisibilityEpoch))
})

test('sendScoped runtime schema accepts exactly four dispositions', () => {
  const fixtures = [
    {
      success: true,
      disposition: 'terminal_success',
      ownerRunId: 'run-1',
      aliasGeneration: 2,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: persisted,
      responseText: 'done',
      canonicalMessage,
      canonicalMessageDigest: 'digest-canonical',
    },
    {
      success: false,
      disposition: 'rejected_before_persistence',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: true,
      persistence: {
        scope: 'pre-existing',
        message: 'skipped',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'thread_busy',
      errorKind: 'thread_busy',
      admissionEvidenceDigest: 'digest-admission',
    },
    {
      success: false,
      disposition: 'ingress_persistence_failed',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: true,
      persistence: {
        scope: 'pre-existing',
        message: 'failed',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'write failed',
      errorKind: 'ingress_transaction_failed',
      evidenceDigest: 'digest-ingress',
    },
    {
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: 'run-1',
      aliasGeneration: 2,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: persisted,
      error: 'proof gap',
      errorKind: 'proof_gap',
      productOutcomeDigest: 'digest-outcome',
    },
  ]

  assert.deepEqual(fixtures.map((fixture) => parseSendScopedResponse(fixture).disposition), [
    'terminal_success',
    'rejected_before_persistence',
    'ingress_persistence_failed',
    'terminal_failure_after_persistence',
  ])
})

test('sendScoped runtime schema rejects mixed optional legacy shapes', () => {
  assert.throws(() => parseSendScopedResponse({
    success: false,
    disposition: 'rejected_before_persistence',
    ownerRunId: 'forbidden-run',
    acceptedAsSteering: true,
    shouldClearInput: false,
    preserveInput: true,
    retryableByUser: true,
    persistence: {
      scope: 'pre-existing',
      message: 'skipped',
      attachments: 'none',
      inputAttachments: 'none',
    },
    error: 'busy',
    errorKind: 'thread_busy',
    admissionEvidenceDigest: 'digest',
  }))
  assert.throws(() => parseSendScopedResponse({
    success: true,
    disposition: 'terminal_success',
    ownerRunId: 'run-1',
    aliasGeneration: 2,
    shouldClearInput: true,
    preserveInput: false,
    retryableByUser: false,
    persistence: persisted,
    responseText: 'done',
    canonicalMessage,
    canonicalMessageDigest: 'digest',
    error: 'impossible',
  }))
})

test('error kind partitions are closed, disjoint, and retire legacy message_persist_failed', () => {
  const all = [
    ...PRE_PERSISTENCE_ERROR_KINDS,
    ...INGRESS_PERSISTENCE_ERROR_KINDS,
    ...TERMINAL_ERROR_KINDS,
  ]
  assert.equal(new Set(all).size, all.length)
  assert.equal(all.includes('message_persist_failed' as never), false)
  assert.equal(all.includes('ingress_message_persist_failed'), true)
  assert.equal(all.includes('persistence_failed'), true)
})

test('renderer mapping preserves input only before durable admission', () => {
  const pre = parseSendScopedResponse({
    success: false,
    disposition: 'rejected_before_persistence',
    shouldClearInput: false,
    preserveInput: true,
    retryableByUser: true,
    persistence: {
      scope: 'pre-existing',
      message: 'skipped',
      attachments: 'none',
      inputAttachments: 'none',
    },
    error: 'capacity',
    errorKind: 'start_identity_capacity_exhausted',
    admissionEvidenceDigest: 'digest',
  })
  const post = parseSendScopedResponse({
    success: false,
    disposition: 'terminal_failure_after_persistence',
    ownerRunId: 'run-1',
    aliasGeneration: 2,
    shouldClearInput: true,
    preserveInput: false,
    retryableByUser: false,
    persistence: persisted,
    error: 'provider failed',
    errorKind: 'blocked_external',
    productOutcomeDigest: 'digest',
  })
  assert.equal(mapSendScopedResponseToMessageResult(pre).preserveInput, true)
  assert.equal(mapSendScopedResponseToMessageResult(post).preserveInput, false)
})

test('create and lifecycle results reject weak objects and free-form errors', () => {
  assert.deepEqual(parseCreateSessionRequest({ agentId: 'butler' }), { agentId: 'butler' })
  assert.throws(() => parseCreateSessionRequest({}))
  assert.throws(() => parseCreateSessionRequest({ agentId: 'butler', aliasId: 'forged' }))
  assert.equal(parseCreateSessionResult({
    ok: true,
    action: 'create',
    aliasId: 'alias-1',
    aliasGeneration: 1,
    persistedAt: '2026-08-07T00:00:00.000Z',
  }).ok, true)
  assert.throws(() => parseCreateSessionResult({ success: true }))
  assert.equal(parseLifecycleResult({
    ok: false,
    action: 'reset',
    code: 'persistence_failed',
    preserveUi: true,
    aliasId: 'alias-1',
    aliasGeneration: 1,
    evidenceDigest: 'digest',
  }).ok, false)
  assert.throws(() => parseLifecycleResult({ ok: false, action: 'reset', error: 'failed' }))
})

test('lifecycle request carries one exact immutable alias generation', () => {
  assert.deepEqual(parseLifecycleRequest({ aliasId: 'alias-1', aliasGeneration: 2 }), {
    aliasId: 'alias-1',
    aliasGeneration: 2,
  })
  assert.throws(() => parseLifecycleRequest({ aliasId: 'alias-1' }))
  assert.throws(() => parseLifecycleRequest({ aliasId: 'alias-1', aliasGeneration: 0 }))
  assert.throws(() => parseLifecycleRequest({
    aliasId: 'alias-1',
    aliasGeneration: 1,
    sessionId: 'retired-shape',
  }))
})

test('stop lifecycle request additionally binds one exact Ready run', () => {
  assert.deepEqual(parseStopLifecycleRequest({
    aliasId: 'alias-1',
    aliasGeneration: 2,
    readyRunId: 'run-1',
  }), {
    aliasId: 'alias-1',
    aliasGeneration: 2,
    readyRunId: 'run-1',
  })
  assert.throws(() => parseStopLifecycleRequest({ aliasId: 'alias-1', aliasGeneration: 2 }))
  assert.throws(() => parseStopLifecycleRequest({
    aliasId: 'alias-1',
    aliasGeneration: 2,
    readyRunId: '',
  }))
  assert.throws(() => parseLifecycleRequest({
    aliasId: 'alias-1',
    aliasGeneration: 2,
    readyRunId: 'run-1',
  }))
})
