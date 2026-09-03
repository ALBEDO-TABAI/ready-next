import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST,
  buildTerminalNativeReadbackReceipt,
  resolveCodexHistoryObservation,
} from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexProductRunPreparer } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { CodexTurnCollector, type CoreTurnCandidate } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import type { CodexNativeRuntime, CodexThread, CodexTurn } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

test('continuation-safe seam is pinned to the machine-readable runtime probe receipt', () => {
  const receipt = JSON.parse(readFileSync(
    'assets/codex-runtime/evidence/continuation-safe-probe-receipt.json',
    'utf8',
  )) as Record<string, unknown>
  const { receiptDigest, ...unsigned } = receipt
  assert.equal(receiptDigest, CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST)
  assert.equal(digestCanonicalJson(unsigned), receiptDigest)
  const manifest = JSON.parse(readFileSync('assets/codex-runtime/runtime-manifest.json', 'utf8'))
  const schema = JSON.parse(readFileSync(
    'assets/codex-runtime/schemas/stable/codex_app_server_protocol.v2.schemas.json',
    'utf8',
  ))
  assert.equal(receipt.binarySha256, manifest.binarySha256)
  assert.equal(receipt.runtimeManifestDigest, digestCanonicalJson(manifest))
  assert.equal(receipt.stableV2SchemaDigest, digestCanonicalJson(schema))
})

const currentInput = textUserInput('再详细一点')
const preparedResult = new CodexProductRunPreparer().prepare({
  taskId: 'task-b',
  runId: 'run-b',
  requestId: 'request-b',
  scopeId: 'scope-1',
  aliasId: 'scope-1',
  aliasGeneration: 1,
  taskOrigin: 'user_root',
  runOrigin: 'initial',
  originUserMessageId: 'message-b',
  reservationSetId: 'reservation-b',
  reservationEvidenceDigest: 'reservation-evidence-b',
  currentInput: [currentInput],
  explicitResourceEnvelope: { input: [], resourceRefs: [] },
  resourceAdditionalContext: [],
  trustedWorkbenchMode: 'browser',
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
  readyMemorySnapshot: disabledReadyMemorySnapshot(),
  ...createCodexToolFixture(),
  authorizationOwnerId: 'owner-b',
  resourceOwnerId: 'resource-owner-b',
  productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
})
if (!preparedResult.ok) throw new Error('fixture_prepare_failed')
const prepared = preparedResult.prepared

function candidate(): Extract<CoreTurnCandidate, { kind: 'native_terminal' }> {
  return {
    kind: 'native_terminal',
    readyTaskId: 'task-b',
    readyRunId: 'run-b',
    scopeId: 'scope-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-b',
    engineOutcome: 'failed',
    candidateSelection: { kind: 'none', code: 'terminal_not_completed' },
    candidateText: null,
    candidateDigest: null,
    usedToolCalls: [],
    actionReceiptRefs: [],
    interactionState: null,
    waitingFor: null,
    terminalReasonCandidate: 'blocked_external',
    abortInitiator: null,
    budgetState: {},
    contextState: {},
    providerDiagnostics: {},
    contextUsage: null,
    recoveryCheckpointRef: null,
    browserContinuationRef: null,
    browserProofRefs: [],
    otherProofRefs: [],
    projectionPatchRefs: [],
    runtimeDiagnostics: {
      finalDeltaItemIds: [],
      commentaryItemIds: [],
      nativeTurnError: 'stream disconnected',
    },
  }
}

function thread(items: CodexThread['turns'][number]['items']): CodexThread {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/tmp/ready',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.149.0',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 2,
    turns: [{ id: 'turn-b', status: 'failed', error: { message: 'disconnected' }, items }],
  }
}

const userItem = {
  type: 'userMessage' as const,
  id: 'native-user-b',
  clientId: 'request-b',
  content: [currentInput],
}

const safeGateway = [{
  requestKind: 'product' as const, responseSequence: 2,
  failure: {
    failureClass: 'provider' as const, failureStage: 'headers' as const,
    responseIdentitySeen: false, partialAssistantItemSeen: false, toolCallItemSeen: false,
    elapsedMs: 16, eventCount: 0, wireByteCount: 0, causeCode: 'gateway_upstream_http_400',
  },
}]

test('lossy native readback cannot erase observed wire or collector suffixes', () => {
  const resolve = (gatewayEvidence: typeof safeGateway, currentCandidate = candidate()) => (
    resolveCodexHistoryObservation({
      candidate: currentCandidate, prepared, expectedClientUserMessageId: 'request-b',
      thread: thread([userItem]), publicationDiverged: false, gatewayEvidence,
    })
  )
  assert.equal(resolve(safeGateway).kind, 'continuation_safe')
  assert.equal(resolve([]).kind, 'diverged')
  for (const field of ['partialAssistantItemSeen', 'toolCallItemSeen'] as const) {
    const partial = [{ ...safeGateway[0], failure: { ...safeGateway[0].failure, [field]: true } }]
    assert.equal(resolve(partial).kind, 'diverged')
    assert.equal(resolve([...partial, ...safeGateway]).kind, 'diverged')
  }
  for (const field of ['finalDeltaItemIds', 'commentaryItemIds'] as const) {
    assert.equal(resolve(safeGateway, {
      ...candidate(), runtimeDiagnostics: { ...candidate().runtimeDiagnostics, [field]: ['partial'] },
    }).kind, 'diverged')
  }
  assert.equal(resolve([{ ...safeGateway[0], failure: {
    ...safeGateway[0].failure, causeCode: 'gateway_upstream_http_401',
  } }]).kind, 'diverged', 'an unprobed seam is not inferred from a nearby HTTP code')
})

test('a failed user-only native turn is the one continuation-safe seam', () => {
  const nativeThread = thread([userItem])
  const observation = resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: candidate(), prepared, expectedClientUserMessageId: 'request-b',
    thread: nativeThread, publicationDiverged: false,
  })
  assert.equal(observation.kind, 'continuation_safe')
  if (observation.kind !== 'continuation_safe') return
  assert.equal(observation.seamId, 'failed_user_only_no_suffix_v1')
  assert.match(observation.retainedFormalInputMappingDigest, /^[a-f0-9]{64}$/)
})

test('an unprobed interrupted seam is not inferred safe from missing native items', () => {
  const interruptedCandidate = {
    ...candidate(),
    engineOutcome: 'interrupted' as const,
    terminalReasonCandidate: 'cancelled_user',
  }
  const interruptedThread = {
    ...thread([userItem]),
    turns: [{
      id: 'turn-b', status: 'interrupted' as const,
      error: { message: 'cancelled' }, items: [userItem],
    }],
  }
  const observation = resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: interruptedCandidate,
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: interruptedThread,
    publicationDiverged: false,
  })
  assert.deepEqual(observation, { kind: 'diverged', reason: 'unprobed_failure_seam' })
})

test('partial assistant, tool/compaction suffix, and input mismatch never continue in place', () => {
  const cases = [
    {
      items: [userItem, { type: 'agentMessage' as const, id: 'partial', text: '一半', phase: 'final_answer' as const }],
      expected: 'diverged',
    },
    {
      items: [userItem, {
        type: 'dynamicToolCall' as const,
        id: 'call-1',
        tool: 'web_search',
        namespace: null,
        arguments: {},
        status: 'inProgress' as const,
      }],
      expected: 'diverged',
    },
    {
      items: [userItem, {
        type: 'contextCompaction' as const,
        id: 'compact-failed',
      }],
      expected: 'unknown_reset_required',
    },
    {
      items: [{ ...userItem, clientId: 'foreign-message' }],
      expected: 'unknown_reset_required',
    },
  ]
  for (const fixture of cases) {
    assert.equal(resolveCodexHistoryObservation({
      gatewayEvidence: safeGateway,
      candidate: candidate(), prepared, expectedClientUserMessageId: 'request-b',
      thread: thread(fixture.items),
      publicationDiverged: false,
    }).kind, fixture.expected)
  }
})

test('automatic compaction is safe only with the exact completed exchange and readback', () => {
  const compactionItem = {
    type: 'contextCompaction' as const,
    id: 'compact-completed',
  }
  const agentItem = {
    type: 'agentMessage' as const,
    id: 'answer-completed',
    text: 'answer',
    phase: 'final_answer' as const,
  }
  const completedThread = {
    ...thread([]),
    turns: [{
      id: 'turn-b', status: 'completed' as const, error: null,
      items: [userItem, compactionItem, agentItem],
    }],
  }
  const exactEvidence = {
    threadId: 'thread-1', turnId: 'turn-b',
    threadReadDigest: digestCanonicalJson(completedThread),
    automaticRequestReceiptId: 'automatic-request',
    automaticRequestEvidenceDigest: 'automatic-request-evidence',
    automaticResponseEvidenceDigest: 'automatic-response-evidence',
    successorProductRequestReceiptId: 'successor-request',
    successorProductRequestEvidenceDigest: 'successor-request-evidence',
    successorProductResponseEvidenceDigest: 'successor-response-evidence',
    automaticRequestSequence: 1, automaticResponseSequence: 2,
    successorProductRequestSequence: 3, successorProductResponseSequence: 4,
  }
  const completedCandidate = {
    ...candidate(),
    engineOutcome: 'completed' as const,
    candidateSelection: { kind: 'accepted' as const, itemId: agentItem.id },
    candidateText: agentItem.text,
    candidateDigest: createHash('sha256').update(agentItem.text).digest('hex'),
    contextState: { automaticCompactionExchanges: [exactEvidence] },
  }
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: completedCandidate,
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: completedThread,
    publicationDiverged: false,
  }).kind, 'continuation_safe')
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: { ...completedCandidate, contextState: { automaticCompactionExchanges: [] } },
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: completedThread,
    publicationDiverged: false,
  }).kind, 'unknown_reset_required')
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: completedCandidate,
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: completedThread,
    publicationDiverged: true,
  }).kind, 'unknown_reset_required')
})

test('completed history uses the accepted text because native readback item ids are lossy', () => {
  const accepted = {
    ...candidate(),
    engineOutcome: 'completed' as const,
    candidateSelection: { kind: 'accepted' as const, itemId: 'provider-message-id' },
    candidateText: 'accepted answer',
    candidateDigest: digestCanonicalJson('accepted answer'),
  }
  const nativeThread = {
    ...thread([]),
    turns: [{
      id: 'turn-b', status: 'completed' as const, error: null,
      items: [userItem, {
        type: 'agentMessage' as const,
        id: 'item-2',
        text: 'accepted answer',
        phase: 'final_answer' as const,
      }],
    }],
  }
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: accepted,
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: nativeThread,
    publicationDiverged: false,
  }).kind, 'continuation_safe')
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: accepted,
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: {
      ...nativeThread,
      turns: [{
        ...nativeThread.turns[0],
        items: [userItem, { ...nativeThread.turns[0].items[1], text: 'foreign answer' }],
      }],
    },
    publicationDiverged: false,
  }).kind, 'diverged')
})

test('completed history consumes the collector selection with commentary and pre-tool messages', () => {
  // buildReadbackCandidate is synchronous and never calls the native runtime.
  const collector = new CodexTurnCollector({} as CodexNativeRuntime)
  const final = {
    type: 'agentMessage' as const, id: 'provider-final',
    text: 'accepted answer', phase: 'final_answer' as const,
  }
  const commentary = {
    type: 'agentMessage' as const, id: 'provider-commentary',
    text: final.text, phase: 'commentary' as const,
  }
  const preamble = { ...final, id: 'provider-preamble', text: 'I will read it.' }
  const tool = {
    type: 'dynamicToolCall' as const, id: 'provider-tool',
    tool: 'document_read_section', namespace: null, arguments: {},
    status: 'completed' as const, success: true,
  }
  const cases = [
    [commentary, final],
    [preamble, tool, final],
    [commentary, preamble, tool, final],
    [{ ...preamble, text: final.text }, tool, final],
  ]
  for (const items of cases) {
    const nativeTurn: CodexTurn = {
      id: 'turn-b', status: 'completed', error: null, items: [userItem, ...items],
    }
    const accepted = collector.buildReadbackCandidate({
      ...candidate(), allowNullPhaseFallback: false,
    }, nativeTurn)
    assert.deepEqual(accepted.candidateSelection, { kind: 'accepted', itemId: final.id })
    assert.equal(accepted.kind, 'native_terminal')
    if (accepted.kind !== 'native_terminal') continue
    const readbackTurn = {
      ...nativeTurn,
      items: nativeTurn.items.map((item, index) => ({ ...item, id: `item-${index}` })),
    }
    assert.equal(resolveCodexHistoryObservation({
      gatewayEvidence: safeGateway,
      candidate: accepted, prepared, expectedClientUserMessageId: 'request-b',
      thread: { ...thread([]), turns: [readbackTurn] }, publicationDiverged: false,
    }).kind, 'continuation_safe')
  }
})

test('completed history rejects ambiguous finals and illegal suffixes using the collector rules', () => {
  const collector = new CodexTurnCollector({} as CodexNativeRuntime)
  const final = {
    type: 'agentMessage' as const, id: 'provider-final',
    text: 'accepted answer', phase: 'final_answer' as const,
  }
  const accepted = collector.buildReadbackCandidate({
    ...candidate(), allowNullPhaseFallback: false,
  }, { id: 'turn-b', status: 'completed', error: null, items: [userItem, final] })
  assert.equal(accepted.kind, 'native_terminal')
  if (accepted.kind !== 'native_terminal') return
  const readbackFinal = { ...final, id: 'item-2' }
  const cases: Array<{ items: CodexTurn['items']; code: string }> = [
    {
      items: [readbackFinal, { ...final, id: 'item-3' }],
      code: 'multiple_explicit_finals',
    },
    {
      items: [readbackFinal, { ...final, id: 'item-3', phase: null }],
      code: 'null_after_explicit_final',
    },
    {
      items: [readbackFinal, {
        type: 'dynamicToolCall', id: 'item-3', tool: 'document_read_section',
        namespace: null, arguments: {}, status: 'completed', success: true,
      }],
      code: 'no_legal_candidate',
    },
    { items: [{ ...readbackFinal, phase: 'commentary' }], code: 'no_legal_candidate' },
    { items: [{ ...readbackFinal, phase: null }], code: 'no_legal_candidate' },
  ]
  for (const entry of cases) {
    const nativeTurn: CodexTurn = {
      id: 'turn-b', status: 'completed', error: null, items: [userItem, ...entry.items],
    }
    assert.deepEqual(collector.buildReadbackCandidate({
      ...candidate(), allowNullPhaseFallback: false,
    }, nativeTurn).candidateSelection, { kind: 'protocol_failure', code: entry.code })
    assert.equal(resolveCodexHistoryObservation({
      gatewayEvidence: safeGateway,
      candidate: accepted, prepared, expectedClientUserMessageId: 'request-b',
      thread: { ...thread([]), turns: [nativeTurn] }, publicationDiverged: false,
    }).kind, 'diverged')
  }
  assert.equal(resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: accepted, prepared, expectedClientUserMessageId: 'request-b',
    thread: {
      ...thread([]),
      turns: [{
        id: 'turn-b', status: 'completed', error: null,
        items: [userItem, { ...readbackFinal, phase: 'commentary' }, {
          ...readbackFinal, id: 'item-3', text: 'foreign final',
        }],
      }],
    },
    publicationDiverged: false,
  }).kind, 'diverged')
})

test('terminal readback receipt freezes exact native identity and item digests', () => {
  const receipt = buildTerminalNativeReadbackReceipt({
    candidate: candidate(),
    prepared,
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    connectionEpoch: 'epoch-1',
    turnRevision: 3,
    thread: thread([userItem]),
  })
  assert.equal(receipt.codexTurnId, 'turn-b')
  assert.deepEqual(receipt.orderedTurnIds, ['turn-b'])
  assert.equal(receipt.terminalTurnItemDigests.length, 1)
  assert.match(receipt.digest, /^[a-f0-9]{64}$/)
})
