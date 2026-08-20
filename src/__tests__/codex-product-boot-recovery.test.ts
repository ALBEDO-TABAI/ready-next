import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import type {
  CodexBindingRecoveryMember,
  CodexProcessLeaseRow,
  CodexProductTurnRuntimeRead,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  buildCodexProductReadbackCandidate,
  classifyCodexProductRecoveryFailure,
  CodexRunLocalRecoveryError,
  CodexProductBootRecovery,
  proveCodexStableStartAbsence,
  routeCodexBootRecoveryFailure,
} from '../main/modules/agent-control/codex-runtime/codex-product-boot-recovery'
import type {
  CodexNativeRuntime,
  CodexThread,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexTurnCollector } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import { recoverCodexTerminalAfterInterrupt } from '../main/modules/agent-control/codex-runtime/codex-terminal-readback-recovery'
import {
  resolveCodexBrowserWorkflowVerifierBundle,
  resolveCodexThreadInstructionContract,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import {
  CODEX_HOST_OVERLAY,
  resolveCodexSelectedSkillMethodology,
} from '../main/modules/agent-control/codex-runtime/codex-thread-instructions'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  __setSkillsRuntimeManagerForTests,
  getSkillsRuntimeManager,
  type SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('direct Codex answers do not require a browser workflow seal', () => {
  assert.equal(resolveCodexBrowserWorkflowVerifierBundle({
    inspection: {
      state: 'absent',
      browserTaskId: null,
      childRevision: null,
      evidence: null,
      seal: null,
    },
    bundle: null,
  }), null)
})

test('boot recovery policy keeps ingress open for one rejected run and fails closed globally', async () => {
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('automatic_compaction_snapshot_mismatch')),
    { kind: 'run_local', code: 'automatic_compaction_snapshot_mismatch' },
  )
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('codex_product_closeout_in_flight')),
    { kind: 'transient', code: 'codex_product_closeout_in_flight' },
  )
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('codex_browser_workflow_action_in_flight')),
    { kind: 'transient', code: 'codex_browser_workflow_action_in_flight' },
  )
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('codex_tool_publication_indeterminate:pending')),
    { kind: 'transient', code: 'codex_tool_publication_indeterminate:pending' },
  )
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('codex_candidate_durable_identity_mismatch')),
    { kind: 'global', code: 'codex_candidate_durable_identity_mismatch' },
  )
  assert.deepEqual(
    classifyCodexProductRecoveryFailure(new Error('SQLITE_BUSY')),
    { kind: 'global', code: 'SQLITE_BUSY' },
  )
  let gateOpen = true
  let runAFence = true
  const terminalRuns: string[] = []
  const admitB = (): string => {
    if (!gateOpen) throw new Error('ingress_closed')
    return 'run-b-admitted'
  }
  assert.equal(await routeCodexBootRecoveryFailure({
    error: new CodexRunLocalRecoveryError('codex_recovered_instruction_contract_drift'),
    async settleRunLocal(code) {
      assert.equal(code, 'codex_recovered_instruction_contract_drift')
      runAFence = false
      terminalRuns.push('run-a')
    },
    failGlobal() { gateOpen = false },
  }), 'run_local_settled')
  assert.equal(runAFence, false)
  assert.deepEqual(terminalRuns, ['run-a'])
  assert.equal(admitB(), 'run-b-admitted')

  assert.equal(await routeCodexBootRecoveryFailure({
    error: new Error('codex_product_closeout_in_flight'),
    async settleRunLocal() { throw new Error('unexpected_local_settlement') },
    failGlobal() { throw new Error('unexpected_global_failure') },
  }), 'held')
  assert.equal(admitB(), 'run-b-admitted')

  let identityMismatchSettlements = 0
  assert.equal(await routeCodexBootRecoveryFailure({
    error: new Error('codex_candidate_durable_identity_mismatch'),
    async settleRunLocal() { identityMismatchSettlements += 1 },
    failGlobal(code) {
      assert.equal(code, 'codex_candidate_durable_identity_mismatch')
    },
  }), 'global_failed')
  assert.equal(identityMismatchSettlements, 0)

  assert.equal(await routeCodexBootRecoveryFailure({
    error: new CodexRunLocalRecoveryError('codex_recovered_turn_readback_ambiguous'),
    async settleRunLocal() { throw new Error('unexpected_local_settlement') },
    failGlobal(code) {
      assert.equal(code, 'codex_recovered_turn_readback_ambiguous')
      gateOpen = false
    },
  }), 'global_failed')
  gateOpen = true

  assert.equal(await routeCodexBootRecoveryFailure({
    error: new Error('codex_sidecar_protocol_failure'),
    async settleRunLocal() { throw new Error('unexpected_local_settlement') },
    failGlobal(code) {
      assert.equal(code, 'codex_sidecar_protocol_failure')
      gateOpen = false
    },
  }), 'global_failed')
  assert.throws(admitB, /ingress_closed/)
})

test('boot fence recovery waits for local settlement of an incomplete Browser closeout', async () => {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  const runtime = {} as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const candidate = buildCodexProductReadbackCandidate({
    collector,
    product: current,
    turn: terminalTurn(),
    recovery: 'stored_terminal',
  })
  const events: string[] = []
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductCloseout: () => null,
      readProductTurnRuntime: () => current,
      claimProductFenceForBoot: () => ({ transferred: false }),
      readEngineTerminalCandidate: () => ({ candidate }),
    } as never,
    runtime: () => runtime,
    collector,
    async closeCandidate() {
      events.push('close')
      throw new Error('codex_browser_workflow_observation_required')
    },
    publishRecoveredCloseout() { throw new Error('unexpected_publish') },
    async onRecoveryFailure(_readyRunId, error) {
      assert.equal((error as Error).message, 'codex_browser_workflow_observation_required')
      events.push('settle:start')
      await new Promise<void>((resolve) => setImmediate(resolve))
      events.push('settle:done')
    },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })

  await recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  assert.deepEqual(events, ['close', 'settle:start', 'settle:done'])
})

test('boot fence recovery holds publication uncertainty and closes after durable evidence arrives', async () => {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  const collector = new CodexTurnCollector({} as CodexNativeRuntime)
  const candidate = buildCodexProductReadbackCandidate({
    collector,
    product: current,
    turn: terminalTurn(),
    recovery: 'stored_terminal',
  })
  let closeAttempts = 0
  let published = 0
  let recoveryFailures = 0
  let restored = 0
  let finished = 0
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductCloseout: () => null,
      readProductTurnRuntime: () => current,
      claimProductFenceForBoot: () => ({ transferred: false }),
      readEngineTerminalCandidate: () => ({ candidate }),
    } as never,
    runtime: () => ({} as CodexNativeRuntime),
    collector,
    async closeCandidate() {
      closeAttempts += 1
      if (closeAttempts < 3) {
        throw new Error('codex_tool_publication_indeterminate:pending_delivery')
      }
      return { closed: true }
    },
    publishRecoveredCloseout() { published += 1 },
    onRecoveryFailure() { recoveryFailures += 1 },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() { restored += 1 },
    finishActiveProductRun() { finished += 1 },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
    pollIntervalMs: 1,
  })

  await recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  assert.equal(closeAttempts, 1)
  assert.equal(published, 0)
  assert.equal(recoveryFailures, 0)
  assert.equal(restored, 1)
  assert.equal(finished, 0)
  await waitUntil(() => published === 1)
  assert.equal(closeAttempts, 3)
  assert.equal(recoveryFailures, 0)
  assert.equal(finished, 1)
})

test('boot resumes a durable lifecycle action by interrupting the exact turn without verifier work', async () => {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  let nativeStatus: CodexTurn['status'] = 'inProgress'
  let interruptCount = 0
  let interruptAckCount = 0
  let hostAbortCount = 0
  let verifierCalls = 0
  let closeCount = 0
  let published = 0
  const runtime = {
    subscribe() { return () => undefined },
    async turnInterrupt(input: { threadId: string; turnId: string }) {
      assert.deepEqual(input, { threadId: 'thread-native-1', turnId: 'turn-native-1' })
      interruptCount += 1
      nativeStatus = 'interrupted'
      return {}
    },
    async threadRead() {
      return { thread: rootThread([terminalTurn(nativeStatus)]) }
    },
  } as unknown as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const repository = {
    readProductCloseout: () => null,
    readProductTurnRuntime: () => current,
    claimProductFenceForBoot: () => ({ transferred: false }),
    readEngineTerminalCandidate: () => null,
    readProductStartState: () => ({
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      hostFailureKind: null, productCloseoutCommitted: false,
    }),
    readProductLifecycleAction: () => ({
      readyRunId: 'run-1', readyTaskId: 'task-1', readyScopeId: 'scope-1',
      readyAliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'binding-1',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      lifecycleAction: 'close', lifecycleActionRequestedAt: '2026-08-07T00:00:01.000Z',
      lifecycleActionEvidenceDigest: 'action-digest',
    }),
    acknowledgeProductInterrupt() { interruptAckCount += 1 },
    markProductInterruptUnknown() { throw new Error('unexpected_interrupt_unknown') },
  }
  const recovery = new CodexProductBootRecovery({
    repository: repository as never,
    runtime: () => runtime,
    collector,
    async closeCandidate(candidate) {
      closeCount += 1
      assert.equal(candidate.engineOutcome, 'interrupted')
      return { closed: true }
    },
    publishRecoveredCloseout() { published += 1 },
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    abortActiveProductRun() {
      hostAbortCount += 1
      return true
    },
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
    verifyAutomaticCompaction() {
      verifierCalls += 1
      throw new Error('automatic_compaction_should_not_run')
    },
    async wait() {},
  })

  await recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  await waitUntil(() => published === 1)
  assert.equal(interruptCount, 1)
  assert.equal(interruptAckCount, 1)
  assert.equal(hostAbortCount, 1)
  assert.equal(verifierCalls, 0)
  assert.equal(closeCount, 1)
})

test('held start recovery gives a durable lifecycle action ownership before any new dispatch', async () => {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  let nativeStatus: CodexTurn['status'] = 'inProgress'
  let hostAbortCount = 0
  let interruptCount = 0
  let interruptAckCount = 0
  let startDispatchCount = 0
  let modelSettingsCount = 0
  let verifierCount = 0
  let closeCount = 0
  let publishCount = 0
  const runtime = {
    subscribe() { return () => undefined },
    async threadStart() {
      startDispatchCount += 1
      throw new Error('thread_start_must_not_dispatch')
    },
    async turnStart() {
      startDispatchCount += 1
      throw new Error('turn_start_must_not_dispatch')
    },
    async turnInterrupt(input: { threadId: string; turnId: string }) {
      assert.deepEqual(input, { threadId: 'thread-native-1', turnId: 'turn-native-1' })
      interruptCount += 1
      nativeStatus = 'interrupted'
      return {}
    },
    async threadRead() {
      return { thread: rootThread([terminalTurn(nativeStatus)]) }
    },
  } as unknown as CodexNativeRuntime
  const lifecycleAction = {
    readyRunId: 'run-1', readyTaskId: 'task-1', readyScopeId: 'scope-1',
    readyAliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'binding-1',
    codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
    lifecycleAction: 'reset' as const,
    lifecycleActionRequestedAt: '2026-08-07T00:00:01.000Z',
    lifecycleActionEvidenceDigest: 'held-action-digest',
  }
  const repository = {
    readProductRunForThreadBinding: () => 'run-1',
    readProductLifecycleAction: () => lifecycleAction,
    readRecoverySnapshot: () => ({
      members: [], lateResponseGuards: [], hostFailureCloseouts: [], manualCompactions: [],
      productFences: [{
        threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
        quarantinedAt: null, quarantineReason: null,
      }],
    }),
    claimProductFenceForBoot: () => ({ transferred: true }),
    readProductTurnRuntime: () => current,
    readProductStartState: () => ({
      codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
      threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
      hostFailureKind: null, productCloseoutCommitted: false,
    }),
    acknowledgeProductInterrupt() { interruptAckCount += 1 },
    markProductInterruptUnknown() { throw new Error('unexpected_interrupt_unknown') },
  }
  const collector = new CodexTurnCollector(runtime)
  const recovery = new CodexProductBootRecovery({
    repository: repository as never,
    runtime: () => runtime,
    collector,
    async closeCandidate(candidate) {
      closeCount += 1
      assert.equal(candidate.engineOutcome, 'interrupted')
      return { closed: true }
    },
    publishRecoveredCloseout() { publishCount += 1 },
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    abortActiveProductRun(productRun) {
      assert.equal(productRun.readyRunId, 'run-1')
      hostAbortCount += 1
      return true
    },
    finishActiveProductRun() {},
    ownerMainBootId: 'new-main',
    resolveNativeModelSettings() {
      modelSettingsCount += 1
      return nativeModelSettings
    },
    resolveDeveloperInstructions: () => 'Ready overlay',
    verifyAutomaticCompaction() {
      verifierCount += 1
      throw new Error('automatic_compaction_should_not_run')
    },
    async wait() {},
  })

  assert.equal(recovery.dispatchHeldStart({
    member: {
      reservationSetId: 'set-1', reservationId: 'thread-member', scopeId: 'scope-1',
      method: 'thread/start', requiredMemberCount: 2, state: 'recovery_held',
      bindingId: 'binding-1', connectionEpoch: 'old-epoch', rpcId: 1, crashSeam: 3,
    },
    registry: {} as never,
  }), 'pending')
  await waitUntil(() => publishCount === 1)
  assert.equal(hostAbortCount, 1)
  assert.equal(interruptCount, 1)
  assert.equal(interruptAckCount, 1)
  assert.equal(startDispatchCount, 0)
  assert.equal(modelSettingsCount, 0)
  assert.equal(verifierCount, 0)
  assert.equal(closeCount, 1)
})

function terminalTurn(status: CodexTurn['status'] = 'completed'): CodexTurn {
  return {
    id: 'turn-native-1',
    status,
    error: null,
    items: [
      {
        type: 'userMessage', id: 'user-1', clientId: 'request-1',
        content: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
    ],
  }
}

function rootThread(turns: CodexTurn[]): CodexThread {
  return {
    id: 'thread-native-1', sessionId: 'thread-native-1',
    parentThreadId: null, forkedFromId: null,
    cwd: '/tmp/recovered-thread', source: 'vscode', threadSource: null,
    modelProvider: 'ready_gateway', cliVersion: '0.146.1',
    createdAt: 1, ephemeral: false, preview: '',
    status: { type: turns.some((turn) => turn.status === 'inProgress') ? 'active' : 'idle',
      ...(turns.some((turn) => turn.status === 'inProgress') ? { activeFlags: [] } : {}) } as CodexThread['status'],
    updatedAt: 1, turns,
  }
}

function product(): CodexProductTurnRuntimeRead {
  const prepared = {
    preparationContract: 'codex_product_run_e1' as const,
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
    taskId: 'task-1', runId: 'run-1',
    conversationAlias: { aliasId: 'scope-1', aliasGeneration: 1 },
    ingressBinding: {
      requestId: 'request-1', reservationSetId: 'set-1',
      reservationEvidenceDigest: 'reservation-evidence',
    },
    ingress: {
      kind: 'user_ingress' as const, attemptKind: 'user_ingress' as const,
      originUserMessageId: 'message-1',
      canonicalCurrentInputRef: {
        messageId: 'message-1', input: [{ type: 'text' as const, text: 'hello', text_elements: [] as [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: 'resource-anchor', recoveredContextDigest: null,
    readyToolSurface: {
      contractVersion: 1 as const, surfaceId: 'surface-1', dynamicTools: [],
      toolSurfaceDigest: 'surface-digest',
    },
    readyTurnToolAuthorization: {
      contractVersion: 1 as const, authorizationId: 'authorization-1',
      authorization: {
        contractVersion: 1 as const, skillIdentity: {
          kind: 'explicit_no_skill' as const, reason: 'no_skill_signal' as const,
        },
        allowedToolNames: [], allowedPrimitives: [], capabilityFloor: [],
        constraints: [], resourceScope: { kind: 'none' as const },
      },
      toolSurfaceDigest: 'surface-digest', authorizationDigest: 'authorization-digest',
    },
    readyToolHostIdentity: {
      scopeId: 'scope-1', aliasId: 'scope-1', authorizationOwnerId: 'owner-1',
      resourceOwnerId: 'owner-1',
    },
    neutralProjectionSeed: { taskTitle: 'Working', taskSummary: 'Working' },
    productBudgetSeed: {
      maxIterations: 8,
      maxToolCalls: 4,
      maxParallelToolGroups: 1,
      lanes: {
        ordinary: { maxIterations: 7, maxToolCalls: 4, maxParallelToolGroups: 1 },
        delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
        final: { maxIterations: 1 },
      },
    },
  }
  return {
    readyRunId: 'run-1', readyTaskId: 'task-1', readyScopeId: 'scope-1',
    readyAliasId: 'scope-1', aliasGeneration: 1, threadBindingId: 'binding-1',
    codexThreadId: null, codexTurnId: null, gatewayClaimedCodexTurnId: null,
    turnRequestId: 'request-1', reservationSetId: 'set-1',
    toolSurfaceDigest: 'surface-digest', turnContractDigest: 'turn-contract',
    messageVisibilityEpoch: 0,
    instructionContractDigest: 'instruction-contract',
    upstreamProfileSnapshotRef: 'profile-ref', upstreamProfileSnapshotDigest: 'profile-digest',
    isolatedThreadCwd: '/tmp/recovered-thread', codexModel: 'ready-e0-model',
    prepared, ingress: prepared.ingress, admittedAt: '2026-08-07T00:00:00.000Z',
  }
}

const nativeModelSettings = {
  reasoningEffort: 'high' as const,
  threadConfig: { model_context_window: 272_000 },
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition_not_reached')
}

type NativeDb = import('better-sqlite3').Database

async function withGatewayDatabase(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  work: (db: NativeDb) => void | Promise<void>,
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'Codex product boot recovery gateway integration')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL, meta_json TEXT NOT NULL
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        status TEXT NOT NULL, execution_binding_json TEXT
      );
      CREATE TABLE run_meta (
        run_id TEXT PRIMARY KEY, task_id TEXT, scope_id TEXT,
        status TEXT NOT NULL, execution_binding_json TEXT
      );
    `)
    for (const migration of [
      '088_codex_runtime_bindings',
      '089_codex_runtime_evidence_guards',
      '090_codex_model_gateway_authority',
      '091_codex_model_gateway_turn_claim',
      '092_codex_tool_bridge',
      '093_codex_e5_budget_admission',
      '094_codex_host_failure_closeout_readback',
      '095_codex_lifecycle_recovery_evidence',
      '096_codex_fence_owner_transfer',
      '097_codex_gateway_completion_evidence',
    ]) __runMigrationForTests(migration, db as unknown as MigrationDatabase)
    await work(db)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

function insertGatewayReceipt(input: {
  db: NativeDb
  receiptId: string
  requestKind: 'automatic_compaction' | 'product'
  acceptedAt: string
  withTranscript: boolean
  inputCharacters?: number
  inputItemSeed?: string
  toolsDigest?: string
  toolCount?: number
  withResponse?: boolean
}): void {
  input.db.prepare(`
    INSERT INTO ready_model_gateway_request_receipts (
      receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
      manual_compaction_id, upstream_profile_snapshot_ref,
      upstream_profile_snapshot_digest, request_digest, accepted_at
    ) VALUES (?, ?, 'thread-native-1', 'turn-native-1', 'run-1', NULL,
      'profile-ref', 'profile-digest', ?, ?)
  `).run(input.receiptId, input.requestKind, digestCanonicalJson(input.receiptId), input.acceptedAt)
  if (!input.withTranscript) return
  const inputCharacters = input.inputCharacters || 100
  const inputItemDigest = digestCanonicalJson(input.inputItemSeed || input.receiptId)
  input.db.prepare(`
    INSERT INTO ready_model_gateway_exchange_events (
      gateway_request_receipt_id, event_kind, instruction_digest, input_digest,
      input_items_json, input_total_string_characters, input_max_string_characters,
      tools_digest, tool_count, body_bytes, evidence_digest, recorded_at
    ) VALUES (?, 'request_admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.receiptId,
    digestCanonicalJson(`instruction:${input.receiptId}`),
    digestCanonicalJson(`input:${input.receiptId}`),
    JSON.stringify([{
      digest: inputItemDigest,
      totalStringCharacters: inputCharacters,
      maxStringCharacters: inputCharacters,
    }]),
    inputCharacters,
    inputCharacters,
    input.toolsDigest || digestCanonicalJson([]),
    input.toolCount || 0,
    inputCharacters + 100,
    digestCanonicalJson(`request-evidence:${input.receiptId}`),
    input.acceptedAt,
  )
  if (!input.withResponse) return
  input.db.prepare(`
    INSERT INTO ready_model_gateway_exchange_events (
      gateway_request_receipt_id, event_kind, response_id, terminal_digest,
      output_digest, usage_digest, evidence_digest, recorded_at
    ) VALUES (?, 'response_completed', ?, ?, ?, ?, ?, ?)
  `).run(
    input.receiptId,
    `response:${input.receiptId}`,
    digestCanonicalJson(`terminal:${input.receiptId}`),
    digestCanonicalJson(`output:${input.receiptId}`),
    digestCanonicalJson(`usage:${input.receiptId}`),
    digestCanonicalJson(`response-evidence:${input.receiptId}`),
    input.acceptedAt,
  )
}

async function recoverWithGatewayEvidence(input: {
  db: NativeDb
  turnStatus: 'completed' | 'interrupted' | 'failed'
}): Promise<{ closed: unknown[]; published: string[]; failures: string[] }> {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  const gatewayRepository = new CodexModelGatewayRepository(
    input.db as unknown as DatabaseConnection,
  )
  const closed: unknown[] = []
  const published: string[] = []
  const failures: string[] = []
  const runtime = {
    async threadRead() {
      return { thread: rootThread([terminalTurn(input.turnStatus)]) }
    },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout(readyRunId) { published.push(readyRunId) },
    onRecoveryFailure(_readyRunId, error) {
      failures.push(error instanceof Error ? error.message : String(error))
    },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    verifyAutomaticCompaction({ product: runtimeProduct, thread }) {
      return verifyCodexAutomaticCompactionEvidence({
        gatewayRepository,
        readyRunId: runtimeProduct.readyRunId,
        codexThreadId: runtimeProduct.codexThreadId || '',
        codexTurnId: runtimeProduct.codexTurnId || '',
        upstreamProfileSnapshotDigest: runtimeProduct.upstreamProfileSnapshotDigest,
        productToolSurfaceDigest: runtimeProduct.toolSurfaceDigest,
        thread,
      })
    },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })
  recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  await waitUntil(() => closed.length + failures.length === 1)
  return { closed, published, failures }
}

test('production boot recovery keeps stable host instructions for a persisted native skill input', async (t) => {
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills', 'lark-cli')
  const compiled = compileSkillDefinition({ folderPath: skillRoot, source: 'embedded' })
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [{
      ...compiled,
      installed: true,
      installStatePath: '',
      managedPath: skillRoot,
    }],
  } as unknown as SkillsRuntimeManager)
  t.after(() => __setSkillsRuntimeManagerForTests(null))
  const host = {
    resolveSelectedSkillMethodology: (skillId: string) => resolveCodexSelectedSkillMethodology({
      skillId,
      skills: getSkillsRuntimeManager().listSkills(),
    }),
  }
  const initial = product()
  const skillAuthorization = {
    mode: 'selected' as const,
    skillId: 'lark-cli',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    source: 'explicit' as const,
    reason: 'explicit_local_feishu_cli_task',
  }
  const prepared = {
    ...initial.prepared,
    readyTurnToolAuthorization: {
      authorizationId: 'authorization-1',
      authorizationDigest: 'authorization-digest',
      allowedToolNames: ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
      skillAuthorization,
    },
  }
  const instructionContract = resolveCodexThreadInstructionContract({
    assetRoot: join(process.cwd(), 'assets', 'codex-runtime'),
    host,
    skillAuthorization,
  })
  let current = {
    ...initial,
    prepared,
    instructionContractDigest: instructionContract.instructionContractDigest,
  } as CodexProductTurnRuntimeRead
  const calls: string[] = []
  const threadInstructions: string[] = []
  const closed: unknown[] = []
  const published: string[] = []
  const runtime = {
    async threadStart(params) {
      calls.push(`thread:${params.cwd}`)
      assert.deepEqual(params.config, { model_context_window: 272_000 })
      threadInstructions.push(params.developerInstructions || '')
      current = { ...current, codexThreadId: 'thread-native-1' }
      return { thread: rootThread([]), instructionSources: [] }
    },
    async turnStart(params) {
      calls.push(`turn:${params.clientUserMessageId}`)
      assert.equal(params.collaborationMode?.settings?.reasoning_effort, 'high')
      current = { ...current, codexTurnId: 'turn-native-1' }
      return { turn: terminalTurn() }
    },
    async threadRead() { return { thread: rootThread([terminalTurn()]) } },
  } as Pick<CodexNativeRuntime, 'threadStart' | 'turnStart' | 'threadRead'>
  const repository = {
    readProductLifecycleAction: () => null,
    readProductRunForThreadBinding: () => 'run-1',
    readRecoverySnapshot: () => ({
      members: [], lateResponseGuards: [], hostFailureCloseouts: [], manualCompactions: [],
      productFences: [{
        threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'main-1',
        quarantinedAt: null, quarantineReason: null,
      }],
    }),
    claimProductFenceForBoot: () => ({ transferred: false }),
    readProductTurnRuntime: () => current,
    readProductStartState: () => ({
      codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
      threadStartDispatchIntentAt: null, turnStartDispatchIntentAt: null,
      hostFailureKind: null, productCloseoutCommitted: false,
    }),
    readProductCloseout: () => null,
    readEngineTerminalCandidate: () => null,
  }
  const recovery = new CodexProductBootRecovery({
    repository: repository as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout(readyRunId) { published.push(readyRunId) },
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: (runtimeProduct) => resolveCodexThreadInstructionContract({
      assetRoot: join(process.cwd(), 'assets', 'codex-runtime'),
      host,
      skillAuthorization: runtimeProduct.prepared.readyTurnToolAuthorization.skillAuthorization,
      expectedDigest: runtimeProduct.instructionContractDigest,
    }).developerInstructions,
  })
  const held: CodexBindingRecoveryMember = {
    reservationSetId: 'set-1', reservationId: 'thread-member', scopeId: 'scope-1',
    method: 'thread/start', requiredMemberCount: 2, state: 'held',
    bindingId: 'binding-1', connectionEpoch: null, rpcId: null, crashSeam: 1,
  }
  assert.equal(recovery.dispatchHeldStart({ member: held, registry: {} as never }), 'pending')
  await waitUntil(() => closed.length === 1)
  assert.deepEqual(calls, ['thread:/tmp/recovered-thread', 'turn:request-1'])
  assert.equal(threadInstructions[0], instructionContract.developerInstructions)
  assert.equal(threadInstructions[0], CODEX_HOST_OVERLAY)
  assert.equal((closed[0] as { candidateText?: string }).candidateText, 'done')
  assert.deepEqual(published, ['run-1'])

  __setSkillsRuntimeManagerForTests({ listSkills: () => [] } as unknown as SkillsRuntimeManager)
  const failures: string[] = []
  let unavailableThreadStarts = 0
  current = {
    ...initial,
    prepared,
    instructionContractDigest: instructionContract.instructionContractDigest,
  } as CodexProductTurnRuntimeRead
  const unavailableRecovery = new CodexProductBootRecovery({
    repository: repository as never,
    runtime: () => ({
      async threadStart() {
        unavailableThreadStarts += 1
        throw new Error('unexpected_thread_start')
      },
    }) as CodexNativeRuntime,
    collector: new CodexTurnCollector({} as CodexNativeRuntime),
    async closeCandidate() { throw new Error('unexpected_close') },
    publishRecoveredCloseout() { throw new Error('unexpected_publish') },
    onRecoveryFailure(_readyRunId, error) {
      failures.push(error instanceof Error ? error.message : String(error))
    },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: (runtimeProduct) => resolveCodexThreadInstructionContract({
      assetRoot: join(process.cwd(), 'assets', 'codex-runtime'),
      host,
      skillAuthorization: runtimeProduct.prepared.readyTurnToolAuthorization.skillAuthorization,
      expectedDigest: runtimeProduct.instructionContractDigest,
    }).developerInstructions,
  })
  unavailableRecovery.dispatchHeldStart({ member: held, registry: {} as never })
  await waitUntil(() => failures.length === 1)
  assert.deepEqual(failures, ['unexpected_thread_start'])
  assert.equal(unavailableThreadStarts, 1)
})

test('production boot recovery leaves an in-progress fence local while polling to exact terminal', async () => {
  let current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  let readCount = 0
  const closed: unknown[] = []
  const runtime = {
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn(readCount < 2 ? 'inProgress' : 'completed')]) }
    },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout() {},
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
    pollIntervalMs: 1,
  })
  await recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  assert.equal(closed.length, 0)
  assert.equal(readCount, 1)
  await waitUntil(() => closed.length === 1)
  assert.equal(readCount, 3)
})

test('held exact active turn is monitored before model settings and closes only after native terminal', async () => {
  const current = {
    ...product(),
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
  }
  let terminal = false
  let readCount = 0
  let waitCount = 0
  let resolverCount = 0
  let threadStartCount = 0
  let turnStartCount = 0
  let archiveCount = 0
  let closeCount = 0
  let publishCount = 0
  let failureCount = 0
  let releaseTerminalWait!: () => void
  const terminalWait = new Promise<void>((resolve) => { releaseTerminalWait = resolve })
  const runtime = {
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn(terminal ? 'completed' : 'inProgress')]) }
    },
    async threadStart() {
      threadStartCount += 1
      throw new Error('unexpected_thread_start')
    },
    async turnStart() {
      turnStartCount += 1
      throw new Error('unexpected_turn_start')
    },
    async threadArchive() {
      archiveCount += 1
      return {}
    },
  } as unknown as CodexNativeRuntime
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductRunForThreadBinding: () => 'run-1',
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readRecoverySnapshot: () => ({
        members: [], lateResponseGuards: [], hostFailureCloseouts: [], manualCompactions: [],
        productFences: [{
          threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'main-1',
          quarantinedAt: null, quarantineReason: null,
        }],
      }),
      claimProductFenceForBoot: () => ({ transferred: false }),
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
    } as never,
    runtime: () => runtime,
    collector: new CodexTurnCollector(runtime),
    async closeCandidate() { closeCount += 1; return { closed: true } },
    publishRecoveredCloseout() { publishCount += 1 },
    onRecoveryFailure() { failureCount += 1 },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings() {
      resolverCount += 1
      throw new Error('upstream_profile_snapshot_unavailable')
    },
    resolveDeveloperInstructions: () => 'Ready overlay',
    wait: async () => {
      waitCount += 1
      await terminalWait
    },
  })
  assert.equal(recovery.dispatchHeldStart({
    member: {
      reservationSetId: 'set-1', reservationId: 'thread-member', scopeId: 'scope-1',
      method: 'thread/start', requiredMemberCount: 2, state: 'held', bindingId: 'binding-1',
      connectionEpoch: null, rpcId: null, crashSeam: 1,
    },
    registry: {} as never,
  }), 'pending')
  await waitUntil(() => readCount === 1 && waitCount === 1)
  assert.equal(resolverCount, 0)
  assert.equal(threadStartCount, 0)
  assert.equal(turnStartCount, 0)
  assert.equal(archiveCount, 0)
  assert.equal(closeCount, 0)
  assert.equal(publishCount, 0)
  assert.equal(failureCount, 0)

  terminal = true
  releaseTerminalWait()
  await waitUntil(() => closeCount === 1)
  assert.equal(readCount, 3)
  assert.equal(resolverCount, 0)
  assert.equal(threadStartCount, 0)
  assert.equal(turnStartCount, 0)
  assert.equal(archiveCount, 0)
  assert.equal(publishCount, 1)
  assert.equal(failureCount, 0)
})

test('boot recovery never locally closes an exact in-progress turn when the old deadline passes', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  let nowMs = 0
  let readCount = 0
  let waitCount = 0
  let closeCount = 0
  let publishCount = 0
  let failureCount = 0
  let releaseBlockedWait!: () => void
  const blockedWait = new Promise<void>((resolve) => { releaseBlockedWait = resolve })
  const runtime = {
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn('inProgress')]) }
    },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId,
        codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent',
        turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null,
        productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate() { closeCount += 1; return { closed: true } },
    publishRecoveredCloseout() { publishCount += 1 },
    onRecoveryFailure() { failureCount += 1 },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
    nowMs: () => nowMs,
    async wait() {
      waitCount += 1
      if (waitCount === 1) {
        nowMs = 600_001
        return
      }
      await blockedWait
    },
  })
  const pending = recovery.reconcileProductFence({
    threadBindingId: 'binding-1',
    readyRunId: 'run-1',
    ownerMainBootId: 'old-main',
    quarantinedAt: null,
    quarantineReason: null,
  })
  await waitUntil(() => readCount >= 2 && waitCount >= 2)
  assert.equal(closeCount, 0)
  assert.equal(publishCount, 0)
  assert.equal(failureCount, 0)
  const nextGeneration = recovery.beginBootGeneration()
  releaseBlockedWait()
  assert.equal(await nextGeneration, true)
  await pending
  assert.equal(closeCount, 0)
  assert.equal(publishCount, 0)
  assert.equal(failureCount, 0)
})

test('boot recovery restores the exact host run handle and its late cleanup cannot release a successor', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  let releasePoll!: () => void
  const poll = new Promise<void>((resolve) => { releasePoll = resolve })
  let readCount = 0
  const runtime = {
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn(readCount < 2 ? 'inProgress' : 'completed')]) }
    },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const host = new CodexHostOrchestrator({})
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate() { return { closed: true } },
    publishRecoveredCloseout() {},
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun(productRun) {
      host.beginActiveProductRun({
        agent: 'butler',
        scopeId: productRun.readyScopeId,
        aliasId: productRun.readyAliasId,
        requestId: productRun.prepared.ingressBinding.requestId,
        runId: productRun.readyRunId,
      })
    },
    finishActiveProductRun(productRun) {
      host.finishActiveProductRun({
        agent: 'butler',
        scopeId: productRun.readyScopeId,
        requestId: productRun.prepared.ingressBinding.requestId,
        runId: productRun.readyRunId,
      })
    },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
    wait: () => poll,
  })

  const pending = recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  await waitUntil(() => host.getActiveRunCount() === 1)
  const recoveredSignal = host.getActiveRunAbortSignal({
    readyRunId: 'run-1', readyScopeId: 'scope-1', readyAliasId: 'scope-1',
  })
  assert.ok(recoveredSignal)
  assert.equal(host.abortActiveProductRun({
    readyRunId: 'run-1', readyScopeId: 'scope-1', readyAliasId: 'scope-1',
  }), true)
  assert.equal(recoveredSignal.aborted, true)

  host.beginActiveProductRun({
    agent: 'butler', scopeId: 'scope-1', aliasId: 'scope-1',
    requestId: 'request-successor', runId: 'run-successor',
  })
  releasePoll()
  await pending
  assert.equal(host.getActiveRunAbortSignal({
    readyRunId: 'run-successor', readyScopeId: 'scope-1', readyAliasId: 'scope-1',
  })?.aborted, false)
  assert.equal(host.getActiveRunCount(), 1)
})

test('boot recovery reconstructs automatic compaction evidence from exact native readback', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  const compactTurn: CodexTurn = {
    ...terminalTurn(),
    items: [
      { type: 'contextCompaction', id: 'compact-1' },
      { type: 'agentMessage', id: 'final-1', text: 'done', phase: 'final_answer' },
    ],
  }
  const closed: unknown[] = []
  const runtime = {
    async threadRead() { return { thread: rootThread([compactTurn]) } },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout() {},
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    verifyAutomaticCompaction({ thread, turn }) {
      assert.equal(thread.id, 'thread-native-1')
      assert.equal(turn.id, 'turn-native-1')
      return {
        threadId: thread.id,
        turnId: turn.id,
        threadReadDigest: 'thread-read-digest',
        upstreamProfileSnapshotDigest: 'profile-digest',
        automaticRequestReceiptId: 'automatic-request-1',
        automaticRequestEvidenceDigest: 'automatic-request-evidence-1',
        automaticResponseEvidenceDigest: 'automatic-response-evidence-1',
        automaticRequestSequence: 1,
        automaticResponseSequence: 2,
        successorProductRequestReceiptId: 'successor-request-1',
        successorProductRequestEvidenceDigest: 'successor-request-evidence-1',
        successorProductResponseEvidenceDigest: 'successor-response-evidence-1',
        successorProductRequestSequence: 3,
        successorProductResponseSequence: 4,
        automaticInputDigest: 'automatic-input-1',
        successorProductInputDigest: 'successor-input-1',
        automaticInputTotalStringCharacters: 1000,
        successorProductInputTotalStringCharacters: 100,
      }
    },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })
  recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  await waitUntil(() => closed.length === 1)
  assert.deepEqual((closed[0] as { contextState: unknown }).contextState, {
    resourceAnchorDigest: 'resource-anchor',
    automaticCompactionExchanges: [{
      threadId: 'thread-native-1', turnId: 'turn-native-1',
      threadReadDigest: 'thread-read-digest', upstreamProfileSnapshotDigest: 'profile-digest',
      automaticRequestReceiptId: 'automatic-request-1',
      automaticRequestEvidenceDigest: 'automatic-request-evidence-1',
      automaticResponseEvidenceDigest: 'automatic-response-evidence-1',
      automaticRequestSequence: 1, automaticResponseSequence: 2,
      successorProductRequestReceiptId: 'successor-request-1',
      successorProductRequestEvidenceDigest: 'successor-request-evidence-1',
      successorProductResponseEvidenceDigest: 'successor-response-evidence-1',
      successorProductRequestSequence: 3, successorProductResponseSequence: 4,
      automaticInputDigest: 'automatic-input-1', successorProductInputDigest: 'successor-input-1',
      automaticInputTotalStringCharacters: 1000,
      successorProductInputTotalStringCharacters: 100,
    }],
  })
})

test('boot recovery surfaces automatic evidence failure without closing or publishing the fenced run', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  const closed: unknown[] = []
  const published: string[] = []
  const failures: Array<{ readyRunId: string; message: string }> = []
  const runtime = {
    async threadRead() { return { thread: rootThread([terminalTurn()]) } },
  } as Pick<CodexNativeRuntime, 'threadRead'>
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime as CodexNativeRuntime,
    collector: new CodexTurnCollector(runtime as CodexNativeRuntime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout(readyRunId) { published.push(readyRunId) },
    onRecoveryFailure(readyRunId, error) {
      failures.push({
        readyRunId,
        message: error instanceof Error ? error.message : String(error),
      })
    },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    verifyAutomaticCompaction() { throw new Error('automatic_exchange_chain_invalid') },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })
  recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  await waitUntil(() => failures.length === 1)
  assert.deepEqual(failures, [{ readyRunId: 'run-1', message: 'automatic_exchange_chain_invalid' }])
  assert.deepEqual(closed, [])
  assert.deepEqual(published, [])
})

test('boot recovery composes durable gateway evidence with native terminal readback', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex product boot recovery native coverage')) return
  await t.test('interrupted turn without automatic compaction closes normally', async (t) => {
    await withGatewayDatabase(t, async (db) => {
      const result = await recoverWithGatewayEvidence({ db, turnStatus: 'interrupted' })
      assert.equal(result.closed.length, 1)
      assert.deepEqual(result.published, ['run-1'])
      assert.deepEqual(result.failures, [])
    })
  })

  await t.test('automatic receipt missing its request transcript fails without closeout', async (t) => {
    await withGatewayDatabase(t, async (db) => {
      insertGatewayReceipt({
        db,
        receiptId: 'automatic-missing-transcript',
        requestKind: 'automatic_compaction',
        acceptedAt: '2026-08-07T00:00:00.000Z',
        withTranscript: false,
      })
      const result = await recoverWithGatewayEvidence({ db, turnStatus: 'completed' })
      assert.deepEqual(result.closed, [])
      assert.deepEqual(result.published, [])
      assert.deepEqual(result.failures, ['gateway_request_transcript_missing'])
    })
  })

  await t.test('completed automatic exchange with non-completed native turn fails without closeout', async (t) => {
    await withGatewayDatabase(t, async (db) => {
      insertGatewayReceipt({
        db,
        receiptId: 'automatic-completed',
        requestKind: 'automatic_compaction',
        acceptedAt: '2026-08-07T00:00:00.000Z',
        withTranscript: true,
        withResponse: true,
        inputCharacters: 1_000,
        inputItemSeed: 'raw-item',
      })
      insertGatewayReceipt({
        db,
        receiptId: 'successor-completed',
        requestKind: 'product',
        acceptedAt: '2026-08-07T00:00:01.000Z',
        withTranscript: true,
        withResponse: true,
        inputCharacters: 100,
        inputItemSeed: 'summary-item',
        toolsDigest: 'surface-digest',
        toolCount: 1,
      })
      const result = await recoverWithGatewayEvidence({ db, turnStatus: 'interrupted' })
      assert.deepEqual(result.closed, [])
      assert.deepEqual(result.published, [])
      assert.deepEqual(result.failures, ['automatic_compaction_turn_readback_mismatch'])
    })
  })
})

test('same-Main boot readback returns to the active collector without a second closeout', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  const runtime = {
    subscribe() { return () => undefined },
    async threadRead() { return { thread: rootThread([terminalTurn()]) } },
  } as unknown as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const collection = collector.collect({
    readyTaskId: 'task-1', readyRunId: 'run-1', scopeId: 'scope-1',
    codexThreadId: 'thread-native-1', startTurn: () => new Promise(() => undefined),
    terminalTimeoutMs: 1_000, actionReceiptRefs: [], interactionState: null,
    waitingFor: null, terminalReasonCandidate: 'done', abortInitiator: null,
    budgetState: {}, contextState: {}, providerDiagnostics: {}, recoveryCheckpointRef: null,
    browserContinuationRef: null, browserProofRefs: [], otherProofRefs: [],
    projectionPatchRefs: [], allowNullPhaseFallback: false, allowDirectProvisionalStream: false,
    onProvisionalDelta() {},
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  let closeCount = 0
  let publishCount = 0
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductTurnRuntime: () => current,
      readProductCloseout: () => null,
      readEngineTerminalCandidate: () => null,
      readProductStartState: () => ({
        codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
        threadStartDispatchIntentAt: 'intent', turnStartDispatchIntentAt: 'intent',
        hostFailureKind: null, productCloseoutCommitted: false,
      }),
      claimProductFenceForBoot: () => ({ transferred: false }),
    } as never,
    runtime: () => runtime,
    collector,
    async closeCandidate() { closeCount += 1; return { closed: true } },
    publishRecoveredCloseout() { publishCount += 1 },
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })

  recovery.reconcileProductFence({
    threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'old-main',
    quarantinedAt: null, quarantineReason: null,
  })
  assert.equal((await collection).candidateText, 'done')
  assert.equal(closeCount, 0)
  assert.equal(publishCount, 0)
  collector.releaseRun('run-1')
})

test('stopping product recovery aborts a hanging native start without publishing', async () => {
  const current = product()
  let closeCount = 0
  let publishCount = 0
  const recovery = new CodexProductBootRecovery({
    repository: {
      readProductLifecycleAction: () => null,
      readProductRunForThreadBinding: () => 'run-1',
      readRecoverySnapshot: () => ({
        members: [], lateResponseGuards: [], hostFailureCloseouts: [], manualCompactions: [],
        productFences: [{
          threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'main-1',
          quarantinedAt: null, quarantineReason: null,
        }],
      }),
      claimProductFenceForBoot: () => ({ transferred: false }),
      readProductTurnRuntime: () => current,
      readProductStartState: () => ({
        codexThreadId: null, codexTurnId: null, threadStartDispatchIntentAt: null,
        turnStartDispatchIntentAt: null, hostFailureKind: null, productCloseoutCommitted: false,
      }),
    } as never,
    runtime: () => ({ threadStart: () => new Promise(() => undefined) }) as CodexNativeRuntime,
    collector: new CodexTurnCollector({} as CodexNativeRuntime),
    async closeCandidate() { closeCount += 1 },
    publishRecoveredCloseout() { publishCount += 1 },
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun() {},
    finishActiveProductRun() {},
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })
  recovery.dispatchHeldStart({
    member: {
      reservationSetId: 'set-1', reservationId: 'thread-member', scopeId: 'scope-1',
      method: 'thread/start', requiredMemberCount: 2, state: 'held', bindingId: 'binding-1',
      connectionEpoch: null, rpcId: null, crashSeam: 1,
    },
    registry: {} as never,
  })
  await recovery.stop()
  assert.equal(closeCount, 0)
  assert.equal(publishCount, 0)
})

test('a new boot generation drains an old hanging job before rescheduling the same run', async () => {
  let current = product()
  let hangFirstStart = true
  const closed: unknown[] = []
  const host = new CodexHostOrchestrator({})
  const runtime = {
    async threadStart() {
      if (hangFirstStart) return new Promise(() => undefined)
      current = { ...current, codexThreadId: 'thread-native-1' }
      return { thread: rootThread([]), instructionSources: [] }
    },
    async turnStart() {
      current = { ...current, codexTurnId: 'turn-native-1' }
      return { turn: terminalTurn() }
    },
    async threadRead() { return { thread: rootThread([terminalTurn()]) } },
  } as unknown as CodexNativeRuntime
  const repository = {
    readProductLifecycleAction: () => null,
    readProductRunForThreadBinding: () => 'run-1',
    readRecoverySnapshot: () => ({
      members: [], lateResponseGuards: [], hostFailureCloseouts: [], manualCompactions: [],
      productFences: [{
        threadBindingId: 'binding-1', readyRunId: 'run-1', ownerMainBootId: 'main-1',
        quarantinedAt: null, quarantineReason: null,
      }],
    }),
    claimProductFenceForBoot: () => ({ transferred: false }),
    readProductTurnRuntime: () => current,
    readProductStartState: () => ({
      codexThreadId: current.codexThreadId, codexTurnId: current.codexTurnId,
      threadStartDispatchIntentAt: null, turnStartDispatchIntentAt: null,
      hostFailureKind: null, productCloseoutCommitted: false,
    }),
  }
  const recovery = new CodexProductBootRecovery({
    repository: repository as never,
    runtime: () => runtime,
    collector: new CodexTurnCollector(runtime),
    async closeCandidate(candidate) { closed.push(candidate); return { closed: true } },
    publishRecoveredCloseout() {},
    onRecoveryFailure(_readyRunId, error) { throw error },
    async settleHostFailure() { throw new Error('unexpected_host_failure') },
    restoreActiveProductRun(productRun) {
      host.beginActiveProductRun({
        agent: 'butler', scopeId: productRun.readyScopeId, aliasId: productRun.readyAliasId,
        requestId: productRun.prepared.ingressBinding.requestId, runId: productRun.readyRunId,
      })
    },
    finishActiveProductRun(productRun) {
      host.finishActiveProductRun({
        agent: 'butler', scopeId: productRun.readyScopeId,
        requestId: productRun.prepared.ingressBinding.requestId, runId: productRun.readyRunId,
      })
    },
    ownerMainBootId: 'main-1',
    resolveNativeModelSettings: () => nativeModelSettings,
    resolveDeveloperInstructions: () => 'Ready overlay',
  })
  const held: CodexBindingRecoveryMember = {
    reservationSetId: 'set-1', reservationId: 'thread-member', scopeId: 'scope-1',
    method: 'thread/start', requiredMemberCount: 2, state: 'held', bindingId: 'binding-1',
    connectionEpoch: null, rpcId: null, crashSeam: 1,
  }
  recovery.dispatchHeldStart({ member: held, registry: {} as never })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(host.getActiveRunCount(), 1)
  hangFirstStart = false
  assert.equal(await recovery.beginBootGeneration(), true)
  assert.equal(host.getActiveRunCount(), 0)
  recovery.dispatchHeldStart({ member: held, registry: {} as never })
  await waitUntil(() => closed.length === 1 && host.getActiveRunCount() === 0)
  assert.equal((closed[0] as { candidateText?: string }).candidateText, 'done')
})

test('production absence proof requires the exact settled process lease and owner evidence', () => {
  const member: CodexBindingRecoveryMember = {
    reservationSetId: 'set-1', reservationId: 'member-1', scopeId: 'scope-1',
    method: 'turn/start', requiredMemberCount: 1, state: 'recovery_held',
    bindingId: 'run-1', connectionEpoch: 'old-epoch', rpcId: 2, crashSeam: 6,
  }
  const lease: CodexProcessLeaseRow = {
    processLeaseId: 'lease-1', ownerMainBootId: 'old-main', ownerMainPid: 10,
    ownerMainProcessStartIdentity: 'old-main-process', sidecarSpawnInstanceId: 'spawn-1',
    connectionEpoch: 'old-epoch', runtimeManifestDigest: 'manifest', binarySha256: 'binary',
    executablePath: '/tmp/codex', isolatedStateDir: '/tmp/state', singletonSlot: 1,
    spawnIntentAt: '2026-08-07T00:00:00.000Z',
    spawnVisibilityDeadlineAt: '2026-08-07T00:00:05.000Z',
    pid: 11, processGroupId: 11, processStartIdentity: 'sidecar-process',
    ownershipConfirmedAt: '2026-08-07T00:00:00.100Z',
    ownerMainDeadAt: '2026-08-07T00:01:00.000Z',
    ownerMainDeathEvidenceDigest: 'owner-death',
    connectionOpenedAt: '2026-08-07T00:00:00.200Z',
    closedAt: '2026-08-07T00:01:00.100Z', treeZeroAt: '2026-08-07T00:01:01.000Z',
    treeZeroMatcherMode: 'post_cas', stableZeroSampleTranscriptDigest: 'stable-zero',
    treeZeroEvidenceDigest: 'tree-zero', revision: 5,
  }
  const repository = {
    readProcessLeaseByConnectionEpoch(epoch: string) {
      return epoch === lease.connectionEpoch ? lease : null
    },
  }
  const accepted = proveCodexStableStartAbsence({
    repository: repository as never,
    ownerMainBootId: 'new-main', member,
    stableReadbackEvidenceDigest: 'native-stable-zero',
  })
  assert.equal(accepted.proven, true)
  if (!accepted.proven) throw new Error('absence_not_proven')
  assert.match(accepted.evidenceDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(proveCodexStableStartAbsence({
    repository: { readProcessLeaseByConnectionEpoch: () => ({ ...lease, treeZeroAt: null }) } as never,
    ownerMainBootId: 'new-main', member,
    stableReadbackEvidenceDigest: 'native-stable-zero',
  }), { proven: false })
  assert.deepEqual(proveCodexStableStartAbsence({
    repository: {
      readProcessLeaseByConnectionEpoch: () => ({
        ...lease, ownerMainDeadAt: null, ownerMainDeathEvidenceDigest: null,
      }),
    } as never,
    ownerMainBootId: 'new-main', member,
    stableReadbackEvidenceDigest: 'native-stable-zero',
  }), { proven: false })
})

test('terminal timeout interrupt readback recovers the exact late native terminal', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  const calls: string[] = []
  const runtime = {
    subscribe() { return () => undefined },
    async turnInterrupt(input) { calls.push(`interrupt:${input.threadId}:${input.turnId}`); return {} },
    async threadRead() { calls.push('read'); return { thread: rootThread([terminalTurn()]) } },
  } as unknown as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const timedOut = await collector.collect({
    readyTaskId: 'task-1', readyRunId: 'run-1', scopeId: 'scope-1',
    codexThreadId: 'thread-native-1',
    startTurn: async () => ({ turn: terminalTurn('inProgress') }),
    terminalTimeoutMs: 1, actionReceiptRefs: [], interactionState: null, waitingFor: null,
    terminalReasonCandidate: 'persistence_failed', abortInitiator: null,
    budgetState: {}, contextState: {}, providerDiagnostics: {}, recoveryCheckpointRef: null,
    browserContinuationRef: null, browserProofRefs: [], otherProofRefs: [],
    projectionPatchRefs: [], allowNullPhaseFallback: false, allowDirectProvisionalStream: false,
    onProvisionalDelta() {},
  })
  collector.releaseRun('run-1')
  assert.equal(timedOut.kind, 'host_failure')
  let acknowledged = 0
  let unknown = 0
  const recovered = await recoverCodexTerminalAfterInterrupt({
    runtime,
    collector,
    product: current,
    timedOutCandidate: timedOut,
    acknowledgeInterrupt() { acknowledged += 1 },
    markInterruptUnknown() { unknown += 1 },
  })
  assert.deepEqual(calls, ['interrupt:thread-native-1:turn-native-1', 'read'])
  assert.equal(acknowledged, 1)
  assert.equal(unknown, 0)
  assert.equal(recovered.kind, 'native_terminal')
  assert.equal(recovered.engineOutcome, 'completed')
  assert.equal(recovered.candidateText, 'done')
  assert.equal(recovered.terminalReasonCandidate, 'done')
})

test('terminal timeout keeps one recovery observer until an exact late terminal arrives', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  let interruptCount = 0
  let readCount = 0
  const runtime = {
    subscribe() { return () => undefined },
    async turnInterrupt() { interruptCount += 1; return {} },
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn(readCount === 1 ? 'inProgress' : 'completed')]) }
    },
  } as unknown as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const timedOut = {
    kind: 'host_failure', readyTaskId: 'task-1', readyRunId: 'run-1', scopeId: 'scope-1',
    codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1', engineOutcome: 'failed',
    candidateSelection: { kind: 'none', code: 'host_failure' }, candidateText: null,
    candidateDigest: null, usedToolCalls: [], actionReceiptRefs: [], interactionState: null,
    waitingFor: null, terminalReasonCandidate: 'persistence_failed', abortInitiator: null,
    budgetState: {}, contextState: {}, providerDiagnostics: {}, recoveryCheckpointRef: null,
    browserContinuationRef: null, browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
    runtimeDiagnostics: { finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: 'timeout' },
    hostFailure: { stage: 'terminal_timeout', code: 'codex_turn_terminal_timeout', message: 'timeout', evidenceDigest: 'evidence' },
  } as const
  let acknowledged = 0
  let unknown = 0
  const recovered = await recoverCodexTerminalAfterInterrupt({
    runtime, collector, product: current, timedOutCandidate: timedOut,
    acknowledgeInterrupt() { acknowledged += 1 },
    markInterruptUnknown() { unknown += 1 },
    async wait() {},
  })
  assert.equal(recovered.kind, 'native_terminal')
  assert.equal(recovered.engineOutcome, 'completed')
  assert.equal(interruptCount, 1)
  assert.equal(readCount, 2)
  assert.equal(acknowledged, 1)
  assert.equal(unknown, 1)
})

test('interrupt delivery uncertainty keeps observing until the exact late terminal arrives', async () => {
  const current = { ...product(), codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1' }
  let listener: ((notification: CodexNativeNotification) => void) | null = null
  let interruptCount = 0
  let readCount = 0
  let unsubscribeCount = 0
  const runtime = {
    subscribe(next) {
      listener = next
      return () => { unsubscribeCount += 1 }
    },
    async turnInterrupt() {
      interruptCount += 1
      throw new Error('interrupt_ack_lost')
    },
    async threadRead() {
      readCount += 1
      return { thread: rootThread([terminalTurn('inProgress')]) }
    },
  } as unknown as CodexNativeRuntime
  const collector = new CodexTurnCollector(runtime)
  const timedOut = {
    kind: 'host_failure', readyTaskId: 'task-1', readyRunId: 'run-1', scopeId: 'scope-1',
    codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1', engineOutcome: 'failed',
    candidateSelection: { kind: 'none', code: 'host_failure' }, candidateText: null,
    candidateDigest: null, usedToolCalls: [], actionReceiptRefs: [], interactionState: null,
    waitingFor: null, terminalReasonCandidate: 'persistence_failed', abortInitiator: null,
    budgetState: {}, contextState: {}, providerDiagnostics: {}, recoveryCheckpointRef: null,
    browserContinuationRef: null, browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
    runtimeDiagnostics: { finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: 'timeout' },
    hostFailure: { stage: 'terminal_timeout', code: 'codex_turn_terminal_timeout', message: 'timeout', evidenceDigest: 'evidence' },
  } as const
  let acknowledged = 0
  let unknown = 0
  let waits = 0
  const recovered = await recoverCodexTerminalAfterInterrupt({
    runtime, collector, product: current, timedOutCandidate: timedOut,
    acknowledgeInterrupt() { acknowledged += 1 },
    markInterruptUnknown() { unknown += 1 },
    async wait() {
      waits += 1
      listener?.({
        method: 'turn/completed',
        params: { threadId: 'thread-foreign', turn: terminalTurn('completed') },
      })
      if (waits === 1) {
        listener?.({
          method: 'turn/completed',
          params: { threadId: 'thread-native-1', turn: terminalTurn('completed') },
        })
      }
    },
  })
  assert.equal(recovered.kind, 'native_terminal')
  assert.equal(recovered.engineOutcome, 'completed')
  assert.equal(interruptCount, 1)
  assert.equal(readCount, 1)
  assert.equal(acknowledged, 0)
  assert.equal(unknown, 1)
  assert.equal(unsubscribeCount, 1)
})
