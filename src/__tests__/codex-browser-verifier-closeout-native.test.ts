import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { AgentSessionCheckpointRepository } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
  type CodexBrowserVerifierAttemptOutcome,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { codexBrowserVerifierFrozenIdentityDigest } from '../main/modules/agent-control/codex-runtime/codex-browser-verifier-identity'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { requestCodexEngineTerminalLifecycleActionBeforeCloseout } from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import {
  openProviderCheckpointTestDb,
  providerCheckpointExecutionBinding,
} from './provider-checkpoint-test-fixtures'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const startedAt = '2026-08-11T05:00:00.000Z'
const verifiedAt = '2026-08-11T05:01:00.000Z'
const closeoutAt = '2026-08-11T05:02:00.000Z'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function prepared(runId: string, taskId: string, scopeId: string, messageId: string): PreparedCodexProductRun {
  const tools = createCodexToolFixture([])
  return {
    preparationContract: 'codex_product_run_e1',
    taskId,
    runId,
    conversationAlias: { aliasId: scopeId, aliasGeneration: 1 },
    ingressBinding: {
      requestId: `request-${runId}`,
      reservationSetId: `reservation-${runId}`,
      reservationEvidenceDigest: `reservation-evidence-${runId}`,
    },
    ingress: {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: messageId,
      canonicalCurrentInputRef: {
        messageId,
        input: [{ type: 'text', text: '查询天气', text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: sha256(JSON.stringify({
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    })),
    recoveredContextDigest: null,
    ...tools,
    readyToolHostIdentity: {
      scopeId,
      aliasId: scopeId,
      authorizationOwnerId: `authorization-${runId}`,
      resourceOwnerId: `resource-${runId}`,
    },
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning',
      taskTitle: '正在理解需求',
      taskSummary: '正在整理任务边界、资源与可用能力',
    },
  }
}

async function fixture(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  suffix: string,
  beforeVerifierDispatch?: (value: {
    db: ReturnType<typeof openProviderCheckpointTestDb>
    repository: CodexBindingRepository
    runId: string
    scopeId: string
    threadBindingId: string
    codexThreadId: string
    codexTurnId: string
  }) => void,
) {
  if (skipIfSqliteUnavailable(t, `codex-browser-verifier-${suffix}`)) return null
  const db = openProviderCheckpointTestDb()
  const accessor = { getRawDb: () => db }
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
  const projections = new TaskProjectionRepository(accessor)
  const runMeta = new RunMetaRepository(db)
  const scopeId = `scope-${suffix}`
  const taskId = `task-${suffix}`
  const runId = `run-${suffix}`
  const messageId = `message-${suffix}`
  const threadBindingId = `binding-${suffix}`
  const codexThreadId = `thread-${suffix}`
  const codexTurnId = `turn-${suffix}`
  const run = prepared(runId, taskId, scopeId, messageId)
  const executionBinding = providerCheckpointExecutionBinding(runId)
  db.prepare(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, handoff_generation, title, source_kind, source_id,
      thread_key, meta_json, created_at, updated_at
    ) VALUES (?, 'butler', 'butler', 0, 'Verifier', 'local', 'app', ?, '{}', ?, ?)
  `).run(scopeId, scopeId, startedAt, startedAt)
  db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
    )
    VALUES (?, ?, 'user', '查询天气', ?, '{}', 0)
  `).run(messageId, scopeId, startedAt)
  projections.create({
    taskId,
    scopeId,
    messageVisibilityEpoch: 0,
    runId,
    taskType: 'direct_answer',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    ownerAgentId: 'butler',
    taskOrigin: 'user_root',
    executionBinding,
    criteria: { items: [], satisfiedCount: 0, totalCount: 0 },
    proofRefs: [],
    checkins: [],
    modelCriteria: [],
    expectedOutputs: [],
    recentArtifacts: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  })
  runMeta.create({
    runId,
    taskId,
    scopeId,
    messageVisibilityEpoch: 0,
    agentId: 'butler',
    executionBinding,
    status: 'running',
  }, Date.parse(startedAt))
  repository.createEmptyAliasGeneration({
    threadBindingId,
    aliasId: scopeId,
    aliasGeneration: 1,
    readyScopeId: scopeId,
    runtimeManifestDigest: `runtime-${suffix}`,
    protocolSchemaDigest: `protocol-${suffix}`,
    createdAt: startedAt,
  })
  const reservation: StartIdentityReservationSet = {
    reservationSetId: run.ingressBinding.reservationSetId,
    scopeId,
    existingThread: false,
    members: [
      { method: 'thread/start', reservationId: `thread-reservation-${suffix}` },
      { method: 'turn/start', reservationId: `turn-reservation-${suffix}` },
    ],
    reservationEvidenceDigest: run.ingressBinding.reservationEvidenceDigest,
  }
  const admissionInput = {
    prepared: run,
    reservation,
    ownerMainBootId: `boot-${suffix}`,
    admittedAt: startedAt,
    ingressAdmittedRevision: 1,
    messageVisibilityEpoch: 0,
    threadBindingId,
    isolatedThreadCwd: `/tmp/ready-codex/${threadBindingId}`,
    turnRequestId: `turn-request-${suffix}`,
    runtimeManifestDigest: `runtime-${suffix}`,
    protocolSchemaDigest: `protocol-${suffix}`,
    instructionContractDigest: `instruction-${suffix}`,
    codexModel: 'frozen-browser-model',
    upstreamProfileSnapshotRef: `snapshot-ref-${suffix}`,
    upstreamProfileSnapshotDigest: 'a'.repeat(64),
    additionalContextDigest: digestCanonicalJson([]),
    turnContractDigest: `turn-contract-${suffix}`,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: '查询天气',
      messageTimestamp: startedAt,
      messageMetaDigest: digestCanonicalJson({}),
      executionBindingDigest: digestCanonicalJson(executionBinding),
    },
  }
  repository.admitProductBindings({
    ...admissionInput,
    ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionInput),
  } as CodexAdmittedBindingInput)
  repository.activateStartDispatch({
    connectionEpoch: `epoch-${suffix}`,
    rpcId: 1,
    method: 'thread/start',
    bindingLookupKey: admissionInput.isolatedThreadCwd,
    requestDigest: `thread-request-${suffix}`,
    dispatchedAt: startedAt,
  })
  const nativeThread: CodexThread = {
    id: codexThreadId,
    sessionId: codexThreadId,
    parentThreadId: null,
    forkedFromId: null,
    cwd: admissionInput.isolatedThreadCwd,
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: Date.parse(startedAt),
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: Date.parse(startedAt),
    turns: [],
  }
  repository.reconcileStartAccepted({
    connectionEpoch: `epoch-${suffix}`,
    rpcId: 1,
    method: 'thread/start',
    bindingId: threadBindingId,
    nativeId: codexThreadId,
    nativeResult: { thread: nativeThread, instructionSources: [] },
    responseDigest: `thread-response-${suffix}`,
    responsePending: false,
    reconciledAt: startedAt,
  })
  repository.activateStartDispatch({
    connectionEpoch: `epoch-${suffix}`,
    rpcId: 2,
    method: 'turn/start',
    bindingLookupKey: runId,
    requestDigest: `turn-request-${suffix}`,
    dispatchedAt: startedAt,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: `epoch-${suffix}`,
    rpcId: 2,
    method: 'turn/start',
    bindingId: runId,
    nativeId: codexTurnId,
    nativeResult: { turn: { id: codexTurnId, items: [], status: 'inProgress', error: null } },
    responseDigest: `turn-response-${suffix}`,
    responsePending: false,
    reconciledAt: startedAt,
  })
  const checkpoints = new AgentSessionCheckpointRepository(accessor)
  const route = await checkpoints.bindBrowserWorkflowRoute({
    parentTaskId: taskId,
    ownerRunId: runId,
    sourceMessageId: messageId,
    executionBinding,
    now: startedAt,
  })
  const finalText = `hidden-candidate-${suffix}`
  const candidateDigest = sha256(finalText)
  repository.recordEngineTerminalCandidate({
    readyRunId: runId,
    codexThreadId,
    codexTurnId,
    engineOutcome: 'completed',
    candidate: {
      kind: 'native_terminal',
      readyTaskId: taskId,
      readyRunId: runId,
      scopeId,
      codexThreadId,
      codexTurnId,
      engineOutcome: 'completed',
      candidateSelection: { kind: 'accepted', itemId: `final-${suffix}` },
      candidateText: finalText,
      candidateDigest,
      usedToolCalls: [],
      actionReceiptRefs: [],
      interactionState: null,
      waitingFor: null,
      terminalReasonCandidate: 'done',
      abortInitiator: null,
      budgetState: {},
      contextState: {},
      providerDiagnostics: {},
      recoveryCheckpointRef: null,
      browserContinuationRef: null,
      browserProofRefs: [],
      otherProofRefs: [],
      projectionPatchRefs: [],
      runtimeDiagnostics: {
        finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: null,
      },
    },
    recordedAt: startedAt,
  })
  const bundleInspection = checkpoints.readWorkflowVerifierBundle(taskId)
  assert.ok(bundleInspection.bundle)
  const projection = projections.get(taskId)
  assert.ok(projection)
  const product = repository.readProductTurnRuntime(runId)
  const frozenIdentityDigest = codexBrowserVerifierFrozenIdentityDigest({
    product: {
      readyRunId: product.readyRunId,
      readyTaskId: product.readyTaskId,
      readyScopeId: product.readyScopeId,
      readyAliasId: product.readyAliasId,
      aliasGeneration: product.aliasGeneration,
      threadBindingId: product.threadBindingId,
      codexThreadId: product.codexThreadId,
      codexTurnId: product.codexTurnId,
      turnRequestId: product.turnRequestId,
      toolSurfaceDigest: product.toolSurfaceDigest,
      turnContractDigest: product.turnContractDigest,
      upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
      codexModel: product.codexModel,
    },
    workflowBundle: bundleInspection.bundle!,
    projection: {
      taskId: projection!.taskId,
      runId: projection!.runId,
      revision: projection!.revision,
      requestAnchor: projection!.requestAnchor,
      criteria: projection!.criteria,
      modelCriteria: projection!.modelCriteria,
      proofRefs: projection!.proofRefs,
      recentArtifacts: projection!.recentArtifacts,
      expectedOutputs: projection!.expectedOutputs,
    },
  })
  beforeVerifierDispatch?.({
    db,
    repository,
    runId,
    scopeId,
    threadBindingId,
    codexThreadId,
    codexTurnId,
  })
  const begun = repository.beginBrowserVerifierAttempt({
    readyRunId: runId,
    readyTaskId: taskId,
    readyScopeId: scopeId,
    readyAliasId: scopeId,
    aliasGeneration: 1,
    threadBindingId,
    codexThreadId,
    codexTurnId,
    candidateDigest,
    frozenIdentityDigest,
    upstreamProfileSnapshotRef: admissionInput.upstreamProfileSnapshotRef,
    upstreamProfileSnapshotDigest: admissionInput.upstreamProfileSnapshotDigest,
    workflowCloseoutSealDigest: workflowDigest(bundleInspection.bundle!.seal),
    dispatchedAt: startedAt,
  })
  return {
    db,
    accessor,
    repository,
    projections,
    checkpoints,
    run,
    scopeId,
    taskId,
    runId,
    threadBindingId,
    finalText,
    candidateDigest,
    bundle: bundleInspection.bundle!,
    projection: projection!,
    route,
    begun,
  }
}

function settle(
  value: NonNullable<Awaited<ReturnType<typeof fixture>>>,
  outcome: CodexBrowserVerifierAttemptOutcome,
) {
  const verdict = outcome === 'accept'
    ? { version: 1 as const, verdict: 'accept' as const, gaps: [], summary: '通过' }
    : { version: 1 as const, verdict: 'block' as const, gaps: [{ kind: 'text', description: '证据不足' }], summary: '未通过' }
  return value.repository.settleBrowserVerifierAttempt({
    readyRunId: value.runId,
    attemptId: value.begun.attempt.attemptId,
    outcome,
    verdict,
    sealedCandidateDigest: outcome === 'accept' ? 'b'.repeat(64) : null,
    verificationUsage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
    verifiedAt,
    settledAt: verifiedAt,
  })
}

function acceptedCloseoutInput(
  value: NonNullable<Awaited<ReturnType<typeof fixture>>>,
  attempt: ReturnType<typeof settle>,
) {
  const terminalQualityPatch = {
    proofRefs: value.projection.proofRefs ?? [],
    checkins: value.projection.checkins ?? [],
    criteria: value.projection.criteria ?? { items: [], satisfiedCount: 0, totalCount: 0 },
  }
  return {
    parentTaskId: value.taskId,
    ownerRunId: value.runId,
    status: 'done' as const,
    terminalReason: 'done',
    initiator: 'done',
    durationMs: 1,
    finalText: value.finalText,
    conversationId: value.scopeId,
    taskType: 'direct_answer',
    module: 'system',
    workflowCloseoutSeal: value.bundle.seal,
    terminalQualityPatch,
    completionVerifierReceipt: {
      version: 1 as const,
      verdict: 'accept' as const,
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      candidateDigest: workflowDigest(value.finalText),
      workflowCloseoutSealDigest: value.begun.attempt.workflowCloseoutSealDigest,
      sealedCandidateDigest: attempt.sealedCandidateDigest!,
      terminalQualityPatchDigest: workflowDigest(terminalQualityPatch),
      durableVerifierReceiptDigest: attempt.receiptDigest!,
      verifiedAt: attempt.verifiedAt!,
    },
    now: closeoutAt,
  }
}

function acceptedCloseoutRepository(
  value: NonNullable<Awaited<ReturnType<typeof fixture>>>,
): AgentSessionCheckpointRepository {
  return new AgentSessionCheckpointRepository(value.accessor, {
    complete(input) {
      value.repository.completeVerifierAcceptedCloseoutInOpenTransaction(input)
    },
  })
}

test('durable accept is required inside the canonical transaction and retries never redispatch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier durable accept')) return
  const value = await fixture(t, 'accept')
  if (!value) return
  try {
    const attempt = settle(value, 'accept')
    assert.equal(value.repository.beginBrowserVerifierAttempt({
      readyRunId: value.runId,
      readyTaskId: value.taskId,
      readyScopeId: value.scopeId,
      readyAliasId: value.scopeId,
      aliasGeneration: 1,
      threadBindingId: value.threadBindingId,
      codexThreadId: value.begun.attempt.codexThreadId,
      codexTurnId: value.begun.attempt.codexTurnId,
      candidateDigest: value.candidateDigest,
      frozenIdentityDigest: value.begun.attempt.frozenIdentityDigest,
      upstreamProfileSnapshotRef: value.begun.attempt.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: value.begun.attempt.upstreamProfileSnapshotDigest,
      workflowCloseoutSealDigest: value.begun.attempt.workflowCloseoutSealDigest,
      dispatchedAt: startedAt,
    }).created, false)
    const terminalQualityPatch = {
      proofRefs: value.projection.proofRefs ?? [],
      checkins: value.projection.checkins ?? [],
      criteria: value.projection.criteria ?? { items: [], satisfiedCount: 0, totalCount: 0 },
    }
    const participant = {
      complete: (input: { readyRunId: string; productTerminalDigest: string; closeoutAt: string }) => {
        value.repository.completeVerifierAcceptedCloseoutInOpenTransaction(input)
      },
    }
    const closeout = new AgentSessionCheckpointRepository(value.accessor, participant)
    const receipt = {
      version: 1 as const,
      verdict: 'accept' as const,
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      candidateDigest: workflowDigest(value.finalText),
      workflowCloseoutSealDigest: value.begun.attempt.workflowCloseoutSealDigest,
      sealedCandidateDigest: attempt.sealedCandidateDigest!,
      terminalQualityPatchDigest: workflowDigest(terminalQualityPatch),
      durableVerifierReceiptDigest: attempt.receiptDigest!,
      verifiedAt: attempt.verifiedAt!,
    }
    await assert.rejects(() => closeout.commitCanonicalCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 1,
      finalText: value.finalText,
      conversationId: value.scopeId,
      taskType: 'direct_answer',
      module: 'system',
      workflowCloseoutSeal: value.bundle.seal,
      terminalQualityPatch,
      completionVerifierReceipt: receipt,
      now: closeoutAt,
    }), /publication_receipt_missing/)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    value.repository.recordToolPublicationReceipt({ readyRunId: value.runId, recordedAt: verifiedAt })
    await assert.rejects(() => closeout.commitCanonicalCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      status: 'done', terminalReason: 'done', initiator: 'done', durationMs: 1,
      finalText: value.finalText, conversationId: value.scopeId,
      taskType: 'direct_answer', module: 'system', workflowCloseoutSeal: value.bundle.seal,
      terminalQualityPatch,
      completionVerifierReceipt: { ...receipt, durableVerifierReceiptDigest: undefined },
      now: closeoutAt,
    }), /browser_verifier_canonical_receipt_mismatch/)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    const committed = await closeout.commitCanonicalCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      status: 'done', terminalReason: 'done', initiator: 'done', durationMs: 1,
      finalText: value.finalText, conversationId: value.scopeId,
      taskType: 'direct_answer', module: 'system', workflowCloseoutSeal: value.bundle.seal,
      terminalQualityPatch, completionVerifierReceipt: receipt, now: closeoutAt,
    })
    assert.equal(committed.value.canonicalMessage.content, value.finalText)
    assert.equal(value.repository.readProductCloseout(value.runId)?.productTerminalDigest,
      committed.value.canonicalMessageDigest)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
  } finally {
    value.db.close()
  }
})

test('accept rolls back when the Browser parent projection changes after verification', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier parent drift')) return
  const value = await fixture(t, 'accept-parent-drift')
  if (!value) return
  try {
    const attempt = settle(value, 'accept')
    value.repository.recordToolPublicationReceipt({ readyRunId: value.runId, recordedAt: verifiedAt })
    const changed = value.projections.compareAndSwap(
      value.taskId,
      value.projection.revision ?? 0,
      { proofRefs: [{ kind: 'browser_observation', ref: 'late-parent-proof' }] },
      { browserDerivedFieldOwner: 'proof' },
    )
    assert.ok(changed)
    const closeout = acceptedCloseoutRepository(value)
    await assert.rejects(
      () => closeout.commitCanonicalCoreCloseout(acceptedCloseoutInput(value, attempt)),
      /core_closeout_workflow_seal_mismatch/,
    )
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(value.repository.readProductCloseout(value.runId), null)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(value.db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get(value.runId), { status: 'running' })
  } finally {
    value.db.close()
  }
})

test('accept rolls back when the Browser child revision changes after verification', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier child drift')) return
  const value = await fixture(t, 'accept-child-drift')
  if (!value) return
  try {
    const attempt = settle(value, 'accept')
    value.repository.recordToolPublicationReceipt({ readyRunId: value.runId, recordedAt: verifiedAt })
    value.db.prepare(`
      UPDATE browser_tasks SET revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(verifiedAt, value.route.browserTaskId)
    assert.equal(value.checkpoints.readWorkflowVerifierBundle(value.taskId).inspection.state, 'sealable')
    const closeout = acceptedCloseoutRepository(value)
    await assert.rejects(
      () => closeout.commitCanonicalCoreCloseout(acceptedCloseoutInput(value, attempt)),
      /core_closeout_workflow_seal_mismatch/,
    )
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(value.repository.readProductCloseout(value.runId), null)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(value.db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get(value.runId), { status: 'running' })
  } finally {
    value.db.close()
  }
})

test('nonaccept publishes no candidate, retires hidden native history, and next user input gets a new root', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier nonaccept')) return
  const value = await fixture(t, 'reject')
  if (!value) return
  try {
    value.repository.recordToolPublicationReceipt({ readyRunId: value.runId, recordedAt: verifiedAt })
    const attempt = settle(value, 'block')
    const closeout = new AgentSessionCheckpointRepository(value.accessor, {
      complete(input) {
        value.repository.completeVerifierRejectedCloseoutInOpenTransaction(input)
      },
    })
    const committed = await closeout.commitCodexFailureCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      conversationId: value.scopeId,
      status: 'error',
      terminalReason: 'proof_gap',
      initiator: 'codex_browser_verifier',
      durationMs: 1,
      taskType: 'direct_answer',
      module: 'system',
      error: 'codex_browser_verifier_rejected',
      verifierReceiptDigest: attempt.receiptDigest!,
      now: closeoutAt,
    })
    assert.ok(committed.value.productTerminalDigest)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    assert.deepEqual(value.db.prepare(`
      SELECT status, continuation_ref_json, resumable_actions_json
        FROM task_projections WHERE task_id = ?
    `).get(value.taskId), {
      status: 'failed', continuation_ref_json: null, resumable_actions_json: '["none"]',
    })
    assert.deepEqual(value.db.prepare(`
      SELECT retired_reason, retirement_evidence_digest,
             continuation_blocked_reason, continuation_blocked_evidence_digest
        FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get(value.threadBindingId), {
      retired_reason: 'publication_diverged',
      retirement_evidence_digest: attempt.receiptDigest,
      continuation_blocked_reason: 'publication_diverged',
      continuation_blocked_evidence_digest: attempt.receiptDigest,
    })
    const successor = value.repository.resolveUserIngressAliasBinding({
      aliasId: value.scopeId,
      runtimeManifestDigest: 'runtime-successor',
      protocolSchemaDigest: 'protocol-successor',
      createdAt: '2026-08-11T05:03:00.000Z',
    })
    assert.equal(successor?.aliasGeneration, 2)
    assert.equal(successor?.codexThreadId, null)
    assert.notEqual(successor?.threadBindingId, value.threadBindingId)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE content = ?`)
      .get<{ count: number }>(value.finalText)?.count, 0)
  } finally {
    value.db.close()
  }
})

test('engine-terminal lifecycle actions abort a deferred verifier and close exactly once', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier lifecycle abort')) return
  for (const action of ['stop', 'close', 'reset'] as const) {
    const value = await fixture(t, `lifecycle-${action}`)
    if (!value) return
    try {
      const product = value.repository.readProductTurnRuntime(value.runId)
      const host = new CodexHostOrchestrator({})
      host.beginActiveProductRun({
        agent: 'butler', scopeId: value.scopeId, aliasId: value.scopeId,
        requestId: value.run.ingressBinding.requestId, runId: value.runId,
      })
      const verifierSignal = host.getActiveRunAbortSignal({
        readyRunId: value.runId,
        readyScopeId: value.scopeId,
        readyAliasId: value.scopeId,
      })
      assert.ok(verifierSignal)
      let resolveLateProvider!: () => void
      const lateProvider = new Promise<void>((resolve) => { resolveLateProvider = resolve })
      const verifierExit = new Promise<'provider_returned'>((resolve, reject) => {
        verifierSignal.addEventListener('abort', () => reject(verifierSignal.reason), { once: true })
        void lateProvider.then(() => resolve('provider_returned'))
      }).then(() => 'provider_returned' as const, () => 'aborted' as const)
      requestCodexEngineTerminalLifecycleActionBeforeCloseout({
        repository: value.repository,
        host,
        product,
        action,
        requestedAt: verifiedAt,
      })
      assert.equal(verifierSignal.aborted, true)
      assert.equal(await verifierExit, 'aborted')
      assert.throws(() => settle(value, 'accept'), /browser_verifier_settlement_interrupted/)
      let participantCalls = 0
      const closeout = new AgentSessionCheckpointRepository(value.accessor, {
        complete(input) {
          participantCalls += 1
          value.repository.completeLifecycleActionCloseoutInOpenTransaction({ ...input, action })
        },
      })
      const committed = await closeout.commitCodexFailureCoreCloseout({
        parentTaskId: value.taskId,
        ownerRunId: value.runId,
        conversationId: value.scopeId,
        status: 'interrupted',
        terminalReason: 'cancelled_user',
        initiator: `user_${action}`,
        durationMs: 1,
        taskType: 'direct_answer',
        module: 'system',
        error: 'cancelled_user',
        now: closeoutAt,
      })
      assert.equal(participantCalls, 1)
      const lifecycle = value.repository.readLifecycleActionCloseout(value.runId)
      assert.equal(lifecycle.action, action)
      assert.equal(lifecycle.closeoutDigest, committed.value.productTerminalDigest)
      assert.equal(lifecycle.retiredGeneration, 1)
      assert.equal(lifecycle.newGeneration, action === 'reset' ? 2 : null)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 0)
      assert.deepEqual(value.db.prepare(`SELECT status FROM browser_tasks WHERE id = ?`)
        .get(value.route.browserTaskId), { status: 'cancelled' })
      const beforeIngress = value.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_thread_bindings
         WHERE ready_conversation_alias = ?
      `).get<{ count: number }>(value.scopeId)?.count
      assert.equal(beforeIngress, action === 'reset' ? 2 : 1, action)
      const successor = value.repository.resolveUserIngressAliasBinding({
        aliasId: value.scopeId,
        runtimeManifestDigest: action === 'reset' ? `runtime-lifecycle-${action}` : 'runtime-successor',
        protocolSchemaDigest: action === 'reset' ? `protocol-lifecycle-${action}` : 'protocol-successor',
        createdAt: '2026-08-11T05:03:00.000Z',
      })
      if (action === 'close') {
        assert.equal(successor, null)
      } else {
        assert.equal(successor?.aliasGeneration, 2)
        assert.equal(successor?.codexThreadId, null)
      }
      host.beginActiveProductRun({
        agent: 'butler', scopeId: value.scopeId, aliasId: value.scopeId,
        requestId: `request-${action}-successor`, runId: `run-${action}-successor`,
      })
      const successorSignal = host.getActiveRunAbortSignal({
        readyRunId: `run-${action}-successor`,
        readyScopeId: value.scopeId,
        readyAliasId: value.scopeId,
      })
      assert.ok(successorSignal)
      resolveLateProvider()
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      assert.equal(successorSignal.aborted, false)
    } finally {
      value.db.close()
    }
  }
})

test('lifecycle participant rollback preserves only the durable action for boot retry', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier lifecycle rollback')) return
  const value = await fixture(t, 'lifecycle-rollback')
  if (!value) return
  try {
    value.repository.requestProductInterrupt({
      action: 'reset',
      aliasId: value.scopeId,
      aliasGeneration: 1,
      readyRunId: value.runId,
      codexThreadId: value.begun.attempt.codexThreadId,
      codexTurnId: value.begun.attempt.codexTurnId,
      requestedAt: verifiedAt,
    })
    const rejected = new AgentSessionCheckpointRepository(value.accessor, {
      complete(input) {
        value.repository.completeLifecycleActionCloseoutInOpenTransaction({
          ...input,
          action: 'reset',
        })
        throw new Error('forced_participant_failure')
      },
    })
    await assert.rejects(() => rejected.commitCodexFailureCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      conversationId: value.scopeId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: 'user_reset',
      durationMs: 1,
      taskType: 'direct_answer',
      module: 'system',
      error: 'cancelled_user',
      now: closeoutAt,
    }), /forced_participant_failure/)
    assert.equal(value.repository.readProductLifecycleAction(value.runId)?.lifecycleAction, 'reset')
    assert.equal(value.repository.readProductCloseout(value.runId), null)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(value.db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get(value.runId), { status: 'running' })

    const retry = new AgentSessionCheckpointRepository(value.accessor, {
      complete(input) {
        value.repository.completeLifecycleActionCloseoutInOpenTransaction({
          ...input,
          action: 'reset',
        })
      },
    })
    await retry.commitCodexFailureCoreCloseout({
      parentTaskId: value.taskId,
      ownerRunId: value.runId,
      conversationId: value.scopeId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: 'user_reset',
      durationMs: 1,
      taskType: 'direct_answer',
      module: 'system',
      error: 'cancelled_user',
      now: closeoutAt,
    })
    assert.equal(value.repository.readLifecycleActionCloseout(value.runId).newGeneration, 2)
  } finally {
    value.db.close()
  }
})

test('durable lifecycle action is first-writer-wins and blocks Browser verifier dispatch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier lifecycle first writer')) return
  let openedDb: ReturnType<typeof openProviderCheckpointTestDb> | null = null
  try {
    await assert.rejects(() => fixture(t, 'lifecycle-action-gate', (value) => {
      openedDb = value.db
      const first = value.repository.requestProductInterrupt({
        action: 'close',
        aliasId: value.scopeId,
        aliasGeneration: 1,
        readyRunId: value.runId,
        codexThreadId: value.codexThreadId,
        codexTurnId: value.codexTurnId,
        requestedAt: verifiedAt,
      })
      assert.equal(first.lifecycleAction, 'close')
      assert.equal(first.lifecycleActionRequestedAt, verifiedAt)
      assert.match(first.lifecycleActionEvidenceDigest, /^[a-f0-9]{64}$/)
      assert.deepEqual(value.repository.requestProductInterrupt({
        action: 'close',
        aliasId: value.scopeId,
        aliasGeneration: 1,
        readyRunId: value.runId,
        codexThreadId: value.codexThreadId,
        codexTurnId: value.codexTurnId,
        requestedAt: closeoutAt,
      }), first)
      assert.throws(() => value.repository.requestProductInterrupt({
        action: 'reset',
        aliasId: value.scopeId,
        aliasGeneration: 1,
        readyRunId: value.runId,
        codexThreadId: value.codexThreadId,
        codexTurnId: value.codexTurnId,
        requestedAt: closeoutAt,
      }), /product_lifecycle_action_conflict/)
      assert.equal(value.repository.readLifecycleOperation({
        aliasId: value.scopeId,
        aliasGeneration: 1,
      }).requestedAction, 'close')
    }), /browser_verifier_lifecycle_action_pending/)
  } finally {
    openedDb?.close()
  }
})

test('cold recovery settles an unknown dispatch once and never reuses a later provider result', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex Browser verifier cold recovery')) return
  const value = await fixture(t, 'unknown')
  if (!value) return
  try {
    const recovered = value.repository.beginBrowserVerifierAttempt({
      readyRunId: value.runId,
      readyTaskId: value.taskId,
      readyScopeId: value.scopeId,
      readyAliasId: value.scopeId,
      aliasGeneration: 1,
      threadBindingId: value.threadBindingId,
      codexThreadId: value.begun.attempt.codexThreadId,
      codexTurnId: value.begun.attempt.codexTurnId,
      candidateDigest: value.candidateDigest,
      frozenIdentityDigest: value.begun.attempt.frozenIdentityDigest,
      upstreamProfileSnapshotRef: value.begun.attempt.upstreamProfileSnapshotRef,
      upstreamProfileSnapshotDigest: value.begun.attempt.upstreamProfileSnapshotDigest,
      workflowCloseoutSealDigest: value.begun.attempt.workflowCloseoutSealDigest,
      dispatchedAt: startedAt,
    })
    assert.equal(recovered.created, false)
    assert.equal(recovered.attempt.status, 'dispatching')
    const unknown = value.repository.settleBrowserVerifierAttempt({
      readyRunId: value.runId,
      attemptId: recovered.attempt.attemptId,
      outcome: 'result_unknown',
      verdict: {
        version: 1,
        verdict: 'block',
        gaps: [{ kind: 'text', description: '远程结果无法确认' }],
        summary: '未重复请求',
      },
      sealedCandidateDigest: null,
      verificationUsage: null,
      verifiedAt,
      settledAt: verifiedAt,
    })
    const late = value.repository.settleBrowserVerifierAttempt({
      readyRunId: value.runId,
      attemptId: recovered.attempt.attemptId,
      outcome: 'provider_unavailable',
      verdict: {
        version: 1,
        verdict: 'block',
        gaps: [{ kind: 'text', description: '迟到结果' }],
        summary: '不应覆盖',
      },
      sealedCandidateDigest: null,
      verificationUsage: null,
      verifiedAt: closeoutAt,
      settledAt: closeoutAt,
    })
    assert.equal(late.outcome, 'result_unknown')
    assert.equal(late.receiptDigest, unknown.receiptDigest)
  } finally {
    value.db.close()
  }
})
