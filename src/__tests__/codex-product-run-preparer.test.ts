import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexProductRunPreparer,
  isPreparedCodexProductRun,
  preparedCodexProductRunMatchesIngress,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  externalReadResourceReference,
  prepareFeishuExternalReadSlice,
} from '../main/modules/agent-control/codex-runtime/codex-external-read-slice'

const preparer = new CodexProductRunPreparer()
const documentDigest = 'a'.repeat(64)
const documentAnchor = {
  kind: 'current_document',
  logicalResourceId: 'ready-current-document:scope-1:doc-1',
  tabId: 'doc-1',
  title: 'Current plan',
  pane: 'primary',
  pathDigest: 'b'.repeat(64),
  incarnationKey: 'c'.repeat(64),
  currentVersion: `sha256:${documentDigest}`,
  currentDigest: documentDigest,
  supersedesVersion: null,
  policyEpoch: 2,
  readScope: { operation: 'read_section', maxChars: 30_000 },
} as const
const documentReference = {
  logicalResourceId: documentAnchor.logicalResourceId,
  currentVersion: documentAnchor.currentVersion,
  currentDigest: documentAnchor.currentDigest,
  supersedesVersion: documentAnchor.supersedesVersion,
  policyEpoch: documentAnchor.policyEpoch,
}
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
  ...createCodexToolFixture(),
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
  assert.equal(result.prepared.actionAuthorizationMode, 'ask')
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

test('product run preparer freezes the conversation authorization mode and old rows default closed', () => {
  const result = preparer.prepare({ ...base, actionAuthorizationMode: 'auto' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.actionAuthorizationMode, 'auto')
  const { actionAuthorizationMode: _omitted, ...oldPreparedRow } = result.prepared
  assert.equal(isPreparedCodexProductRun(oldPreparedRow), true)
  assert.deepEqual(preparer.prepare({
    ...base,
    actionAuthorizationMode: 'invalid',
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer persists the exact browser page identity in the resource anchor', () => {
  const browserPageRef = {
    tabId: 'tab-referenced',
    physicalTargetToken: 'physical-target-1',
    mainFrameId: '0',
    mainFrameDocumentToken: 'document-token-1',
    profileId: 'browser',
  }
  const result = preparer.prepare({ ...base, browserPageRef })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.browserPageRef, browserPageRef)
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(isPreparedCodexProductRun({
    ...result.prepared,
    browserPageRef: { ...browserPageRef, tabId: 'tab-swapped' },
  }), false)
})

test('product run preparer persists exact resource authority only with matching refs and tool authorization', () => {
  const resourceDigest = 'd'.repeat(64)
  const reference = {
    logicalResourceId: 'local-file:notes',
    currentVersion: `sha256:${resourceDigest}`,
    currentDigest: resourceDigest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const authority = {
    kind: 'local_file',
    logicalResourceId: reference.logicalResourceId,
    name: 'notes.txt',
    path: '/canonical/notes.txt',
    currentVersion: reference.currentVersion,
    currentDigest: reference.currentDigest,
    policyEpoch: reference.policyEpoch,
    allowedToolNames: ['file_extract_text'],
  }
  const resourceInput = {
    ...base,
    explicitResourceEnvelope: {
      input: [{ type: 'mention', name: 'notes.txt', path: '/canonical/notes.txt' }],
      resourceRefs: [reference],
    },
    resourceAdditionalContext: [reference],
    resourceAuthorities: [authority],
    ...createCodexToolFixture(['file_extract_text']),
  }
  const result = preparer.prepare(resourceInput)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.resourceAuthorities, [authority])
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.deepEqual(preparer.prepare({
    ...resourceInput,
    resourceAuthorities: [{ ...authority, currentDigest: 'e'.repeat(64) }],
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer rejects retired background ingress, handoff, workflow child, and unknown extensions', () => {
  assert.deepEqual(preparer.prepare({ ...base, taskOrigin: 'system_background', runOrigin: 'scheduled_task' }), {
    ok: false,
    code: 'invalid_product_ingress',
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

test('product run preparer binds a body-free current-document anchor to the exact thin reference', () => {
  const result = preparer.prepare({
    ...base,
    explicitResourceEnvelope: { input: [], resourceRefs: [documentReference] },
    resourceAdditionalContext: [documentReference],
    currentDocumentAnchor: documentAnchor,
  })
  assert.equal(result.ok, true)
  if (!result.ok || result.prepared.ingress.kind !== 'user_ingress') return
  assert.deepEqual(result.prepared.ingress.currentDocumentAnchor, documentAnchor)
  assert.equal(JSON.stringify(result.prepared).includes('RESOURCE_BODY'), false)

  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    currentDocumentAnchor: documentAnchor,
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer persists an external read slice only with its exact resource and tool authority', () => {
  const externalReadSlice = prepareFeishuExternalReadSlice({
    request: {
      kind: 'feishu_typed_read',
      channelId: 'channel-1',
      docToken: 'doc-token',
      docType: 'docx',
      logicalResourceId: 'feishu:doc-token',
      currentVersion: 'v1',
      currentDigest: 'd'.repeat(64),
      policyEpoch: 1,
    },
    sidecarRunning: true,
    channelIdentityDigest: 'b'.repeat(64),
  })
  const reference = externalReadResourceReference(externalReadSlice)
  const externalBase = {
    ...base,
    ...createCodexToolFixture(['feishu_doc_read']),
    explicitResourceEnvelope: { input: [], resourceRefs: [reference] },
    resourceAdditionalContext: [reference],
    externalReadSlice,
  }
  const result = preparer.prepare(externalBase)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.externalReadSlice, externalReadSlice)
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(JSON.stringify(result.prepared).includes('accessToken'), false)

  assert.deepEqual(preparer.prepare({
    ...externalBase,
    resourceAdditionalContext: [{ ...reference, currentVersion: 'v2' }],
  }), { ok: false, code: 'invalid_product_ingress' })
  assert.deepEqual(preparer.prepare({
    ...externalBase,
    ...createCodexToolFixture(['ready_read']),
  }), { ok: false, code: 'invalid_product_ingress' })
  assert.deepEqual(preparer.prepare({
    ...externalBase,
    currentDocumentAnchor: documentAnchor,
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer rejects authorization outside the frozen thread surface', () => {
  const unsigned = {
    authorizationId: base.readyTurnToolAuthorization.authorizationId,
    allowedToolNames: ['forged_tool'],
    skillAuthorization: base.readyTurnToolAuthorization.skillAuthorization,
  }
  assert.deepEqual(preparer.prepare({
    ...base,
    readyTurnToolAuthorization: {
      ...unsigned,
      authorizationDigest: digestCanonicalJson(unsigned),
    },
  }), { ok: false, code: 'invalid_product_ingress' })
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
