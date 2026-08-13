import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  CodexDatabaseModelGatewayAuthority,
  CodexModelGatewayRepository,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  digestText,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { createCodexToolFixtureFromDefinitions } from './utils/codex-tool-fixture'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'

type NativeDb = import('better-sqlite3').Database

const at = '2026-08-07T04:00:00.000Z'
const gatewayToolDefinition: ToolDefinition = {
  name: 'ready_read_probe', groupId: 'agent_interaction', domain: 'document', kind: 'read',
  concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
  supportsTextBridge: true, projectionHint: null, description: 'read', schema: { type: 'object' },
  executionVisibility: 'model', resultShape: 'json',
}

const tools = createCodexToolFixtureFromDefinitions([gatewayToolDefinition])
  .readyToolSurface.responsesTools

function requestEvidence(seed: string, toolSurface: unknown[] = tools) {
  return {
    instructionDigest: digestCanonicalJson(`instruction:${seed}`),
    inputDigest: digestCanonicalJson(`input:${seed}`),
    inputItems: [{
      digest: digestCanonicalJson(`item:${seed}`),
      totalStringCharacters: 10,
      maxStringCharacters: 10,
    }],
    inputTotalStringCharacters: 10,
    inputMaxStringCharacters: 10,
    toolsDigest: digestCanonicalJson(toolSurface),
    toolCount: toolSurface.length,
    bodyBytes: 100,
  }
}

function prepared(toolSurfaceDigest: string, maxIterations = 8, maxToolCalls = 4): PreparedCodexProductRun {
  const toolFixture = createCodexToolFixtureFromDefinitions([gatewayToolDefinition])
  assert.equal(toolFixture.readyToolSurface.toolSurfaceDigest, toolSurfaceDigest)
  return {
    preparationContract: 'codex_product_run_e1',
    taskId: 'task-run-1',
    runId: 'run-1',
    conversationAlias: { aliasId: 'scope-1', aliasGeneration: 1 },
    ingressBinding: {
      requestId: 'request-run-1',
      reservationSetId: 'set-run-1',
      reservationEvidenceDigest: 'reservation-evidence-run-1',
    },
    ingress: {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: 'message-run-1',
      canonicalCurrentInputRef: {
        messageId: 'message-run-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: digestCanonicalJson([]),
    recoveredContextDigest: null,
    ...toolFixture,
    readyToolHostIdentity: {
      scopeId: 'scope-1',
      aliasId: 'scope-1',
      authorizationOwnerId: 'owner-1',
      resourceOwnerId: 'resource-owner-1',
    },
    productBudgetSeed: { maxIterations, maxToolCalls, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning', taskTitle: '正在理解需求', taskSummary: '正在整理任务边界',
    },
  }
}

function reservation(): StartIdentityReservationSet {
  return {
    reservationSetId: 'set-run-1',
    scopeId: 'scope-1',
    existingThread: false,
    members: [
      { method: 'thread/start', reservationId: 'thread-member-1' },
      { method: 'turn/start', reservationId: 'turn-member-1' },
    ],
    reservationEvidenceDigest: 'reservation-evidence-run-1',
  }
}

async function withDatabase(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  work: (db: NativeDb) => void | Promise<void>,
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'Codex model gateway authority')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'local',
        source_id TEXT NOT NULL DEFAULT '',
        thread_key TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'butler',
        closed_at TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL, meta_json TEXT NOT NULL,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        status TEXT NOT NULL, execution_binding_json TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE run_meta (
        run_id TEXT PRIMARY KEY, task_id TEXT, scope_id TEXT,
        status TEXT NOT NULL, execution_binding_json TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE skill_task_runs (
        id TEXT PRIMARY KEY,
        scope_id TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT -1,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE pending_task_events (
        id TEXT PRIMARY KEY,
        scope_id TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT -1,
        consumed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ''
      );
    `)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    __runMigrationForTests('089_codex_runtime_evidence_guards', db as unknown as MigrationDatabase)
    __runMigrationForTests('090_codex_model_gateway_authority', db as unknown as MigrationDatabase)
    __runMigrationForTests('091_codex_model_gateway_turn_claim', db as unknown as MigrationDatabase)
    __runMigrationForTests('092_codex_tool_bridge', db as unknown as MigrationDatabase)
    __runMigrationForTests('093_codex_e5_budget_admission', db as unknown as MigrationDatabase)
    __runMigrationForTests('094_codex_host_failure_closeout_readback', db as unknown as MigrationDatabase)
    __runMigrationForTests('095_codex_lifecycle_recovery_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('096_codex_fence_owner_transfer', db as unknown as MigrationDatabase)
    __runMigrationForTests('097_codex_gateway_completion_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('098_codex_manual_compaction_recovery_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('101_codex_manual_compaction_item_identity', db as unknown as MigrationDatabase)
    __runMigrationForTests('108_codex_thread_retirement_cleanup', db as unknown as MigrationDatabase)
    await work(db)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

function admitProduct(db: NativeDb, input: {
  snapshotRef: string
  snapshotDigest: string
  toolSurfaceDigest: string
  instructionDigest: string
  maxIterations?: number
  maxToolCalls?: number
}): CodexBindingRepository {
  const run = prepared(input.toolSurfaceDigest, input.maxIterations, input.maxToolCalls)
  const executionBinding = { schemaVersion: 1, runId: 'run-1' }
  const parentMeta = { requestId: run.ingressBinding.requestId }
  db.prepare(`INSERT INTO chat_conversations (id) VALUES ('scope-1')`).run()
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
    VALUES ('message-run-1', 'scope-1', 'user', 'hello', ?, ?, 0)
  `).run(at, JSON.stringify(parentMeta))
  db.prepare(`
    INSERT INTO task_projections (task_id, run_id, scope_id, status, execution_binding_json, message_visibility_epoch)
    VALUES ('task-run-1', 'run-1', 'scope-1', 'running', ?, 0)
  `).run(JSON.stringify(executionBinding))
  db.prepare(`
    INSERT INTO run_meta (run_id, task_id, scope_id, status, execution_binding_json, message_visibility_epoch)
    VALUES ('run-1', 'task-run-1', 'scope-1', 'running', ?, 0)
  `).run(JSON.stringify(executionBinding))
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
  repository.createEmptyAliasGeneration({
    threadBindingId: 'thread-binding-1', aliasId: 'scope-1', aliasGeneration: 1,
    readyScopeId: 'scope-1', runtimeManifestDigest: 'runtime-manifest-digest',
    protocolSchemaDigest: 'protocol-schema-digest', createdAt: at,
  })
  const admissionInput = {
    prepared: run,
    reservation: reservation(),
    ownerMainBootId: 'main-boot-1',
    admittedAt: at,
    ingressAdmittedRevision: 1,
    threadBindingId: 'thread-binding-1',
    isolatedThreadCwd: '/tmp/ready-codex/thread-binding-1',
    turnRequestId: 'turn-request-1',
    runtimeManifestDigest: 'runtime-manifest-digest',
    protocolSchemaDigest: 'protocol-schema-digest',
    instructionContractDigest: input.instructionDigest,
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: input.snapshotRef,
    upstreamProfileSnapshotDigest: input.snapshotDigest,
    additionalContextDigest: digestCanonicalJson([]),
    turnContractDigest: 'turn-contract-1',
    messageVisibilityEpoch: 0,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: 'hello',
      messageTimestamp: at,
      messageMetaDigest: digestCanonicalJson(parentMeta),
      executionBindingDigest: digestCanonicalJson(executionBinding),
    },
  }
  const admission: CodexAdmittedBindingInput = {
    ...admissionInput,
    ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionInput),
  }
  repository.admitProductBindings(admission)
  repository.activateStartDispatch({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
    bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
    requestDigest: 'thread-start-request', dispatchedAt: at,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
    bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
    nativeResult: {
      thread: {
        id: 'thread-native-1', sessionId: 'thread-native-1', parentThreadId: null,
        forkedFromId: null, cwd: '/tmp/ready-codex/thread-binding-1', source: 'vscode',
        threadSource: null, modelProvider: 'ready_gateway', cliVersion: '0.146.1',
        createdAt: 1, ephemeral: false, preview: '', status: { type: 'idle' },
        updatedAt: 1, turns: [],
      },
      instructionSources: [],
    },
    responseDigest: 'thread-start-response', responsePending: false, reconciledAt: at,
  })
  return repository
}

test('durable gateway authority resolves only the active product binding before turn reconciliation', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex model gateway authority outer coverage')) return
  await withDatabase(t, async (db) => {
    const created = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-1',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
        apiKey: 'never-persist-this', model: 'upstream-model', agentProtocol: 'openai',
        wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const instructionDigest = digestText('fixed instructions')
    const bindingRepository = admitProduct(db, {
      snapshotRef: created.snapshotRef,
      snapshotDigest: created.snapshotDigest,
      toolSurfaceDigest: digestCanonicalJson(tools),
      instructionDigest,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      bindingRepository,
    )
    gatewayRepository.storeSnapshot({ ...created, createdAt: at })
    bindingRepository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-start-request', dispatchedAt: at,
    })
    const metadata = {
      requestKind: 'turn', threadId: 'thread-native-1', turnId: 'turn-native-early',
      readyRunId: 'run-1', toolSurfaceDigest: digestCanonicalJson(tools),
      turnContractDigest: 'turn-contract-1',
      upstreamProfileSnapshotDigest: created.snapshotDigest,
      raw: { request_kind: 'turn' },
    }
    const authority = new CodexDatabaseModelGatewayAuthority(gatewayRepository)
    await assert.rejects(
      authority.resolve({
        metadata, requestDigest: 'request-digest-invalid',
        requestEvidence: requestEvidence('invalid'), receivedAt: at,
        validate: () => { throw new Error('gateway_request_contract_invalid') },
      }),
      /gateway_request_contract_invalid/,
    )
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts`).get<{ count: number }>()?.count,
      0,
    )
    const resolved = await authority.resolve({
      metadata, requestDigest: 'request-digest-1',
      requestEvidence: requestEvidence('request-1'), receivedAt: at,
      validate: () => new Set(['ready_read_probe']),
    })
    assert.equal(resolved.kind, 'product')
    assert.equal(resolved.snapshot.model, 'upstream-model')
    assert.deepEqual(resolved.allowedToolNames, ['ready_read_probe'])
    assert.equal(JSON.stringify(resolved.snapshot).includes('never-persist-this'), false)
    const responseEvidence = {
      responseId: 'response-request-1',
      terminalDigest: digestCanonicalJson({ terminal: 'request-1' }),
      outputDigest: digestCanonicalJson({ output: 'request-1' }),
      usageDigest: digestCanonicalJson({ usage: 'request-1' }),
    }
    await authority.recordResponseEvidence({
      metadata,
      requestDigest: 'request-digest-1',
      responseEvidence,
      completedAt: at,
    })
    await authority.recordResponseEvidence({
      metadata,
      requestDigest: 'request-digest-1',
      responseEvidence,
      completedAt: '2026-08-07T04:00:00.500Z',
    })
    await assert.rejects(authority.recordResponseEvidence({
      metadata,
      requestDigest: 'request-digest-1',
      responseEvidence: {
        ...responseEvidence,
        outputDigest: digestCanonicalJson({ output: 'conflict' }),
      },
      completedAt: '2026-08-07T04:00:00.750Z',
    }), /gateway_response_receipt_conflict/)
    const exchange = gatewayRepository.readTurnGatewayEvidence({
      readyRunId: 'run-1', codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-early',
    })
    assert.equal(exchange.length, 1)
    assert.ok((exchange[0].responseSequence || 0) > exchange[0].requestSequence)
    assert.equal(exchange[0].responseEvidenceDigest, digestCanonicalJson({
      gatewayRequestReceiptId: exchange[0].receiptId,
      ...responseEvidence,
    }))
    await authority.admitToolResponse({
      metadata,
      requestDigest: 'request-digest-1',
      calls: [
        { codexCallId: 'call-1', toolName: 'ready_read_probe', argsDigest: digestCanonicalJson({ q: 1 }) },
        { codexCallId: 'call-2', toolName: 'ready_read_probe', argsDigest: digestCanonicalJson({ q: 2 }) },
      ],
      admittedAt: at,
    })
    assert.deepEqual(db.prepare(`
      SELECT request_kind, ready_run_id, codex_thread_id, codex_turn_id
        FROM ready_model_gateway_request_receipts
    `).all(), [{
      request_kind: 'product', ready_run_id: 'run-1',
      codex_thread_id: 'thread-native-1', codex_turn_id: 'turn-native-early',
    }])
    assert.equal(db.prepare(`
      SELECT gateway_claimed_codex_turn_id FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
    `).get<{ gateway_claimed_codex_turn_id: string }>()?.gateway_claimed_codex_turn_id, 'turn-native-early')
    const automaticMetadata = {
      ...metadata,
      requestKind: 'compaction',
      raw: {
        request_kind: 'compaction',
        compaction: {
          trigger: 'auto', reason: 'context_limit', implementation: 'responses',
          phase: 'pre_turn', strategy: 'memento',
        },
      },
    }
    const automatic = await authority.resolve({
      metadata: automaticMetadata,
      requestDigest: 'automatic-request-digest', receivedAt: at,
      requestEvidence: requestEvidence('automatic-1', []),
      validate: () => new Set<string>(),
    })
    assert.equal(automatic.kind, 'automatic_compaction')
    assert.equal(automatic.allowedToolNames, null)
    await assert.rejects(authority.resolve({
      metadata: { ...automaticMetadata, turnId: 'automatic-turn-forged' },
      requestDigest: 'automatic-request-forged', receivedAt: at,
      requestEvidence: requestEvidence('automatic-forged', []),
      validate: () => new Set<string>(),
    }), /gateway_product_binding_mismatch/)

    const restarted = new CodexDatabaseModelGatewayAuthority(
      new CodexModelGatewayRepository(db as unknown as DatabaseConnection, bindingRepository),
    )
    await assert.rejects(restarted.resolve({
      metadata, requestDigest: 'request-digest-1',
      requestEvidence: requestEvidence('request-1'), receivedAt: '2026-08-07T04:00:01.000Z',
      validate: () => new Set(['ready_read_probe']),
    }), /gateway_request_replayed/)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts`).get<{ count: number }>()?.count, 2)
    await restarted.resolve({
      metadata, requestDigest: 'request-digest-2',
      requestEvidence: requestEvidence('request-2'), receivedAt: '2026-08-07T04:00:02.000Z',
      validate: () => new Set(['ready_read_probe']),
    })
    await assert.rejects(restarted.admitToolResponse({
      metadata,
      requestDigest: 'request-digest-2',
      calls: [
        { codexCallId: 'call-3', toolName: 'ready_read_probe', argsDigest: digestCanonicalJson({ q: 3 }) },
        { codexCallId: 'call-4', toolName: 'ready_read_probe', argsDigest: digestCanonicalJson({ q: 4 }) },
      ],
      admittedAt: '2026-08-07T04:00:02.000Z',
    }), /parallel_tool_group_budget_exhausted/)
    const secondReceipt = db.prepare(`
      SELECT receipt_id FROM ready_model_gateway_request_receipts
       WHERE request_digest = 'request-digest-2'
    `).get<{ receipt_id: string }>()
    assert.ok(secondReceipt)
    assert.throws(() => db.prepare(`
      INSERT INTO codex_tool_group_admissions (
        gateway_request_receipt_id, ready_run_id, codex_thread_id, codex_turn_id,
        tool_call_count, parallel_group_charged, group_digest, admitted_at
      ) VALUES (?, 'run-1', 'thread-native-1', 'turn-native-early', 2, 0,
        'forged-uncharged-parallel-group', ?)
    `).run(secondReceipt.receipt_id, '2026-08-07T04:00:02.000Z'), /CHECK constraint failed/)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_tool_group_admissions
    `).get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_tool_call_admissions
    `).get<{ count: number }>()?.count, 2)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts`).get<{ count: number }>()?.count, 3)
    await assert.rejects(
      restarted.resolve({
        metadata: { ...metadata, turnId: 'turn-native-forged' },
        requestDigest: 'request-digest-forged-turn', receivedAt: at,
        validate: () => new Set(['ready_read_probe']),
      }),
      /gateway_product_binding_mismatch/,
    )
    assert.throws(() => bindingRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
      nativeId: 'turn-native-forged',
      nativeResult: { turn: { id: 'turn-native-forged', items: [], status: 'inProgress', error: null } },
      responseDigest: 'turn-start-response-forged', responsePending: false, reconciledAt: at,
    }), /turn_reconciliation_metadata_mismatch/)
    bindingRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
      nativeId: 'turn-native-early',
      nativeResult: { turn: { id: 'turn-native-early', items: [], status: 'inProgress', error: null } },
      responseDigest: 'turn-start-response', responsePending: false, reconciledAt: at,
    })
    await assert.rejects(
      restarted.resolve({
        metadata: { ...metadata, turnContractDigest: 'forged-turn-contract' },
        requestDigest: 'request-digest-forged', receivedAt: at,
        validate: () => new Set(['ready_read_probe']),
      }),
      /gateway_product_binding_mismatch/,
    )
    assert.throws(
      () => db.prepare(`
        UPDATE ready_model_gateway_profile_snapshots SET profile_id = 'forged'
         WHERE snapshot_ref = ?
      `).run(created.snapshotRef),
      /ready_model_gateway_snapshot_immutable/,
    )
  })
})

test('product iteration budget is durable while automatic compaction is not charged', async (t) => {
  await withDatabase(t, async (db) => {
    const created = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-budget',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
        apiKey: 'never-persist-this', model: 'upstream-model', agentProtocol: 'openai',
        wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const repository = admitProduct(db, {
      snapshotRef: created.snapshotRef,
      snapshotDigest: created.snapshotDigest,
      toolSurfaceDigest: digestCanonicalJson(tools),
      instructionDigest: digestText('fixed instructions'),
      maxIterations: 1,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...created, createdAt: at })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-start-request', dispatchedAt: at,
    })
    const authority = new CodexDatabaseModelGatewayAuthority(gatewayRepository)
    const metadata = {
      requestKind: 'turn', threadId: 'thread-native-1', turnId: 'turn-native-budget',
      readyRunId: 'run-1', toolSurfaceDigest: digestCanonicalJson(tools),
      turnContractDigest: 'turn-contract-1',
      upstreamProfileSnapshotDigest: created.snapshotDigest,
      raw: { request_kind: 'turn' },
    }
    const finalOnly = await authority.resolve({
      metadata, requestDigest: 'budget-product-1',
      requestEvidence: requestEvidence('budget-product-1'), receivedAt: at,
      validate: () => new Set(['ready_read_probe']),
    })
    assert.equal(finalOnly.forceToolFreeFinalization, true)
    const automaticCompaction = await authority.resolve({
      metadata: {
        ...metadata,
        requestKind: 'compaction',
        raw: {
          request_kind: 'compaction',
          compaction: {
            trigger: 'auto', reason: 'context_limit', implementation: 'responses',
            phase: 'pre_turn', strategy: 'memento',
          },
        },
      },
      requestDigest: 'budget-auto-1', receivedAt: at,
      requestEvidence: requestEvidence('budget-auto-1', []),
      validate: () => new Set<string>(),
    })
    assert.equal(automaticCompaction.forceToolFreeFinalization, false)
    await assert.rejects(authority.resolve({
      metadata, requestDigest: 'budget-product-2',
      requestEvidence: requestEvidence('budget-product-2'), receivedAt: at,
      validate: () => new Set(['ready_read_probe']),
    }), /gateway_iteration_budget_exhausted/)
    assert.deepEqual(db.prepare(`
      SELECT request_kind, COUNT(*) AS count
        FROM ready_model_gateway_request_receipts GROUP BY request_kind ORDER BY request_kind
    `).all(), [
      { request_kind: 'automatic_compaction', count: 1 },
      { request_kind: 'product', count: 1 },
    ])
  })
})

test('product budget keeps one final model request after the last admitted tool call', async (t) => {
  await withDatabase(t, async (db) => {
    const created = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-final-response-budget',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
        apiKey: 'never-persist-this', model: 'upstream-model', agentProtocol: 'openai',
        wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const bindingRepository = admitProduct(db, {
      snapshotRef: created.snapshotRef,
      snapshotDigest: created.snapshotDigest,
      toolSurfaceDigest: digestCanonicalJson(tools),
      instructionDigest: digestText('fixed instructions'),
      maxIterations: 2,
      maxToolCalls: 1,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      bindingRepository,
    )
    gatewayRepository.storeSnapshot({ ...created, createdAt: at })
    bindingRepository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-start-request', dispatchedAt: at,
    })
    const authority = new CodexDatabaseModelGatewayAuthority(gatewayRepository)
    const metadata = {
      requestKind: 'turn', threadId: 'thread-native-1', turnId: 'turn-native-final-budget',
      readyRunId: 'run-1', toolSurfaceDigest: digestCanonicalJson(tools),
      turnContractDigest: 'turn-contract-1',
      upstreamProfileSnapshotDigest: created.snapshotDigest,
      raw: { request_kind: 'turn' },
    }
    const toolBinding = await authority.resolve({
      metadata, requestDigest: 'tool-request',
      requestEvidence: requestEvidence('tool-request'), receivedAt: at,
      validate: () => new Set(['ready_read_probe']),
    })
    assert.equal(toolBinding.forceToolFreeFinalization, false)
    await authority.admitToolResponse({
      metadata,
      requestDigest: 'tool-request',
      calls: [{
        codexCallId: 'call-1',
        toolName: 'ready_read_probe',
        argsDigest: digestCanonicalJson({ q: 1 }),
      }],
      admittedAt: at,
    })
    const restartedAuthority = new CodexDatabaseModelGatewayAuthority(
      new CodexModelGatewayRepository(db as unknown as DatabaseConnection, bindingRepository),
    )
    const finalBinding = await restartedAuthority.resolve({
      metadata, requestDigest: 'final-response-request',
      requestEvidence: requestEvidence('final-response-request'),
      receivedAt: '2026-08-07T04:00:01.000Z',
      validate: () => new Set(['ready_read_probe']),
    })
    assert.equal(finalBinding.forceToolFreeFinalization, true)
    await assert.rejects(authority.admitToolResponse({
      metadata,
      requestDigest: 'final-response-request',
      calls: [{
        codexCallId: 'call-2',
        toolName: 'ready_read_probe',
        argsDigest: digestCanonicalJson({ q: 2 }),
      }],
      admittedAt: '2026-08-07T04:00:01.000Z',
    }), /tool_call_budget_exhausted/)
    await assert.rejects(authority.resolve({
      metadata, requestDigest: 'over-budget-request',
      requestEvidence: requestEvidence('over-budget-request'),
      receivedAt: '2026-08-07T04:00:02.000Z',
      validate: () => new Set(['ready_read_probe']),
    }), /gateway_iteration_budget_exhausted/)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_tool_group_admissions WHERE ready_run_id = 'run-1'
    `).get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM ready_model_gateway_request_receipts
       WHERE ready_run_id = 'run-1' AND request_kind = 'product'
    `).get<{ count: number }>()?.count, 2)
  })
})

test('turn gateway evidence rejects an admitted receipt with a missing request transcript', async (t) => {
  await withDatabase(t, (db) => {
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id,
        ready_run_id, manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'automatic_compaction', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'receipt-missing-transcript',
      'thread-missing-transcript',
      'turn-missing-transcript',
      'run-missing-transcript',
      'snapshot-ref-missing-transcript',
      'snapshot-digest-missing-transcript',
      'request-digest-missing-transcript',
      at,
    )
    const repository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
    )
    assert.throws(() => repository.readTurnGatewayEvidence({
      readyRunId: 'run-missing-transcript',
      codexThreadId: 'thread-missing-transcript',
      codexTurnId: 'turn-missing-transcript',
    }), /gateway_request_transcript_missing/)
  })
})

test('manual compaction resolves only the reserved thread and empty tool surface', async (t) => {
  await withDatabase(t, async (db) => {
    const created = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-1',
      config: {
        provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
        apiKey: 'never-persist-this', model: 'upstream-model', agentProtocol: 'openai',
        wireApi: 'chat/completions', toolUseMode: 'on',
      },
      maxRetries: 0,
    })
    const repository = admitProduct(db, {
      snapshotRef: created.snapshotRef,
      snapshotDigest: created.snapshotDigest,
      toolSurfaceDigest: digestCanonicalJson(tools),
      instructionDigest: digestText('fixed instructions'),
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...created, createdAt: at })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-start-request', dispatchedAt: at,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
      nativeId: 'turn-native-1',
      nativeResult: { turn: { id: 'turn-native-1', items: [], status: 'completed', error: null } },
      responseDigest: 'turn-start-response', responsePending: false, reconciledAt: at,
    })
    const candidateText = 'manual-compaction-prerequisite'
    repository.recordEngineTerminalCandidate({
      readyRunId: 'run-1', codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      engineOutcome: 'completed', recordedAt: at,
      candidate: {
        kind: 'native_terminal', readyTaskId: 'task-run-1', readyRunId: 'run-1',
        scopeId: 'scope-1', codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
        engineOutcome: 'completed',
        candidateSelection: { kind: 'accepted', itemId: 'final-1' },
        candidateText,
        candidateDigest: createHash('sha256').update(candidateText).digest('hex'),
        usedToolCalls: [], actionReceiptRefs: [], interactionState: null, waitingFor: null,
        terminalReasonCandidate: 'done', abortInitiator: null, budgetState: {}, contextState: {},
        providerDiagnostics: {}, recoveryCheckpointRef: null, browserContinuationRef: null,
        browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
        runtimeDiagnostics: { finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: null },
      },
    })
    repository.recordToolPublicationReceipt({ readyRunId: 'run-1', recordedAt: at })
    const terminalMessage = {
      id: 'assistant:task-run-1:run-1:terminal', conversationId: 'scope-1',
      role: 'assistant', content: candidateText, timestamp: at,
      meta: { taskId: 'task-run-1', runId: 'run-1', terminalReason: 'done' },
    }
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      terminalMessage.id, terminalMessage.conversationId, terminalMessage.role,
      terminalMessage.content, terminalMessage.timestamp, JSON.stringify(terminalMessage.meta),
    )
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1', productTerminalDigest: workflowDigest(terminalMessage), closeoutAt: at,
    })
    repository.beginManualCompaction({
      manualCompactionId: 'manual-1', threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: created.snapshotRef,
      upstreamProfileSnapshotDigest: created.snapshotDigest,
      providerSnapshot: created.snapshot,
      credentialReferenceId: created.snapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]),
      preDispatchThreadReadDigest: 'pre-dispatch-thread-read',
      preDispatchTurnIds: ['turn-native-1'],
      expiresAt: '2026-08-07T05:00:00.000Z', createdAt: at,
    })
    const authority = new CodexDatabaseModelGatewayAuthority(gatewayRepository)
    const resolved = await authority.resolve({
      metadata: {
        requestKind: 'compaction', threadId: 'thread-native-1', turnId: 'compact-turn-1',
        readyRunId: null, toolSurfaceDigest: null, turnContractDigest: null,
        upstreamProfileSnapshotDigest: null,
        raw: {
          request_kind: 'compaction',
          compaction: {
            trigger: 'manual', reason: 'user_requested', implementation: 'responses',
            phase: 'standalone_turn', strategy: 'memento',
          },
        },
      },
      requestDigest: 'manual-request-digest', receivedAt: at,
      requestEvidence: requestEvidence('manual-request', []),
      validate: () => new Set<string>(),
    })
    assert.equal(resolved.kind, 'manual_compaction')
    assert.equal(resolved.toolSurfaceDigest, digestCanonicalJson([]))
    assert.equal(db.prepare(`
      SELECT manual_compaction_id FROM ready_model_gateway_request_receipts
       WHERE request_kind = 'manual_compaction'
    `).get<{ manual_compaction_id: string }>()?.manual_compaction_id, 'manual-1')
    assert.equal(db.prepare(`
      SELECT codex_compaction_turn_id FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-1'
    `).get<{ codex_compaction_turn_id: string }>()?.codex_compaction_turn_id, 'compact-turn-1')
    await assert.rejects(authority.resolve({
      metadata: {
        requestKind: 'compaction', threadId: 'thread-native-1', turnId: 'compact-turn-forged',
        readyRunId: null, toolSurfaceDigest: null, turnContractDigest: null,
        upstreamProfileSnapshotDigest: null,
        raw: {
          request_kind: 'compaction',
          compaction: {
            trigger: 'manual', reason: 'user_requested', implementation: 'responses',
            phase: 'standalone_turn', strategy: 'memento',
          },
        },
      },
      requestDigest: 'manual-request-forged', receivedAt: at,
      requestEvidence: requestEvidence('manual-forged', []),
      validate: () => new Set<string>(),
    }), /gateway_manual_binding_mismatch/)
    assert.throws(() => repository.consumeManualCompaction({
      manualCompactionId: 'manual-1', codexCompactionTurnId: 'compact-turn-forged',
      notificationContextCompactionItemId: 'compact-notification-item-1',
      contextCompactionItemId: 'compact-item-1', threadReadDigest: 'thread-read-1',
      terminalEvidenceDigest: 'terminal-evidence-1', gatewayRequestReceiptId: 'gateway-receipt-1',
      gatewayRequestEvidenceDigest: 'gateway-request-evidence-1',
      gatewayResponseEvidenceDigest: 'gateway-response-evidence-1',
      consumedAt: at,
    }), /manual_compaction_turn_identity_conflict/)
  })
})
