import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database/connection'
import {
  codexTerminalPublicMessage,
  readProductTurnPresentation,
  readProductTurnPresentations,
} from '../main/modules/agent-control/codex-runtime/codex-product-turn-presentation'
import {
  digestReadyMemoryValue,
  READY_MEMORY_READ_RECEIPT_CONTRACT,
  READY_MEMORY_SNAPSHOT_CONTRACT,
  READY_MEMORY_SUMMARY_BUDGET_CHARS,
  type ReadyMemoryReadReceipt,
  type ReadyMemorySnapshot,
} from '../main/modules/agent-control/ready-memory'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('public terminal messages keep internal failure codes in diagnostics only', () => {
  const message = codexTerminalPublicMessage('error')
  assert.match(message, /未能完成/)
  assert.doesNotMatch(message, /codex_|gateway_|protocol_|persistence_/)
})

test('native usage failures explain the account limit without exposing provider text', () => {
  const error = { message: 'private provider diagnostics', codexErrorInfo: 'usageLimitExceeded' as const }
  assert.match(codexTerminalPublicMessage('error', error), /额度.*稍后/)
  assert.doesNotMatch(codexTerminalPublicMessage('error', error), /private provider/)
  assert.equal(codexTerminalPublicMessage('interrupted', error), codexTerminalPublicMessage('interrupted'))
  assert.equal(codexTerminalPublicMessage('error', { message: 'untrusted provider text' }), '本轮未能完成。')
})

test('transient service failures say so, and invite continuing only when the work was kept', () => {
  const overloaded = { message: 'We are experiencing high demand', codexErrorInfo: 'internalServerError' as const }
  const disconnected = { message: 'stream closed', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }
  const kept = { historySeam: 'failed_after_completed_rounds_v1' }
  assert.match(codexTerminalPublicMessage('error', overloaded, kept), /暂时出错.*保留.*继续/)
  assert.match(codexTerminalPublicMessage('error', disconnected, kept), /继续/)
  assert.doesNotMatch(codexTerminalPublicMessage('error', overloaded), /继续/)
  assert.doesNotMatch(codexTerminalPublicMessage('error', overloaded, kept), /high demand/)
  assert.equal(codexTerminalPublicMessage('error', { message: 'bad', codexErrorInfo: 'badRequest' as const },
    { historySeam: 'failed_user_only_no_suffix_v1' }), '本轮未能完成。')
  const idle = { message: 'stream disconnected before completion: idle timeout waiting for SSE', codexErrorInfo: 'other' as const }
  assert.match(codexTerminalPublicMessage('error', idle, { historySeam: 'failed_mid_stream_v1' }), /中途断开.*保留.*继续/)
  assert.equal(codexTerminalPublicMessage('error', idle, { historySeam: null }), '本轮未能完成。')
  assert.match(codexTerminalPublicMessage('error', null, { undelivered: 'codex_tool_publication_incomplete:artifact_staged_receipt_missing' }),
    /计划保存的文件没有保存成功/)
  assert.match(codexTerminalPublicMessage('error', null, { undelivered: 'codex_tool_publication_incomplete:action_obligation_missing' }),
    /需要执行的操作没有执行/)
  assert.equal(codexTerminalPublicMessage('error', null, { undelivered: 'codex_browser_workflow_observation_required' }), '本轮未能完成。')
  assert.equal(codexTerminalPublicMessage('error', null, {
    undelivered: 'codex_tool_publication_incomplete:artifact_export_receipt_missing',
    answer: '  保存时被拒绝，原文档尚未改动。要另存为新文件吗？\n',
  }), '本轮没有完成：计划保存的文件没有保存成功。\n\n保存时被拒绝，原文档尚未改动。要另存为新文件吗？',
  'the verified note leads and the answer stays, so the user can reply to it')
})

test('product presentation reads one terminal snapshot and degrades an oversized tool result', (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex product presentation database')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE codex_thread_bindings (
      thread_binding_id TEXT PRIMARY KEY,
      ready_scope_id TEXT NOT NULL,
      ready_conversation_alias TEXT NOT NULL,
      alias_generation INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      action_projection_sequence INTEGER NOT NULL,
      thread_materialization_kind TEXT NOT NULL,
      materialization_state TEXT NOT NULL,
      history_seed_digest TEXT,
      codex_thread_id TEXT,
      continuation_blocked_at TEXT,
      runtime_manifest_digest TEXT NOT NULL,
      protocol_schema_digest TEXT NOT NULL,
      retired_at TEXT
    );
    CREATE TABLE codex_turn_bindings (
      ready_run_id TEXT PRIMARY KEY,
      ready_task_id TEXT NOT NULL,
      thread_binding_id TEXT NOT NULL,
      message_visibility_epoch INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      product_terminal_digest TEXT,
      host_failure_product_terminal_digest TEXT,
      publication_receipt_digest TEXT,
      ready_memory_snapshot_json TEXT,
      ready_memory_snapshot_digest TEXT,
      ready_memory_read_receipt_json TEXT,
      ready_memory_read_receipt_digest TEXT,
      engine_terminal_candidate_json TEXT,
      terminal_facts_json TEXT,
      terminal_facts_digest TEXT,
      ingress_json TEXT NOT NULL
    );
    CREATE TABLE run_meta (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      terminal_reason TEXT,
      provider_diagnostics_json TEXT
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      meta_json TEXT
    );
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      message_visibility_epoch INTEGER NOT NULL
    );
    CREATE TABLE codex_tool_call_admissions (
      ready_run_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      codex_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      admitted_at TEXT NOT NULL
    );
    CREATE TABLE codex_tool_call_bindings (
      ready_run_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      codex_call_id TEXT NOT NULL,
      ready_action_id TEXT NOT NULL
    );
    CREATE TABLE ready_tool_action_receipts (
      ready_action_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      receipt_id TEXT,
      revision INTEGER,
      result_digest TEXT,
      result_json TEXT,
      resolution_evidence_digest TEXT
    );
    CREATE TABLE codex_tool_response_delivery_attempts (
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      codex_call_id TEXT NOT NULL,
      ready_action_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      transport_write_confirmed_at TEXT,
      tool_response_digest TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pending_confirmations (
      id TEXT PRIMARY KEY, run_id TEXT, status TEXT
    );
    CREATE TABLE codex_thread_dispatch_fences (
      thread_binding_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL
    );
    CREATE TABLE codex_manual_compaction_bindings (
      manual_compaction_id TEXT PRIMARY KEY,
      thread_binding_id TEXT NOT NULL,
      consumed_at TEXT,
      abandoned_at TEXT,
      abandoned_reconciled_at TEXT,
      unknown_at TEXT,
      created_at TEXT NOT NULL
    );
  `)
  const now = '2026-08-18T00:00:00.000Z'
  db.prepare(`
    INSERT INTO codex_thread_bindings (
      thread_binding_id, ready_scope_id, ready_conversation_alias,
      alias_generation, revision, action_projection_sequence,
      thread_materialization_kind, materialization_state, history_seed_digest,
      codex_thread_id, continuation_blocked_at,
      runtime_manifest_digest, protocol_schema_digest, retired_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)
  `).run(
    'thread-binding-1', 'scope-1', 'scope-1', 1, 1, 0,
    'legacy', 'confirmed', 'thread-1', 'runtime', 'protocol',
  )
  db.prepare('INSERT INTO chat_conversations VALUES (?, ?)').run('scope-1', 3)
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id, message_visibility_epoch, revision,
      product_terminal_digest, host_failure_product_terminal_digest,
      publication_receipt_digest, engine_terminal_candidate_json, ingress_json
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
  `)
    .run(
      'run-1',
      'task-1',
      'thread-binding-1',
      3,
      7,
      'a'.repeat(64),
      JSON.stringify({
        contextUsage: {
          usedInputTokens: 6_400,
          windowTokens: 128_000,
          ratio: 0.05,
          windowSource: 'model',
          source: 'last_model_request',
          timestamp: now,
        },
      }),
      '{}',
    )
  db.prepare('INSERT INTO run_meta VALUES (?, ?, ?, ?)').run(
    'run-1',
    'error',
    'blocked_external',
    JSON.stringify({ codexFailure: { error: 'gateway_native_event_limit_exceeded' } }),
  )
  db.prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, ?, ?)').run(
    'assistant:task-1:run-1:terminal',
    'scope-1',
    'assistant',
    '本轮未能完成，已有结果已保留。',
    now,
    JSON.stringify({ runId: 'run-1' }),
  )
  db.prepare('INSERT INTO codex_tool_call_admissions VALUES (?, ?, ?, ?, ?, ?)').run(
    'run-1', 'thread-1', 'turn-1', 'call-1', 'web_search', now,
  )
  db.prepare('INSERT INTO codex_tool_call_bindings VALUES (?, ?, ?, ?, ?)').run(
    'run-1', 'thread-1', 'turn-1', 'call-1', 'action-1',
  )
  db.prepare('INSERT INTO ready_tool_action_receipts VALUES (?, ?, ?, ?, ?, ?, NULL)').run(
    'action-1', 'confirmed', 'receipt-1', 2, 'b'.repeat(64), JSON.stringify({ data: { text: 'x'.repeat(300_000) } }),
  )
  db.prepare('INSERT INTO codex_tool_response_delivery_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-1', 'turn-1', 'call-1', 'action-1', 'delivery-1', now, 'c'.repeat(64), now,
  )

  const receipt = readProductTurnPresentation(db as unknown as DatabaseConnection, 'run-1')
  assert.equal(receipt.contract, 'ready_product_turn_receipt_v3')
  assert.equal(receipt.terminal, 'error')
  assert.equal(receipt.tools[0]?.state, 'degraded')
  assert.equal(receipt.failure, null)
  assert.equal(receipt.actionProjection.retryEvidenceKind, 'unavailable_legacy')
  assert.equal(receipt.memory, null)
  assert.deepEqual(receipt.contextUsage, {
    usedInputTokens: 6_400,
    windowTokens: 128_000,
    ratio: 0.05,
    windowSource: 'model',
    source: 'last_model_request',
    timestamp: now,
  })
  assert.match(receipt.presentationDigest, /^[a-f0-9]{64}$/)

  const memoryContent = '回答保持简洁。'
  const snapshotCore = {
    contract: READY_MEMORY_SNAPSHOT_CONTRACT,
    enabled: true,
    stateRevision: 2,
    revocationRevision: 0,
    lastRevocationReason: null,
    frozenAt: now,
    summaryBudgetChars: READY_MEMORY_SUMMARY_BUDGET_CHARS,
    summaryChars: Array.from(memoryContent).length,
    summary: memoryContent,
    summaryEntryIds: ['entry-1'],
    entries: [{
      entryId: 'entry-1',
      category: 'preference' as const,
      content: memoryContent,
      contentDigest: createHash('sha256').update(memoryContent).digest('hex'),
      origin: 'manual' as const,
      pinned: true,
      sourceRefs: [],
      stateRevision: 2,
    }],
    sourceRefs: [],
    truncated: false,
  } as const
  const snapshot: ReadyMemorySnapshot = {
    ...snapshotCore,
    snapshotDigest: digestReadyMemoryValue(snapshotCore),
  }
  const readReceiptCore = {
    contract: READY_MEMORY_READ_RECEIPT_CONTRACT,
    snapshotDigest: snapshot.snapshotDigest,
    stateRevision: snapshot.stateRevision,
    revocationRevision: snapshot.revocationRevision,
    readEntryIds: ['entry-1'],
    readAt: now,
  } as const
  const readReceipt: ReadyMemoryReadReceipt = {
    ...readReceiptCore,
    readEntryIds: [...readReceiptCore.readEntryIds],
    receiptDigest: digestReadyMemoryValue(readReceiptCore),
  }
  const writeMemoryReceipt = db.prepare(`
    UPDATE codex_turn_bindings
       SET ready_memory_snapshot_json = ?, ready_memory_snapshot_digest = ?,
           ready_memory_read_receipt_json = ?, ready_memory_read_receipt_digest = ?
     WHERE ready_run_id = 'run-1'
  `)
  writeMemoryReceipt.run(
    JSON.stringify(snapshot),
    snapshot.snapshotDigest,
    JSON.stringify(readReceipt),
    readReceipt.receiptDigest,
  )
  assert.deepEqual(readProductTurnPresentation(
    db as unknown as DatabaseConnection,
    'run-1',
  ).memory, {
    snapshotDigest: snapshot.snapshotDigest,
    stateRevision: 2,
    revocationRevision: 0,
    summaryEntryIds: ['entry-1'],
    readEntryIds: ['entry-1'],
    readReceiptDigest: readReceipt.receiptDigest,
  })

  db.prepare(`
    UPDATE codex_turn_bindings SET ready_memory_snapshot_digest = ? WHERE ready_run_id = 'run-1'
  `).run('f'.repeat(64))
  assert.throws(
    () => readProductTurnPresentation(db as unknown as DatabaseConnection, 'run-1'),
    /product_turn_memory_snapshot_digest_mismatch/,
  )
  writeMemoryReceipt.run(
    JSON.stringify(snapshot),
    snapshot.snapshotDigest,
    JSON.stringify(readReceipt),
    readReceipt.receiptDigest,
  )

  const unknownEntryReceiptCore = { ...readReceiptCore, readEntryIds: ['missing-entry'] }
  const unknownEntryReceipt = {
    ...unknownEntryReceiptCore,
    receiptDigest: digestReadyMemoryValue(unknownEntryReceiptCore),
  }
  writeMemoryReceipt.run(
    JSON.stringify(snapshot),
    snapshot.snapshotDigest,
    JSON.stringify(unknownEntryReceipt),
    unknownEntryReceipt.receiptDigest,
  )
  assert.throws(
    () => readProductTurnPresentation(db as unknown as DatabaseConnection, 'run-1'),
    /product_turn_memory_receipt_digest_mismatch/,
  )

  writeMemoryReceipt.run(JSON.stringify(snapshot), snapshot.snapshotDigest, JSON.stringify(readReceipt), null)
  assert.throws(
    () => readProductTurnPresentation(db as unknown as DatabaseConnection, 'run-1'),
    /product_turn_memory_receipt_incomplete/,
  )
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    assert.deepEqual(readProductTurnPresentations(db as unknown as DatabaseConnection, ['missing', 'run-1']), [])
  } finally {
    __setMetricSinkForTests(null)
  }
  assert.deepEqual(metrics.map(({ metric, readyRunId, reason }) => ({ metric, readyRunId, reason })), [{
    metric: 'codex_product_turn_presentation_unreadable',
    readyRunId: 'run-1',
    reason: 'product_turn_memory_receipt_incomplete',
  }], 'a damaged run is reported; a run without a binding stays quiet')
  writeMemoryReceipt.run(
    JSON.stringify(snapshot),
    snapshot.snapshotDigest,
    JSON.stringify(readReceipt),
    readReceipt.receiptDigest,
  )

  assert.deepEqual(
    readProductTurnPresentations(db as unknown as DatabaseConnection, ['missing', 'run-1', 'run-1'])
      .map((item) => item.readyRunId),
    ['run-1'],
  )
  assert.equal(db.inTransaction, false)
})
