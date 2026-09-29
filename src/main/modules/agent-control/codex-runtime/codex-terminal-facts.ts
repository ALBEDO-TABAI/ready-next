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
  const exchanges = input.candidate.contextState.automaticCompactionExchanges
  if (!Array.isArray(exchanges) || exchanges.length !== 1) return false
  const value = exchanges[0]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as Record<string, unknown>
  return evidence.threadId === input.candidate.codexThreadId
    && evidence.turnId === input.candidate.codexTurnId
    && evidence.threadReadDigest === digestCanonicalJson(input.thread)
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

// Pinned probe receipt for the local 0.149.0 user-only failed-turn seam. This
// literal is package-scoped evidence identity, not a claim about future runtimes.
const continuationSafeFailureWire = {
  failureClass: 'provider', failureStage: 'headers', causeCode: 'gateway_upstream_http_400',
  responseIdentitySeen: false, partialAssistantItemSeen: false, toolCallItemSeen: false,
  eventCount: 0, wireByteCount: 0,
} as const
const usageLimitFailureWire = { ...continuationSafeFailureWire, causeCode: 'gateway_upstream_http_429' } as const

export const CODEX_CONTINUATION_SAFE_PROBE_RECEIPT_DIGEST = digestCanonicalJson({
  contract: 'codex_0_149_failed_user_only_continuity_probe_v2',
  runtimeVersion: '0.149.0',
  binarySha256: 'f4a74117b8142cda581c95ff753abf4508b5636d89682c1ed77e4a9249af8963',
  runtimeManifestDigest: '22816589f287db132fdc4e3a57b674878795fb75891d765d598b3c94e381bc79',
  stableV2SchemaDigest: '38483e82eb7170aaa49861a9690734f1201249ae8207d84e3300c7a1c06412e1',
  seam: 'one_user_item_no_assistant_tool_or_compaction_suffix',
  failedUserRetention: 'prior_user_exact_once',
  retainedPriorUserCount: 1,
  unsafeSuffixObserved: false,
  probeTransport: 'isolated_local_responses_fixture',
  wire: continuationSafeFailureWire,
  usageLimitWire: usageLimitFailureWire,
  usageLimitErrorInfo: 'usageLimitExceeded',
  continuationAfterRestart: true,
})

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
    && digestCanonicalJson(item.content) === digestCanonicalJson(projectCodexUserInputReadback(sentInput))
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
    || Object.entries(failureWire).some(([key, value]) => (
      exchange.failure?.[key as keyof CodexModelGatewayFailureEvidence] !== value
    ))) {
    return { kind: 'diverged', reason: 'unprobed_failure_seam' }
  }
  return {
    kind: 'continuation_safe',
    seamId: 'failed_user_only_no_suffix_v1',
    retainedFormalInputMappingDigest: digestCanonicalJson({
      originUserMessageId: current.messageId,
      clientUserMessageId: input.expectedClientUserMessageId,
      inputDigest: digestCanonicalJson(sentInput),
    }),
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
