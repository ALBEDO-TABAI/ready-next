import type { CodexThread } from './codex-native-runtime'
import { CodexModelGatewayRepository } from './codex-model-gateway-authority'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export type CodexAutomaticCompactionEvidence = {
  threadId: string
  turnId: string
  threadReadDigest: string
  upstreamProfileSnapshotDigest: string
  automaticRequestReceiptId: string
  automaticRequestEvidenceDigest: string
  automaticResponseEvidenceDigest: string
  automaticRequestSequence: number
  automaticResponseSequence: number
  successorProductRequestReceiptId: string
  successorProductRequestEvidenceDigest: string
  successorProductResponseEvidenceDigest: string
  successorProductRequestSequence: number
  successorProductResponseSequence: number
  automaticInputDigest: string
  successorProductInputDigest: string
  automaticInputTotalStringCharacters: number
  successorProductInputTotalStringCharacters: number
}

function assertCompletedResponse(row: ReturnType<
  CodexModelGatewayRepository['readTurnGatewayEvidence']
>[number], code: string): asserts row is typeof row & {
  responseSequence: number
  responseId: string
  responseEvidenceDigest: string
  responseTerminalDigest: string
  responseOutputDigest: string
  responseUsageDigest: string
} {
  if (
    row.responseSequence === null
    || !row.responseEvidenceDigest
    || !row.responseId
    || !row.responseTerminalDigest
    || !row.responseOutputDigest
    || !row.responseUsageDigest
    || row.responseSequence <= row.requestSequence
  ) throw new Error(code)
}

/**
 * Every automatic compaction in the turn — before it starts or mid-turn when a long tool loop fills the context —
 * paired with the first product request after it. A pair proves the history was replaced: the successor request is a
 * different, smaller input, and something the compaction saw (other than its own prompt) is gone from it.
 */
export function verifyCodexAutomaticCompactionEvidence(input: {
  gatewayRepository: Pick<CodexModelGatewayRepository, 'readTurnGatewayEvidence'>
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  upstreamProfileSnapshotDigest: string
  /** The request tools the pinned runtime sends for the turn's frozen surface (codexRequestToolsDigest). */
  productRequestToolsDigest: string
  thread: CodexThread
}): CodexAutomaticCompactionEvidence[] {
  if (input.thread.id !== input.codexThreadId) {
    throw new Error('automatic_compaction_thread_readback_mismatch')
  }
  const rows = input.gatewayRepository.readTurnGatewayEvidence({
    readyRunId: input.readyRunId,
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
  })
  const automaticRows = rows.filter((row) => row.requestKind === 'automatic_compaction')
  if (automaticRows.length === 0) return []
  const turns = input.thread.turns.filter((turn) => turn.id === input.codexTurnId)
  if (turns.length !== 1 || turns[0].status !== 'completed') {
    throw new Error('automatic_compaction_turn_readback_mismatch')
  }
  const threadReadDigest = digestCanonicalJson(input.thread)
  return automaticRows.map((automatic) => {
    assertCompletedResponse(automatic, 'automatic_compaction_response_evidence_missing')
    const successorCandidates = rows.filter((row) => row.requestSequence > automatic.responseSequence)
    if (successorCandidates.length === 0 || successorCandidates[0].requestKind !== 'product') {
      throw new Error('automatic_compaction_successor_missing')
    }
    const successor = successorCandidates[0]
    assertCompletedResponse(successor, 'automatic_compaction_successor_response_evidence_missing')
    if (
      automatic.upstreamProfileSnapshotDigest !== input.upstreamProfileSnapshotDigest
      || successor.upstreamProfileSnapshotDigest !== input.upstreamProfileSnapshotDigest
    ) throw new Error('automatic_compaction_snapshot_mismatch')
    if (automatic.toolCount !== 0 || automatic.toolsDigest !== digestCanonicalJson([])) {
      throw new Error('automatic_compaction_tool_surface_not_empty')
    }
    if (successor.toolsDigest !== input.productRequestToolsDigest) {
      throw new Error('automatic_compaction_successor_tool_surface_mismatch')
    }
    if (
      successor.inputDigest === automatic.inputDigest
      || successor.inputTotalStringCharacters >= automatic.inputTotalStringCharacters
    ) throw new Error('automatic_compaction_successor_input_not_replaced')
    // The last item is the compaction prompt itself; the base instructions before it may legitimately survive.
    const successorDigests = new Set(successor.inputItems.map((item) => item.digest))
    const compactedAway = automatic.inputItems.slice(0, -1)
      .filter((item) => item.maxStringCharacters > 0 && !successorDigests.has(item.digest))
    if (compactedAway.length === 0) throw new Error('automatic_compaction_source_item_replayed')
    return {
      threadId: input.codexThreadId,
      turnId: input.codexTurnId,
      threadReadDigest,
      upstreamProfileSnapshotDigest: input.upstreamProfileSnapshotDigest,
      automaticRequestReceiptId: automatic.receiptId,
      automaticRequestEvidenceDigest: automatic.requestEvidenceDigest,
      automaticResponseEvidenceDigest: automatic.responseEvidenceDigest,
      automaticRequestSequence: automatic.requestSequence,
      automaticResponseSequence: automatic.responseSequence,
      successorProductRequestReceiptId: successor.receiptId,
      successorProductRequestEvidenceDigest: successor.requestEvidenceDigest,
      successorProductResponseEvidenceDigest: successor.responseEvidenceDigest,
      successorProductRequestSequence: successor.requestSequence,
      successorProductResponseSequence: successor.responseSequence,
      automaticInputDigest: automatic.inputDigest,
      successorProductInputDigest: successor.inputDigest,
      automaticInputTotalStringCharacters: automatic.inputTotalStringCharacters,
      successorProductInputTotalStringCharacters: successor.inputTotalStringCharacters,
    }
  })
}
