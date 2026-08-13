import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'

import { DatabaseManager } from '../main/modules/database'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  assertCodexPendingInteractionRestartSweepComplete,
  cancelCodexPendingInteractionsWithoutRunCloseout,
  completeCodexPendingInteractionRestartInOpenTransaction,
  readCodexPendingInteractionIdentityForCard,
  scanCodexPendingInteractionsForRestart,
  settleCodexPendingInteractionsInMemoryAfterCommit,
} from '../main/modules/agent-control/codex-runtime/codex-pending-interaction-restart'
import {
  CodexProductCloseoutExpectationGuard,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { AgentSessionCheckpointRepository } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  _resetAskUserQuestionsStoreForTests,
  getAskUserQuestionsStore,
} from '../main/modules/tools/builtins/ask-user-questions-store'
import { FrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-store'
import {
  _resetFrozenCallBridgeForTests,
  registerFrozenCallStore,
} from '../main/modules/agent-control/safety/frozen-call-bridge'
import {
  providerCheckpointExecutionBinding as executionBinding,
  providerCheckpointPreparedSkill as preparedSkill,
} from './provider-checkpoint-test-fixtures'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const admittedAt = '2026-08-11T02:00:00.000Z'
const restartAt = '2026-08-11T02:05:00.000Z'

type SeededRun = {
  scopeId: string
  runId: string
  taskId: string
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  browserTaskId: string
}

function prepared(input: {
  scopeId: string
  runId: string
  taskId: string
  sourceMessageId: string
}): PreparedCodexProductRun {
  return {
    preparationContract: 'codex_product_run_e1',
    taskId: input.taskId,
    runId: input.runId,
    conversationAlias: { aliasId: input.scopeId, aliasGeneration: 1 },
    ingressBinding: {
      requestId: input.runId,
      reservationSetId: `reservation-set-${input.runId}`,
      reservationEvidenceDigest: `reservation-evidence-${input.runId}`,
    },
    ingress: {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: input.sourceMessageId,
      canonicalCurrentInputRef: {
        messageId: input.sourceMessageId,
        input: [{ type: 'text', text: '查询天气', text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    },
    resourceAnchorDigest: digestCanonicalJson({
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    }),
    recoveredContextDigest: null,
    ...createCodexToolFixture([]),
    readyToolHostIdentity: {
      scopeId: input.scopeId,
      aliasId: input.scopeId,
      authorizationOwnerId: `authorization-${input.runId}`,
      resourceOwnerId: `resource-${input.runId}`,
    },
    productBudgetSeed: { maxIterations: 9, maxToolCalls: 8, maxParallelToolGroups: 1 },
    neutralProjectionSeed: {
      phase: 'planning',
      taskTitle: '正在理解需求',
      taskSummary: '正在整理任务边界、资源与可用能力',
    },
  }
}

async function seedRun(input: {
  database: DatabaseManager
  bindings: CodexBindingRepository
  checkpoints: AgentSessionCheckpointRepository
  projections: TaskProjectionRepository
  index: number
  scopeId: string
  runId: string
}): Promise<SeededRun> {
  const db = input.database.getRawDb()
  assert.ok(db)
  const taskId = `task-${input.runId}`
  const sourceMessageId = `message-${input.runId}`
  const threadBindingId = `thread-binding-${input.runId}`
  const codexThreadId = `thread-${input.runId}`
  const codexTurnId = `turn-${input.runId}`
  const ownerBinding = executionBinding(input.runId)
  const run = prepared({
    scopeId: input.scopeId,
    runId: input.runId,
    taskId,
    sourceMessageId,
  })
  const reservation: StartIdentityReservationSet = {
    reservationSetId: run.ingressBinding.reservationSetId,
    scopeId: input.scopeId,
    existingThread: false,
    members: [
      { method: 'thread/start', reservationId: `thread-reservation-${input.runId}` },
      { method: 'turn/start', reservationId: `turn-reservation-${input.runId}` },
    ],
    reservationEvidenceDigest: run.ingressBinding.reservationEvidenceDigest,
  }
  db.prepare(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, handoff_generation, title, source_kind, source_id,
      thread_key, meta_json, created_at, updated_at
    ) VALUES (?, 'butler', 'butler', 0, ?, 'local', 'app', ?, '{}', ?, ?)
  `).run(input.scopeId, input.scopeId, input.scopeId, admittedAt, admittedAt)
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
    VALUES (?, ?, 'user', '查询天气', ?, '{}', 0)
  `).run(sourceMessageId, input.scopeId, admittedAt)
  input.projections.create({
    taskId,
    scopeId: input.scopeId,
    messageVisibilityEpoch: 0,
    runId: input.runId,
    taskType: 'direct_answer',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'confirmation',
    steps: [],
    ownerAgentId: 'butler',
    taskOrigin: 'user_root',
    executionBinding: ownerBinding,
    createdAt: admittedAt,
    updatedAt: admittedAt,
  })
  new RunMetaRepository(db).create({
    runId: input.runId,
    taskId,
    scopeId: input.scopeId,
    messageVisibilityEpoch: 0,
    agentId: 'butler',
    executionBinding: ownerBinding,
    status: 'running',
  }, Date.parse(admittedAt))
  input.bindings.createEmptyAliasGeneration({
    threadBindingId,
    aliasId: input.scopeId,
    aliasGeneration: 1,
    readyScopeId: input.scopeId,
    runtimeManifestDigest: `runtime-${input.runId}`,
    protocolSchemaDigest: `protocol-${input.runId}`,
    createdAt: admittedAt,
  })
  const admissionBase = {
    prepared: run,
    reservation,
    ownerMainBootId: 'old-main-boot',
    admittedAt,
    ingressAdmittedRevision: 1,
    threadBindingId,
    isolatedThreadCwd: `/tmp/ready-codex/${threadBindingId}`,
    turnRequestId: `turn-request-${input.runId}`,
    runtimeManifestDigest: `runtime-${input.runId}`,
    protocolSchemaDigest: `protocol-${input.runId}`,
    instructionContractDigest: `instructions-${input.runId}`,
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: `profile-ref-${input.runId}`,
    upstreamProfileSnapshotDigest: `profile-digest-${input.runId}`,
    additionalContextDigest: digestCanonicalJson([]),
    turnContractDigest: `turn-contract-${input.runId}`,
    messageVisibilityEpoch: 0,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: '查询天气',
      messageTimestamp: admittedAt,
      messageMetaDigest: digestCanonicalJson({}),
      executionBindingDigest: digestCanonicalJson(ownerBinding),
    },
  }
  const admission: CodexAdmittedBindingInput = {
    ...admissionBase,
    ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionBase),
  }
  input.bindings.admitProductBindings(admission)
  const threadRpcId = input.index * 2 + 1
  const turnRpcId = threadRpcId + 1
  const connectionEpoch = `epoch-${input.runId}`
  input.bindings.activateStartDispatch({
    connectionEpoch,
    rpcId: threadRpcId,
    method: 'thread/start',
    bindingLookupKey: admissionBase.isolatedThreadCwd,
    requestDigest: `thread-request-${input.runId}`,
    dispatchedAt: admittedAt,
  })
  const nativeThread: CodexThread = {
    id: codexThreadId,
    sessionId: codexThreadId,
    parentThreadId: null,
    forkedFromId: null,
    cwd: admissionBase.isolatedThreadCwd,
    source: 'vscode',
    threadSource: null,
    modelProvider: 'ready_gateway',
    cliVersion: '0.146.1',
    createdAt: Date.parse(admittedAt),
    ephemeral: false,
    preview: '',
    status: { type: 'idle' },
    updatedAt: Date.parse(admittedAt),
    turns: [],
  }
  input.bindings.reconcileStartAccepted({
    connectionEpoch,
    rpcId: threadRpcId,
    method: 'thread/start',
    bindingId: threadBindingId,
    nativeId: codexThreadId,
    nativeResult: { thread: nativeThread, instructionSources: [] },
    responseDigest: `thread-response-${input.runId}`,
    responsePending: false,
    reconciledAt: admittedAt,
  })
  input.bindings.activateStartDispatch({
    connectionEpoch,
    rpcId: turnRpcId,
    method: 'turn/start',
    bindingLookupKey: input.runId,
    requestDigest: `turn-request-${input.runId}`,
    dispatchedAt: admittedAt,
  })
  input.bindings.reconcileStartAccepted({
    connectionEpoch,
    rpcId: turnRpcId,
    method: 'turn/start',
    bindingId: input.runId,
    nativeId: codexTurnId,
    nativeResult: { turn: { id: codexTurnId, items: [], status: 'inProgress', error: null } },
    responseDigest: `turn-response-${input.runId}`,
    responsePending: false,
    reconciledAt: admittedAt,
  })
  const route = await input.checkpoints.bindBrowserWorkflowRoute({
    parentTaskId: taskId,
    ownerRunId: input.runId,
    sourceMessageId,
    executionBinding: ownerBinding,
    now: admittedAt,
  })
  const sourceItems = [{ role: 'user', content: '查询天气' } as AgentInputItem]
  await input.checkpoints.writeCleanBoundary({
    parentTaskId: taskId,
    browserTaskId: route.browserTaskId,
    ownerRunId: input.runId,
    sourceItems,
    sdkSourceItems: sourceItems,
    sdkSourceItemCount: sourceItems.length,
    sdkSourcePrefixDigest: workflowDigest(sourceItems),
    preparedSkill: preparedSkill(),
    activatedCapabilityGroups: ['browser'],
    now: admittedAt,
  })
  return {
    scopeId: input.scopeId,
    runId: input.runId,
    taskId,
    threadBindingId,
    codexThreadId,
    codexTurnId,
    browserTaskId: route.browserTaskId,
  }
}

function insertAskCard(input: {
  database: DatabaseManager
  cardId: string
  run: SeededRun
  lifecycleType: 'ask_user_questions' | 'action_confirmation'
  requestId?: string | null
  codexIdentity?: unknown
}): void {
  const db = input.database.getRawDb()
  assert.ok(db)
  const repository = new CodexBindingRepository(db)
  const requestId = input.requestId === undefined ? input.run.runId : input.requestId
  const identity = input.codexIdentity === undefined
    ? readCodexPendingInteractionIdentityForCard({
        repository,
        readyRunId: requestId,
        scopeId: input.run.scopeId,
      })
    : input.codexIdentity
  const questions = input.lifecycleType === 'action_confirmation'
    ? [{ id: 'frozen_call_confirm', question: '确认执行', kind: 'single_choice', options: ['确认执行', '取消'] }]
    : [{ id: 'city', question: '查询哪个城市？', kind: 'free_text' }]
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
    VALUES (?, ?, 'agent_card', '等待用户回答', ?, ?, 0)
  `).run(
    input.cardId,
    input.run.scopeId,
    new Date(Date.parse(admittedAt) + 1_000).toISOString(),
    JSON.stringify({
      askUserQuestions: {
        cardId: input.cardId,
        status: 'pending',
        questions,
        askedAt: Date.parse(admittedAt) + 1_000,
        scopeId: input.run.scopeId,
        requestId,
        lifecycleType: input.lifecycleType,
        codexRunIdentity: identity,
      },
    }),
  )
}

test('cold restart atomically cancels action/ask-user cards and only their exact Codex runs', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-pending-interaction-restart-native')) return
  const database = new DatabaseManager(true)
  const db = database.getRawDb()
  assert.ok(db)
  const bindings = new CodexBindingRepository(db)
  const expectations = new CodexProductCloseoutExpectationGuard()
  const participant = {
    complete(closeout: { readyRunId: string; productTerminalDigest: string; closeoutAt: string }) {
      const failure = expectations.readRecoveryFailure(closeout.readyRunId)
      assert.ok(failure)
      const result = bindings.completeRecoveryFailureCloseoutInOpenTransaction({
        ...closeout,
        recoveryFailureCode: failure.code,
        recoveryFailureEvidenceDigest: failure.evidenceDigest,
      })
      assert.equal(result.handled, true)
      assert.ok(failure.pendingInteractionRestart)
      completeCodexPendingInteractionRestartInOpenTransaction({
        db,
        plan: failure.pendingInteractionRestart,
        readyRunId: closeout.readyRunId,
        closeoutAt: closeout.closeoutAt,
        recoveryEvidenceDigest: failure.evidenceDigest,
      })
    },
  }
  const checkpoints = new AgentSessionCheckpointRepository(database, participant)
  const projections = new TaskProjectionRepository(database)
  try {
    const actionRun = await seedRun({
      database, bindings, checkpoints, projections, index: 0,
      scopeId: 'scope-action', runId: 'run-action',
    })
    const askRun = await seedRun({
      database, bindings, checkpoints, projections, index: 1,
      scopeId: 'scope-ask', runId: 'run-ask',
    })
    const newRun = await seedRun({
      database, bindings, checkpoints, projections, index: 2,
      scopeId: 'scope-new', runId: 'run-new',
    })
    const terminalRun = await seedRun({
      database, bindings, checkpoints, projections, index: 3,
      scopeId: 'scope-terminal', runId: 'run-terminal',
    })

    db.prepare(`
      INSERT INTO pending_confirmations (
        id, run_id, task_id, scope_id, tool_name, params_json,
        created_at, expires_at, status
      ) VALUES (?, ?, ?, ?, 'external_send', ?, ?, ?, 'pending')
    `).run(
      'frozen-action', actionRun.runId, actionRun.taskId, actionRun.scopeId,
      JSON.stringify({ __audit: 'redacted', sha256: 'action-params' }),
      admittedAt, '2026-08-11T02:10:00.000Z',
    )
    insertAskCard({
      database,
      cardId: 'card-action',
      run: actionRun,
      lifecycleType: 'action_confirmation',
    })
    insertAskCard({
      database,
      cardId: 'card-ask',
      run: askRun,
      lifecycleType: 'ask_user_questions',
    })
    const wrongIdentity = readCodexPendingInteractionIdentityForCard({
      repository: bindings,
      readyRunId: actionRun.runId,
      scopeId: actionRun.scopeId,
    })
    const newRunIdentity = readCodexPendingInteractionIdentityForCard({
      repository: bindings,
      readyRunId: newRun.runId,
      scopeId: newRun.scopeId,
    })
    insertAskCard({
      database,
      cardId: 'card-stale-wrong-run',
      run: newRun,
      lifecycleType: 'ask_user_questions',
      codexIdentity: wrongIdentity,
    })
    insertAskCard({
      database,
      cardId: 'card-missing-exact-identity',
      run: newRun,
      lifecycleType: 'ask_user_questions',
      codexIdentity: null,
    })
    insertAskCard({
      database,
      cardId: 'card-terminal-run',
      run: terminalRun,
      lifecycleType: 'ask_user_questions',
    })
    db.prepare(`
      UPDATE run_meta SET status = 'done', terminal_reason = 'completed'
       WHERE run_id = ?
    `).run(terminalRun.runId)
    insertAskCard({
      database,
      cardId: 'card-unbound',
      run: newRun,
      lifecycleType: 'ask_user_questions',
      requestId: null,
      codexIdentity: newRunIdentity,
    })
    insertAskCard({
      database,
      cardId: 'card-non-codex-live',
      run: newRun,
      lifecycleType: 'ask_user_questions',
      requestId: 'run-non-codex-live',
      codexIdentity: null,
    })
    db.prepare(`
      INSERT INTO pending_confirmations (
        id, run_id, task_id, scope_id, tool_name, params_json,
        created_at, expires_at, status
      ) VALUES ('frozen-non-codex-live', 'run-non-codex-live', 'task-non-codex-live',
                'scope-non-codex-live', 'external_send', '{}', ?, ?, 'pending')
    `).run(admittedAt, '2026-08-11T02:10:00.000Z')

    const scan = scanCodexPendingInteractionsForRestart({
      db,
      repository: bindings,
      cancelledAt: restartAt,
    })
    assert.deepEqual(
      scan.closeoutPlans.map((plan) => plan.readyRunId).sort(),
      [actionRun.runId, askRun.runId].sort(),
    )
    assert.deepEqual(scan.cancelOnly.map((entry) => entry.interactionId).sort(), [
      'card-missing-exact-identity',
      'card-stale-wrong-run',
      'card-terminal-run',
      'card-unbound',
    ])
    assert.throws(
      () => assertCodexPendingInteractionRestartSweepComplete({
        db,
        repository: bindings,
        cancelledAt: restartAt,
      }),
      /codex_pending_interaction_restart_sweep_incomplete/,
    )

    for (const plan of scan.closeoutPlans) {
      const token = expectations.acquireRecoveryFailure(plan.readyRunId, {
        code: 'codex_pending_interaction_cancelled_app_restart',
        evidenceDigest: plan.evidenceDigest,
        pendingInteractionRestart: plan,
      })
      const product = bindings.readProductTurnRuntime(plan.readyRunId)
      try {
        await checkpoints.commitCodexFailureCoreCloseout({
          parentTaskId: product.readyTaskId,
          ownerRunId: product.readyRunId,
          conversationId: product.readyScopeId,
          status: 'interrupted',
          terminalReason: 'cancelled_runtime',
          initiator: 'codex_recovery',
          durationMs: 1,
          taskType: 'direct_answer',
          module: 'system',
          error: 'codex_pending_interaction_cancelled_app_restart',
          now: restartAt,
        })
      } finally {
        expectations.release(plan.readyRunId, token)
      }
    }
    cancelCodexPendingInteractionsWithoutRunCloseout({
      db,
      interactions: scan.cancelOnly,
      cancelledAt: restartAt,
    })
    assert.doesNotThrow(() => assertCodexPendingInteractionRestartSweepComplete({
      db,
      repository: bindings,
      cancelledAt: restartAt,
    }))

    for (const run of [actionRun, askRun]) {
      assert.deepEqual(
        db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(run.runId),
        { status: 'interrupted', terminal_reason: 'cancelled_runtime' },
      )
      assert.equal(
        db.prepare('SELECT status FROM task_projections WHERE task_id = ?')
          .get<{ status: string }>(run.taskId)?.status,
        'killed',
      )
      assert.equal(
        db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
          .get<{ status: string }>(run.browserTaskId)?.status,
        'cancelled',
      )
      const codex = db.prepare(`
        SELECT recovery_failure_code, product_terminal_digest, fence_release_revision
          FROM codex_turn_bindings WHERE ready_run_id = ?
      `).get<{
        recovery_failure_code: string | null
        product_terminal_digest: string | null
        fence_release_revision: number | null
      }>(run.runId)
      assert.equal(codex?.recovery_failure_code, 'codex_pending_interaction_cancelled_app_restart')
      assert.ok(codex?.product_terminal_digest)
      assert.equal(codex?.fence_release_revision, 2)
    }
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
                   WHERE owner_ready_run_id IN (?, ?)`)
        .get<{ count: number }>(actionRun.runId, askRun.runId)?.count,
      0,
    )
    const frozen = db.prepare(`
      SELECT status, params_json, released_at
        FROM pending_confirmations WHERE id = 'frozen-action'
    `).get<{ status: string; params_json: string; released_at: string | null }>()
    assert.equal(frozen?.status, 'expired')
    assert.equal(frozen?.released_at, null)
    assert.equal(JSON.parse(frozen?.params_json || '{}').restartCancellation.reason, 'app_restart')
    for (const cardId of [
      'card-action',
      'card-ask',
      'card-missing-exact-identity',
      'card-stale-wrong-run',
      'card-terminal-run',
      'card-unbound',
    ]) {
      const row = db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?')
        .get<{ meta_json: string }>(cardId)
      const card = JSON.parse(row?.meta_json || '{}').askUserQuestions
      assert.equal(card.status, 'cancelled')
      assert.equal(card.cancelReason, 'app_restart')
      assert.match(card.cancellationEvidenceDigest, /^[a-f0-9]{64}$/)
    }

    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(newRun.runId),
      { status: 'running', terminal_reason: null },
    )
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
                   WHERE owner_ready_run_id = ?`)
        .get<{ count: number }>(newRun.runId)?.count,
      1,
    )
    assert.equal(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
        .get<{ status: string }>(newRun.browserTaskId)?.status,
      'running',
    )
    const nonCodexCard = JSON.parse(db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?')
      .get<{ meta_json: string }>('card-non-codex-live')?.meta_json || '{}').askUserQuestions
    assert.equal(nonCodexCard.status, 'pending')
    assert.equal(
      db.prepare('SELECT status FROM pending_confirmations WHERE id = ?')
        .get<{ status: string }>('frozen-non-codex-live')?.status,
      'pending',
    )
    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?')
        .get(terminalRun.runId),
      { status: 'done', terminal_reason: 'completed' },
    )
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
                   WHERE owner_ready_run_id = ?`)
        .get<{ count: number }>(terminalRun.runId)?.count,
      1,
    )
  } finally {
    database.close()
  }
})

test('restart closeout rollback leaves no half state before card-only fail-closed cancellation', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-pending-interaction-restart-rollback-native')) return
  const database = new DatabaseManager(true)
  const db = database.getRawDb()
  assert.ok(db)
  const bindings = new CodexBindingRepository(db)
  const expectations = new CodexProductCloseoutExpectationGuard()
  const checkpoints = new AgentSessionCheckpointRepository(database, {
    complete(closeout) {
      const failure = expectations.readRecoveryFailure(closeout.readyRunId)
      assert.ok(failure)
      const result = bindings.completeRecoveryFailureCloseoutInOpenTransaction({
        ...closeout,
        recoveryFailureCode: failure.code,
        recoveryFailureEvidenceDigest: failure.evidenceDigest,
      })
      assert.equal(result.handled, true)
      throw new Error('injected_restart_participant_failure')
    },
  })
  const projections = new TaskProjectionRepository(database)
  _resetAskUserQuestionsStoreForTests()
  _resetFrozenCallBridgeForTests()
  try {
    const run = await seedRun({
      database, bindings, checkpoints, projections, index: 9,
      scopeId: 'scope-rollback', runId: 'run-rollback',
    })
    const frozenStore = new FrozenCallStore(db, { now: () => Date.parse(admittedAt) })
    registerFrozenCallStore(frozenStore)
    const frozen = frozenStore.freeze({
      toolName: 'external_send',
      params: { message: 'rollback-test' },
      runId: run.runId,
      taskId: run.taskId,
      scopeId: run.scopeId,
      sessionId: run.scopeId,
    })
    if (!frozen.ok) assert.fail(`failed to freeze rollback fixture: ${frozen.reason}`)
    insertAskCard({
      database,
      cardId: 'card-rollback',
      run,
      lifecycleType: 'action_confirmation',
    })
    let askRejected = 0
    const askStore = getAskUserQuestionsStore()
    askStore.register({
      cardId: 'card-rollback',
      sessionId: run.scopeId,
      conversationId: run.scopeId,
      scopeId: run.scopeId,
      agent: 'butler',
      requestId: run.runId,
      responsePolicy: 'local_renderer_only',
      lifecycleType: 'action_confirmation',
      questions: [{
        id: 'frozen_call_confirm',
        question: '确认执行',
        kind: 'single_choice',
        options: ['确认执行', '取消'],
        required: true,
      }],
      askedAt: Date.parse(admittedAt) + 1_000,
      resolve() {},
      reject() { askRejected += 1 },
      timeoutHandle: setTimeout(() => undefined, 60_000),
    })
    const scan = scanCodexPendingInteractionsForRestart({
      db,
      repository: bindings,
      cancelledAt: restartAt,
    })
    assert.equal(scan.closeoutPlans.length, 1)
    const plan = scan.closeoutPlans[0]
    const token = expectations.acquireRecoveryFailure(plan.readyRunId, {
      code: 'codex_pending_interaction_cancelled_app_restart',
      evidenceDigest: plan.evidenceDigest,
      pendingInteractionRestart: plan,
    })
    try {
      await assert.rejects(
        checkpoints.commitCodexFailureCoreCloseout({
          parentTaskId: run.taskId,
          ownerRunId: run.runId,
          conversationId: run.scopeId,
          status: 'interrupted',
          terminalReason: 'cancelled_runtime',
          initiator: 'codex_recovery',
          durationMs: 1,
          taskType: 'direct_answer',
          module: 'system',
          error: 'codex_pending_interaction_cancelled_app_restart',
          now: restartAt,
        }),
        /injected_restart_participant_failure/,
      )
    } finally {
      expectations.release(plan.readyRunId, token)
    }
    assert.equal(
      db.prepare('SELECT status FROM run_meta WHERE run_id = ?')
        .get<{ status: string }>(run.runId)?.status,
      'running',
    )
    assert.equal(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
        .get<{ status: string }>(run.browserTaskId)?.status,
      'running',
    )
    assert.equal(bindings.readProductCloseout(run.runId), null)
    assert.equal(
      db.prepare('SELECT status FROM pending_confirmations WHERE id = ?')
        .get<{ status: string }>(frozen.id)?.status,
      'pending',
    )
    const pendingCard = JSON.parse(db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?')
      .get<{ meta_json: string }>('card-rollback')?.meta_json || '{}').askUserQuestions
    assert.equal(pendingCard.status, 'pending')
    assert.equal(askStore.has('card-rollback'), true)
    assert.equal(frozenStore.get(frozen.id)?.status, 'pending')
    assert.equal(askRejected, 0)
    assert.throws(
      () => assertCodexPendingInteractionRestartSweepComplete({
        db,
        repository: bindings,
        cancelledAt: restartAt,
      }),
      /codex_pending_interaction_restart_sweep_incomplete/,
    )

    db.exec(`
      CREATE TEMP TRIGGER fail_pending_interaction_fallback
      BEFORE UPDATE OF status ON pending_confirmations
      WHEN OLD.id = '${frozen.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected_pending_interaction_fallback_failure');
      END;
    `)
    assert.throws(
      () => cancelCodexPendingInteractionsWithoutRunCloseout({
        db,
        interactions: plan.interactions,
        cancelledAt: restartAt,
        disposition: 'run_closeout_failed',
      }),
      /injected_pending_interaction_fallback_failure/,
    )
    assert.throws(
      () => assertCodexPendingInteractionRestartSweepComplete({
        db,
        repository: bindings,
        cancelledAt: restartAt,
      }),
      /codex_pending_interaction_restart_sweep_incomplete/,
    )
    db.exec('DROP TRIGGER fail_pending_interaction_fallback')

    cancelCodexPendingInteractionsWithoutRunCloseout({
      db,
      interactions: plan.interactions,
      cancelledAt: restartAt,
      disposition: 'run_closeout_failed',
    })
    const settledMemory = settleCodexPendingInteractionsInMemoryAfterCommit(plan.interactions)
    assert.deepEqual(settledMemory, { askUserQuestions: 1, frozenCalls: 1 })
    assert.doesNotThrow(() => assertCodexPendingInteractionRestartSweepComplete({
      db,
      repository: bindings,
      cancelledAt: restartAt,
    }))
    assert.equal(
      db.prepare('SELECT status FROM run_meta WHERE run_id = ?')
        .get<{ status: string }>(run.runId)?.status,
      'running',
    )
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
                   WHERE owner_ready_run_id = ?`)
        .get<{ count: number }>(run.runId)?.count,
      1,
    )
    assert.equal(
      db.prepare('SELECT status FROM pending_confirmations WHERE id = ?')
        .get<{ status: string }>(frozen.id)?.status,
      'expired',
    )
    const cancelledCard = JSON.parse(db.prepare('SELECT meta_json FROM chat_messages WHERE id = ?')
      .get<{ meta_json: string }>('card-rollback')?.meta_json || '{}').askUserQuestions
    assert.equal(cancelledCard.status, 'cancelled')
    assert.equal(cancelledCard.cancelReason, 'app_restart')
    assert.equal(cancelledCard.cancelDisposition, 'run_closeout_failed')
    assert.equal(askRejected, 1)
    assert.equal(askStore.has('card-rollback'), false)
    assert.equal(askStore.findPendingForSession(run.scopeId), null)
    assert.equal(askStore.resolve('card-rollback', { answers: [], answeredAt: Date.now() }), false)
    assert.deepEqual(frozenStore.release(frozen.id, frozen.token), {
      ok: false,
      reason: 'not_pending',
    })
    assert.equal(frozenStore.freeze({
      toolName: 'external_send',
      params: { message: 'new-interaction' },
      runId: 'run-after-restart',
      taskId: 'task-after-restart',
      scopeId: run.scopeId,
      sessionId: run.scopeId,
    }).ok, true)
  } finally {
    _resetAskUserQuestionsStoreForTests()
    _resetFrozenCallBridgeForTests()
    database.close()
  }
})
