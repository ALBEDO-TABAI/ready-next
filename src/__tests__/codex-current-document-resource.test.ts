import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildCodexCurrentDocumentAnchor,
  resetCodexCurrentDocumentAnchorStateForTest,
} from '../renderer/modules/agent/codexCurrentDocumentAnchor'
import { executeCodexCurrentDocumentRead } from '../renderer/modules/agent/codexCurrentDocumentRead'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'
import { currentDocumentReadReceiptMatches } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

function setDocument(content: string): void {
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({
    tabs: [{
      id: 'doc-current',
      path: '/workspace/current.md',
      title: 'Current document',
      content,
      isDirty: true,
    }],
    activeTabId: 'doc-current',
    splitTabId: null,
    focusedPaneTabId: 'doc-current',
  })
}

test('current document V1 is rejected after V2 and the stale response contains zero body', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  setDocument('V1_ONLY_SENTINEL\nshared')
  const v1 = await buildCodexCurrentDocumentAnchor('scope-doc')
  assert.ok(v1)
  assert.equal(JSON.stringify(v1).includes('V1_ONLY_SENTINEL'), false)

  const bindingDigest = 'd'.repeat(64)
  const v1Result = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: { scopeId: 'scope-doc', requestBindingDigest: bindingDigest, anchor: v1 },
  })
  assert.equal(v1Result?.ok, true)
  assert.match(String(v1Result?.summary), /V1_ONLY_SENTINEL/)

  setDocument('V2_ONLY_SENTINEL\nshared')
  const stale = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: { scopeId: 'scope-doc', requestBindingDigest: bindingDigest, anchor: v1 },
  })
  assert.deepEqual(stale, {
    ok: false,
    errorKind: 'resource_version_superseded',
    summary: '当前文档已在本轮读取前发生变化，请基于新版本重新读取。',
    bodyBytes: 0,
    requestedVersion: v1.currentVersion,
  })
  assert.equal(JSON.stringify(stale).includes('V1_ONLY_SENTINEL'), false)
  assert.equal(JSON.stringify(stale).includes('V2_ONLY_SENTINEL'), false)

  const v2 = await buildCodexCurrentDocumentAnchor('scope-doc')
  assert.ok(v2)
  assert.equal(v2.supersedesVersion, v1.currentVersion)
  assert.ok(v2.policyEpoch > v1.policyEpoch)
  const v2Result = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: { scopeId: 'scope-doc', requestBindingDigest: bindingDigest, anchor: v2 },
  })
  assert.equal(v2Result?.ok, true)
  assert.match(String(v2Result?.summary), /V2_ONLY_SENTINEL/)
  assert.doesNotMatch(String(v2Result?.summary), /V1_ONLY_SENTINEL/)
})

test('same bytes still receive a fresh policy epoch while the version remains content-addressed', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  setDocument('same bytes')
  const first = await buildCodexCurrentDocumentAnchor('scope-doc')
  const second = await buildCodexCurrentDocumentAnchor('scope-doc')
  assert.ok(first && second)
  assert.equal(second.currentVersion, first.currentVersion)
  assert.equal(second.supersedesVersion, null)
  assert.ok(second.policyEpoch > first.policyEpoch)
  const stale = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: {
      scopeId: 'scope-doc',
      requestBindingDigest: 'd'.repeat(64),
      anchor: first,
    },
  })
  assert.equal(stale?.ok, false)
  assert.equal(stale?.bodyBytes, 0)
  assert.equal(JSON.stringify(stale).includes('same bytes'), false)
  const current = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: {
      scopeId: 'scope-doc',
      requestBindingDigest: 'd'.repeat(64),
      anchor: second,
    },
  })
  assert.equal(current?.ok, true)
  assert.match(String(current?.summary), /same bytes/)
})

test('no current-document anchor is emitted outside a visible document mode', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  setDocument('hidden document body')
  useMode.setState({ workbenchMode: 'browser', splitMode: null })
  assert.equal(await buildCodexCurrentDocumentAnchor('scope-doc'), undefined)
})

test('renderer restart clears current authorization and fails an old handle closed', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  setDocument('RESTART_SECRET_BODY')
  const beforeRestart = await buildCodexCurrentDocumentAnchor('scope-doc')
  assert.ok(beforeRestart)
  resetCodexCurrentDocumentAnchorStateForTest()
  const stale = await executeCodexCurrentDocumentRead({
    range: 'full',
    __readyResourceRead: {
      scopeId: 'scope-doc',
      requestBindingDigest: 'd'.repeat(64),
      anchor: beforeRestart,
    },
  })
  assert.equal(stale?.ok, false)
  assert.equal(stale?.bodyBytes, 0)
  assert.equal(JSON.stringify(stale).includes('RESTART_SECRET_BODY'), false)
})

async function assertPolicyRotationWhileDigestPending(heldDigestCall: 4 | 7): Promise<void> {
  resetCodexCurrentDocumentAnchorStateForTest()
  setDocument('POST_READ_ROTATION_SECRET')
  const first = await buildCodexCurrentDocumentAnchor('scope-doc')
  assert.ok(first)
  const subtle = globalThis.crypto.subtle
  const originalDigest = subtle.digest.bind(subtle)
  let digestCalls = 0
  let releaseDigest: (() => void) | null = null
  let reachedDigest: (() => void) | null = null
  let rotationCompleted = false
  let digestEnteredAfterRotation = false
  const digestReached = new Promise<void>((resolve) => { reachedDigest = resolve })
  const digestRelease = new Promise<void>((resolve) => { releaseDigest = resolve })
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    value: async (...args: Parameters<SubtleCrypto['digest']>) => {
      digestCalls += 1
      if (rotationCompleted) digestEnteredAfterRotation = true
      if (digestCalls === heldDigestCall) {
        reachedDigest?.()
        await digestRelease
      }
      return originalDigest(...args)
    },
  })
  try {
    const pendingRead = executeCodexCurrentDocumentRead({
      range: 'full',
      __readyResourceRead: {
        scopeId: 'scope-doc',
        requestBindingDigest: 'd'.repeat(64),
        anchor: first,
      },
    })
    await digestReached
    if (heldDigestCall === 7) {
      Object.defineProperty(subtle, 'digest', { configurable: true, value: originalDigest })
    }
    const second = await buildCodexCurrentDocumentAnchor('scope-doc')
    assert.ok(second)
    assert.equal(second.currentVersion, first.currentVersion)
    assert.ok(second.policyEpoch > first.policyEpoch)
    rotationCompleted = true
    releaseDigest?.()
    const stale = await pendingRead
    assert.equal(stale?.ok, false)
    assert.equal(stale?.bodyBytes, 0)
    assert.equal(JSON.stringify(stale).includes('POST_READ_ROTATION_SECRET'), false)
    if (heldDigestCall === 4) assert.equal(digestEnteredAfterRotation, false)
  } finally {
    releaseDigest?.()
    Object.defineProperty(subtle, 'digest', { configurable: true, value: originalDigest })
  }
}

test('policy rotation during post-read snapshot hashing rejects the old handle', async () => {
  await assertPolicyRotationWhileDigestPending(4)
})

test('policy rotation during final summary hashing rejects the old handle', async () => {
  await assertPolicyRotationWhileDigestPending(7)
})

test('publication receipt cannot be grafted across run, turn, call, action, version, or policy epoch', () => {
  const expected = {
    readyRunId: 'run-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'action-digest-1',
    logicalResourceId: 'resource-1',
    currentVersion: `sha256:${'a'.repeat(64)}`,
    currentDigest: 'a'.repeat(64),
    policyEpoch: 7,
    tabId: 'doc-1',
    pane: 'primary' as const,
    pathDigest: 'b'.repeat(64),
    incarnationKey: 'c'.repeat(64),
  }
  const modelVisibleText = 'current document body'
  const unsigned = {
    ...expected,
    operation: 'read_section',
    summaryDigest: createHash('sha256').update(modelVisibleText).digest('hex'),
    bodyBytes: Buffer.byteLength(modelVisibleText),
  }
  const receipt = { ...unsigned, receiptDigest: digestCanonicalJson(unsigned) }
  assert.equal(currentDocumentReadReceiptMatches(receipt, { ...expected, modelVisibleText }), true)
  for (const [key, value] of [
    ['readyRunId', 'run-2'],
    ['codexThreadId', 'thread-2'],
    ['codexTurnId', 'turn-2'],
    ['codexCallId', 'call-2'],
    ['readyActionId', 'action-2'],
    ['actionIdentityDigest', 'action-digest-2'],
    ['logicalResourceId', 'resource-2'],
    ['currentVersion', `sha256:${'b'.repeat(64)}`],
    ['currentDigest', 'b'.repeat(64)],
    ['policyEpoch', 8],
    ['tabId', 'doc-2'],
    ['pane', 'split'],
    ['pathDigest', 'e'.repeat(64)],
    ['incarnationKey', 'f'.repeat(64)],
  ] as const) {
    assert.equal(currentDocumentReadReceiptMatches(
      { ...receipt, [key]: value },
      { ...expected, modelVisibleText },
    ), false, key)
  }
  assert.equal(currentDocumentReadReceiptMatches(
    { ...receipt, bodyBytes: 0 },
    { ...expected, modelVisibleText },
  ), false)
  assert.equal(currentDocumentReadReceiptMatches(
    { ...receipt, summaryDigest: 'summary-digest' },
    { ...expected, modelVisibleText },
  ), false)
  assert.equal(currentDocumentReadReceiptMatches(
    receipt,
    { ...expected, modelVisibleText: 'different model-visible text' },
  ), false)
  assert.equal(currentDocumentReadReceiptMatches(
    { ...receipt, receiptDigest: 'forged' },
    { ...expected, modelVisibleText },
  ), false)
})
