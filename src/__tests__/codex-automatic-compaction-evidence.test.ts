import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'

const productToolsDigest = digestCanonicalJson([{ type: 'function', name: 'ready_read_probe' }])

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
}) {
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
    inputItems: [{
      digest: input.inputItemDigest,
      totalStringCharacters: input.inputCharacters,
      maxStringCharacters: input.inputCharacters,
    }],
    inputTotalStringCharacters: input.inputCharacters,
    inputMaxStringCharacters: input.inputCharacters,
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
    productToolSurfaceDigest: productToolsDigest,
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
  assert.equal(result?.automaticRequestReceiptId, 'receipt-1')
  assert.equal(result?.successorProductRequestReceiptId, 'receipt-3')
  assert.equal(result?.automaticResponseSequence, 2)
  assert.equal(result?.successorProductResponseSequence, 4)
  assert.match(result?.threadReadDigest || '', /^[a-f0-9]{64}$/)
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
  assert.throws(() => verify([automatic, { ...successor, inputItems: automatic.inputItems }]),
    /automatic_compaction_source_item_replayed/)
  assert.equal(verify([successor]), null)
})

test('ordinary interrupted or failed turns without automatic compaction have no compaction evidence', () => {
  const product = row({
    requestKind: 'product', requestSequence: 1, responseSequence: 2,
    inputDigest: 'ordinary-input', inputCharacters: 100, inputItemDigest: 'ordinary-item',
  })
  assert.equal(verify([product], 'interrupted'), null)
  assert.equal(verify([product], 'failed'), null)
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
