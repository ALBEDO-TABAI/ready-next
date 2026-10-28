import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

const productToolsDigest = digestCanonicalJson([{ type: 'function', name: 'ready_read_probe' }])

const COMPACTION_PROMPT = 'compaction-prompt'

function thread(status: 'completed' | 'interrupted' | 'failed' = 'completed'): CodexThread {
  return {
    id: 'thread-1', sessionId: 'thread-1', parentThreadId: null, forkedFromId: null,
    cwd: '/tmp/thread-1', source: 'vscode', threadSource: 'vscode',
    modelProvider: 'ready_gateway', cliVersion: '0.146.1', createdAt: 1,
    ephemeral: false, preview: '', status: { type: 'idle' }, updatedAt: 2,
    turns: [{ id: 'turn-1', status, error: null, items: [] }],
  }
}

function row(input: {
  requestKind: 'automatic_compaction' | 'product'
  requestSequence: number
  responseSequence: number | null
  inputDigest: string
  inputCharacters: number
  inputItemDigest: string
  /** Items before the last one; Codex ends every compaction request with its compaction prompt. */
  extraItems?: Array<{ digest: string, characters: number }>
}) {
  const items = [
    ...(input.extraItems || []),
    { digest: input.inputItemDigest, characters: input.inputCharacters },
    ...(input.requestKind === 'automatic_compaction' ? [{ digest: COMPACTION_PROMPT, characters: 40 }] : []),
  ]
  return {
    requestSequence: input.requestSequence,
    responseSequence: input.responseSequence,
    receiptId: `receipt-${input.requestSequence}`,
    requestKind: input.requestKind,
    readyRunId: 'run-1', codexThreadId: 'thread-1', codexTurnId: 'turn-1',
    upstreamProfileSnapshotDigest: 'snapshot-1',
    requestDigest: `request-${input.requestSequence}`,
    instructionDigest: 'instruction-1',
    inputDigest: input.inputDigest,
    inputItems: items.map((item) => ({
      digest: item.digest,
      totalStringCharacters: item.characters,
      maxStringCharacters: item.characters,
    })),
    inputTotalStringCharacters: items.reduce((total, item) => total + item.characters, 0),
    inputMaxStringCharacters: Math.max(...items.map((item) => item.characters)),
    toolsDigest: input.requestKind === 'automatic_compaction'
      ? digestCanonicalJson([])
      : productToolsDigest,
    toolCount: input.requestKind === 'automatic_compaction' ? 0 : 1,
    bodyBytes: input.inputCharacters + 100,
    requestEvidenceDigest: `request-evidence-${input.requestSequence}`,
    responseId: input.responseSequence === null ? null : `response-${input.responseSequence}`,
    responseTerminalDigest: input.responseSequence === null ? null : `terminal-${input.responseSequence}`,
    responseOutputDigest: input.responseSequence === null ? null : `output-${input.responseSequence}`,
    responseUsageDigest: input.responseSequence === null ? null : `usage-${input.responseSequence}`,
    responseEvidenceDigest: input.responseSequence === null ? null : `response-evidence-${input.responseSequence}`,
  }
}

function gateway(rows: ReturnType<typeof row>[]) {
  return { readTurnGatewayEvidence: () => rows }
}

function verify(
  rows: ReturnType<typeof row>[],
  turnStatus: 'completed' | 'interrupted' | 'failed' = 'completed',
) {
  return verifyCodexAutomaticCompactionEvidence({
    gatewayRepository: gateway(rows),
    readyRunId: 'run-1', codexThreadId: 'thread-1', codexTurnId: 'turn-1',
    upstreamProfileSnapshotDigest: 'snapshot-1',
    productRequestToolsDigest: productToolsDigest,
    thread: thread(turnStatus),
  })
}

test('automatic compaction evidence binds the completed exchange and compressed successor without an app-server item', () => {
  const result = verify([
    row({
      requestKind: 'automatic_compaction', requestSequence: 1, responseSequence: 2,
      inputDigest: 'raw-input', inputCharacters: 1_000, inputItemDigest: 'raw-item',
    }),
    row({
      requestKind: 'product', requestSequence: 3, responseSequence: 4,
      inputDigest: 'summary-input', inputCharacters: 100, inputItemDigest: 'summary-item',
    }),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].automaticRequestReceiptId, 'receipt-1')
  assert.equal(result[0].successorProductRequestReceiptId, 'receipt-3')
  assert.equal(result[0].automaticResponseSequence, 2)
  assert.equal(result[0].successorProductResponseSequence, 4)
  assert.match(result[0].threadReadDigest, /^[a-f0-9]{64}$/)
})

// 2026-10-06: a 37-tool turn filled the context and Codex compacted mid-turn, possibly several times. The base
// instructions survive every compaction and are often the longest item, so only the replaced history proves it.
test('every mid-turn compaction is paired with the request after it, even when the longest item survives', () => {
  const base = { digest: 'base-instructions', characters: 20_000 }
  const result = verify([
    row({ requestKind: 'product', requestSequence: 1, responseSequence: 2,
      inputDigest: 'start', inputCharacters: 50, inputItemDigest: 'task', extraItems: [base] }),
    row({ requestKind: 'automatic_compaction', requestSequence: 3, responseSequence: 4,
      inputDigest: 'history-1', inputCharacters: 9_000, inputItemDigest: 'tool-output-1', extraItems: [base] }),
    row({ requestKind: 'product', requestSequence: 5, responseSequence: 6,
      inputDigest: 'summary-1', inputCharacters: 300, inputItemDigest: 'summary-1-item', extraItems: [base] }),
    row({ requestKind: 'automatic_compaction', requestSequence: 7, responseSequence: 8,
      inputDigest: 'history-2', inputCharacters: 9_000, inputItemDigest: 'tool-output-2', extraItems: [base] }),
    row({ requestKind: 'product', requestSequence: 9, responseSequence: 10,
      inputDigest: 'summary-2', inputCharacters: 300, inputItemDigest: 'summary-2-item', extraItems: [base] }),
  ])
  assert.deepEqual(result.map((entry) => [entry.automaticRequestReceiptId, entry.successorProductRequestReceiptId]), [
    ['receipt-3', 'receipt-5'],
    ['receipt-7', 'receipt-9'],
  ])
})

test('automatic compaction evidence fails closed on incomplete, unordered, or replayed exchanges', () => {
  const automatic = row({
    requestKind: 'automatic_compaction', requestSequence: 1, responseSequence: 2,
    inputDigest: 'raw-input', inputCharacters: 1_000, inputItemDigest: 'raw-item',
  })
  const successor = row({
    requestKind: 'product', requestSequence: 3, responseSequence: 4,
    inputDigest: 'summary-input', inputCharacters: 100, inputItemDigest: 'summary-item',
  })
  assert.throws(() => verify([{ ...automatic, responseSequence: null, responseId: null,
    responseTerminalDigest: null, responseOutputDigest: null, responseUsageDigest: null,
    responseEvidenceDigest: null }, successor]), /automatic_compaction_response_evidence_missing/)
  assert.throws(() => verify([automatic]), /automatic_compaction_successor_missing/)
  assert.throws(() => verify([automatic, { ...successor, inputItems: automatic.inputItems.slice(0, -1) }]),
    /automatic_compaction_source_item_replayed/, 'only the compaction prompt is gone; the history was replayed')
  assert.throws(() => verify([automatic, { ...successor, inputTotalStringCharacters: 1_040 }]),
    /automatic_compaction_successor_input_not_replaced/)
  const second = { ...automatic, requestSequence: 3, responseSequence: 4, receiptId: 'receipt-3' }
  assert.throws(() => verify([automatic, second, { ...successor, requestSequence: 5, responseSequence: 6 }]),
    /automatic_compaction_successor_missing/, 'a compaction must be followed by a product request')
  assert.deepEqual(verify([successor]), [])
})

test('ordinary interrupted or failed turns without automatic compaction have no compaction evidence', () => {
  const product = row({
    requestKind: 'product', requestSequence: 1, responseSequence: 2,
    inputDigest: 'ordinary-input', inputCharacters: 100, inputItemDigest: 'ordinary-item',
  })
  assert.deepEqual(verify([product], 'interrupted'), [])
  assert.deepEqual(verify([product], 'failed'), [])
})

test('automatic compaction still requires the native turn to be completed', () => {
  const automatic = row({
    requestKind: 'automatic_compaction', requestSequence: 1, responseSequence: 2,
    inputDigest: 'raw-input', inputCharacters: 1_000, inputItemDigest: 'raw-item',
  })
  const successor = row({
    requestKind: 'product', requestSequence: 3, responseSequence: 4,
    inputDigest: 'summary-input', inputCharacters: 100, inputItemDigest: 'summary-item',
  })
  assert.throws(
    () => verify([automatic, successor], 'interrupted'),
    /automatic_compaction_turn_readback_mismatch/,
  )
})
