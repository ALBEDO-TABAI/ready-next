import type { ProductTurnReceipt } from '../../../../shared/ipc-contracts/agent-runtime'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import { selectCodexTerminalCandidate, type CoreTurnCandidate } from './codex-turn-collector'
import type { CodexThread } from './codex-native-runtime'
import { projectCodexUserInputReadback } from './codex-user-input'
import { digestCanonicalJson, type CodexModelGatewayFailureEvidence, type CodexModelGatewayRequestKind } from './codex-model-gateway-contract'

type NativeCandidate = Extract<CoreTurnCandidate, { kind: 'native_terminal' }>

export type CodexHistoryGatewayExchange = {
  requestKind: CodexModelGatewayRequestKind
  responseSequence: number | null
  failure: CodexModelGatewayFailureEvidence | null
}

type CodexTerminalEvidenceRefBase = {
  evidenceRefId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  aliasGeneration: number
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  revision: number
  digest: string
}

export type CodexTerminalEvidenceRef =
  | (CodexTerminalEvidenceRefBase & {
      kind: 'native_turn'
      receiptId: string
      ownerIdentity: { nativeTurnId: string; terminalStatus: 'completed' | 'interrupted' | 'failed' }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'native_readback'
      receiptId: string
      ownerIdentity: {
        connectionEpoch: string
        readRevision: number
        verifiedThreadId: string
        verifiedTurnId: string
      }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'gateway'
      receiptId: string
      ownerIdentity: { gatewayRequestReceiptId: string; eventSequence: number }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'publication'
      receiptId: string
      ownerIdentity: { publicationReceiptId: string }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'verifier'
      receiptId: string
      ownerIdentity: { verifierAttemptId: string }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'artifact'
      receiptId: string
      ownerIdentity: { artifactReceiptId: string }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'lifecycle'
      receiptId: string
      ownerIdentity: { lifecycleActionId: string }
    })
  | (CodexTerminalEvidenceRefBase & {
      kind: 'effect'
      effectEvidence:
        | {
            state: 'confirmed'
            readyActionId: string
            actionIdentityDigest: string
            receiptId: string
          }
        | {
            state: 'indeterminate'
            readyActionId: string
            actionIdentityDigest: string
            sourceRevision: number
            resolutionEvidenceDigest: string
          }
    })

export type CodexTerminalNativeReadbackReceipt = {
  contract: 'codex_terminal_native_readback_v1'
  receiptId: string
  readyRunId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  aliasGeneration: number
  connectionEpoch: string
  codexThreadId: string
  codexTurnId: string
  turnStatus: 'completed' | 'interrupted' | 'failed'
  turnRevision: number
  threadStatus: CodexThread['status']
  orderedTurnIds: string[]
  terminalTurnItemDigests: string[]
  contextCompactionItemIds: string[]
  digest: string
}

export type CodexHistoryObservation =
  | {
      kind: 'continuation_safe'
      seamId: 'completed_product_accepted_v1' | 'failed_user_only_no_suffix_v1'
        | 'failed_after_completed_rounds_v1' | 'failed_mid_stream_v1' | 'interrupted_after_completed_items_v1'
      retainedFormalInputMappingDigest: string
    }
  | {
      kind: 'diverged'
      reason: 'partial_assistant' | 'tool_or_compaction_suffix' | 'protocol_or_publication_rejected'
        | 'uncommitted_tail_failure' | 'unprobed_failure_seam' | 'missing_user_half_turn'
    }
  | {
      kind: 'unknown_reset_required'
      reason: 'native_readback_identity_unknown' | 'formal_input_mapping_unknown' | 'uncommitted_tail_budget_exceeded'
    }

export type CodexTerminalFacts = {
  contract: 'codex_terminal_facts_v1'
  product: {
    terminal: 'done' | 'error' | 'cancelled' | 'interrupted'
    terminalReason: string
    failureKind: NonNullable<ProductTurnReceipt['failure']>['kind'] | null
    evidence: CodexTerminalEvidenceRef[]
  }
  history:
    | {
        kind: 'continuation_safe'
        seamId: Extract<CodexHistoryObservation, { kind: 'continuation_safe' }>['seamId']
        policyVersion: 'codex_history_continuity_v1'
        runtimeProbeReceiptDigest: string
        retainedFormalInputMappingDigest: string
        evidence: CodexTerminalEvidenceRef[]
      }
    | {
        kind: 'diverged'
        reason: Extract<CodexHistoryObservation, { kind: 'diverged' }>['reason']
        policyVersion: 'codex_history_continuity_v1'
        evidence: CodexTerminalEvidenceRef[]
      }
    | {
        kind: 'unknown_reset_required'
        reason: Extract<CodexHistoryObservation, { kind: 'unknown_reset_required' }>['reason']
        policyVersion: 'codex_history_continuity_v1'
        evidence: CodexTerminalEvidenceRef[]
      }
    | { kind: 'reset' | 'closed'; evidence: CodexTerminalEvidenceRef[] }
  effect:
    | { state: 'none'; evidence: [] }
    | { state: 'confirmed' | 'indeterminate'; evidence: CodexTerminalEvidenceRef[] }
}

type ContinuationSafeObservation = Extract<CodexHistoryObservation, { kind: 'continuation_safe' }>

function hasExactAutomaticCompactionEvidence(input: {
  candidate: NativeCandidate
  thread: CodexThread
}): boolean {
  // One pair per automatic compaction in the turn (before it or mid-turn), in request order.
  const exchanges = input.candidate.contextState.automaticCompactionExchanges
  if (!Array.isArray(exchanges) || exchanges.length === 0) return false
  const compactionItems = input.thread.turns.find((turn) => turn.id === input.candidate.codexTurnId)
    ?.items.filter((item) => item.type === 'contextCompaction').length
  if (compactionItems !== exchanges.length) return false
  const threadReadDigest = digestCanonicalJson(input.thread)
  return exchanges.every((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const previous = index > 0 ? exchanges[index - 1] as Record<string, unknown> : null
    const evidence = value as Record<string, unknown>
    return isExactAutomaticCompactionPair(evidence, input.candidate, threadReadDigest)
      && (!previous || Number(previous.automaticResponseSequence) < Number(evidence.automaticRequestSequence))
  })
}

function isExactAutomaticCompactionPair(
  evidence: Record<string, unknown>,
  candidate: NativeCandidate,
  threadReadDigest: string,
): boolean {
  return evidence.threadId === candidate.codexThreadId
    && evidence.turnId === candidate.codexTurnId
    && evidence.threadReadDigest === threadReadDigest
    && typeof evidence.automaticRequestReceiptId === 'string'
    && typeof evidence.automaticRequestEvidenceDigest === 'string'
    && typeof evidence.automaticResponseEvidenceDigest === 'string'
    && typeof evidence.successorProductRequestReceiptId === 'string'
    && typeof evidence.successorProductRequestEvidenceDigest === 'string'
    && typeof evidence.successorProductResponseEvidenceDigest === 'string'
    && Number.isSafeInteger(evidence.automaticRequestSequence)
    && Number.isSafeInteger(evidence.automaticResponseSequence)
    && Number.isSafeInteger(evidence.successorProductRequestSequence)
    && Number.isSafeInteger(evidence.successorProductResponseSequence)
    && Number(evidence.automaticRequestSequence) < Number(evidence.automaticResponseSequence)
    && Number(evidence.automaticResponseSequence) < Number(evidence.successorProductRequestSequence)
    && Number(evidence.successorProductRequestSequence) < Number(evidence.successorProductResponseSequence)
}

export function resolveCodexProductFailureKind(input: {
  terminal: CodexTerminalFacts['product']['terminal']
  terminalReason: string
  gatewayFailureClass?: 'provider' | 'transport' | 'protocol' | 'context' | null
}): CodexTerminalFacts['product']['failureKind'] {
  if (input.terminal === 'done') return null
  if (input.terminal === 'cancelled' || input.terminal === 'interrupted'
    || input.terminalReason === 'cancelled_user'
    || input.terminalReason === 'cancelled_runtime') return 'cancelled'
  if (input.terminalReason === 'persistence_failed') return 'persistence'
  if (input.terminalReason === 'proof_gap') return 'protocol'
  if (input.gatewayFailureClass === 'transport') return 'transport'
  if (input.gatewayFailureClass === 'protocol') return 'protocol'
  return 'provider'
}

// Pinned probe receipt for the local 0.160.1 failed-turn seams. This literal is
// package-scoped evidence identity, not a claim about future runtimes.
const continuationSafeFailureWire = {
  failureClass: 'provider', failureStage: 'headers', causeCode: 'gateway_upstream_http_400',
  responseIdentitySeen: false, partialAssistantItemSeen: false, toolCallItemSeen: false,
  eventCount: 0, wireByteCount: 0,
} as const
const usageLimitFailureWire = { ...continuationSafeFailureWire, causeCode: 'gateway_upstream_http_429' } as const
// Transient failures the probe drove through the pinned runtime before any
// output. Gateway transport failures reach the runtime as 502 or 504.
const transientFailureWire = {
  failureStages: ['connect', 'headers'],
  httpStatuses: [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524],
  gatewayCauseCodes: [
    'gateway_upstream_headers_deadline',
    'gateway_upstream_retry_exhausted',
    'gateway_upstream_transport_failed',
  ],
  responseIdentitySeen: false, partialAssistantItemSeen: false, toolCallItemSeen: false,
  eventCount: 0, wireByteCount: 0,
} as const
// After the response began, every gateway failure reaches the runtime as one
// gateway `response.failed`, and a held tool call is never delivered; the
// runtime's own stream idle timeout ends the stream the same way. Completed
// items stay exactly once and partial ones are dropped.
const midStreamFailureWire = {
  failureStages: ['stream-before-item', 'stream-after-item', 'terminal-validation'],
  downstreamWires: ['gateway_response_failed', 'runtime_stream_idle_timeout'],
  heldToolCallsDelivered: false,
} as const

export const CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST = digestCanonicalJson({
  contract: 'codex_0_160_failed_turn_continuity_probe_v7',
  runtimeVersion: '0.160.1',
  binarySha256: '09fa44fdc37a5fc70dc1ace31235f90468a2e193d0e85f7552eab068ea2582be',
  runtimeManifestDigest: '10dbe332f05e6c73234f895df9d3c7db8d970f82b0fb1542a32b9129d583de0c',
  stableV2SchemaDigest: 'f4f1cdde028f2bba3bab32ca69af1c0d584cb642f2f9a043ac612e41b0c79989',
  seams: {
    failed_user_only_no_suffix_v1: {
      seam: 'one_user_item_no_assistant_tool_or_compaction_suffix',
      failedUserRetention: 'prior_user_exact_once',
      wires: ['semantic_400', 'usage_limit_429', 'transient'],
    },
    failed_after_completed_rounds_v1: {
      seam: 'user_item_then_completed_commentary_and_tool_rounds_then_transient_failure',
      failedTurnRetention: 'user_commentary_and_tool_rounds_exact_once',
      nativeReadbackOmitsDynamicToolCalls: false,
      wires: ['transient'],
    },
    failed_mid_stream_v1: {
      seam: 'completed_rounds_and_items_then_failure_after_response_began',
      failedTurnRetention: 'completed_items_exact_once_partial_items_dropped',
      wires: ['mid_stream'],
    },
    interrupted_after_completed_items_v1: {
      seam: 'completed_rounds_and_items_then_user_interrupt',
      failedTurnRetention: 'completed_items_exact_once_partial_items_dropped_open_call_closed_as_aborted',
      runtimeAddsTurnAbortedNotice: true,
      wires: ['between_requests', 'mid_stream', 'tool_in_flight'],
    },
  },
  probeTransport: 'isolated_local_responses_fixture',
  probeTest: 'src/__tests__/codex-failed-turn-continuity.e2e.ts',
  wire: continuationSafeFailureWire,
  usageLimitWire: usageLimitFailureWire,
  usageLimitErrorInfo: 'usageLimitExceeded',
  transientWire: transientFailureWire,
  midStreamWire: midStreamFailureWire,
  continuationAfterRestart: true,
  derivation: {
    evidenceKind: 'additive_host_gateway_lineage_contract',
    priorTargetManifestDigest: 'e2ae5b1c9807e039b9516dc58dda8e9675f3c08e71dc1da362cd354216410558',
    priorReceiptDigest: 'c263fdabac10d3feda843d47811314e9bea60fed3bb221eda3d529080c464cfd',
  },
})

function isTransientFailureBeforeOutput(failure: CodexModelGatewayFailureEvidence | null): boolean {
  if (!failure
    || !(transientFailureWire.failureStages as readonly string[]).includes(failure.failureStage)
    || failure.responseIdentitySeen || failure.partialAssistantItemSeen || failure.toolCallItemSeen
    || failure.eventCount !== 0 || failure.wireByteCount !== 0) return false
  const http = /^gateway_upstream_http_(\d{3})$/.exec(failure.causeCode)
  return http
    ? (transientFailureWire.httpStatuses as readonly number[]).includes(Number(http[1]))
    : (transientFailureWire.gatewayCauseCodes as readonly string[]).includes(failure.causeCode)
}

function isFailureAfterResponseBegan(failure: CodexModelGatewayFailureEvidence | null): boolean {
  return Boolean(failure)
    && (midStreamFailureWire.failureStages as readonly string[]).includes(failure!.failureStage)
}

export function buildTerminalNativeReadbackReceipt(input: {
  candidate: NativeCandidate
  prepared: PreparedCodexProductRun
  aliasGeneration: number
  messageVisibilityEpoch: number
  connectionEpoch: string
  turnRevision: number
  thread: CodexThread
}): CodexTerminalNativeReadbackReceipt {
  const turn = input.thread.turns.find((entry) => entry.id === input.candidate.codexTurnId)
  if (!turn || turn.status === 'inProgress') throw new Error('terminal_native_readback_turn_missing')
  const unsigned = {
    contract: 'codex_terminal_native_readback_v1' as const,
    receiptId: `native-readback:${input.candidate.readyRunId}:${input.turnRevision}`,
    readyRunId: input.candidate.readyRunId,
    readyScopeId: input.candidate.scopeId,
    messageVisibilityEpoch: input.messageVisibilityEpoch,
    aliasGeneration: input.aliasGeneration,
    connectionEpoch: input.connectionEpoch,
    codexThreadId: input.candidate.codexThreadId,
    codexTurnId: input.candidate.codexTurnId,
    turnStatus: turn.status,
    turnRevision: input.turnRevision,
    threadStatus: input.thread.status,
    orderedTurnIds: input.thread.turns.map((entry) => entry.id),
    terminalTurnItemDigests: turn.items.map((item) => digestCanonicalJson(item)),
    contextCompactionItemIds: turn.items.flatMap((item) => (
      item.type === 'contextCompaction' ? [item.id] : []
    )),
  }
  return { ...unsigned, digest: digestCanonicalJson(unsigned) }
}

export function resolveCodexHistoryObservation(input: {
  candidate: NativeCandidate
  prepared: PreparedCodexProductRun
  expectedClientUserMessageId: string
  thread: CodexThread
  publicationDiverged: boolean
  gatewayEvidence: readonly CodexHistoryGatewayExchange[]
}): CodexHistoryObservation {
  if (input.thread.id !== input.candidate.codexThreadId
    || input.thread.turns.some((turn) => turn.status === 'inProgress')) {
    return { kind: 'unknown_reset_required', reason: 'native_readback_identity_unknown' }
  }
  const matchingTurns = input.thread.turns.filter((turn) => turn.id === input.candidate.codexTurnId)
  if (matchingTurns.length !== 1
    || matchingTurns[0].status !== input.candidate.engineOutcome) {
    return { kind: 'unknown_reset_required', reason: 'native_readback_identity_unknown' }
  }
  if (input.publicationDiverged || input.candidate.candidateSelection.kind === 'protocol_failure') {
    if (matchingTurns[0].items.some((item) => item.type === 'contextCompaction')) {
      return { kind: 'unknown_reset_required', reason: 'formal_input_mapping_unknown' }
    }
    return { kind: 'diverged', reason: 'protocol_or_publication_rejected' }
  }
  const turn = matchingTurns[0]
  const current = input.prepared.ingress.canonicalCurrentInputRef
  const sentInput = [...current.input, ...input.prepared.ingress.explicitResourceEnvelope.input]
  const userItems = turn.items.filter((item) => item.type === 'userMessage')
  const exactUser = userItems.filter((item) => (
    item.clientId === input.expectedClientUserMessageId
    && digestCanonicalJson(item.content)
      === digestCanonicalJson(projectCodexUserInputReadback(sentInput, input.thread.historyMode))
  ))
  if (userItems.length === 0 && input.candidate.engineOutcome !== 'completed') {
    return { kind: 'diverged', reason: 'missing_user_half_turn' }
  }
  if (userItems.length !== 1 || exactUser.length !== 1) {
    return { kind: 'unknown_reset_required', reason: 'formal_input_mapping_unknown' }
  }
  if (input.candidate.engineOutcome === 'completed') {
    const acceptedItemId = input.candidate.candidateSelection.kind === 'accepted'
      ? input.candidate.candidateSelection.itemId
      : null
    const selection = selectCodexTerminalCandidate(
      turn,
      turn.items.map((item, order) => ({ item, order })),
      new Map(),
      false,
    )
    if (!acceptedItemId
      || input.candidate.candidateText === null
      || selection.result.kind !== 'accepted'
      || selection.message?.text !== input.candidate.candidateText) {
      return { kind: 'diverged', reason: 'protocol_or_publication_rejected' }
    }
    if (turn.items.some((item) => item.type === 'contextCompaction')) {
      if (!hasExactAutomaticCompactionEvidence({
        candidate: input.candidate,
        thread: input.thread,
      })) {
        return { kind: 'unknown_reset_required', reason: 'formal_input_mapping_unknown' }
      }
    }
    return {
      kind: 'continuation_safe',
      seamId: 'completed_product_accepted_v1',
      retainedFormalInputMappingDigest: digestCanonicalJson({
        originUserMessageId: current.messageId,
        clientUserMessageId: input.expectedClientUserMessageId,
        inputDigest: digestCanonicalJson(sentInput),
        acceptedItemId,
        nativeReadbackAgentItemDigest: digestCanonicalJson(selection.message),
      }),
    }
  }
  if (input.prepared.ingress.uncommittedUserTail?.length) {
    return { kind: 'diverged', reason: 'uncommitted_tail_failure' }
  }
  // Readback is lossy. Positive wire/collector observations survive even when
  // the native item projection later omits them.
  if (input.gatewayEvidence.some((exchange) => exchange.requestKind !== 'product')
    || turn.items.some((item) => item.type === 'contextCompaction')) {
    return { kind: 'unknown_reset_required', reason: 'formal_input_mapping_unknown' }
  }
  const failedUserMappingDigest = digestCanonicalJson({
    originUserMessageId: current.messageId,
    clientUserMessageId: input.expectedClientUserMessageId,
    inputDigest: digestCanonicalJson(sentInput),
  })
  // Earlier sampling rounds finished and their tool results were published; only
  // the last request failed, either transiently before any output or after its
  // response began. The runtime keeps the completed rounds and items, so the
  // next ordinary input continues them on this thread.
  const failedExchange = input.gatewayEvidence.at(-1)
  const completedBeforeFailure = input.candidate.engineOutcome === 'failed'
    && failedExchange !== undefined && failedExchange.responseSequence !== null
    && input.gatewayEvidence.slice(0, -1).every((exchange) => (
      exchange.failure === null && exchange.responseSequence !== null
    ))
    && input.candidate.runtimeDiagnostics.finalDeltaItemIds.length === 0
    && turn.items.every((item) => item.type === 'userMessage'
      || (item.type === 'agentMessage' && item.phase === 'commentary')
      || (item.type === 'dynamicToolCall' && item.status !== 'inProgress')
      || (item.type === 'other' && item.nativeType === 'reasoning'))
  if (completedBeforeFailure && input.gatewayEvidence.length >= 2
    && isTransientFailureBeforeOutput(failedExchange.failure)) {
    return {
      kind: 'continuation_safe',
      seamId: 'failed_after_completed_rounds_v1',
      retainedFormalInputMappingDigest: failedUserMappingDigest,
    }
  }
  if (completedBeforeFailure && isFailureAfterResponseBegan(failedExchange.failure)) {
    return {
      kind: 'continuation_safe',
      seamId: 'failed_mid_stream_v1',
      retainedFormalInputMappingDigest: failedUserMappingDigest,
    }
  }
  // A stop keeps what had finished: the runtime closes an open tool call as aborted, drops partial items and
  // tells the model the user interrupted, so the next ordinary input continues on this thread.
  const lastExchange = input.gatewayEvidence.at(-1)
  if (input.candidate.engineOutcome === 'interrupted'
    && input.gatewayEvidence.slice(0, -1).every((exchange) => (
      exchange.failure === null && exchange.responseSequence !== null
    ))
    && (lastExchange === undefined
      || (lastExchange.failure === null && lastExchange.responseSequence !== null)
      || isFailureAfterResponseBegan(lastExchange.failure))
    && input.candidate.runtimeDiagnostics.finalDeltaItemIds.length === 0
    && turn.items.every((item) => item.type === 'userMessage'
      || (item.type === 'agentMessage' && item.phase === 'commentary')
      || (item.type === 'dynamicToolCall' && item.status !== 'inProgress')
      || (item.type === 'other' && item.nativeType === 'reasoning'))) {
    return {
      kind: 'continuation_safe',
      seamId: 'interrupted_after_completed_items_v1',
      retainedFormalInputMappingDigest: failedUserMappingDigest,
    }
  }
  const partialAssistant = turn.items.some((item) => item.type === 'agentMessage')
    || input.candidate.runtimeDiagnostics.finalDeltaItemIds.length > 0
    || input.candidate.runtimeDiagnostics.commentaryItemIds.length > 0
    || input.gatewayEvidence.some((exchange) => exchange.failure?.partialAssistantItemSeen)
  if (partialAssistant) return { kind: 'diverged', reason: 'partial_assistant' }
  const unsafeSuffix = turn.items.some((item) => (
    item.type === 'dynamicToolCall' || item.type === 'contextCompaction'
  ))
  if (unsafeSuffix || input.candidate.usedToolCalls.length > 0
    || input.gatewayEvidence.some((exchange) => exchange.failure?.toolCallItemSeen)) {
    return { kind: 'diverged', reason: 'tool_or_compaction_suffix' }
  }
  const exchange = input.gatewayEvidence[0]
  const failureWire = turn.error?.codexErrorInfo === 'usageLimitExceeded'
    && exchange?.failure?.causeCode === usageLimitFailureWire.causeCode
    ? usageLimitFailureWire : continuationSafeFailureWire
  if (input.candidate.engineOutcome !== 'failed'
    || input.gatewayEvidence.length !== 1
    || exchange.requestKind !== 'product' || exchange.responseSequence === null
    || !exchange.failure
    || (Object.entries(failureWire).some(([key, value]) => (
      exchange.failure?.[key as keyof CodexModelGatewayFailureEvidence] !== value
    )) && !isTransientFailureBeforeOutput(exchange.failure))) {
    return { kind: 'diverged', reason: 'unprobed_failure_seam' }
  }
  return {
    kind: 'continuation_safe',
    seamId: 'failed_user_only_no_suffix_v1',
    retainedFormalInputMappingDigest: failedUserMappingDigest,
  }
}

export function terminalEvidenceRef(input: {
  kind: 'native_turn'
  readyRunId: string
  readyScopeId: string
  messageVisibilityEpoch: number
  aliasGeneration: number
  codexThreadId: string
  codexTurnId: string
  receiptId: string
  digest: string
  ownerIdentity: Extract<CodexTerminalEvidenceRef, { kind: 'native_turn' }>['ownerIdentity']
}): CodexTerminalEvidenceRef {
  return {
    ...input,
    // This candidate is write-once; the mutable containing turn row is not its version.
    revision: 1,
    evidenceRefId: `${input.kind}:${input.receiptId}`,
  }
}

export function terminalNativeReadbackEvidenceRef(input: Omit<
  Extract<CodexTerminalEvidenceRef, { kind: 'native_readback' }>,
  'kind' | 'evidenceRefId'
>): Extract<CodexTerminalEvidenceRef, { kind: 'native_readback' }> {
  return {
    ...input,
    kind: 'native_readback',
    evidenceRefId: `native_readback:${input.receiptId}`,
  }
}

export function terminalGatewayEvidenceRef(input: Omit<
  Extract<CodexTerminalEvidenceRef, { kind: 'gateway' }>,
  'kind' | 'evidenceRefId'
>): Extract<CodexTerminalEvidenceRef, { kind: 'gateway' }> {
  return {
    ...input,
    kind: 'gateway',
    evidenceRefId: `gateway:${input.receiptId}`,
  }
}

export function terminalIndeterminateEffectEvidenceRef(input: Omit<
  Extract<CodexTerminalEvidenceRef, { kind: 'effect' }>,
  'kind' | 'evidenceRefId'
>): Extract<CodexTerminalEvidenceRef, { kind: 'effect' }> {
  return {
    ...input,
    kind: 'effect',
    evidenceRefId: `effect:${input.effectEvidence.readyActionId}:${input.revision}`,
  }
}

export function resolveCodexTerminalFacts(input: {
  product: CodexTerminalFacts['product']
  history: CodexHistoryObservation | { kind: 'reset' | 'closed' }
  historyEvidence: CodexTerminalEvidenceRef[]
  effect: CodexTerminalFacts['effect']
}): CodexTerminalFacts {
  const canonicalReferences = (references: CodexTerminalEvidenceRef[]): CodexTerminalEvidenceRef[] => (
    [...references].sort((left, right) => left.evidenceRefId.localeCompare(right.evidenceRefId))
  )
  const history = input.history.kind === 'continuation_safe'
    ? {
        kind: 'continuation_safe' as const,
        seamId: input.history.seamId as ContinuationSafeObservation['seamId'],
        policyVersion: 'codex_history_continuity_v1' as const,
        runtimeProbeReceiptDigest: CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST,
        retainedFormalInputMappingDigest: input.history.retainedFormalInputMappingDigest,
        evidence: canonicalReferences(input.historyEvidence),
      }
    : input.history.kind === 'diverged'
      ? {
          kind: 'diverged' as const,
          reason: input.history.reason,
          policyVersion: 'codex_history_continuity_v1' as const,
          evidence: canonicalReferences(input.historyEvidence),
        }
      : input.history.kind === 'unknown_reset_required'
        ? {
            kind: 'unknown_reset_required' as const,
            reason: input.history.reason,
            policyVersion: 'codex_history_continuity_v1' as const,
            evidence: canonicalReferences(input.historyEvidence),
          }
        : { kind: input.history.kind, evidence: canonicalReferences(input.historyEvidence) }
  const facts: CodexTerminalFacts = {
    contract: 'codex_terminal_facts_v1',
    product: { ...input.product, evidence: canonicalReferences(input.product.evidence) },
    history,
    effect: input.effect.state === 'none'
      ? input.effect
      : { ...input.effect, evidence: canonicalReferences(input.effect.evidence) },
  }
  assertCodexTerminalFacts(facts)
  return facts
}

export function assertCodexTerminalFacts(value: unknown): asserts value is CodexTerminalFacts {
  const record = (candidate: unknown): candidate is Record<string, unknown> => (
    Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate)
  )
  const exactKeys = (candidate: Record<string, unknown>, keys: readonly string[]): boolean => (
    Object.keys(candidate).sort().join(',') === [...keys].sort().join(',')
  )
  const sha = (candidate: unknown): candidate is string => (
    typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
  )
  const nonEmpty = (candidate: unknown): candidate is string => (
    typeof candidate === 'string' && candidate.trim().length > 0
  )
  const evidenceRef = (candidate: unknown): candidate is CodexTerminalEvidenceRef => {
    if (!record(candidate)
      || !nonEmpty(candidate.kind)
      || !nonEmpty(candidate.evidenceRefId)
      || !nonEmpty(candidate.readyScopeId)
      || !Number.isSafeInteger(candidate.messageVisibilityEpoch) || Number(candidate.messageVisibilityEpoch) < 0
      || !Number.isSafeInteger(candidate.aliasGeneration) || Number(candidate.aliasGeneration) < 1
      || !nonEmpty(candidate.readyRunId)
      || !nonEmpty(candidate.codexThreadId)
      || !nonEmpty(candidate.codexTurnId)
      || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1
      || !sha(candidate.digest)) return false
    const common = [
      'kind', 'evidenceRefId', 'readyScopeId', 'messageVisibilityEpoch',
      'aliasGeneration', 'readyRunId', 'codexThreadId', 'codexTurnId', 'revision', 'digest',
    ]
    if (candidate.kind === 'effect') {
      if (!exactKeys(candidate, [...common, 'effectEvidence']) || !record(candidate.effectEvidence)) return false
      const effect = candidate.effectEvidence
      if (!nonEmpty(effect.readyActionId) || !sha(effect.actionIdentityDigest)) return false
      return effect.state === 'confirmed'
        ? exactKeys(effect, ['state', 'readyActionId', 'actionIdentityDigest', 'receiptId'])
          && nonEmpty(effect.receiptId)
        : effect.state === 'indeterminate'
          && exactKeys(effect, [
            'state', 'readyActionId', 'actionIdentityDigest', 'sourceRevision', 'resolutionEvidenceDigest',
          ])
          && Number.isSafeInteger(effect.sourceRevision) && Number(effect.sourceRevision) >= 1
          && sha(effect.resolutionEvidenceDigest)
    }
    if (!exactKeys(candidate, [...common, 'receiptId', 'ownerIdentity'])
      || !nonEmpty(candidate.receiptId) || !record(candidate.ownerIdentity)) return false
    const owner = candidate.ownerIdentity
    if (candidate.kind === 'native_turn') return exactKeys(owner, ['nativeTurnId', 'terminalStatus'])
      && owner.nativeTurnId === candidate.codexTurnId
      && ['completed', 'interrupted', 'failed'].includes(String(owner.terminalStatus))
    if (candidate.kind === 'native_readback') return exactKeys(owner, [
      'connectionEpoch', 'readRevision', 'verifiedThreadId', 'verifiedTurnId',
    ]) && nonEmpty(owner.connectionEpoch)
      && Number.isSafeInteger(owner.readRevision) && Number(owner.readRevision) >= 1
      && owner.verifiedThreadId === candidate.codexThreadId
      && owner.verifiedTurnId === candidate.codexTurnId
    if (candidate.kind === 'gateway') return exactKeys(owner, ['gatewayRequestReceiptId', 'eventSequence'])
      && nonEmpty(owner.gatewayRequestReceiptId)
      && Number.isSafeInteger(owner.eventSequence) && Number(owner.eventSequence) >= 1
    if (candidate.kind === 'publication') return exactKeys(owner, ['publicationReceiptId'])
      && nonEmpty(owner.publicationReceiptId)
    if (candidate.kind === 'verifier') return exactKeys(owner, ['verifierAttemptId'])
      && nonEmpty(owner.verifierAttemptId)
    if (candidate.kind === 'artifact') return exactKeys(owner, ['artifactReceiptId'])
      && nonEmpty(owner.artifactReceiptId)
    return candidate.kind === 'lifecycle'
      && exactKeys(owner, ['lifecycleActionId']) && nonEmpty(owner.lifecycleActionId)
  }
  if (!record(value) || !exactKeys(value, ['contract', 'product', 'history', 'effect'])) {
    throw new Error('terminal_facts_invalid')
  }
  const facts = value as CodexTerminalFacts
  const allReferences = [
    ...(facts.product?.evidence || []),
    ...(facts.history?.evidence || []),
    ...(facts.effect?.evidence || []),
  ]
  const referencesUnique = (references: CodexTerminalEvidenceRef[]): boolean => (
    new Set(references.map((reference) => reference.evidenceRefId)).size === references.length
  )
  if (facts.contract !== 'codex_terminal_facts_v1'
    || !record(facts.product) || !record(facts.history) || !record(facts.effect)
    || !exactKeys(facts.product, ['terminal', 'terminalReason', 'failureKind', 'evidence'])
    || !['done', 'error', 'cancelled', 'interrupted'].includes(facts.product.terminal)
    || !nonEmpty(facts.product.terminalReason)
    || !Array.isArray(facts.product.evidence)
    || (facts.product.terminal === 'done') !== (facts.product.failureKind === null)
    || (facts.product.terminal === 'done') !== (facts.product.terminalReason === 'done')
    || !['continuation_safe', 'diverged', 'unknown_reset_required', 'reset', 'closed']
      .includes(facts.history.kind)
    || !Array.isArray(facts.history.evidence)
    || !['none', 'confirmed', 'indeterminate'].includes(facts.effect.state)
    || !Array.isArray(facts.effect.evidence)
    || (facts.effect.state === 'none' && facts.effect.evidence.length !== 0)
    || (facts.effect.state !== 'none' && facts.effect.evidence.length === 0)
    || allReferences.some((reference) => !evidenceRef(reference))
    || !referencesUnique(facts.product.evidence)
    || !referencesUnique(facts.history.evidence)
    || !referencesUnique(facts.effect.evidence)
    || (facts.effect.state === 'confirmed'
      && facts.effect.evidence.some((reference) => (
        reference.kind !== 'effect' || reference.effectEvidence.state !== 'confirmed'
      )))
    || (facts.effect.state === 'indeterminate'
      && !facts.effect.evidence.some((reference) => (
        reference.kind === 'effect' && reference.effectEvidence.state === 'indeterminate'
      )))
    || ((facts.history.kind === 'reset' || facts.history.kind === 'closed')
      && !facts.history.evidence.some((reference) => reference.kind === 'lifecycle'))
    || (facts.history.kind === 'continuation_safe'
      && (!sha(facts.history.runtimeProbeReceiptDigest)
        || !sha(facts.history.retainedFormalInputMappingDigest)
        || !nonEmpty(facts.history.seamId)
        || facts.history.policyVersion !== 'codex_history_continuity_v1'))) {
    throw new Error('terminal_facts_invalid')
  }
}
