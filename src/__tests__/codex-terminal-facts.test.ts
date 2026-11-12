import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST,
  buildTerminalNativeReadbackReceipt,
  resolveCodexHistoryObservation,
  type CodexHistoryGatewayExchange,
} from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
import { digestCanonicalJson, type CodexModelGatewayFailureEvidence } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexProductRunPreparer } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import type { CodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { CodexTurnCollector, type CoreTurnCandidate } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import type { CodexNativeRuntime, CodexThread, CodexTurn } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

test('continuation-safe seam is pinned to the machine-readable runtime probe receipt', () => {
  const receipt = JSON.parse(readFileSync(
    'assets/codex-runtime/evidence/continuation-safe-probe-receipt-v7.json',
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
  const prior = JSON.parse(readFileSync('assets/codex-runtime/evidence/continuation-safe-probe-receipt-v6.json', 'utf8'))
  const { receiptDigest: priorDigest, ...priorUnsigned } = prior
  assert.equal(digestCanonicalJson(priorUnsigned), priorDigest)
  assert.deepEqual(receipt.derivation, {
    evidenceKind: 'additive_host_gateway_lineage_contract',
    priorTargetManifestDigest: prior.runtimeManifestDigest,
    priorReceiptDigest: priorDigest,
  })
  const behavior = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['contract', 'runtimeManifestDigest', 'derivation'].includes(key)))
  assert.deepEqual(behavior(unsigned), behavior(priorUnsigned), 'all native failure-seam evidence is retained unchanged')
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

function thread(
  items: CodexThread['turns'][number]['items'],
  historyMode: CodexThread['historyMode'] = 'paginated',
): CodexThread {
  return {
    id: 'thread-1',
    sessionId: 'session-1',
    historyMode,
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

test('quota rejection with no output retains the thread, but uncertain failures do not', () => {
  const quotaThread = thread([userItem])
  quotaThread.turns[0].error = { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }
  const quotaGateway = [{ ...safeGateway[0], failure: {
    ...safeGateway[0].failure, causeCode: 'gateway_upstream_http_429',
  } }]
  const resolve = (nativeThread = quotaThread, gatewayEvidence = quotaGateway, currentCandidate = candidate()) => (
    resolveCodexHistoryObservation({
      candidate: currentCandidate, prepared, expectedClientUserMessageId: 'request-b',
      thread: nativeThread, publicationDiverged: false, gatewayEvidence,
    })
  )
  assert.equal(resolve().kind, 'continuation_safe')
  assert.equal(resolve(thread([userItem])).kind, 'continuation_safe', 'a plain 429 is a probed transient wire')
  assert.equal(resolve(quotaThread, []).kind, 'diverged')
  assert.equal(resolve(quotaThread, [...quotaGateway, ...quotaGateway]).kind, 'diverged')
  for (const field of ['responseIdentitySeen', 'partialAssistantItemSeen', 'toolCallItemSeen'] as const) {
    assert.equal(resolve(quotaThread, [{ ...quotaGateway[0], failure: {
      ...quotaGateway[0].failure, [field]: true,
    } }]).kind, 'diverged')
  }
  assert.equal(resolve(quotaThread, quotaGateway, {
    ...candidate(), runtimeDiagnostics: { ...candidate().runtimeDiagnostics, finalDeltaItemIds: ['partial'] },
  }).kind, 'diverged')
})

test('completed resource input is checked against the pinned native history projection', () => {
  const resourceInput = [
    { type: 'text' as const, text: 'project directory', text_elements: [] as [] },
    { type: 'mention' as const, name: 'project', path: '/tmp/project' },
    { type: 'image' as const, url: 'data:image/png;base64,fixture', detail: null },
  ]
  const resourcePrepared = { ...prepared, ingress: { ...prepared.ingress,
    explicitResourceEnvelope: { input: resourceInput, resourceRefs: [] },
  } }
  const accepted = { ...candidate(), engineOutcome: 'completed' as const,
    candidateSelection: { kind: 'accepted' as const, itemId: 'answer' }, candidateText: 'done',
  }
  // A paginated thread reads every item back exactly, in order; a legacy one (created before 0.160.1, or forked
  // from such a thread) joins the text and drops the mention. Each thread is checked against its own shape.
  const exact = [textUserInput(currentInput.text), ...resourceInput]
  const joined = [textUserInput(currentInput.text + 'project directory'), resourceInput[2]]
  const resolve = (historyMode: CodexThread['historyMode'], content: CodexUserInput[]) => (
    resolveCodexHistoryObservation({
      candidate: accepted, prepared: resourcePrepared, expectedClientUserMessageId: 'request-b',
      thread: { ...thread([], historyMode), turns: [{ id: 'turn-b', status: 'completed', error: null,
        items: [{ ...userItem, content }, { type: 'agentMessage', id: 'answer', text: 'done', phase: 'final_answer' }],
      }] }, publicationDiverged: false, gatewayEvidence: [],
    }).kind
  )
  assert.equal(resolve('paginated', exact), 'continuation_safe')
  assert.equal(resolve('legacy', joined), 'continuation_safe')
  assert.equal(resolve('paginated', joined), 'unknown_reset_required')
  assert.equal(resolve('legacy', exact), 'unknown_reset_required')
  assert.equal(resolve('paginated', [textUserInput(currentInput.text), resourceInput[0], resourceInput[2]]),
    'unknown_reset_required')
  assert.equal(resolve('paginated', [...exact, textUserInput('foreign')]), 'unknown_reset_required')
  assert.equal(resolve('legacy', [...joined, textUserInput('foreign')]), 'unknown_reset_required')
})

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

test('a transient upstream failure on the first request keeps the user-only turn in place', () => {
  const resolve = (failure: Partial<CodexModelGatewayFailureEvidence>) => resolveCodexHistoryObservation({
    candidate: candidate(), prepared, expectedClientUserMessageId: 'request-b',
    thread: thread([userItem]), publicationDiverged: false,
    gatewayEvidence: [{ ...safeGateway[0], failure: { ...safeGateway[0].failure, ...failure } }],
  })
  for (const causeCode of ['gateway_upstream_http_500', 'gateway_upstream_http_503', 'gateway_upstream_http_524']) {
    const observation = resolve({ causeCode })
    assert.equal(observation.kind, 'continuation_safe', causeCode)
    if (observation.kind === 'continuation_safe') assert.equal(observation.seamId, 'failed_user_only_no_suffix_v1')
  }
  for (const causeCode of ['gateway_upstream_headers_deadline', 'gateway_upstream_transport_failed']) {
    assert.equal(resolve({ causeCode, failureClass: 'transport', failureStage: 'connect' }).kind,
      'continuation_safe', causeCode)
  }
  for (const causeCode of ['gateway_upstream_http_401', 'gateway_upstream_http_501', 'gateway_upstream_http_505',
    'gateway_upstream_http_599', 'gateway_request_forward_failed']) {
    assert.deepEqual(resolve({ causeCode }), { kind: 'diverged', reason: 'unprobed_failure_seam' }, causeCode)
  }
  const afterResponseBegan = resolve({ causeCode: 'gateway_native_stream_failed', failureStage: 'stream-before-item' })
  assert.equal(afterResponseBegan.kind === 'continuation_safe' && afterResponseBegan.seamId, 'failed_mid_stream_v1')
  assert.equal(resolve({ causeCode: 'gateway_upstream_http_500', wireByteCount: 12 }).kind, 'diverged')
})

test('a transient failure after completed tool rounds keeps those rounds on the same thread', () => {
  const commentary = { type: 'agentMessage' as const, id: 'commentary-b', text: '先核对原文', phase: 'commentary' as const }
  const toolItem = {
    type: 'dynamicToolCall' as const, id: 'call-1', tool: 'file_read_excerpt', namespace: null,
    arguments: {}, status: 'completed' as const,
  }
  const completedRound: CodexHistoryGatewayExchange = { requestKind: 'product', responseSequence: 2, failure: null }
  const failedFailure: CodexModelGatewayFailureEvidence = { ...safeGateway[0].failure, causeCode: 'gateway_upstream_http_500' }
  const failedRound: CodexHistoryGatewayExchange = { ...safeGateway[0], responseSequence: 6, failure: failedFailure }
  const roundsCandidate = () => ({
    ...candidate(),
    usedToolCalls: [{ callId: 'call-1', name: 'file_read_excerpt' }] as unknown as ReturnType<typeof candidate>['usedToolCalls'],
    runtimeDiagnostics: { ...candidate().runtimeDiagnostics, commentaryItemIds: ['commentary-b'] },
  })
  const resolve = (overrides: {
    items?: CodexThread['turns'][number]['items']
    gatewayEvidence?: CodexHistoryGatewayExchange[]
    candidate?: ReturnType<typeof candidate>
    publicationDiverged?: boolean
  } = {}) => resolveCodexHistoryObservation({
    candidate: overrides.candidate ?? roundsCandidate(), prepared, expectedClientUserMessageId: 'request-b',
    thread: thread(overrides.items ?? [userItem, commentary, toolItem]),
    publicationDiverged: overrides.publicationDiverged ?? false,
    gatewayEvidence: overrides.gatewayEvidence ?? [completedRound, { ...completedRound, responseSequence: 4 }, failedRound],
  })
  const observation = resolve()
  assert.equal(observation.kind, 'continuation_safe')
  if (observation.kind !== 'continuation_safe') return
  assert.equal(observation.seamId, 'failed_after_completed_rounds_v1')
  assert.equal(resolve({ items: [userItem, commentary] }).kind, 'continuation_safe', 'readback omits dynamic tool calls')

  const diverged = [
    resolve({ gatewayEvidence: [failedRound] }),
    resolve({ gatewayEvidence: [{ ...failedRound, responseSequence: 2 }, failedRound] }),
    resolve({ gatewayEvidence: [completedRound, { ...failedRound, failure: { ...failedFailure, causeCode: 'gateway_upstream_http_400' } }] }),
    resolve({ gatewayEvidence: [completedRound, { ...failedRound, failure: { ...failedFailure, partialAssistantItemSeen: true } }] }),
    resolve({ gatewayEvidence: [completedRound, { ...failedRound, failure: { ...failedFailure, toolCallItemSeen: true } }] }),
    resolve({ items: [userItem, { ...commentary, phase: 'final_answer' }, toolItem] }),
    resolve({ items: [userItem, { ...commentary, phase: null }, toolItem] }),
    resolve({ items: [userItem, commentary, { ...toolItem, status: 'inProgress' }] }),
    resolve({ candidate: { ...roundsCandidate(), runtimeDiagnostics: {
      ...roundsCandidate().runtimeDiagnostics, finalDeltaItemIds: ['answer-partial'],
    } } }),
    resolve({ publicationDiverged: true }),
  ]
  for (const [index, result] of diverged.entries()) assert.equal(result.kind, 'diverged', String(index))
  const interruptedThread = thread([userItem, commentary, toolItem])
  interruptedThread.turns[0].status = 'interrupted'
  assert.equal(resolveCodexHistoryObservation({
    candidate: { ...roundsCandidate(), engineOutcome: 'interrupted' }, prepared,
    expectedClientUserMessageId: 'request-b', thread: interruptedThread, publicationDiverged: false,
    gatewayEvidence: [completedRound, failedRound],
  }).kind, 'diverged', 'a user stop is not a provider failure seam')
  assert.equal(resolve({ items: [userItem, commentary, { type: 'contextCompaction', id: 'compact' }] }).kind,
    'unknown_reset_required')
  assert.equal(resolve({ gatewayEvidence: [{ ...completedRound, requestKind: 'automatic_compaction' }, failedRound] }).kind,
    'unknown_reset_required')
})

test('a stream that breaks after its response began keeps the completed rounds and items', () => {
  const commentary = { type: 'agentMessage' as const, id: 'commentary-b', text: '开始写文档', phase: 'commentary' as const }
  const toolItem = {
    type: 'dynamicToolCall' as const, id: 'call-1', tool: 'file_read_excerpt', namespace: null,
    arguments: {}, status: 'completed' as const,
  }
  const completedRound: CodexHistoryGatewayExchange = { requestKind: 'product', responseSequence: 2, failure: null }
  // The 2026-10-05 failure: a long tool call held by the gateway until the runtime's idle timeout closed the stream.
  const brokenStream: CodexModelGatewayFailureEvidence = {
    failureClass: 'transport', failureStage: 'stream-after-item', responseIdentitySeen: true,
    partialAssistantItemSeen: true, toolCallItemSeen: true, elapsedMs: 306_312, eventCount: 10,
    wireByteCount: 2_587_638, causeCode: 'gateway_native_stream_failed',
  }
  const brokenRound: CodexHistoryGatewayExchange = { requestKind: 'product', responseSequence: 74, failure: brokenStream }
  const resolve = (overrides: {
    items?: CodexThread['turns'][number]['items']
    gatewayEvidence?: CodexHistoryGatewayExchange[]
    failure?: Partial<CodexModelGatewayFailureEvidence>
    finalDeltas?: string[]
  } = {}) => resolveCodexHistoryObservation({
    candidate: { ...candidate(), runtimeDiagnostics: { ...candidate().runtimeDiagnostics,
      commentaryItemIds: ['commentary-b'], finalDeltaItemIds: overrides.finalDeltas ?? [] } },
    prepared, expectedClientUserMessageId: 'request-b',
    thread: thread(overrides.items ?? [userItem, commentary, toolItem, commentary]),
    publicationDiverged: false,
    gatewayEvidence: overrides.gatewayEvidence
      ?? [completedRound, { ...completedRound, responseSequence: 4 }, { ...brokenRound, failure: { ...brokenStream, ...overrides.failure } }],
  })
  for (const failure of [{}, { failureStage: 'terminal-validation' as const }, { failureStage: 'stream-before-item' as const,
    partialAssistantItemSeen: false, toolCallItemSeen: false }, { causeCode: 'gateway_native_event_idle_timeout' }]) {
    const observation = resolve({ failure })
    assert.equal(observation.kind === 'continuation_safe' && observation.seamId, 'failed_mid_stream_v1', JSON.stringify(failure))
  }
  assert.equal(resolve({ gatewayEvidence: [brokenRound], items: [userItem, commentary] }).kind, 'continuation_safe',
    'the first request breaking after a completed commentary item')

  assert.equal(resolve({ failure: { failureStage: 'post-terminal' } }).kind, 'diverged', 'a provider-declared failure is not this wire')
  assert.equal(resolve({ finalDeltas: ['answer-partial'] }).kind, 'diverged', 'a partly shown answer is not in history')
  assert.equal(resolve({ items: [userItem, { ...commentary, phase: 'final_answer' }] }).kind, 'diverged')
  assert.equal(resolve({ items: [userItem, commentary, { ...toolItem, status: 'inProgress' }] }).kind, 'diverged')
  assert.equal(resolve({ gatewayEvidence: [{ ...brokenRound, responseSequence: 2 }, brokenRound] }).kind, 'diverged')
  assert.equal(resolve({ gatewayEvidence: [completedRound, { ...brokenRound, responseSequence: null }] }).kind, 'diverged')
  assert.equal(resolve({ items: [userItem, commentary, { type: 'contextCompaction', id: 'compact' }] }).kind,
    'unknown_reset_required')
  const stopped = thread([userItem, commentary])
  stopped.turns[0].status = 'interrupted'
  const stop = resolveCodexHistoryObservation({
    candidate: { ...candidate(), engineOutcome: 'interrupted' }, prepared, expectedClientUserMessageId: 'request-b',
    thread: stopped, publicationDiverged: false, gatewayEvidence: [completedRound, brokenRound],
  })
  assert.equal(stop.kind === 'continuation_safe' && stop.seamId, 'interrupted_after_completed_items_v1', 'a user stop is its own seam')
})

test('a user stop keeps the finished rounds on the same thread unless an answer was half shown', () => {
  const commentary = { type: 'agentMessage' as const, id: 'commentary-b', text: '先读到第三章', phase: 'commentary' as const }
  const toolItem = {
    type: 'dynamicToolCall' as const, id: 'call-1', tool: 'file_read_excerpt', namespace: null,
    arguments: {}, status: 'completed' as const,
  }
  const completedRound: CodexHistoryGatewayExchange = { requestKind: 'product', responseSequence: 2, failure: null }
  const brokenStream: CodexModelGatewayFailureEvidence = {
    failureClass: 'transport', failureStage: 'stream-after-item', responseIdentitySeen: true,
    partialAssistantItemSeen: true, toolCallItemSeen: false, elapsedMs: 8_000, eventCount: 6,
    wireByteCount: 4_096, causeCode: 'gateway_native_stream_failed',
  }
  const resolve = (overrides: {
    items?: CodexThread['turns'][number]['items']
    gatewayEvidence?: CodexHistoryGatewayExchange[]
    finalDeltas?: string[]
    outcome?: 'interrupted' | 'failed'
  } = {}) => {
    const nativeThread = thread(overrides.items ?? [userItem, commentary, toolItem])
    nativeThread.turns[0].status = overrides.outcome ?? 'interrupted'
    return resolveCodexHistoryObservation({
      candidate: { ...candidate(), engineOutcome: overrides.outcome ?? 'interrupted', terminalReasonCandidate: 'cancelled_user',
        runtimeDiagnostics: { ...candidate().runtimeDiagnostics, finalDeltaItemIds: overrides.finalDeltas ?? [] } },
      prepared, expectedClientUserMessageId: 'request-b', thread: nativeThread, publicationDiverged: false,
      gatewayEvidence: overrides.gatewayEvidence ?? [completedRound, { ...completedRound, responseSequence: 4 }],
    })
  }
  const kept = [
    resolve(),
    resolve({ gatewayEvidence: [completedRound, { requestKind: 'product', responseSequence: 6, failure: brokenStream }] }),
    resolve({ items: [userItem], gatewayEvidence: [] }),
    resolve({ items: [userItem, commentary, { ...toolItem, status: 'failed' }] }),
  ]
  for (const [index, observation] of kept.entries()) {
    assert.equal(observation.kind === 'continuation_safe' && observation.seamId, 'interrupted_after_completed_items_v1', String(index))
  }
  const setAside = [
    resolve({ finalDeltas: ['answer-partial'] }),
    resolve({ items: [userItem, { ...commentary, phase: 'final_answer' }] }),
    resolve({ items: [userItem, commentary, { ...toolItem, status: 'inProgress' }] }),
    resolve({ gatewayEvidence: [{ ...completedRound, failure: brokenStream }, completedRound] }),
    resolve({ gatewayEvidence: [completedRound, { requestKind: 'product', responseSequence: null, failure: null }] }),
    resolve({ gatewayEvidence: [completedRound, { requestKind: 'product', responseSequence: 6, failure: {
      ...brokenStream, failureStage: 'headers', causeCode: 'gateway_upstream_http_400' } }] }),
  ]
  for (const [index, observation] of setAside.entries()) assert.equal(observation.kind, 'diverged', String(index))
  assert.equal(resolve({ items: [userItem, commentary, { type: 'contextCompaction', id: 'compact' }] }).kind, 'unknown_reset_required')
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

  // 2026-10-06: a long tool loop compacts mid-turn, possibly more than once; one ordered pair per compaction item.
  const twiceThread = {
    ...completedThread,
    turns: [{ ...completedThread.turns[0], items: [userItem, compactionItem, { ...compactionItem, id: 'compact-2' }, agentItem] }],
  }
  const firstPair = { ...exactEvidence, threadReadDigest: digestCanonicalJson(twiceThread) }
  const secondPair = {
    ...firstPair,
    automaticRequestReceiptId: 'automatic-request-2', successorProductRequestReceiptId: 'successor-request-2',
    automaticRequestSequence: 5, automaticResponseSequence: 6,
    successorProductRequestSequence: 7, successorProductResponseSequence: 8,
  }
  const observeTwice = (exchanges: unknown[]) => resolveCodexHistoryObservation({
    gatewayEvidence: safeGateway,
    candidate: { ...completedCandidate, contextState: { automaticCompactionExchanges: exchanges } },
    prepared,
    expectedClientUserMessageId: 'request-b',
    thread: twiceThread,
    publicationDiverged: false,
  }).kind
  assert.equal(observeTwice([firstPair, secondPair]), 'continuation_safe')
  assert.equal(observeTwice([firstPair]), 'unknown_reset_required', 'a compaction Ready did not verify')
  assert.equal(observeTwice([secondPair, firstPair]), 'unknown_reset_required', 'pairs out of order')
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
