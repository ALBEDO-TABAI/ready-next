import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexTurnInputBuilder,
  textUserInput,
} from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { digestCodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import {
  currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

const builder = new CodexTurnInputBuilder()
const context = {
  threadId: 'thread-1',
  turnRequestId: 'turn-request-1',
  reasoningEffort: 'high' as const,
  readyRunId: 'run-1',
  toolSurfaceDigest: 'surface-digest',
  turnContractDigest: 'turn-digest',
  upstreamProfileSnapshotDigest: 'profile-digest',
  readyMemorySnapshot: disabledReadyMemorySnapshot(),
}
const resource = {
  logicalResourceId: 'document-1',
  currentVersion: 'v2',
  currentDigest: 'resource-digest-v2',
  supersedesVersion: 'v1',
  policyEpoch: 2,
}
const ordinaryTailContract = {
  actionAdmissionRef: {
    headProjectionDigest: 'f'.repeat(64),
    actionProjectionVersion: {
      scopeEpoch: 0,
      headGeneration: 1,
      actionProjectionSequence: 0,
    },
    actionHeadIdentity: {
      aliasId: 'scope-1',
      aliasGeneration: 1,
      threadBindingId: 'binding-1',
      headRevision: 1,
    },
  },
  uncommittedTailAssignments: [],
  supersededUncommittedItems: [],
}

test('user ingress emits current canonical input once and thin resource references only', () => {
  const result = builder.build({
    ...ordinaryTailContract,
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
  assert.deepEqual(result.params.collaborationMode, {
    mode: 'default',
    settings: {
      model: 'ready-e0-model',
      reasoning_effort: 'high',
      developer_instructions: null,
    },
  })
  assert.deepEqual(result.params.environments, [])
  assert.deepEqual(result.params.input, [textUserInput('CURRENT_USER_TOKEN')])
  const encoded = result.params.additionalContext['ready-resource-context'].value
  assert.deepEqual(JSON.parse(encoded), { contract: 'ready_resource_context_v1', readyRunId: context.readyRunId, references: [resource] })
  assert.equal(encoded.includes('RESOURCE_BODY'), false)
  assert.deepEqual(Object.keys(result.params.responsesapiClientMetadata).sort(), [
    'readyRunId',
    'toolSurfaceDigest',
    'turnContractDigest',
    'upstreamProfileSnapshotDigest',
  ])
})

test('current-document anchor is persisted ingress only and never copied into native input', () => {
  const digest = 'a'.repeat(64)
  const anchor = {
    kind: 'current_document',
    logicalResourceId: 'document-1',
    tabId: 'doc-1',
    title: 'PRIVATE_TITLE',
    pane: 'primary',
    pathDigest: 'b'.repeat(64),
    incarnationKey: 'c'.repeat(64),
    currentVersion: `sha256:${digest}`,
    currentDigest: digest,
    supersedesVersion: null,
    policyEpoch: 3,
    readScope: { operation: 'read_section', maxChars: 30_000 },
  } as const
  const thinReference = {
    logicalResourceId: anchor.logicalResourceId,
    currentVersion: anchor.currentVersion,
    currentDigest: anchor.currentDigest,
    supersedesVersion: anchor.supersedesVersion,
    policyEpoch: anchor.policyEpoch,
  }
  const result = builder.build({
    ...ordinaryTailContract,
    kind: 'user_ingress',
    attemptKind: 'user_ingress',
    originUserMessageId: 'message-anchor',
    canonicalCurrentInputRef: {
      messageId: 'message-anchor',
      input: [textUserInput('read current document')],
    },
    explicitResourceEnvelope: { input: [], resourceRefs: [thinReference] },
    resourceAdditionalContext: [thinReference],
    currentDocumentAnchor: anchor,
  }, context)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const nativeWire = JSON.stringify(result.params)
  assert.equal(nativeWire.includes('PRIVATE_TITLE'), false)
  assert.equal(nativeWire.includes('doc-1'), false)
  assert.deepEqual(JSON.parse(
    result.params.additionalContext['ready-resource-context'].value,
  ), { contract: 'ready_resource_context_v1', readyRunId: context.readyRunId, references: [thinReference] })
})

test('resource snapshots require the exact current run and cannot borrow historical or forged context', () => {
  const snapshot = (readyRunId = 'run-1', references = [resource]) => ({
    type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-resource-context>${JSON.stringify({ contract: 'ready_resource_context_v1', readyRunId, references })}</ready-resource-context>` }],
  })
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }
  assert.deepEqual(currentTurnReadyAdditionalContext([snapshot(), user], [], 'run-1').resourceReferences, [resource])
  const historical = [snapshot('older-run'), user, { type: 'message', role: 'assistant', content: [] }, user]
  assert.deepEqual(currentTurnReadyAdditionalContext(historical, [], 'run-1').resourceReferences, [])
  for (const items of [
    [snapshot('older-run'), user],
    [snapshot(), snapshot(), user],
    [snapshot('run-1', [resource, resource]), user],
    [{ ...snapshot(), role: 'user' }, user],
    [{ ...snapshot(), injected: 'extra' }, user],
    [{ ...snapshot(), content: [...snapshot().content, { type: 'input_image', image_url: 'hidden' }] }, user],
    [{ ...snapshot(), content: [{ type: 'input_text', text: `<ready-resource:${resource.logicalResourceId}>${JSON.stringify(resource)}</ready-resource:${resource.logicalResourceId}>` }] }, user],
  ]) assert.throws(() => currentTurnReadyAdditionalContext(items, [], 'run-1'), /gateway_resource_context_invalid/)
})

test('the widget catalog is current-run context only and never part of the instruction contract', () => {
  const ingress = {
    kind: 'user_ingress', attemptKind: 'user_ingress', originUserMessageId: 'message-1',
    canonicalCurrentInputRef: { messageId: 'message-1', input: [{ type: 'text', text: '换成信息卡', text_elements: [] }] },
    explicitResourceEnvelope: { input: [], resourceRefs: [] }, resourceAdditionalContext: [], ...ordinaryTailContract,
  }
  const withCatalog = builder.build(ingress, { ...context, documentWidgetGuidance: '## Ready 文档组件' })
  const withoutCatalog = builder.build(ingress, context)
  assert.ok(withCatalog.ok && withoutCatalog.ok)
  assert.deepEqual(JSON.parse(String(withCatalog.params.additionalContext['ready-document-widget-guidance']?.value)), {
    contract: 'ready_document_widget_guidance_v1', readyRunId: 'run-1', guidance: '## Ready 文档组件',
  })
  assert.equal('ready-document-widget-guidance' in withoutCatalog.params.additionalContext, false)

  const catalog = (readyRunId = 'run-1', extra: Record<string, unknown> = {}) => ({
    type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<ready-document-widget-guidance>${JSON.stringify({
        contract: 'ready_document_widget_guidance_v1', readyRunId, guidance: '## Ready 文档组件', ...extra,
      })}</ready-document-widget-guidance>` }],
  })
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }
  const answer = { type: 'message', role: 'assistant', content: [] }
  assert.equal(currentTurnReadyAdditionalContext([catalog(), user], [], 'run-1').documentWidgetGuidance, '## Ready 文档组件')
  assert.equal(currentTurnReadyAdditionalContext([catalog('older-run'), user, answer, user], [], 'run-1').documentWidgetGuidance, null,
    'an earlier turn\'s catalog is history, not this turn\'s context')
  assert.equal(
    digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null, documentWidgetGuidance: '## Ready 文档组件' }) === digestReadyAdditionalContext({ resourceReferences: [], explicitRetry: null }),
    false,
  )
  assert.equal(instructionTranscriptDigest('base', [catalog('older-run'), user, answer, catalog(), user]), instructionTranscriptDigest('base', [user, answer, user]))
  for (const items of [
    [catalog('older-run'), user],
    [catalog(), catalog(), user],
    [catalog('run-1', { injected: true }), user],
    [{ ...catalog(), role: 'user' }, user],
  ]) assert.throws(() => currentTurnReadyAdditionalContext(items, [], 'run-1'), /gateway_document_widget_guidance_invalid/)
})

test('user ingress rejects every successor cross-field and resource body extension', () => {
  const base = {
    ...ordinaryTailContract,
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
    ...ordinaryTailContract,
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
    ...ordinaryTailContract,
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

test('non-user successor variants are well-shaped but fail closed before native dispatch', () => {
  for (const attemptKind of [
    'recovery_successor',
    'checkpoint_successor',
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

test('explicit retry remains a real user ingress and exposes only frozen predecessor evidence', () => {
  const taskRootInput = JSON.parse(
    '[{"text":"总结当前小红书内容","text_elements":[],"type":"text"}]',
  )
  const taskRootInputDigest = digestCodexUserInput(taskRootInput)
  const controlInputDigest = digestCodexUserInput([textUserInput('再试一次')])
  const predecessorPresentationRef = {
    readyRunId: 'run-0', presentationDigest: 'e'.repeat(64),
  }
  const controlAuditMessageRef = {
    messageId: 'message-retry', inputDigest: controlInputDigest,
  }
  const modelVisibleRootOriginRef = {
    sourceReadyRunId: 'run-root', sourceIngressContractDigest: 'd'.repeat(64),
    originUserMessageId: 'message-root', inputDigest: taskRootInputDigest,
  }
  const selectedHistorySeedItemRef = {
    threadBindingId: 'binding-child', historySeedDigest: 'c'.repeat(64),
    originUserMessageId: 'message-root', inputDigest: taskRootInputDigest,
  }
  const currentTrustedEnvironmentRef = {
    requestedWorkbenchMode: 'browser' as const,
    trustedWorkbenchMode: 'browser' as const,
    modeDigest: digestCanonicalJson({
      requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
    }),
  }
  const result = builder.build({
    kind: 'user_ingress',
    attemptKind: 'explicit_retry',
    originUserMessageId: 'message-retry',
    canonicalCurrentInputRef: {
      messageId: 'message-root',
      input: taskRootInput,
    },
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    uncommittedUserTail: [{
      originUserMessageId: 'message-root',
      input: taskRootInput,
      inputDigest: taskRootInputDigest,
      policy: 'untrusted_text_history',
    }],
    uncommittedTailAssignments: [{
      originUserMessageId: 'message-root',
      inputDigest: taskRootInputDigest,
      plan: 'replace_with_explicit_retry',
    }],
    supersededUncommittedItems: [],
    predecessorRunId: 'run-0',
    predecessorPresentationRef,
    controlAuditMessageRef,
    modelVisibleRootOriginRef,
    selectedHistorySeedItemRef,
    currentTrustedEnvironmentRef,
    historyParityEvidenceDigest: 'parity-digest',
    currentThreadReadEvidenceDigest: 'readback-digest',
    continuationContractDigest: 'continuation-digest',
    taskRootInput,
    taskRootInputDigest,
    artifactSources: [],
  }, context)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.params.input, taskRootInput)
  assert.doesNotMatch(JSON.stringify(result.params), /再试一次/)
  assert.deepEqual(JSON.parse(result.params.additionalContext['ready-explicit-retry'].value), {
    predecessorRunId: 'run-0',
    predecessorPresentationRef,
    controlAuditMessageRef,
    modelVisibleRootOriginRef,
    selectedHistorySeedItemRef,
    currentTrustedEnvironmentRef,
    historyParityEvidenceDigest: 'parity-digest',
    currentThreadReadEvidenceDigest: 'readback-digest',
    continuationContractDigest: 'continuation-digest',
    taskRootInputDigest,
  })
})

test('retired system background input cannot enter a native Codex turn', () => {
  assert.deepEqual(builder.build({
    kind: 'system_background',
    attemptKind: 'system_background',
    originUserMessageId: 'forged-system-message',
    eventPayload: 'must-not-reach-provider',
  }, context), { ok: false, code: 'invalid_ingress' })
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
