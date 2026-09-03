import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import type { AgentInputItem } from '@openai/agents'
import { BrowserTargetClaimRepository, BrowserTargetClaimService } from '../main/modules/browser-engine/browser-target-claims'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { DatabaseManager } from '../main/modules/database'
import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
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
import { commitCanonicalCodexFailure } from './helpers/codex-product-closeout'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import {
  openProviderCheckpointTestDb as openDb,
  providerCheckpointExecutionBinding as executionBinding,
  providerCheckpointPreparedSkill as preparedSkill,
} from './provider-checkpoint-test-fixtures'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('Codex failed closeouts atomically end their bound Browser child and recovery state', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-user-stop-browser-child-native')) return
  const db = openDb()
  try {
    const accessor = { getRawDb: () => db }
    const projections = new TaskProjectionRepository(accessor)
    const runMeta = new RunMetaRepository(db)
    let participantInput: {
      readyRunId: string
      productTerminalDigest: string
      closeoutAt: string
    } | null = null
    const repository = new AgentSessionCheckpointRepository(accessor, {
      complete(input) {
        assert.equal(db.inTransaction, true)
        participantInput = input
      },
    })
    const parentTaskId = 'parent-codex-user-stop'
    const scopeId = 'scope-codex-user-stop'
    const ownerRunId = 'run-codex-user-stop'
    const ownerBinding = executionBinding(ownerRunId)
    const startedAt = '2026-08-11T03:00:00.000Z'
    const closeoutAt = '2026-08-11T03:01:00.000Z'
    db.prepare(`
      INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
      VALUES (?, 'butler', 'Codex user stop', ?, ?)
    `).run(scopeId, startedAt, startedAt)
    projections.create({
      taskId: parentTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      runId: ownerRunId,
      taskType: 'direct_answer',
      module: 'system',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: ownerBinding,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    runMeta.create({
      runId: ownerRunId,
      taskId: parentTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      executionBinding: ownerBinding,
      status: 'running',
    }, Date.parse(startedAt))
    const sourceMessageId = 'message-codex-user-stop'
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
      VALUES (?, ?, 'user', '查询广州天气', ?, '{}', 0)
    `).run(sourceMessageId, scopeId, startedAt)
    const route = await repository.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now: startedAt,
    })
    const sourceItems = [{ role: 'user', content: '查询广州天气' } as AgentInputItem]
    await repository.writeCleanBoundary({
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      sourceItems,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      preparedSkill: preparedSkill(),
      activatedCapabilityGroups: ['browser'],
      now: startedAt,
    })
    const claimService = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const heldClaim = claimService.acquire({
      partition: 'persist:browser',
      tabId: 'tab-codex-user-stop',
      physicalTargetToken: 'physical-codex-user-stop',
      bootIncarnationId: 'boot-codex-user-stop',
      profileId: null,
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
      messageVisibilityEpoch: 0,
    })
    if (isAgentBrowserError(heldClaim)) throw new Error(heldClaim.message)

    const closeout = await commitCanonicalCodexFailure(repository, {
      parentTaskId,
      ownerRunId,
      conversationId: scopeId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: 'user_stop',
      durationMs: 60_000,
      taskType: 'direct_answer',
      module: 'system',
      error: 'cancelled_user',
      now: closeoutAt,
    })

    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(ownerRunId),
      { status: 'interrupted', terminal_reason: 'cancelled_user' },
    )
    assert.deepEqual(
      db.prepare('SELECT status, interaction_state, waiting_for FROM task_projections WHERE task_id = ?')
        .get(parentTaskId),
      { status: 'killed', interaction_state: 'suspended', waiting_for: 'none' },
    )
    const child = db.prepare(`
      SELECT status, result_json, error, finished_at FROM browser_tasks WHERE id = ?
    `).get<{
      status: string
      result_json: string
      error: string | null
      finished_at: string
    }>(route.browserTaskId)
    assert.equal(child?.status, 'cancelled')
    assert.deepEqual(JSON.parse(child?.result_json || '{}'), {
      terminalReason: 'cancelled_user',
      canonicalMessageId: `assistant:${parentTaskId}:${ownerRunId}:terminal`,
      canonicalMessageDigest: closeout.value.productTerminalDigest,
    })
    assert.equal(child?.error, null)
    assert.equal(child?.finished_at, closeoutAt)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM agent_session_checkpoints WHERE parent_task_id = ?')
        .get<{ count: number }>(parentTaskId)?.count,
      0,
    )
    assert.equal(claimService.read(heldClaim.logicalKey)?.state, 'released')
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM chat_messages
                   WHERE conversation_id = ? AND role = 'assistant'`)
        .get<{ count: number }>(scopeId)?.count,
      1,
    )
    assert.equal(participantInput?.readyRunId, ownerRunId)
    assert.equal(participantInput?.productTerminalDigest, closeout.value.productTerminalDigest)
    assert.equal(participantInput?.closeoutAt, closeoutAt)

    const failedTaskId = 'parent-codex-recovery-failure'
    const failedRunId = 'run-codex-recovery-failure'
    const failedBinding = executionBinding(failedRunId)
    projections.create({
      taskId: failedTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      runId: failedRunId,
      taskType: 'direct_answer',
      module: 'system',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: failedBinding,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    runMeta.create({
      runId: failedRunId,
      taskId: failedTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      executionBinding: failedBinding,
      status: 'running',
    }, Date.parse(startedAt))
    const failedMessageId = 'message-codex-recovery-failure'
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
      VALUES (?, ?, 'user', '旧浏览器任务', ?, '{}', 0)
    `).run(failedMessageId, scopeId, startedAt)
    const failedRoute = await repository.bindBrowserWorkflowRoute({
      parentTaskId: failedTaskId,
      ownerRunId: failedRunId,
      sourceMessageId: failedMessageId,
      executionBinding: failedBinding,
      now: startedAt,
    })
    const noDocumentIdentity = {
      documentState: 'no_document' as const,
      tabId: null,
      physicalTargetToken: null,
      frameId: null,
      frameDocumentToken: null,
      targetRef: null,
    }
    const oldOpenAction = repository.beginBrowserWorkflowAction({
      taskId: failedRoute.browserTaskId,
      operationId: 'tabs_open',
      ownerRunId: failedRunId,
      argsDigest: 'old-weather-tab-open',
      identity: noDocumentIdentity,
    })
    repository.settleBrowserWorkflowAction(failedRoute.browserTaskId, oldOpenAction.actionId, {
      actionId: oldOpenAction.actionId,
      actionSeq: oldOpenAction.actionSeq,
      taskId: failedRoute.browserTaskId,
      ownerRunId: failedRunId,
      operationId: 'tabs_open',
      mode: 'mutate',
      dispatch: 'accepted',
      delivery: 'delivered',
      effect: 'observed',
      needsObservation: false,
      mayHaveCommitted: true,
      identity: noDocumentIdentity,
      successorIdentity: noDocumentIdentity,
    })
    assert.equal(repository.inspectWorkflowCloseout(failedTaskId).state, 'observation_required')

    await commitCanonicalCodexFailure(repository, {
      parentTaskId: failedTaskId,
      ownerRunId: failedRunId,
      conversationId: scopeId,
      status: 'error',
      terminalReason: 'blocked_external',
      initiator: 'codex_recovery',
      durationMs: 60_000,
      taskType: 'direct_answer',
      module: 'system',
      error: 'codex_browser_workflow_research_incomplete',
      now: closeoutAt,
    })
    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(failedRunId),
      { status: 'error', terminal_reason: 'blocked_external' },
    )
    assert.equal(
      db.prepare('SELECT status FROM task_projections WHERE task_id = ?')
        .get<{ status: string }>(failedTaskId)?.status,
      'failed',
    )
    assert.equal(
      db.prepare('SELECT status FROM browser_tasks WHERE id = ?')
        .get<{ status: string }>(failedRoute.browserTaskId)?.status,
      'failed',
    )
  } finally {
    db.close()
  }
})

test('production live closeout retires an observation-required Browser workflow once', async (t) => {
  if (skipIfSqliteUnavailable(t, 'codex-live-browser-closeout-native')) return
  const appPath = fileURLToPath(new URL('../..', import.meta.url))
  const userDataPath = mkdtempSync(join(tmpdir(), 'ready-codex-live-closeout-'))
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
    async requestRendererToolAction() {
      throw new Error('unexpected_renderer_tool_action')
    },
    providerReadiness: { async ensureReady() {} },
  })
  let unsubscribe = () => undefined
  let waiterTimeout: ReturnType<typeof setTimeout> | null = null
  const metricEvents: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => { metricEvents.push(event) })
  t.after(() => { __setMetricSinkForTests(null) })
  try {
    const scopeId = 'scope-codex-live-browser-closeout'
    const parentTaskId = 'task-codex-live-browser-closeout'
    const ownerRunId = 'run-codex-live-browser-closeout'
    const sourceMessageId = 'message-codex-live-browser-closeout'
    const threadBindingId = 'thread-binding-codex-live-browser-closeout'
    const codexThreadId = 'thread-codex-live-browser-closeout'
    const codexTurnId = 'turn-codex-live-browser-closeout'
    const startedAt = '2026-08-11T04:00:00.000Z'
    const ownerBinding = executionBinding(ownerRunId)
    const toolFixture = createCodexToolFixture([])
    const prepared: PreparedCodexProductRun = {
      preparationContract: 'codex_product_run_e2',
      sourceTrustedEnvironmentRef: {
        workbenchMode: 'browser',
        environmentDigest: 'e'.repeat(64),
      },
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
        canonicalCurrentInputRef: {
          messageId: sourceMessageId,
          input: [{ type: 'text', text: '查询广州天气', text_elements: [] }],
        },
        explicitResourceEnvelope: { input: [], resourceRefs: [] },
        resourceAdditionalContext: [],
      },
      resourceAnchorDigest: createHash('sha256').update(JSON.stringify({
        explicitResourceEnvelope: { input: [], resourceRefs: [] },
        resourceAdditionalContext: [],
      })).digest('hex'),
      ...toolFixture,
      readyToolHostIdentity: {
        scopeId,
        aliasId: scopeId,
        authorizationOwnerId: 'authorization-owner-live-closeout',
        resourceOwnerId: 'resource-owner-live-closeout',
      },
      productBudgetSeed: {
        maxIterations: 9, maxToolCalls: 8, maxParallelToolGroups: 1,
        lanes: {
          ordinary: { maxIterations: 8, maxToolCalls: 8, maxParallelToolGroups: 1 },
          delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
          final: { maxIterations: 1 },
        },
      },
      neutralProjectionSeed: {
        phase: 'planning',
        taskTitle: '正在理解需求',
        taskSummary: '正在整理任务边界、资源与可用能力',
      },
    }
    const reservation: StartIdentityReservationSet = {
      reservationSetId: prepared.ingressBinding.reservationSetId,
      scopeId,
      existingThread: false,
      members: [
        { method: 'thread/start', reservationId: 'thread-reservation-live-closeout' },
        { method: 'turn/start', reservationId: 'turn-reservation-live-closeout' },
      ],
      reservationEvidenceDigest: prepared.ingressBinding.reservationEvidenceDigest,
    }
    const scope: ConversationScope = {
      id: scopeId,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Codex live Browser closeout',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: scopeId,
      meta: {},
      createdAt: startedAt,
      updatedAt: startedAt,
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
      VALUES (?, ?, 'user', '查询广州天气', ?, '{}', 0)
    `).run(sourceMessageId, scopeId, startedAt)
    const projections = new TaskProjectionRepository(database)
    projections.create({
      taskId: parentTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      runId: ownerRunId,
      taskType: 'direct_answer',
      module: 'system',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: ownerBinding,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    new RunMetaRepository(db).create({
      runId: ownerRunId,
      taskId: parentTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      executionBinding: ownerBinding,
      status: 'running',
    }, Date.parse(startedAt))

    const codexRepository = new CodexBindingRepository(db)
    const upstream = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-live-closeout',
      config: {
        provider: 'openai', baseUrl: 'http://127.0.0.1:10532/v1', apiKey: 'isolated-test-key',
        model: 'ready-e0-model', agentProtocol: 'openai', wireApi: 'responses',
        toolUseMode: 'on', nativeVideoMode: 'off',
      },
      maxRetries: 0,
    })
    const gateway = new CodexModelGatewayRepository(db)
    gateway.storeSnapshot({ ...upstream, snapshotRef: 'profile-ref-live-closeout', createdAt: startedAt })
    codexRepository.createEmptyAliasGeneration({
      threadBindingId,
      aliasId: scopeId,
      aliasGeneration: 1,
      readyScopeId: scopeId,
      runtimeManifestDigest: 'runtime-manifest-live-closeout',
      protocolSchemaDigest: 'protocol-schema-live-closeout',
      createdAt: startedAt,
    })
    const headProjection = projectCodexHeadActionProjection(codexRepository.readHeadActionFacts({
      aliasId: scopeId,
      aliasGeneration: 1,
      currentRuntimeManifestDigest: 'runtime-manifest-live-closeout',
      currentProtocolSchemaDigest: 'protocol-schema-live-closeout',
    }))
    prepared.ingress.actionAdmissionRef = {
      headProjectionDigest: headProjection.evidenceDigest,
      actionProjectionVersion: headProjection.actionProjectionVersion,
      actionHeadIdentity: headProjection.actionHeadIdentity!,
    }
    prepared.ingress.uncommittedTailAssignments = []
    prepared.ingress.supersededUncommittedItems = []
    const admissionInput = {
      prepared,
      reservation,
      ownerMainBootId: 'main-boot-live-closeout',
      admittedAt: startedAt,
      ingressAdmittedRevision: 1,
      threadBindingId,
      isolatedThreadCwd: `/tmp/ready-codex/${threadBindingId}`,
      turnRequestId: 'turn-request-live-closeout',
      runtimeManifestDigest: 'runtime-manifest-live-closeout',
      protocolSchemaDigest: 'protocol-schema-live-closeout',
      instructionContractDigest: 'instruction-contract-live-closeout',
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-live-closeout',
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
      additionalContextDigest: digestCanonicalJson([]),
      turnContractDigest: 'turn-contract-live-closeout',
      messageVisibilityEpoch: 0,
      readyParentReceipt: {
        messageRole: 'user' as const,
        messageContent: '查询广州天气',
        messageTimestamp: startedAt,
        messageMetaDigest: digestCanonicalJson({}),
        executionBindingDigest: digestCanonicalJson(ownerBinding),
      },
    }
    const admission: CodexAdmittedBindingInput = {
      ...admissionInput,
      ingressAdmittedDigest: buildCodexIngressAdmittedDigest(admissionInput),
    }
    codexRepository.admitProductBindings(admission)
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-live-closeout',
      rpcId: 1,
      method: 'thread/start',
      bindingLookupKey: admissionInput.isolatedThreadCwd,
      requestDigest: 'thread-request-live-closeout',
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
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-live-closeout',
      rpcId: 1,
      method: 'thread/start',
      bindingId: threadBindingId,
      nativeId: codexThreadId,
      nativeResult: { thread: nativeThread, instructionSources: [] },
      responseDigest: 'thread-response-live-closeout',
      responsePending: false,
      reconciledAt: startedAt,
    })
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-live-closeout',
      rpcId: 2,
      method: 'turn/start',
      bindingLookupKey: ownerRunId,
      requestDigest: 'turn-request-live-closeout',
      dispatchedAt: startedAt,
    })
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-live-closeout',
      rpcId: 2,
      method: 'turn/start',
      bindingId: ownerRunId,
      nativeId: codexTurnId,
      nativeResult: { turn: { id: codexTurnId, items: [], status: 'inProgress', error: null } },
      responseDigest: 'turn-response-live-closeout',
      responsePending: false,
      reconciledAt: startedAt,
    })

    const checkpoints = new AgentSessionCheckpointRepository(
      database,
      composition.canonicalCloseoutTransactionParticipant,
    )
    const route = await checkpoints.bindBrowserWorkflowRoute({
      parentTaskId,
      ownerRunId,
      sourceMessageId,
      executionBinding: ownerBinding,
      now: startedAt,
    })
    const noDocumentIdentity = {
      documentState: 'no_document' as const,
      tabId: null,
      physicalTargetToken: null,
      frameId: null,
      frameDocumentToken: null,
      targetRef: null,
    }
    const unresolvedAction = checkpoints.beginBrowserWorkflowAction({
      taskId: route.browserTaskId,
      operationId: 'tabs_open',
      ownerRunId,
      argsDigest: 'weather-tab-open-live-closeout',
      identity: noDocumentIdentity,
    })
    checkpoints.settleBrowserWorkflowAction(route.browserTaskId, unresolvedAction.actionId, {
      actionId: unresolvedAction.actionId,
      actionSeq: unresolvedAction.actionSeq,
      taskId: route.browserTaskId,
      ownerRunId,
      operationId: 'tabs_open',
      mode: 'mutate',
      dispatch: 'accepted',
      delivery: 'delivered',
      effect: 'observed',
      needsObservation: false,
      mayHaveCommitted: true,
      identity: noDocumentIdentity,
      successorIdentity: noDocumentIdentity,
    })
    assert.equal(checkpoints.inspectWorkflowCloseout(parentTaskId).state, 'observation_required')
    const claimService = new BrowserTargetClaimService(new BrowserTargetClaimRepository(database))
    const heldClaim = claimService.acquire({
      partition: 'persist:browser',
      tabId: 'tab-live-closeout',
      physicalTargetToken: 'physical-live-closeout',
      bootIncarnationId: 'boot-live-closeout',
      profileId: null,
      surface: 'agent-view',
      parentTaskId,
      browserTaskId: route.browserTaskId,
      ownerRunId,
      scopeId,
      sessionId: null,
      messageVisibilityEpoch: 0,
    })
    if (isAgentBrowserError(heldClaim)) throw new Error(heldClaim.message)
    assert.equal(codexRepository.readProductTurnRuntime(ownerRunId).readyTaskId, parentTaskId)

    let threadReadCalls = 0
    const archiveIntentCountsAtThreadRead: number[] = []
    composition.nativeRuntime.threadRead = async ({ threadId, includeTurns }) => {
      assert.equal(threadId, codexThreadId)
      assert.equal(includeTurns, true)
      threadReadCalls += 1
      archiveIntentCountsAtThreadRead.push(
        db.prepare('SELECT COUNT(*) AS count FROM codex_thread_archive_intents')
          .get<{ count: number }>()?.count ?? 0,
      )
      return {
        thread: {
          ...nativeThread,
          turns: [{
            id: codexTurnId,
            items: [{
              type: 'userMessage',
              id: 'item-user-live-closeout',
              clientId: admission.turnRequestId,
              content: prepared.ingress.canonicalCurrentInputRef.input,
            }, {
              type: 'agentMessage',
              id: 'item-agent-live-closeout',
              text: '广州实时天气回复',
              phase: 'final_answer',
            }],
            status: 'completed',
            error: null,
          }],
        },
      }
    }
    let recoveryCloseoutCalls = 0
    composition.bindHost({
      runtime: {
        getAgentSessionCheckpointRepository: () => checkpoints,
      },
      getScope: (id: string) => id === scopeId ? scope : null,
      getTaskProjectionStore: () => ({
        get: (taskId: string) => projections.get(taskId),
      }),
      async commitCanonicalCoreCloseout() {
        throw new Error('canonical_closeout_must_not_run_before_browser_observation')
      },
      async commitCodexProductTurnCloseout(input) {
        recoveryCloseoutCalls += 1
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

    const finalText = '广州实时天气回复'
    const candidate: CoreTurnCandidate = {
      kind: 'native_terminal',
      readyTaskId: parentTaskId,
      readyRunId: ownerRunId,
      scopeId,
      codexThreadId,
      codexTurnId,
      engineOutcome: 'completed',
      candidateSelection: { kind: 'accepted', itemId: 'final-live-closeout' },
      candidateText: finalText,
      candidateDigest: createHash('sha256').update(finalText).digest('hex'),
      usedToolCalls: [],
      actionReceiptRefs: [],
      interactionState: null,
      waitingFor: null,
      terminalReasonCandidate: 'done',
      abortInitiator: null,
      budgetState: {},
      contextState: {},
      providerDiagnostics: {},
      contextUsage: null,
      recoveryCheckpointRef: null,
      browserContinuationRef: null,
      browserProofRefs: [],
      otherProofRefs: [],
      projectionPatchRefs: [],
      runtimeDiagnostics: {
        finalDeltaItemIds: [],
        commentaryItemIds: [],
        nativeTurnError: null,
      },
    }
    let waiterCallbacks = 0
    const readbackPromise = new Promise<ReadyClosedCodexProductRun>((resolve, reject) => {
      waiterTimeout = setTimeout(
        () => reject(new Error(
          `live_browser_closeout_waiter_timeout:thread_reads=${threadReadCalls}:recovery_closeouts=${recoveryCloseoutCalls}:metrics=${JSON.stringify(metricEvents.slice(-5))}`,
        )),
        4_000,
      )
      unsubscribe = composition.lifecycleAdapter.observeRunCloseout({
        prepared,
        expectedScopeId: scopeId,
        pending: {
          state: 'ready_closeout_pending',
          pendingKind: 'product_turn_engine_terminal_closeout_pending',
          candidate,
          recoveryEvidenceDigest: digestCanonicalJson({ ownerRunId, candidate: 'pending' }),
          error: 'codex_browser_workflow_observation_required',
        },
      }, (readback) => {
        waiterCallbacks += 1
        resolve(readback)
      })
    })
    const readback = await readbackPromise
    if (waiterTimeout) clearTimeout(waiterTimeout)
    waiterTimeout = null
    assert.equal(readback.execution.success, false)
    assert.equal(readback.execution.error, 'codex_browser_workflow_observation_required')
    assert.equal(readback.execution.terminalReason, 'blocked_external')
    assert.equal(readback.committedTerminalEvent.phase, 'error')
    assert.equal(waiterCallbacks, 1)
    assert.equal(threadReadCalls, 3)
    assert.deepEqual(archiveIntentCountsAtThreadRead, [0, 0, 1])
    assert.equal(recoveryCloseoutCalls, 1)
    assert.deepEqual(
      db.prepare(`
        SELECT source_kind, ready_run_id, state, attempt_count
          FROM codex_thread_archive_intents
         WHERE codex_thread_id = ?
      `).get(codexThreadId),
      {
        source_kind: 'publication_divergence',
        ready_run_id: ownerRunId,
        state: 'pending',
        attempt_count: 0,
      },
    )

    assert.deepEqual(
      db.prepare('SELECT status, terminal_reason FROM run_meta WHERE run_id = ?').get(ownerRunId),
      { status: 'error', terminal_reason: 'blocked_external' },
    )
    assert.equal(
      db.prepare('SELECT status FROM task_projections WHERE task_id = ?')
        .get<{ status: string }>(parentTaskId)?.status,
      'failed',
    )
    const browserChild = db.prepare(`
      SELECT status, result_json FROM browser_tasks WHERE id = ?
    `).get<{ status: string; result_json: string }>(route.browserTaskId)
    assert.equal(browserChild?.status, 'failed')
    assert.deepEqual(JSON.parse(browserChild?.result_json || '{}'), {
      terminalReason: 'blocked_external',
      canonicalMessageId: `assistant:${parentTaskId}:${ownerRunId}:terminal`,
      canonicalMessageDigest: readback.productOutcomeDigest,
    })
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM agent_session_checkpoints WHERE parent_task_id = ?')
        .get<{ count: number }>(parentTaskId)?.count,
      0,
    )
    assert.equal(claimService.read(heldClaim.logicalKey)?.state, 'released')
    const codexCloseout = db.prepare(`
      SELECT product_terminal_digest, product_closeout_at, fence_release_revision
        FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<{
      product_terminal_digest: string | null
      product_closeout_at: string | null
      fence_release_revision: number | null
    }>(ownerRunId)
    assert.ok(codexCloseout?.product_terminal_digest)
    assert.ok(codexCloseout?.product_closeout_at)
    assert.equal(codexCloseout?.fence_release_revision, 2)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences')
        .get<{ count: number }>()?.count,
      0,
    )

    await delay(1_100)
    assert.equal(waiterCallbacks, 1)
    assert.equal(threadReadCalls, 3)
    assert.deepEqual(archiveIntentCountsAtThreadRead, [0, 0, 1])
    assert.equal(recoveryCloseoutCalls, 1)
    assert.equal(
      composition.lifecycleAdapter.deliverRecoveredCloseout(ownerRunId, readback),
      'duplicate',
    )

    unsubscribe()
    const rejectedRunId = 'run-codex-live-deterministic-rejection'
    const rejectedTaskId = 'task-codex-live-deterministic-rejection'
    const rejectedMessageId = 'message-codex-live-deterministic-rejection'
    const rejectedAlias = codexRepository.readActiveAliasBinding(scopeId)
    assert.equal(rejectedAlias?.aliasGeneration, 2)
    const rejectedTail = codexRepository.readLiveUncommittedUserTail(
      rejectedAlias!.threadBindingId,
    )
    const rejectedHeadProjection = projectCodexHeadActionProjection(
      codexRepository.readHeadActionFacts({
        aliasId: scopeId,
        aliasGeneration: 2,
        currentRuntimeManifestDigest: 'runtime-manifest-live-closeout',
        currentProtocolSchemaDigest: 'protocol-schema-live-closeout',
      }),
    )
    const rejectedPrepared: PreparedCodexProductRun = {
      ...prepared,
      taskId: rejectedTaskId,
      runId: rejectedRunId,
      conversationAlias: { aliasId: scopeId, aliasGeneration: 2 },
      ingressBinding: {
        requestId: `request-${rejectedRunId}`,
        reservationSetId: `reservation-set-${rejectedRunId}`,
        reservationEvidenceDigest: `reservation-evidence-${rejectedRunId}`,
      },
      ingress: {
        ...prepared.ingress,
        uncommittedUserTail: rejectedTail,
        actionAdmissionRef: {
          headProjectionDigest: rejectedHeadProjection.evidenceDigest,
          actionProjectionVersion: rejectedHeadProjection.actionProjectionVersion,
          actionHeadIdentity: rejectedHeadProjection.actionHeadIdentity!,
        },
        uncommittedTailAssignments: rejectedTail.map((item) => ({
          originUserMessageId: item.originUserMessageId,
          inputDigest: item.inputDigest,
          plan: item.policy === 'untrusted_text_history'
            ? 'deliver_untrusted_history' as const
            : 'omit_from_current_run' as const,
        })),
        supersededUncommittedItems: rejectedTail.flatMap((item) => (
          item.policy === 'untrusted_text_history' ? [] : [{
            originUserMessageId: item.originUserMessageId,
            inputDigest: item.inputDigest,
            policy: item.policy,
          }]
        )),
        originUserMessageId: rejectedMessageId,
        canonicalCurrentInputRef: {
          messageId: rejectedMessageId,
          input: [{ type: 'text', text: '继续查询天气', text_elements: [] }],
        },
      },
    }
    const rejectedReservation: StartIdentityReservationSet = {
      reservationSetId: rejectedPrepared.ingressBinding.reservationSetId,
      scopeId,
      existingThread: false,
      members: [
        { method: 'thread/start', reservationId: 'thread-reservation-live-rejection' },
        { method: 'turn/start', reservationId: 'turn-reservation-live-rejection' },
      ],
      reservationEvidenceDigest: rejectedPrepared.ingressBinding.reservationEvidenceDigest,
    }
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
      VALUES (?, ?, 'user', '继续查询天气', ?, '{}', 0)
    `).run(rejectedMessageId, scopeId, startedAt)
    const rejectedBinding = executionBinding(rejectedRunId)
    projections.create({
      taskId: rejectedTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      runId: rejectedRunId,
      taskType: 'direct_answer',
      module: 'system',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: rejectedBinding,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    new RunMetaRepository(db).create({
      runId: rejectedRunId,
      taskId: rejectedTaskId,
      scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      executionBinding: rejectedBinding,
      status: 'running',
    }, Date.parse(startedAt))
    const rejectedAdmissionInput = {
      ...admissionInput,
      prepared: rejectedPrepared,
      reservation: rejectedReservation,
      threadBindingId: rejectedAlias!.threadBindingId,
      isolatedThreadCwd: `/tmp/ready-codex/${rejectedAlias!.threadBindingId}`,
      turnRequestId: 'turn-request-live-rejection',
      runtimeManifestDigest: 'runtime-manifest-live-closeout',
      protocolSchemaDigest: 'protocol-schema-live-closeout',
      instructionContractDigest: 'instruction-contract-live-rejection',
      upstreamProfileSnapshotRef: 'profile-ref-live-closeout',
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
      readyParentReceipt: {
        messageRole: 'user' as const,
        messageContent: '继续查询天气',
        messageTimestamp: startedAt,
        messageMetaDigest: digestCanonicalJson({}),
        executionBindingDigest: digestCanonicalJson(rejectedBinding),
      },
    }
    codexRepository.admitProductBindings({
      ...rejectedAdmissionInput,
      ingressAdmittedDigest: buildCodexIngressAdmittedDigest(rejectedAdmissionInput),
    })
    const rejectedThreadId = 'thread-codex-live-rejection'
    const rejectedTurnId = 'turn-codex-live-rejection'
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-live-rejection', rpcId: 11, method: 'thread/start',
      bindingLookupKey: rejectedAdmissionInput.isolatedThreadCwd,
      requestDigest: 'thread-request-live-rejection', dispatchedAt: startedAt,
    })
    const rejectedThread: CodexThread = {
      ...nativeThread,
      id: rejectedThreadId,
      sessionId: rejectedThreadId,
      cwd: rejectedAdmissionInput.isolatedThreadCwd,
      turns: [],
    }
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-live-rejection', rpcId: 11, method: 'thread/start',
      bindingId: rejectedAlias!.threadBindingId, nativeId: rejectedThreadId,
      nativeResult: { thread: rejectedThread, instructionSources: [] },
      responseDigest: 'thread-response-live-rejection', responsePending: false,
      reconciledAt: startedAt,
    })
    codexRepository.activateStartDispatch({
      connectionEpoch: 'epoch-live-rejection', rpcId: 12, method: 'turn/start',
      bindingLookupKey: rejectedRunId, requestDigest: 'turn-request-live-rejection',
      dispatchedAt: startedAt,
    })
    codexRepository.reconcileStartAccepted({
      connectionEpoch: 'epoch-live-rejection', rpcId: 12, method: 'turn/start',
      bindingId: rejectedRunId, nativeId: rejectedTurnId,
      nativeResult: { turn: { id: rejectedTurnId, items: [], status: 'completed', error: null } },
      responseDigest: 'turn-response-live-rejection', responsePending: false,
      reconciledAt: startedAt,
    })

    const rejectedCandidate: CoreTurnCandidate = {
      ...candidate,
      readyTaskId: 'forged-task-id',
      readyRunId: rejectedRunId,
      codexThreadId: rejectedThreadId,
      codexTurnId: rejectedTurnId,
      candidateDigest: createHash('sha256').update(finalText).digest('hex'),
    }
    let rejectedReadbackCalls = 0
    unsubscribe = composition.lifecycleAdapter.observeRunCloseout({
      prepared: rejectedPrepared,
      expectedScopeId: scopeId,
      pending: {
        state: 'ready_closeout_pending',
        pendingKind: 'product_turn_engine_terminal_closeout_pending',
        candidate: rejectedCandidate,
        recoveryEvidenceDigest: digestCanonicalJson({ rejectedRunId }),
        error: 'codex_candidate_durable_identity_mismatch',
      },
    }, () => { rejectedReadbackCalls += 1 })
    await delay(1_100)
    assert.equal(rejectedReadbackCalls, 0)
    assert.equal(recoveryCloseoutCalls, 1)
    assert.equal(metricEvents.some((event) => event.metric === 'codex_live_closeout_recovery_failed'
      && event.readyRunId === rejectedRunId
      && event.reason === 'codex_candidate_durable_identity_mismatch'), true)
  } finally {
    if (waiterTimeout) clearTimeout(waiterTimeout)
    unsubscribe()
    await composition.stop()
    database.close()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
