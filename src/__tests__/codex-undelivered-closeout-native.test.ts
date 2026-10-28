import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DatabaseManager } from '../main/modules/database'
import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { AgentSessionCheckpointRepository } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { resolveReadyActionObligationSet } from '../main/modules/agent-control/codex-runtime/codex-action-obligation'
import { createCodexUpstreamProfileSnapshot, digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import {
  createCodexRuntimeComposition,
  type ReadyClosedCodexProductRun,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import type { CodexRuntimeHostPort } from '../main/modules/agent-control/codex-runtime/codex-runtime-composition'
import type { CoreTurnCandidate } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import { providerCheckpointExecutionBinding as executionBinding } from './provider-checkpoint-test-fixtures'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// 2026-10-05: a completed turn that never did what it owed (a declared file, a product action) kept its live
// closeout retrying for ten minutes; the receipts it waited for could never arrive.
test('a completed turn that skipped its owed action closes as not delivered instead of waiting', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-undelivered-closeout-native')) return
  const appPath = fileURLToPath(new URL('../..', import.meta.url))
  const userDataPath = mkdtempSync(join(tmpdir(), 'ready-codex-undelivered-closeout-'))
  const database = new DatabaseManager(true)
  const db = database.getRawDb()
  assert.ok(db)
  const composition = createCodexRuntimeComposition({
    appPath,
    resourcesPath: appPath,
    userDataPath,
    isPackaged: false,
    database,
    settings: new AppSettingsRepository(() => database),
    async requestRendererToolAction() { throw new Error('unexpected_renderer_tool_action') },
    providerReadiness: { async ensureReady() {} },
  })
  let unsubscribe = () => undefined
  let waiterTimeout: ReturnType<typeof setTimeout> | null = null
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => { metrics.push(event) })
  t.after(() => { __setMetricSinkForTests(null) })
  try {
    const scopeId = 'scope-codex-undelivered'
    const parentTaskId = 'task-codex-undelivered'
    const ownerRunId = 'run-codex-undelivered'
    const sourceMessageId = 'message-codex-undelivered'
    const threadBindingId = 'thread-binding-codex-undelivered'
    const codexThreadId = 'thread-codex-undelivered'
    const codexTurnId = 'turn-codex-undelivered'
    const startedAt = '2026-10-05T12:34:26.000Z'
    const ownerBinding = executionBinding(ownerRunId)
    const userText = '把这句话贴到宠物便利贴上'
    const prepared: PreparedCodexProductRun = {
      preparationContract: 'codex_product_run_e2',
      sourceTrustedEnvironmentRef: { workbenchMode: 'document', environmentDigest: 'e'.repeat(64) },
      readyMemorySnapshot: disabledReadyMemorySnapshot(),
      taskId: parentTaskId,
      runId: ownerRunId,
      conversationAlias: { aliasId: scopeId, aliasGeneration: 1 },
      ingressBinding: {
        requestId: `request-${ownerRunId}`,
        reservationSetId: `reservation-set-${ownerRunId}`,
        reservationEvidenceDigest: `reservation-evidence-${ownerRunId}`,
      },
      ingress: {
        kind: 'user_ingress',
        attemptKind: 'user_ingress',
        originUserMessageId: sourceMessageId,
        canonicalCurrentInputRef: { messageId: sourceMessageId, input: [{ type: 'text', text: userText, text_elements: [] }] },
        explicitResourceEnvelope: { input: [], resourceRefs: [] },
        resourceAdditionalContext: [],
      },
      resourceAnchorDigest: createHash('sha256').update(JSON.stringify({
        explicitResourceEnvelope: { input: [], resourceRefs: [] },
        resourceAdditionalContext: [],
      })).digest('hex'),
      ...createCodexToolFixture(['pet_show_sticky_note']),
      actionObligations: resolveReadyActionObligationSet({
        intent: { primaryDomain: 'pet', actionSignals: ['pet-show-action'] },
        allowedToolNames: ['pet_show_sticky_note'],
        primaryInstruction: userText,
      }),
      readyToolHostIdentity: {
        scopeId,
        aliasId: scopeId,
        authorizationOwnerId: 'authorization-owner-undelivered',
        resourceOwnerId: 'resource-owner-undelivered',
      },
      productBudgetSeed: {
        maxIterations: 9, maxToolCalls: 8, maxParallelToolGroups: 1,
        lanes: {
          ordinary: { maxIterations: 8, maxToolCalls: 8, maxParallelToolGroups: 1 },
          delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
          final: { maxIterations: 1 },
        },
      },
      neutralProjectionSeed: { phase: 'planning', taskTitle: '正在理解需求', taskSummary: '正在整理任务边界、资源与可用能力' },
    }
    const reservation: StartIdentityReservationSet = {
      reservationSetId: prepared.ingressBinding.reservationSetId,
      scopeId,
      existingThread: false,
      members: [
        { method: 'thread/start', reservationId: 'thread-reservation-undelivered' },
        { method: 'turn/start', reservationId: 'turn-reservation-undelivered' },
      ],
      reservationEvidenceDigest: prepared.ingressBinding.reservationEvidenceDigest,
    }
    const scope: ConversationScope = {
      id: scopeId, agent: 'butler', activeAgentId: 'butler', handoffGeneration: 0, title: 'Codex undelivered closeout',
      sourceKind: 'local', sourceId: 'app', threadKey: scopeId, meta: {}, createdAt: startedAt, updatedAt: startedAt,
      lastMessageAt: startedAt,
    }
    db.prepare(`
      INSERT INTO chat_conversations (
        id, agent, active_agent_id, handoff_generation, title, source_kind, source_id,
        thread_key, meta_json, created_at, updated_at
      ) VALUES (?, 'butler', 'butler', 0, ?, 'local', 'app', ?, '{}', ?, ?)
    `).run(scopeId, scope.title, scopeId, startedAt, startedAt)
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
      VALUES (?, ?, 'user', ?, ?, '{}', 0)
    `).run(sourceMessageId, scopeId, userText, startedAt)
    const projections = new TaskProjectionRepository(database)
    projections.create({
      taskId: parentTaskId, scopeId, messageVisibilityEpoch: 0, runId: ownerRunId, taskType: 'direct_answer',
      module: 'system', status: 'running', interactionState: 'running', waitingFor: 'none', steps: [],
      ownerAgentId: 'butler', taskOrigin: 'user_root', executionBinding: ownerBinding, createdAt: startedAt, updatedAt: startedAt,
    })
    new RunMetaRepository(db).create({
      runId: ownerRunId, taskId: parentTaskId, scopeId, messageVisibilityEpoch: 0, agentId: 'butler',
      executionBinding: ownerBinding, status: 'running',
    }, Date.parse(startedAt))

    const runtimeManifestDigest = digestCanonicalJson({ fixture: 'undelivered-runtime' })
    const codexRepository = new CodexBindingRepository(db, {
      runtimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-undelivered',
      runtimeContinuityCatalog: { contract: 'ready_runtime_continuity_catalog_v1', targetManifestDigest: runtimeManifestDigest, transitions: [] },
    })
    const upstream = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-undelivered',
      config: {
        provider: 'openai', baseUrl: 'http://127.0.0.1:10532/v1', apiKey: 'isolated-test-key', model: 'ready-e0-model',
        agentProtocol: 'openai', wireApi: 'responses', toolUseMode: 'on', nativeVideoMode: 'off',
      },
      maxRetries: 0,
    })
    new CodexModelGatewayRepository(db).storeSnapshot({ ...upstream, snapshotRef: 'profile-ref-undelivered', createdAt: startedAt })
    codexRepository.createEmptyAliasGeneration({
      threadBindingId, aliasId: scopeId, aliasGeneration: 1, readyScopeId: scopeId, runtimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-undelivered', createdAt: startedAt,
    })
    const headProjection = projectCodexHeadActionProjection(codexRepository.readHeadActionFacts({
      aliasId: scopeId, aliasGeneration: 1, currentRuntimeManifestDigest: runtimeManifestDigest,
      currentProtocolSchemaDigest: 'protocol-schema-undelivered',
    }))
    prepared.ingress.actionAdmissionRef = {
      headProjectionDigest: headProjection.evidenceDigest,
      actionProjectionVersion: headProjection.actionProjectionVersion,
      actionHeadIdentity: headProjection.actionHeadIdentity!,
    }
    prepared.ingress.uncommittedTailAssignments = []
    prepared.ingress.supersededUncommittedItems = []
    const admissionInput = {
      prepared, reservation, ownerMainBootId: 'main-boot-undelivered', admittedAt: startedAt, ingressAdmittedRevision: 1,
      threadBindingId, isolatedThreadCwd: `/tmp/ready-codex/${threadBindingId}`, turnRequestId: 'turn-request-undelivered',
      runtimeManifestDigest, protocolSchemaDigest: 'protocol-schema-undelivered',
      instructionContractDigest: 'instruction-contract-undelivered', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-undelivered', upstreamProfileSnapshotDigest: upstream.snapshotDigest,
      additionalContextDigest: digestCanonicalJson([]), turnContractDigest: 'turn-contract-undelivered',
      messageVisibilityEpoch: 0,
      readyParentReceipt: {
        messageRole: 'user' as const, messageContent: userText, messageTimestamp: startedAt,
        messageMetaDigest: digestCanonicalJson({}), executionBindingDigest: digestCanonicalJson(ownerBinding),
      },
      continuationCandidate: null,
    }
    const admission: CodexAdmittedBindingInput = { ...admissionInput, ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionInput) }
    codexRepository.admitProductBindings(admission)
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-undelivered', rpcId: 1, method: 'thread/start', bindingLookupKey: admissionInput.isolatedThreadCwd,
      requestDigest: 'thread-request-undelivered', dispatchedAt: startedAt,
    })
    const nativeThread: CodexThread = {
      id: codexThreadId, sessionId: codexThreadId, historyMode: 'paginated', parentThreadId: null, forkedFromId: null,
      cwd: admissionInput.isolatedThreadCwd,
      source: 'vscode', threadSource: null, modelProvider: 'ready_gateway', cliVersion: '0.149.0', createdAt: Date.parse(startedAt),
      ephemeral: false, preview: '', status: { type: 'idle' }, updatedAt: Date.parse(startedAt), turns: [],
    }
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-undelivered', rpcId: 1, method: 'thread/start', bindingId: threadBindingId, nativeId: codexThreadId,
      nativeResult: { thread: nativeThread, instructionSources: [] }, responseDigest: 'thread-response-undelivered',
      responsePending: false, reconciledAt: startedAt,
    })
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-undelivered', rpcId: 2, method: 'turn/start', bindingLookupKey: ownerRunId,
      requestDigest: 'turn-request-undelivered', dispatchedAt: startedAt,
    })
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-undelivered', rpcId: 2, method: 'turn/start', bindingId: ownerRunId, nativeId: codexTurnId,
      nativeResult: { turn: { id: codexTurnId, items: [], status: 'inProgress', error: null } },
      responseDigest: 'turn-response-undelivered', responsePending: false, reconciledAt: startedAt,
    })

    const finalText = '已经贴好了。'
    composition.nativeRuntime.threadRead = async () => ({
      thread: {
        ...nativeThread,
        turns: [{
          id: codexTurnId,
          items: [
            { type: 'userMessage', id: 'item-user-undelivered', clientId: admission.turnRequestId, content: prepared.ingress.canonicalCurrentInputRef.input },
            { type: 'agentMessage', id: 'final-undelivered', text: finalText, phase: 'final_answer' },
          ],
          status: 'completed',
          error: null,
        }],
      },
    })
    const checkpoints = new AgentSessionCheckpointRepository(database, composition.canonicalCloseoutTransactionParticipant)
    const committedTexts: string[] = []
    composition.bindHost({
      runtime: { getAgentSessionCheckpointRepository: () => checkpoints },
      getScope: (id: string) => id === scopeId ? scope : null,
      getTaskProjectionStore: () => ({ get: (taskId: string) => projections.get(taskId) }),
      async commitCanonicalCoreCloseout() { throw new Error('unexpected_core_closeout') },
      async commitCodexProductTurnCloseout(input) {
        committedTexts.push(String(input.finalText))
        const committed = await checkpoints.commitCanonicalCoreCloseout(input)
        const product = codexRepository.readProductCloseout(input.ownerRunId)
        if (!product) throw new Error('test_product_closeout_missing')
        return {
          productTerminalDigest: product.productTerminalDigest,
          closeoutAt: product.productCloseoutAt,
          canonicalMessage: committed.value.canonicalMessage,
          canonicalMessageDigest: committed.value.canonicalMessageDigest,
        }
      },
    } as unknown as CodexRuntimeHostPort)

    const candidate: CoreTurnCandidate = {
      kind: 'native_terminal', readyTaskId: parentTaskId, readyRunId: ownerRunId, scopeId, codexThreadId, codexTurnId,
      engineOutcome: 'completed', candidateSelection: { kind: 'accepted', itemId: 'final-undelivered' }, candidateText: finalText,
      candidateDigest: createHash('sha256').update(finalText).digest('hex'), usedToolCalls: [], actionReceiptRefs: [],
      interactionState: null, waitingFor: null, terminalReasonCandidate: 'done', abortInitiator: null, budgetState: {},
      contextState: {}, providerDiagnostics: {}, contextUsage: null, recoveryCheckpointRef: null, browserContinuationRef: null,
      browserProofRefs: [], otherProofRefs: [], projectionPatchRefs: [],
      runtimeDiagnostics: { finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: null },
    }
    const startedWaiting = Date.now()
    const readback = await new Promise<ReadyClosedCodexProductRun>((resolve, reject) => {
      waiterTimeout = setTimeout(() => reject(new Error(`undelivered_closeout_kept_waiting:${JSON.stringify(metrics.slice(-4))}`)), 6_000)
      unsubscribe = composition.lifecycleAdapter.observeRunCloseout({
        prepared,
        expectedScopeId: scopeId,
        pending: {
          state: 'ready_closeout_pending',
          pendingKind: 'product_turn_engine_terminal_closeout_pending',
          candidate,
          recoveryEvidenceDigest: digestCanonicalJson({ ownerRunId, candidate: 'pending' }),
          error: 'codex_tool_publication_incomplete:action_obligation_missing',
        },
      }, resolve)
    })
    assert.ok(Date.now() - startedWaiting < 6_000)
    assert.equal(readback.execution.success, false)
    assert.equal(readback.execution.error, 'codex_tool_publication_incomplete:action_obligation_missing')
    assert.equal(readback.execution.terminalReason, 'blocked_external')
    assert.deepEqual(
      committedTexts,
      ['本轮没有完成：需要执行的操作没有执行。\n\n已经贴好了。'],
      'the verified note leads; the unverified answer follows it instead of being published as done',
    )
    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(ownerRunId),
      { status: 'error', terminal_reason: 'blocked_external' },
    )
    assert.ok(codexRepository.readProductCloseout(ownerRunId))
    // The user can answer the model on the same thread instead of restating the task.
    const facts = JSON.parse(String(db.prepare('SELECT terminal_facts_json FROM codex_turn_bindings WHERE ready_run_id = ?')
      .get<{ terminal_facts_json: string }>(ownerRunId)?.terminal_facts_json))
    assert.deepEqual([facts.product.terminal, facts.history.kind, facts.history.seamId],
      ['error', 'continuation_safe', 'completed_product_accepted_v1'])
    assert.deepEqual(
      db.prepare('SELECT retired_at, continuation_blocked_at FROM codex_thread_bindings WHERE thread_binding_id = ?').get(threadBindingId),
      { retired_at: null, continuation_blocked_at: null },
    )
    assert.deepEqual(codexRepository.readLiveUncommittedUserTail(threadBindingId), [], 'nothing is left to restate')
  } finally {
    if (waiterTimeout) clearTimeout(waiterTimeout)
    unsubscribe()
    await composition.stop()
    database.close()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
