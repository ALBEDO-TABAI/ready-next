import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  CodexBindingRepository,
  CodexBindingRepositoryError,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { CodexDurableStartDispatchPort } from '../main/modules/agent-control/codex-runtime/codex-durable-start-dispatch'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import type {
  CodexNativeNotification,
  CodexThread,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const admittedAt = '2026-08-07T01:00:00.000Z'

function prepared(runId = 'run-1'): PreparedCodexProductRun {
  return {
    preparationContract: 'codex_product_run_e1',
    taskId: `task-${runId}`,
    runId,
    conversationAlias: { aliasId: 'scope-1', aliasGeneration: 1 },
    ingressBinding: {
      requestId: `request-${runId}`,
      reservationSetId: `set-${runId}`,
      reservationEvidenceDigest: `reservation-evidence-${runId}`,
    },
    ingress: {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: `message-${runId}`,
      canonicalCurrentInputRef: {
        messageId: `message-${runId}`,
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: `resource-${runId}`,
    recoveredContextDigest: null,
    readyToolSurface: {
      surfaceId: 'surface-1',
      toolSurfaceDigest: 'tool-surface-digest',
      toolNames: [],
    },
    readyTurnToolAuthorization: {
      authorizationId: 'authorization-1',
      authorizationDigest: 'authorization-digest',
    },
    readyToolHostIdentity: {
      scopeId: 'scope-1',
      aliasId: 'scope-1',
      authorizationOwnerId: 'owner-1',
      resourceOwnerId: 'resource-owner-1',
    },
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning',
      taskTitle: '正在理解需求',
      taskSummary: '正在整理任务边界、资源与可用能力',
    },
  }
}

function lazyReservation(runId = 'run-1'): StartIdentityReservationSet {
  return {
    reservationSetId: `set-${runId}`,
    scopeId: 'scope-1',
    existingThread: false,
    members: [
      { method: 'thread/start', reservationId: `thread-member-${runId}` },
      { method: 'turn/start', reservationId: `turn-member-${runId}` },
    ],
    reservationEvidenceDigest: `reservation-evidence-${runId}`,
  }
}

function existingReservation(runId: string): StartIdentityReservationSet {
  return {
    reservationSetId: `set-${runId}`,
    scopeId: 'scope-1',
    existingThread: true,
    members: [{ method: 'turn/start', reservationId: `turn-member-${runId}` }],
    reservationEvidenceDigest: `reservation-evidence-${runId}`,
  }
}

function admission(
  run: PreparedCodexProductRun,
  reservation: StartIdentityReservationSet,
  overrides: Partial<CodexAdmittedBindingInput> = {},
): CodexAdmittedBindingInput {
  return {
    prepared: run,
    reservation,
    ownerMainBootId: 'main-boot-1',
    admittedAt,
    ingressAdmittedRevision: 1,
    ingressAdmittedDigest: `ingress-digest-${run.runId}`,
    threadBindingId: 'thread-binding-1',
    isolatedThreadCwd: '/tmp/ready-codex/thread-binding-1',
    turnRequestId: `turn-request-${run.runId}`,
    runtimeManifestDigest: 'runtime-manifest-digest',
    protocolSchemaDigest: 'protocol-schema-digest',
    instructionContractDigest: 'instruction-contract-digest',
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: 'profile-ref-1',
    upstreamProfileSnapshotDigest: 'profile-digest-1',
    additionalContextDigest: `additional-context-${run.runId}`,
    turnContractDigest: `turn-contract-${run.runId}`,
    ...overrides,
  }
}

function rootThread(): CodexThread {
  return {
    id: 'thread-native-1',
    sessionId: 'thread-native-1',
    parentThreadId: null,
    forkedFromId: null,
    cwd: '/tmp/ready-codex/thread-binding-1',
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: 1,
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: 1,
    turns: [],
  }
}

function activeTurn(): CodexTurn {
  return { id: 'turn-native-1', items: [], status: 'inProgress', error: null }
}

function prepareReadyParentRowsOnly(db: NativeDb, run: PreparedCodexProductRun): void {
  db.prepare(`INSERT OR IGNORE INTO chat_conversations (id) VALUES (?)`).run(
    run.readyToolHostIdentity.scopeId,
  )
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id) VALUES (?, ?)
  `).run(run.ingress.originUserMessageId, run.readyToolHostIdentity.scopeId)
  db.prepare(`
    INSERT INTO task_projections (task_id, run_id, scope_id, status) VALUES (?, ?, ?, 'running')
  `).run(run.taskId, run.runId, run.readyToolHostIdentity.scopeId)
}

function prepareReadyParents(
  db: NativeDb,
  repository: CodexBindingRepository,
  run: PreparedCodexProductRun,
): void {
  prepareReadyParentRowsOnly(db, run)
  if (run.conversationAlias.aliasGeneration === 1) {
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-1',
      aliasId: run.conversationAlias.aliasId,
      aliasGeneration: run.conversationAlias.aliasGeneration,
      readyScopeId: run.readyToolHostIdentity.scopeId,
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })
  }
}

async function withRepository(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  work: (db: NativeDb, repository: CodexBindingRepository) => void | Promise<void>,
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'Codex binding repository')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    __runMigrationForTests('089_codex_runtime_evidence_guards', db as unknown as MigrationDatabase)
    await work(db, new CodexBindingRepository(db as unknown as DatabaseConnection))
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

test('unknown early inbound identity remains durably quarantined across repository restart', async (t) => {
  await withRepository(t, async (db, repository) => {
    const registry = new CodexStartIdentityRegistry({ capacity: 4 })
    const reserved = registry.reserve({ scopeId: 'scope-1', existingThread: false })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) throw new Error(reserved.code)
    const run = prepared('run-unknown-inbound')
    run.ingressBinding = {
      requestId: 'request-run-unknown-inbound',
      reservationSetId: reserved.reservation.reservationSetId,
      reservationEvidenceDigest: reserved.reservation.reservationEvidenceDigest,
    }
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, reserved.reservation))
    const inboundBuffer = new CodexProvisionalInboundBuffer({
      maxFramesPerOwner: 8,
      maxBytesPerOwner: 16_384,
      nowMs: () => Date.parse(admittedAt),
      serverRequestExecutor: { async execute() { throw new Error('unexpected_tool_execution') } },
      startInboundQuarantinePort: {
        quarantine: (input) => repository.quarantineStartInbound({
          ...input,
          quarantinedAt: admittedAt,
        }),
      },
    })
    inboundBuffer.attachReleasePort({
      broadcastNotification() { throw new Error('unexpected_notification_release') },
      respondServerRequest() { throw new Error('unexpected_server_request_release') },
      failProtocol(error) { throw error },
    })
    const dispatch = new CodexDurableStartDispatchPort({
      repository,
      registry,
      inboundBuffer,
      evidenceResolver: { async resolveTypedRejection() { return { resolution: 'unknown' } } },
      now: () => admittedAt,
      inboundDeadlineMs: 5_000,
      pinnedThreadSource: 'vscode',
    })
    await dispatch.activate({
      connectionEpoch: 'epoch-unknown',
      rpcId: 1,
      method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-unknown',
    })
    const conflicting: CodexNativeNotification = {
      method: 'thread/started',
      params: {
        thread: {
          ...rootThread(),
          sessionId: 'parent-session',
          parentThreadId: 'parent-thread',
        },
      },
    }
    assert.equal(await inboundBuffer.routeNotification({
      connectionEpoch: 'epoch-unknown',
      frame: conflicting,
      notification: conflicting,
    }), 'buffered')
    await assert.rejects(
      dispatch.reconcileAccepted({
        connectionEpoch: 'epoch-unknown',
        rpcId: 1,
        method: 'thread/start',
        bindingId: 'thread-binding-1',
        nativeId: 'thread-native-1',
        nativeResult: { thread: rootThread(), instructionSources: [] },
        responseDigest: 'thread-response-unknown',
        responsePending: false,
      }),
      /start_inbound_identity_unknown/,
    )
    assert.equal(registry.snapshot().capacityCharged, 2)
    assert.deepEqual(db.prepare(`
      SELECT codex_thread_id, thread_start_reconciled_at,
             thread_start_reservation_released_at
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), {
      codex_thread_id: null,
      thread_start_reconciled_at: null,
      thread_start_reservation_released_at: null,
    })

    const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const recovery = restarted.readRecoverySnapshot(() => false)
    assert.equal(recovery.members.length, 2)
    assert.deepEqual(recovery.productFences, [{
      threadBindingId: 'thread-binding-1',
      readyRunId: 'run-unknown-inbound',
      ownerMainBootId: 'main-boot-1',
      quarantinedAt: admittedAt,
      quarantineReason: 'thread_metadata_conflict',
    }])
  })
})

test('response-first turn keeps durable capacity held until exact client identity or quarantine', async (t) => {
  await withRepository(t, async (db, repository) => {
    let nowMs = Date.parse(admittedAt)
    const registry = new CodexStartIdentityRegistry({ capacity: 4 })
    const reserved = registry.reserve({ scopeId: 'scope-1', existingThread: false })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) throw new Error(reserved.code)
    const run = prepared('run-response-first')
    run.ingressBinding = {
      requestId: 'request-run-response-first',
      reservationSetId: reserved.reservation.reservationSetId,
      reservationEvidenceDigest: reserved.reservation.reservationEvidenceDigest,
    }
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, reserved.reservation))
    const inboundBuffer = new CodexProvisionalInboundBuffer({
      maxFramesPerOwner: 8,
      maxBytesPerOwner: 16_384,
      nowMs: () => nowMs,
      serverRequestExecutor: { async execute() { throw new Error('unexpected_tool_execution') } },
      startInboundQuarantinePort: {
        quarantine: (input) => repository.quarantineStartInbound({
          ...input,
          quarantinedAt: admittedAt,
        }),
      },
    })
    inboundBuffer.attachReleasePort({
      broadcastNotification() {},
      respondServerRequest() { throw new Error('unexpected_server_request_release') },
      failProtocol(error) { throw error },
    })
    const dispatch = new CodexDurableStartDispatchPort({
      repository,
      registry,
      inboundBuffer,
      evidenceResolver: { async resolveTypedRejection() { return { resolution: 'unknown' } } },
      now: () => admittedAt,
      inboundDeadlineMs: 5_000,
      pinnedThreadSource: 'vscode',
    })
    await dispatch.activate({
      connectionEpoch: 'epoch-response-first', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-response-first',
    })
    const started: CodexNativeNotification = {
      method: 'thread/started', params: { thread: rootThread() },
    }
    await inboundBuffer.routeNotification({
      connectionEpoch: 'epoch-response-first', frame: started, notification: started,
    })
    await dispatch.reconcileAccepted({
      connectionEpoch: 'epoch-response-first', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-first', responsePending: false,
    })
    await dispatch.activate({
      connectionEpoch: 'epoch-response-first', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-response-first', requestDigest: 'turn-request-response-first',
    })
    const reconciling = dispatch.reconcileAccepted({
      connectionEpoch: 'epoch-response-first', rpcId: 2, method: 'turn/start',
      bindingId: 'run-response-first', nativeId: 'turn-native-1',
      nativeResult: { turn: activeTurn() }, responseDigest: 'turn-response-first',
      responsePending: false,
    })
    assert.equal(await Promise.race([
      reconciling.then(() => 'resolved'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]), 'pending')
    assert.equal(registry.snapshot().capacityCharged, 1)
    assert.deepEqual(db.prepare(`
      SELECT codex_turn_id, turn_start_reconciled_at, turn_start_reservation_released_at
        FROM codex_turn_bindings WHERE ready_run_id = 'run-response-first'
    `).get(), {
      codex_turn_id: null,
      turn_start_reconciled_at: null,
      turn_start_reservation_released_at: null,
    })

    nowMs += 5_001
    assert.equal(inboundBuffer.expireDue(), 1)
    await assert.rejects(reconciling, /start_inbound_identity_unknown/)
    assert.equal(registry.snapshot().capacityCharged, 1)
    assert.deepEqual(db.prepare(`
      SELECT codex_turn_id, turn_start_reconciled_at, turn_start_reservation_released_at
        FROM codex_turn_bindings WHERE ready_run_id = 'run-response-first'
    `).get(), {
      codex_turn_id: null,
      turn_start_reconciled_at: null,
      turn_start_reservation_released_at: null,
    })
    const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection)
    assert.deepEqual(restarted.readRecoverySnapshot(() => false).productFences, [{
      threadBindingId: 'thread-binding-1',
      readyRunId: 'run-response-first',
      ownerMainBootId: 'main-boot-1',
      quarantinedAt: admittedAt,
      quarantineReason: 'provisional_buffer_deadline_exceeded',
    }])
  })
})

test('migrations 088-089 create six Codex-owned tables and immutable binding evidence', async (t) => {
  await withRepository(t, (db, repository) => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'codex_%' ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(tables.map((row) => row.name), [
      'codex_manual_compaction_bindings',
      'codex_sidecar_process_leases',
      'codex_thread_bindings',
      'codex_thread_dispatch_fences',
      'codex_tool_call_bindings',
      'codex_turn_bindings',
    ])

    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    assert.throws(
      () => db.prepare(`
        UPDATE codex_thread_dispatch_fences SET owner_main_boot_id = 'forged-boot'
         WHERE thread_binding_id = 'thread-binding-1'
      `).run(),
      /codex_fence_identity_immutable/,
    )
    assert.throws(
      () => db.prepare(`
        UPDATE codex_turn_bindings SET authorization_snapshot_digest = 'forged-auth'
         WHERE ready_run_id = 'run-1'
      `).run(),
      /codex_turn_binding_identity_immutable/,
    )
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-schema', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-schema', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-schema', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-schema', responsePending: false, reconciledAt: admittedAt,
    })
    assert.deepEqual(db.prepare(`
      SELECT codex_thread_id FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
    `).get(), { codex_thread_id: 'thread-native-1' })
    assert.throws(
      () => db.prepare(`
        UPDATE codex_thread_bindings
           SET codex_thread_id = 'forged-thread', codex_session_id = 'forged-thread'
         WHERE thread_binding_id = 'thread-binding-1'
      `).run(),
      /codex_thread_binding_admission_immutable/,
    )
    const restartedRepository = new CodexBindingRepository(db as unknown as DatabaseConnection)
    assert.deepEqual(restartedRepository.readStartInboundIdentity('turn/start', 'run-1'), {
      method: 'turn/start',
      threadId: 'thread-native-1',
      clientUserMessageId: 'turn-request-run-1',
    })
    assert.throws(
      () => db.prepare(`
        UPDATE codex_turn_bindings SET thread_binding_id = 'missing-parent'
         WHERE ready_run_id = 'run-1'
      `).run(),
      /codex_turn_binding_identity_immutable|codex_turn_parent_mismatch/,
    )
    assert.throws(
      () => db.prepare(`
        INSERT INTO codex_tool_call_bindings (
          codex_thread_id, codex_turn_id, codex_call_id, ready_run_id,
          ready_action_id, tool_name, args_digest, turn_contract_digest,
          revision, created_at, updated_at
        ) VALUES ('thread-x', 'turn-x', 'call-x', 'run-1', 'action-x',
          'tool-x', 'args-x', 'turn-contract-run-1', 1, ?, ?)
      `).run(admittedAt, admittedAt),
      /codex_call_parent_mismatch/,
    )
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-schema', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-request-schema', dispatchedAt: admittedAt,
    })
    repository.quarantineStartInbound({
      method: 'turn/start', bindingId: 'run-1',
      reason: 'schema-quarantine', quarantinedAt: admittedAt,
    })
    assert.throws(
      () => db.prepare(`
        UPDATE codex_thread_dispatch_fences
           SET quarantined_at = NULL, quarantine_reason = NULL
         WHERE thread_binding_id = 'thread-binding-1'
      `).run(),
      /codex_fence_identity_immutable/,
    )
    assert.throws(
      () => db.prepare(`
        UPDATE codex_thread_dispatch_fences
           SET quarantined_at = 'forged-time', quarantine_reason = 'forged-reason'
         WHERE thread_binding_id = 'thread-binding-1'
      `).run(),
      /codex_fence_identity_immutable/,
    )
    assert.throws(
      () => db.prepare(`DELETE FROM codex_thread_bindings WHERE thread_binding_id = ?`).run(
        'thread-binding-1',
      ),
      /codex_thread_binding_delete_forbidden/,
    )
  })
})

test('empty alias generations charge no start capacity and idle reset inserts the successor atomically', async (t) => {
  await withRepository(t, (db, repository) => {
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-empty-1',
      aliasId: 'scope-empty',
      aliasGeneration: 1,
      readyScopeId: 'scope-empty',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })
    assert.equal(repository.readRecoverySnapshot(() => false).members.length, 0)
    const reset = repository.resetIdleAlias({
      aliasId: 'scope-empty',
      expectedGeneration: 1,
      retirementEvidenceDigest: 'reset-evidence',
      resetAt: admittedAt,
    })
    assert.equal(reset.retiredGeneration, 1)
    assert.equal(reset.newGeneration, 2)
    assert.deepEqual(db.prepare(`
      SELECT alias_generation, retired_reason, thread_start_reservation_set_id
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-empty'
       ORDER BY alias_generation
    `).all(), [
      { alias_generation: 1, retired_reason: 'user_reset', thread_start_reservation_set_id: null },
      { alias_generation: 2, retired_reason: null, thread_start_reservation_set_id: null },
    ])
    assert.equal(repository.readRecoverySnapshot(() => false).members.length, 0)
  })
})

test('lazy admission creates thread, turn, and fence atomically with exact Ready parents', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    assert.deepEqual(repository.admitProductBindings(admission(run, lazyReservation())), {
      threadBindingId: 'thread-binding-1',
      readyRunId: 'run-1',
      threadState: 'unstarted',
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`).get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`).get<{ count: number }>()?.count, 1)
    assert.deepEqual(db.prepare(`
      SELECT operation_kind, owner_ready_run_id FROM codex_thread_dispatch_fences
    `).get(), { operation_kind: 'product_turn', owner_ready_run_id: 'run-1' })

    const badRun = prepared('run-bad-parent')
    assert.throws(
      () => repository.admitProductBindings(admission(
        badRun,
        existingReservation('run-bad-parent'),
      )),
      /ready_parent_mismatch/,
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`).get<{ count: number }>()?.count, 1)
  })
})

test('accepted start releases capacity atomically and response guards never charge capacity', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))

    const threadDispatch = repository.activateStartDispatch({
      connectionEpoch: 'epoch-1',
      rpcId: 1,
      method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-digest',
      dispatchedAt: admittedAt,
    })
    assert.deepEqual(threadDispatch, {
      bindingId: 'thread-binding-1',
      reservationSetId: 'set-run-1',
      reservationId: 'thread-member-run-1',
      inboundIdentity: {
        method: 'thread/start',
        expectedCwd: '/tmp/ready-codex/thread-binding-1',
      },
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', childWriteDigest: 'thread-request-digest',
      confirmedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-digest', responsePending: true,
      reconciledAt: admittedAt,
    })
    let recovery = repository.readRecoverySnapshot(() => true)
    assert.deepEqual(recovery.members.map((member) => member.method), ['turn/start'])
    assert.deepEqual(recovery.lateResponseGuards, [{
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
    }])
    assert.equal(repository.consumeLateStartResponse({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      nativeId: 'thread-native-1', responseDigest: 'late-response', closedAt: admittedAt,
    }), true)

    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-request-digest', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start',
      bindingId: 'run-1', nativeId: 'turn-native-1',
      nativeResult: { turn: activeTurn() }, responseDigest: 'turn-response-digest',
      responsePending: true, reconciledAt: admittedAt,
    })
    const overlappingRun = prepared('run-overlap')
    prepareReadyParentRowsOnly(db, overlappingRun)
    assert.throws(
      () => repository.admitProductBindings(admission(
        overlappingRun,
        existingReservation('run-overlap'),
      )),
      /UNIQUE constraint failed: codex_thread_dispatch_fences.thread_binding_id/,
    )
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_turn_bindings WHERE ready_run_id = 'run-overlap'
    `).get<{ count: number }>()?.count, 0)
    recovery = repository.readRecoverySnapshot(() => true)
    assert.equal(recovery.members.length, 0)
    assert.deepEqual(recovery.lateResponseGuards.map((guard) => guard.method), ['turn/start'])
    assert.equal(repository.closeLateResponseGuardsForConnection('epoch-1', admittedAt), 1)
    assert.equal(repository.readRecoverySnapshot(() => true).lateResponseGuards.length, 0)
  })
})

test('canonical Ready terminal and Codex fence release share one rollback boundary', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-atomic', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-atomic', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-atomic', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-atomic', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-atomic', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-request-atomic', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-atomic', rpcId: 2, method: 'turn/start',
      bindingId: 'run-1', nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response-atomic', responsePending: false, reconciledAt: admittedAt,
    })

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: 'canonical-terminal-digest', closeoutAt: admittedAt,
    })
    db.exec('ROLLBACK')
    assert.deepEqual(db.prepare(`
      SELECT status FROM task_projections WHERE task_id = 'task-run-1'
    `).get(), { status: 'running' })
    assert.deepEqual(db.prepare(`
      SELECT product_terminal_digest, product_closeout_at FROM codex_turn_bindings
       WHERE ready_run_id = 'run-1'
    `).get(), { product_terminal_digest: null, product_closeout_at: null })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    assert.deepEqual(repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: 'canonical-terminal-digest', closeoutAt: admittedAt,
    }), { handled: true, reservationSetId: 'set-run-1' })
    db.exec('COMMIT')
    assert.deepEqual(db.prepare(`
      SELECT product_terminal_digest, product_closeout_at FROM codex_turn_bindings
       WHERE ready_run_id = 'run-1'
    `).get(), {
      product_terminal_digest: 'canonical-terminal-digest',
      product_closeout_at: admittedAt,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.throws(
      () => repository.assertThreadArchiveEligible('thread-native-1'),
      /thread_archive_not_retired/,
    )
    repository.resetIdleAlias({
      aliasId: 'scope-1',
      expectedGeneration: 1,
      retirementEvidenceDigest: 'archive-retirement-evidence',
      resetAt: admittedAt,
    })
    assert.doesNotThrow(() => repository.assertThreadArchiveEligible('thread-native-1'))
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1', productTerminalDigest: 'canonical-terminal-digest', closeoutAt: admittedAt,
    })
  })
})

test('intent without reconciliation is recovery-held and host failure joins canonical terminal closeout', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-dead', rpcId: 7, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-digest', dispatchedAt: admittedAt,
    })
    assert.deepEqual(
      repository.readRecoverySnapshot(() => false).members.map((member) => member.state),
      ['recovery_held', 'held'],
    )
    repository.recordHostFailureEvidence({
      readyRunId: 'run-1', kind: 'thread_start_delivery_proven_absent',
      evidenceDigest: 'stable-zero-evidence', recordedAt: admittedAt,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 1)
    assert.equal(repository.readRecoverySnapshot(() => false).members.length, 2)

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = 'task-run-1'`).run()
    repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: 'product-terminal-digest', closeoutAt: admittedAt,
    })
    db.exec('COMMIT')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
    assert.equal(repository.readRecoverySnapshot(() => false).members.length, 0)
    assert.deepEqual(db.prepare(`
      SELECT continuation_blocked_reason FROM codex_thread_bindings
    `).get(), { continuation_blocked_reason: 'start_delivery_absent' })
    assert.deepEqual(repository.completeHostFailureCloseout({
      readyRunId: 'run-1', productTerminalDigest: 'product-terminal-digest',
      continuationBlockedReason: 'start_delivery_absent', closeoutAt: admittedAt,
    }), { reservationSetId: 'set-run-1' })
  })
})

test('tool-call binding is exact-once and process leases require stable tree-zero before replacement', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-digest', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'thread-binding-1',
      nativeId: 'thread-native-1', nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingLookupKey: 'run-1',
      requestDigest: 'turn-request-digest', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
      nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response', responsePending: false, reconciledAt: admittedAt,
    })
    const call = {
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1', codexCallId: 'call-1',
      readyRunId: 'run-1', readyActionId: 'action-1', toolName: 'ready_read',
      argsDigest: 'args-digest', turnContractDigest: 'turn-contract-run-1', at: admittedAt,
    }
    assert.deepEqual(repository.bindToolCall(call), { duplicate: false })
    assert.deepEqual(repository.bindToolCall(call), { duplicate: true })
    assert.throws(
      () => repository.bindToolCall({ ...call, toolName: 'different-tool' }),
      /tool_call_identity_conflict/,
    )

    const identity = {
      processLeaseId: 'lease-1', ownerMainBootId: 'main-boot-1', ownerMainPid: 10,
      ownerMainProcessStartIdentity: 'main-start-1', sidecarSpawnInstanceId: 'spawn-1',
      connectionEpoch: 'epoch-process-1', runtimeManifestDigest: 'manifest-digest',
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex',
    }
    let lease = repository.createProcessLeaseIntent({
      ...identity, spawnIntentAt: admittedAt, spawnVisibilityDeadlineAt: admittedAt,
    })
    assert.throws(
      () => repository.createProcessLeaseIntent({
        ...identity,
        processLeaseId: 'lease-2',
        sidecarSpawnInstanceId: 'spawn-2',
        connectionEpoch: 'epoch-process-2',
        spawnIntentAt: admittedAt,
        spawnVisibilityDeadlineAt: admittedAt,
      }),
      /UNIQUE constraint failed/,
    )
    lease = repository.confirmProcessLeaseOwnership({
      processLeaseId: 'lease-1', expectedRevision: lease.revision,
      pid: 20, processGroupId: 20, processStartIdentity: 'sidecar-start-1', confirmedAt: admittedAt,
    })
    assert.throws(
      () => db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET pid = 21, process_group_id = 21,
               process_start_identity = 'forged-child', ownership_confirmed_at = 'forged-time'
         WHERE process_lease_id = 'lease-1'
      `).run(),
      /codex_process_lease_identity_immutable/,
    )
    lease = repository.markProcessConnectionOpened({
      processLeaseId: 'lease-1', expectedRevision: lease.revision, openedAt: admittedAt,
    })
    lease = repository.markProcessConnectionClosed({
      processLeaseId: 'lease-1', expectedRevision: lease.revision, closedAt: admittedAt,
    })
    lease = repository.recordProcessTreeZero({
      processLeaseId: 'lease-1', expectedRevision: lease.revision, treeZeroAt: admittedAt,
      matcherMode: 'post_cas', sampleTranscriptDigest: 'sample-transcript',
      evidenceDigest: 'tree-zero-evidence',
    })
    assert.equal(lease.treeZeroMatcherMode, 'post_cas')
    assert.throws(
      () => db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET tree_zero_at = NULL, tree_zero_matcher_mode = NULL,
               stable_zero_sample_transcript_digest = NULL, tree_zero_evidence_digest = NULL
         WHERE process_lease_id = 'lease-1'
      `).run(),
      /codex_process_lease_identity_immutable/,
    )
    assert.equal(repository.readLiveProcessLease(), null)
    assert.throws(
      () => repository.createProcessLeaseIntent({
        ...identity, processLeaseId: 'lease-bad', ownerMainBootId: 'same',
        sidecarSpawnInstanceId: 'same', connectionEpoch: 'epoch-new',
        spawnIntentAt: admittedAt, spawnVisibilityDeadlineAt: admittedAt,
      }),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'process_identity_reused',
    )
  })
})

test('manual compaction owns the idle-thread fence and consume is all-or-nothing', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-digest', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 1, method: 'thread/start', bindingId: 'thread-binding-1',
      nativeId: 'thread-native-1', nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingLookupKey: 'run-1',
      requestDigest: 'turn-request-digest', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 2, method: 'turn/start', bindingId: 'run-1',
      nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response', responsePending: false, reconciledAt: admittedAt,
    })
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1', productTerminalDigest: 'product-terminal-digest', closeoutAt: admittedAt,
    })

    const manualInput = {
      manualCompactionId: 'manual-1',
      threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1',
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-1',
      upstreamProfileSnapshotDigest: 'profile-digest-1',
      providerSnapshot: { route: 'fixture' },
      credentialReferenceId: 'credential-ref-1',
      expectedToolsDigest: 'empty-tools-digest',
      expiresAt: '2026-08-07T03:00:00.000Z',
      createdAt: admittedAt,
    }
    assert.deepEqual(repository.beginManualCompaction(manualInput), {
      manualCompactionId: 'manual-1', codexThreadId: 'thread-native-1',
    })
    assert.throws(
      () => repository.beginManualCompaction({ ...manualInput, manualCompactionId: 'manual-duplicate' }),
      /UNIQUE constraint failed/,
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings`).get<{ count: number }>()?.count, 1)

    db.prepare(`DELETE FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?`).run('thread-binding-1')
    assert.throws(
      () => repository.consumeManualCompaction({
        manualCompactionId: 'manual-1', codexCompactionTurnId: 'compact-turn-1',
        contextCompactionItemId: 'compact-item-1', threadReadDigest: 'thread-read-1',
        consumedAt: admittedAt,
      }),
      /manual_compaction_fence_release_failed/,
    )
    assert.deepEqual(db.prepare(`
      SELECT consumed_at, consume_evidence_digest FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-1'
    `).get(), { consumed_at: null, consume_evidence_digest: null })

    db.prepare(`
      INSERT INTO codex_thread_dispatch_fences (
        thread_binding_id, owner_main_boot_id, operation_kind,
        owner_manual_compaction_id, acquired_at, revision
      ) VALUES ('thread-binding-1', 'main-boot-1', 'manual_compaction', 'manual-1', ?, 1)
    `).run(admittedAt)
    repository.consumeManualCompaction({
      manualCompactionId: 'manual-1', codexCompactionTurnId: 'compact-turn-1',
      contextCompactionItemId: 'compact-item-1', threadReadDigest: 'thread-read-1',
      consumedAt: admittedAt,
    })
    assert.deepEqual(db.prepare(`
      SELECT codex_compaction_turn_id, consumed_at FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-1'
    `).get(), { codex_compaction_turn_id: 'compact-turn-1', consumed_at: admittedAt })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
  })
})

test('unknown manual compaction remains quarantined until late terminal readback', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    db.prepare(`
      UPDATE codex_thread_bindings
         SET codex_thread_id = 'thread-native-1', codex_session_id = 'thread-native-1',
             codex_source_json = '"vscode"', thread_start_reconciled_at = ?,
             thread_start_reconciliation_evidence_digest = 'thread-evidence',
             thread_started_at = ?, thread_start_reservation_released_at = ?,
             thread_start_reservation_release_reason = 'native_identity_reconciled', revision = revision + 1
       WHERE thread_binding_id = 'thread-binding-1'
    `).run(admittedAt, admittedAt, admittedAt)
    db.prepare(`DELETE FROM codex_thread_dispatch_fences WHERE thread_binding_id = 'thread-binding-1'`).run()
    repository.beginManualCompaction({
      manualCompactionId: 'manual-unknown', threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-1', upstreamProfileSnapshotDigest: 'profile-digest-1',
      providerSnapshot: { route: 'fixture' }, credentialReferenceId: 'credential-ref-1',
      expectedToolsDigest: 'empty-tools-digest', expiresAt: '2026-08-07T03:00:00.000Z',
      createdAt: admittedAt,
    })
    const quarantine = repository.quarantineUnknownManualCompaction({
      manualCompactionId: 'manual-unknown', reason: 'compaction_state_unknown',
      evidenceDigest: 'quarantine-evidence', quarantinedAt: admittedAt,
    })
    assert.equal(quarantine.aliasId, 'scope-1')
    assert.equal(quarantine.retiredGeneration, 1)
    assert.equal(quarantine.nextAliasGeneration, 2)
    assert.match(quarantine.newThreadBindingId, /^codex-thread-[a-f0-9]{32}$/)
    assert.deepEqual(db.prepare(`
      SELECT thread_binding_id, alias_generation, thread_start_reservation_set_id
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1' AND retired_at IS NULL
    `).get(), {
      thread_binding_id: quarantine.newThreadBindingId,
      alias_generation: 2,
      thread_start_reservation_set_id: null,
    })
    assert.deepEqual(db.prepare(`
      SELECT abandoned_at, abandoned_reason, abandoned_reconciled_at
        FROM codex_manual_compaction_bindings WHERE manual_compaction_id = 'manual-unknown'
    `).get(), {
      abandoned_at: admittedAt,
      abandoned_reason: 'compaction_state_unknown',
      abandoned_reconciled_at: null,
    })
    assert.deepEqual(db.prepare(`
      SELECT quarantined_at, quarantine_reason FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { quarantined_at: admittedAt, quarantine_reason: 'compaction_state_unknown' })

    repository.reconcileQuarantinedManualCompaction({
      manualCompactionId: 'manual-unknown', threadReadDigest: 'late-thread-read-digest',
      reconciledAt: '2026-08-07T02:05:00.000Z',
    })
    assert.deepEqual(db.prepare(`
      SELECT abandoned_reconciled_at FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-unknown'
    `).get(), { abandoned_reconciled_at: '2026-08-07T02:05:00.000Z' })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
  })
})
