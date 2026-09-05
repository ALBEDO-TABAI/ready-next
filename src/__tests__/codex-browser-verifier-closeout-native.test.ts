import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { DatabaseConnection, DatabaseManager } from '../main/modules/database'
import { AppSettingsRepository } from '../main/modules/repositories/app-settings-repository'
import { AgentSessionCheckpointRepository } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexAdmittedBindingInput,
  type CodexBrowserVerifierAttemptOutcome,
  type CodexLifecycleAction,
  type CodexTerminalCloseoutEvidence,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { codexBrowserVerifierFrozenIdentityDigest } from '../main/modules/agent-control/codex-runtime/codex-browser-verifier-identity'
import { createCodexUpstreamProfileSnapshot, digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { CodexThread } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import type { PreparedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { createCodexRuntimeComposition, requestCodexEngineTerminalLifecycleActionBeforeCloseout } from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import type { CodexRuntimeHostPort, ReadyClosedCodexProductRun } from '../main/modules/agent-control/codex-runtime/codex-runtime-composition'
import type { CoreTurnCandidate } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { collectArtifactProof, collectToolResultProof } from '../main/modules/agent-control/quality/proof-collector'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import {
  openProviderCheckpointTestDb,
  providerCheckpointExecutionBinding,
} from './provider-checkpoint-test-fixtures'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { commitCanonicalCodexFailure } from './helpers/codex-product-closeout'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import {
  buildTerminalNativeReadbackReceipt,
  resolveCodexHistoryObservation,
  resolveCodexProductFailureKind,
  resolveCodexTerminalFacts,
  terminalEvidenceRef,
  terminalGatewayEvidenceRef,
  terminalNativeReadbackEvidenceRef,
} from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { projectCodexLifecycleOperationV2 } from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'
import { classifyLifecycleOperation } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import { verifyCodexAutomaticCompactionEvidence } from '../main/modules/agent-control/codex-runtime/codex-automatic-compaction-evidence'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'

const startedAt = '2026-08-11T05:00:00.000Z'
const verifiedAt = '2026-08-11T05:01:00.000Z'
const closeoutAt = '2026-08-11T05:02:00.000Z'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function lifecycleTerminalEvidence(
  repository: CodexBindingRepository,
  readyRunId: string,
  input: {
    action?: CodexLifecycleAction
    terminal: 'done' | 'error' | 'interrupted'
    terminalReason: string
    failureKind: CodexTerminalCloseoutEvidence['terminalFacts']['product']['failureKind']
    nativeThread?: CodexThread
  },
): CodexTerminalCloseoutEvidence {
  const product = repository.readProductTurnRuntime(readyRunId)
  const engine = repository.readEngineTerminalCandidate(readyRunId)
  const lifecycle = input.action ? repository.readProductLifecycleAction(readyRunId) : null
  if (!engine || (input.action && !lifecycle) || !product.codexThreadId || !product.codexTurnId) {
    throw new Error('lifecycle_terminal_fixture_missing')
  }
  const unsigned = {
    contract: 'codex_terminal_native_readback_v1' as const,
    receiptId: `native-readback:${readyRunId}:${product.turnRevision}`,
    readyRunId,
    readyScopeId: product.readyScopeId,
    messageVisibilityEpoch: product.messageVisibilityEpoch,
    aliasGeneration: product.aliasGeneration,
    connectionEpoch: product.turnStartConnectionEpoch,
    codexThreadId: product.codexThreadId,
    codexTurnId: product.codexTurnId,
    turnStatus: engine.engineOutcome,
    turnRevision: product.turnRevision,
    threadStatus: { type: 'idle' as const },
    orderedTurnIds: [product.codexTurnId],
    terminalTurnItemDigests: [],
    contextCompactionItemIds: [],
  }
  const nativeReadback = input.nativeThread
    ? buildTerminalNativeReadbackReceipt({
        candidate: engine.candidate as Extract<CoreTurnCandidate, { kind: 'native_terminal' }>,
        prepared: product.prepared, aliasGeneration: product.aliasGeneration,
        messageVisibilityEpoch: product.messageVisibilityEpoch,
        connectionEpoch: product.turnStartConnectionEpoch, turnRevision: product.turnRevision,
        thread: input.nativeThread,
      })
    : { ...unsigned, digest: digestCanonicalJson(unsigned) }
  const nativeTurnRef = terminalEvidenceRef({
    kind: 'native_turn', readyRunId, readyScopeId: product.readyScopeId,
    messageVisibilityEpoch: product.messageVisibilityEpoch,
    aliasGeneration: product.aliasGeneration, codexThreadId: product.codexThreadId,
    codexTurnId: product.codexTurnId,
    receiptId: `engine-terminal:${readyRunId}`, digest: engine.candidateDigest,
    ownerIdentity: { nativeTurnId: product.codexTurnId, terminalStatus: engine.engineOutcome },
  })
  const readbackRef = terminalNativeReadbackEvidenceRef({
    readyRunId, readyScopeId: product.readyScopeId,
    messageVisibilityEpoch: product.messageVisibilityEpoch,
    aliasGeneration: product.aliasGeneration, codexThreadId: product.codexThreadId,
    codexTurnId: product.codexTurnId, revision: nativeReadback.turnRevision,
    receiptId: nativeReadback.receiptId, digest: nativeReadback.digest,
    ownerIdentity: {
      connectionEpoch: product.turnStartConnectionEpoch,
      readRevision: product.turnRevision,
      verifiedThreadId: product.codexThreadId,
      verifiedTurnId: product.codexTurnId,
    },
  })
  const lifecycleRef = lifecycle && input.action ? {
    kind: 'lifecycle' as const,
    evidenceRefId: `lifecycle:${readyRunId}:${input.action}`,
    readyRunId, readyScopeId: product.readyScopeId,
    messageVisibilityEpoch: product.messageVisibilityEpoch,
    aliasGeneration: product.aliasGeneration, codexThreadId: product.codexThreadId,
    codexTurnId: product.codexTurnId, revision: 1,
    receiptId: `lifecycle:${readyRunId}:${input.action}`,
    digest: lifecycle.lifecycleActionEvidenceDigest,
    ownerIdentity: { lifecycleActionId: `${readyRunId}:${input.action}` },
  } : null
  const history = input.action === 'reset'
    ? { kind: 'reset' as const }
    : input.action === 'close'
      ? { kind: 'closed' as const }
      : input.nativeThread
        ? resolveCodexHistoryObservation({
            gatewayEvidence: [],
            candidate: engine.candidate as Extract<CoreTurnCandidate, { kind: 'native_terminal' }>,
            prepared: product.prepared, expectedClientUserMessageId: product.turnRequestId,
            thread: input.nativeThread, publicationDiverged: input.terminal !== 'done',
          })
      : input.terminal === 'done'
        ? {
            kind: 'continuation_safe' as const,
            seamId: 'completed_product_accepted_v1' as const,
            retainedFormalInputMappingDigest: digestCanonicalJson({
              originUserMessageId: product.prepared.ingress.originUserMessageId,
              inputDigest: digestCanonicalJson(
                product.prepared.ingress.canonicalCurrentInputRef.input,
              ),
            }),
          }
        : { kind: 'diverged' as const, reason: 'protocol_or_publication_rejected' as const }
  return {
    nativeReadback,
    terminalFacts: resolveCodexTerminalFacts({
      product: {
        terminal: input.terminal, terminalReason: input.terminalReason,
        failureKind: input.failureKind,
        evidence: [nativeTurnRef, readbackRef, ...(lifecycleRef ? [lifecycleRef] : [])],
      },
      history,
      historyEvidence: history.kind === 'reset' || history.kind === 'closed'
        ? [lifecycleRef as NonNullable<typeof lifecycleRef>]
        : [nativeTurnRef, readbackRef],
      effect: { state: 'none', evidence: [] },
    }),
  }
}

function prepared(runId: string, taskId: string, scopeId: string, messageId: string): PreparedCodexProductRun {
  const tools = createCodexToolFixture([])
  return {
    preparationContract: 'codex_product_run_e2',
    sourceTrustedEnvironmentRef: {
      workbenchMode: 'browser',
      environmentDigest: 'e'.repeat(64),
    },
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
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
      uncommittedTailAssignments: [],
      supersededUncommittedItems: [],
    },
    resourceAnchorDigest: sha256(JSON.stringify({
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    })),
    ...tools,
    readyToolHostIdentity: {
      scopeId,
      aliasId: scopeId,
      authorizationOwnerId: `authorization-${runId}`,
      resourceOwnerId: `resource-${runId}`,
    },
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
    neutralProjectionSeed: {
      phase: 'planning',
      taskTitle: '正在理解需求',
      taskSummary: '正在整理任务边界、资源与可用能力',
    },
  }
}

async function nativeTerminalFixture(
  t: Parameters<typeof skipIfSqliteUnavailable>[0],
  suffix: string,
) {
  if (skipIfSqliteUnavailable(t, `codex-browser-verifier-${suffix}`)) return null
  const db = openProviderCheckpointTestDb()
  const accessor = { getRawDb: () => db }
  const runtimeManifestDigest = digestCanonicalJson({ fixture: `browser-verifier-${suffix}` })
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, {
    runtimeManifestDigest,
    protocolSchemaDigest: `protocol-${suffix}`,
    runtimeContinuityCatalog: {
      contract: 'ready_runtime_continuity_catalog_v1',
      targetManifestDigest: runtimeManifestDigest,
      transitions: [],
    },
  })
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
  const upstream = createCodexUpstreamProfileSnapshot({
    profileId: `profile-${suffix}`,
    config: {
      provider: 'openai', baseUrl: 'http://127.0.0.1:10532/v1', apiKey: 'isolated-test-key',
      model: 'frozen-browser-model', agentProtocol: 'openai', wireApi: 'responses',
      toolUseMode: 'on', nativeVideoMode: 'off',
    },
    maxRetries: 0,
  })
  new CodexModelGatewayRepository(db).storeSnapshot({
    ...upstream, snapshotRef: `snapshot-ref-${suffix}`, createdAt: startedAt,
  })
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
    runtimeManifestDigest,
    protocolSchemaDigest: `protocol-${suffix}`,
    createdAt: startedAt,
  })
   const actionHead = projectCodexHeadActionProjection(repository.readHeadActionFacts({
    aliasId: scopeId,
    aliasGeneration: 1,
    currentRuntimeManifestDigest: runtimeManifestDigest,
    currentProtocolSchemaDigest: `protocol-${suffix}`,
  }))
  if (!actionHead.actionHeadIdentity) throw new Error('fixture_action_head_missing')
  const admittedRun: PreparedCodexProductRun = {
    ...run,
    ingress: {
      ...run.ingress,
      actionAdmissionRef: {
        headProjectionDigest: actionHead.evidenceDigest,
        actionProjectionVersion: actionHead.actionProjectionVersion,
        actionHeadIdentity: actionHead.actionHeadIdentity,
      },
    },
  }
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
    prepared: admittedRun,
    reservation,
    ownerMainBootId: `boot-${suffix}`,
    admittedAt: startedAt,
    ingressAdmittedRevision: 1,
    messageVisibilityEpoch: 0,
    threadBindingId,
    isolatedThreadCwd: `/tmp/ready-codex/${threadBindingId}`,
    turnRequestId: `turn-request-${suffix}`,
    runtimeManifestDigest,
    protocolSchemaDigest: `protocol-${suffix}`,
    instructionContractDigest: `instruction-${suffix}`,
    codexModel: 'frozen-browser-model',
    upstreamProfileSnapshotRef: `snapshot-ref-${suffix}`,
    upstreamProfileSnapshotDigest: upstream.snapshotDigest,
    additionalContextDigest: digestCanonicalJson([]),
    turnContractDigest: `turn-contract-${suffix}`,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: '查询天气',
      messageTimestamp: startedAt,
      messageMetaDigest: digestCanonicalJson({}),
      executionBindingDigest: digestCanonicalJson(executionBinding),
    },
    continuationCandidate: null,
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
  const finalText = `hidden-candidate-${suffix}`
  const candidateDigest = sha256(finalText)
  const candidate: Extract<CoreTurnCandidate, { kind: 'native_terminal' }> = {
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
      contextUsage: null,
      recoveryCheckpointRef: null,
      browserContinuationRef: null,
      browserProofRefs: [],
      otherProofRefs: [],
      projectionPatchRefs: [],
      runtimeDiagnostics: {
        finalDeltaItemIds: [], commentaryItemIds: [], nativeTurnError: null,
      },
  }
  return {
    db, accessor, repository, projections, checkpoints, run: admittedRun,
    scopeId, taskId, runId, messageId, threadBindingId, codexThreadId, codexTurnId,
    finalText, candidateDigest, candidate, nativeThread, admissionInput,
    runtimeManifestDigest,
    protocolSchemaDigest: `protocol-${suffix}`,
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
  const base = await nativeTerminalFixture(t, suffix)
  if (!base) return null
  const {
    db, repository, projections, checkpoints,
    scopeId, taskId, runId, messageId, threadBindingId, codexThreadId, codexTurnId,
    candidateDigest, admissionInput,
  } = base
  const route = await checkpoints.bindBrowserWorkflowRoute({
    parentTaskId: taskId,
    ownerRunId: runId,
    sourceMessageId: messageId,
    executionBinding: providerCheckpointExecutionBinding(runId),
    now: startedAt,
  })
  repository.recordEngineTerminalCandidate({
    readyRunId: runId, codexThreadId, codexTurnId,
    engineOutcome: 'completed', candidate: base.candidate, recordedAt: startedAt,
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
    ...base,
    bundle: bundleInspection.bundle!,
    projection: projection!,
    route,
    begun,
  }
}

function completedNativeThread(
  value: NonNullable<Awaited<ReturnType<typeof nativeTerminalFixture>>>,
  compacted = false,
): CodexThread {
  return {
    ...value.nativeThread,
    turns: [{
      id: value.codexTurnId, status: 'completed', error: null,
      items: [{
        type: 'userMessage', id: 'item-1', clientId: value.admissionInput.turnRequestId,
        content: value.run.ingress.canonicalCurrentInputRef.input,
      }, ...(compacted ? [{ type: 'contextCompaction' as const, id: 'compact-item' }] : []), {
        type: 'agentMessage', id: 'item-2', text: value.finalText, phase: 'final_answer',
      }],
    }],
  }
}

async function productionCloseout(
  value: NonNullable<Awaited<ReturnType<typeof nativeTerminalFixture>>>,
  compacted = false,
  nativeThread = completedNativeThread(value, compacted),
) {
  const appPath = fileURLToPath(new URL('../..', import.meta.url))
  const userDataPath = mkdtempSync(join(tmpdir(), 'ready-codex-qc-closeout-'))
  const composition = createCodexRuntimeComposition({
    appPath, resourcesPath: appPath, userDataPath, isPackaged: false,
    database: value.accessor as unknown as DatabaseManager,
    settings: new AppSettingsRepository(() => ({
      ...value.accessor,
      getSetting: () => undefined,
      setSetting() { throw new Error('unexpected_settings_write') },
    })),
    async requestRendererToolAction() { throw new Error('unexpected_renderer_action') },
    providerReadiness: { async ensureReady() { throw new Error('unexpected_provider_call') } },
  })
  const checkpoints = new AgentSessionCheckpointRepository(
    value.accessor, composition.canonicalCloseoutTransactionParticipant,
  )
  let terminalNativeReads = 0
  let canonicalCommits = 0
  composition.nativeRuntime.threadRead = async ({ threadId }) => {
    assert.equal(threadId, value.codexThreadId)
    // The retired source's archive owner may read it again after the commit.
    if (canonicalCommits === 0) {
      terminalNativeReads += 1
      assert.equal(terminalNativeReads, 1, 'QC consumes the one frozen native terminal snapshot')
    }
    return { thread: nativeThread }
  }
  composition.nativeRuntime.threadFork = async () => { throw new Error('unexpected_native_fork') }
  const scope: ConversationScope = {
    id: value.scopeId, agent: 'butler', activeAgentId: 'butler', handoffGeneration: 0,
    aliasGeneration: 1, messageVisibilityEpoch: 0, title: 'QC closeout',
    sourceKind: 'local', sourceId: 'app', threadKey: value.scopeId, meta: {},
    createdAt: startedAt, updatedAt: startedAt, lastMessageAt: startedAt,
  }
  composition.bindHost({
    runtime: { getAgentSessionCheckpointRepository: () => checkpoints },
    getScope: (scopeId: string) => scopeId === value.scopeId ? scope : null,
    getTaskProjectionStore: () => value.projections,
    async commitCodexProductTurnCloseout(input) {
      canonicalCommits += 1
      const committed = await checkpoints.commitCanonicalCoreCloseout(input)
      const closeout = value.repository.readProductCloseout(value.runId)
      assert.ok(closeout)
      return {
        productTerminalDigest: closeout.productTerminalDigest,
        closeoutAt: closeout.productCloseoutAt,
        ...committed.value,
      }
    },
  } as unknown as CodexRuntimeHostPort)
  let unsubscribe = () => {}
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await new Promise<ReadyClosedCodexProductRun>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('production_qc_closeout_timeout')), 5_000)
      unsubscribe = composition.lifecycleAdapter.observeRunCloseout({
        prepared: value.run,
        expectedScopeId: value.scopeId,
        pending: {
          state: 'ready_closeout_pending',
          pendingKind: 'product_turn_engine_terminal_closeout_pending',
          candidate: value.candidate,
          recoveryEvidenceDigest: digestCanonicalJson(value.candidate),
          error: 'test_native_candidate_ready',
        },
      }, resolve)
    })
    return { result, terminalNativeReads, canonicalCommits }
  } finally {
    clearTimeout(timeout)
    unsubscribe()
    await composition.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
}

test('canonical transaction rejects forged same-run native owner references', async (t) => {
  for (const kind of ['native_turn', 'native_readback'] as const) {
    const value = await nativeTerminalFixture(t, `forged-${kind}`)
    if (!value) return
    try {
      value.repository.recordEngineTerminalCandidate({
        readyRunId: value.runId, codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
        engineOutcome: 'completed', candidate: value.candidate, recordedAt: verifiedAt,
      })
      const evidence = lifecycleTerminalEvidence(value.repository, value.runId, {
        terminal: 'done', terminalReason: 'done', failureKind: null,
      })
      for (const refs of [evidence.terminalFacts.product.evidence, evidence.terminalFacts.history.evidence]) {
        const ref = refs.find((ref) => ref.kind === kind)!
        Object.assign(ref, {
          receiptId: 'forged-not-an-owner', evidenceRefId: `${kind}:forged-not-an-owner`,
          revision: 999999, digest: 'f'.repeat(64),
        })
      }
      value.db.exec('BEGIN IMMEDIATE')
      try {
        assert.throws(() => value.repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: value.runId, productTerminalDigest: 'test-uncommitted',
          closeoutAt, terminalEvidence: evidence,
        }), new RegExp(`terminal_evidence_owner_mismatch:${kind}`))
      } finally { value.db.exec('ROLLBACK') }
      assert.equal(value.repository.readTerminalCloseoutEvidence(value.runId), null)
      assert.equal(value.repository.readProductCloseout(value.runId), null)
    } finally { value.db.close() }
  }
})

test('production history fold consumes durable wire evidence despite lossy native readback', async (t) => {
  for (const seam of ['safe', 'partial', 'pending'] as const) {
    const partial = seam === 'partial'
    const value = await nativeTerminalFixture(t, `wire-${seam}`)
    if (!value) return
    try {
      value.candidate = {
        ...value.candidate, engineOutcome: 'failed',
        candidateSelection: { kind: 'none', code: 'terminal_not_completed' },
        candidateText: null, candidateDigest: null, terminalReasonCandidate: 'blocked_external',
        runtimeDiagnostics: {
          finalDeltaItemIds: partial ? ['partial-output-item'] : [],
          commentaryItemIds: [], nativeTurnError: 'fixture failure',
        },
      }
      const gateway = new CodexModelGatewayRepository(value.db)
      const requestDigest = 'd'.repeat(64)
      // Only request transcript content is synthetic; both event writers and
      // their immutable DB readback are the production implementation.
      const writer = gateway as unknown as { writeReceipt(input: unknown): string }
      writer.writeReceipt({
        kind: 'product', codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
        readyRunId: value.runId, manualCompactionId: null,
        snapshotRef: value.admissionInput.upstreamProfileSnapshotRef,
        snapshotDigest: value.admissionInput.upstreamProfileSnapshotDigest, requestDigest,
        requestEvidence: {
          instructionDigest: requestDigest, inputDigest: requestDigest, inputItems: [],
          inputTotalStringCharacters: 0, inputMaxStringCharacters: 0,
          toolsDigest: requestDigest, toolCount: 0, bodyBytes: 100,
          memoryHistoryRedactionDigest: requestDigest, memoryHistoryRedactedItemCount: 0,
        },
        acceptedAt: startedAt, budgetLane: 'ordinary',
      })
      const metadata = {
          threadId: value.codexThreadId, turnId: value.codexTurnId, readyRunId: value.runId,
          raw: { request_kind: 'turn' },
      } as Parameters<CodexModelGatewayRepository['recordResponseFailureEvidence']>[0]['metadata']
      const failureInput = {
        metadata,
        requestDigest,
        failureEvidence: {
          failureClass: partial ? 'transport' as const : 'provider' as const,
          failureStage: partial ? 'stream-after-item' as const : 'headers' as const,
          responseIdentitySeen: partial, partialAssistantItemSeen: partial, toolCallItemSeen: false,
          elapsedMs: 10, eventCount: partial ? 3 : 0, wireByteCount: partial ? 300 : 0,
          causeCode: partial ? 'gateway_native_stream_failed' : 'gateway_upstream_http_400',
        },
        failedAt: verifiedAt,
      }
      if (seam !== 'pending') gateway.recordResponseFailureEvidence(failureInput)
      const nativeThread = completedNativeThread(value)
      nativeThread.turns[0] = {
        ...nativeThread.turns[0], status: 'failed', error: { message: 'fixture failure' },
        items: [nativeThread.turns[0].items[0]],
      }
      value.repository.recordEngineTerminalCandidate({
        readyRunId: value.runId, codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
        engineOutcome: 'failed', candidate: value.candidate, recordedAt: verifiedAt,
      })
      const forged = lifecycleTerminalEvidence(value.repository, value.runId, {
        terminal: 'error', terminalReason: 'blocked_external', failureKind: 'provider', nativeThread,
      })
      const row = gateway.readTurnGatewayEvidence({ readyRunId: value.runId,
        codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId })[0]
      const forgedGateway = terminalGatewayEvidenceRef({
        readyRunId: value.runId, readyScopeId: value.scopeId, messageVisibilityEpoch: 0, aliasGeneration: 1,
        codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
        receiptId: row.receiptId, revision: 999999, digest: 'f'.repeat(64),
        ownerIdentity: { gatewayRequestReceiptId: row.receiptId, eventSequence: 999999 },
      })
      forged.terminalFacts.product.evidence.push(forgedGateway)
      forged.terminalFacts.history.evidence.push(forgedGateway)
      value.db.exec('BEGIN IMMEDIATE')
      try {
        assert.throws(() => value.repository.completeCanonicalProductCloseoutInOpenTransaction({
          readyRunId: value.runId, productTerminalDigest: 'test-uncommitted', closeoutAt, terminalEvidence: forged,
        }), /terminal_evidence_owner_mismatch:gateway/)
      } finally { value.db.exec('ROLLBACK') }
      await productionCloseout(value, false, nativeThread)
      const evidence = value.repository.readTerminalCloseoutEvidence(value.runId)
      assert.equal(evidence?.terminalFacts.history.kind, seam === 'safe' ? 'continuation_safe' : 'diverged')
      assert.equal(evidence?.terminalFacts.history.evidence.filter((ref) => ref.kind === 'gateway').length, 1)
      assert.equal(value.repository.readActiveAliasBinding(value.scopeId)?.aliasGeneration, seam === 'safe' ? 1 : 2)
      const frozen = digestCanonicalJson(evidence)
      if (seam === 'pending') {
        assert.throws(() => gateway.recordResponseFailureEvidence(failureInput), /gateway_response_owner_closed/)
        assert.throws(() => gateway.recordResponseEvidence({
          metadata, requestDigest, completedAt: verifiedAt,
          responseEvidence: {
            responseId: 'late-response', terminalDigest: requestDigest,
            outputDigest: requestDigest, usageDigest: requestDigest,
          },
        }), /gateway_response_owner_closed/)
        assert.equal(gateway.readTurnGatewayEvidence({ readyRunId: value.runId,
          codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId })[0].responseSequence, null)
      } else {
        gateway.recordResponseFailureEvidence(failureInput) // Exact replay remains a zero-write operation.
      }
      assert.equal(digestCanonicalJson(value.repository.readTerminalCloseoutEvidence(value.runId)), frozen)
    } finally {
      value.db.close()
    }
  }
})

test('production QC rejection commits one coherent failure and replay retains its reason', async (t) => {
  for (const partialDelivery of [false, true]) {
    const value = await nativeTerminalFixture(t, `qc-${partialDelivery ? 'partial' : 'claim-only'}`)
    if (!value) return
    try {
      const proofRefs = partialDelivery ? [
        collectToolResultProof('skill_write_artifact', 'written a', new Date(verifiedAt)),
        collectArtifactProof('/tmp/qc-a.md', new Date(verifiedAt), value.runId),
      ] : []
      value.projections.update(value.taskId, {
        taskType: partialDelivery ? 'multi_step_task' : 'short_task', module: 'skill', proofRefs,
        expectedOutputs: ['/tmp/qc-a.md', '/tmp/qc-b.md'],
      })
      const first = await productionCloseout(value)
      const evidence = value.repository.readTerminalCloseoutEvidence(value.runId)
      assert.ok(evidence)
      assert.deepEqual(value.db.prepare(`
        SELECT status, terminal_reason FROM run_meta WHERE run_id = ?
      `).get(value.runId), { status: 'error', terminal_reason: 'proof_gap' })
      assert.equal(evidence.terminalFacts.product.terminal, 'error')
      assert.equal(evidence.terminalFacts.product.terminalReason, 'proof_gap')
      assert.equal(evidence.terminalFacts.history.kind, 'diverged')
      assert.equal(first.result.execution.terminalReason, 'proof_gap')
      assert.equal(first.result.committedTerminalEvent.terminalReason, 'proof_gap')
      assert.equal(first.result.execution.canonicalMessage?.content, first.result.execution.finalText)
      assert.notEqual(first.result.execution.finalText, value.finalText)
      assert.match(first.result.execution.finalText, /还没有满足全部完成要求/)
      assert.equal(first.canonicalCommits, 1)
      assert.equal(first.terminalNativeReads, 1)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_native_coverage_receipts`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 0)
      const head = value.repository.readActiveAliasBinding(value.scopeId)
      assert.ok(head)
      assert.equal(head.aliasGeneration, 2)
      assert.equal(head.materializationKind, 'fresh_root_with_tail')
      const projection = value.projections.get(value.taskId)
      assert.equal(projection?.status, 'failed')
      assert.equal(projection?.checkins?.length, 1)
      if (partialDelivery) {
        assert.ok((projection?.criteria?.satisfiedCount ?? 0) > 0)
        assert.equal(projection?.checkins?.[0].verdict, 'degraded')
        assert.ok((projection?.proofRefs ?? []).some((proof) => proof.digest === proofRefs[1].digest))
      }
      const firstFactsDigest = digestCanonicalJson(evidence.terminalFacts)
      const replay = await productionCloseout(value)
      assert.equal(replay.canonicalCommits, 0)
      assert.equal(replay.terminalNativeReads, 0)
      assert.equal(replay.result.execution.terminalReason, first.result.execution.terminalReason)
      assert.equal(replay.result.committedTerminalEvent.terminalReason, first.result.committedTerminalEvent.terminalReason)
      assert.deepEqual(replay.result.execution.canonicalMessage, first.result.execution.canonicalMessage)
      assert.equal(replay.result.execution.canonicalMessageDigest, first.result.execution.canonicalMessageDigest)
      assert.equal(digestCanonicalJson(value.repository.readTerminalCloseoutEvidence(value.runId)?.terminalFacts), firstFactsDigest)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
        .get<{ count: number }>()?.count, 1)
    } finally {
      value.db.close()
    }
  }
})

test('QC cannot infer a fresh root from missing coverage when native history has an earlier unmapped turn', async (t) => {
  const value = await nativeTerminalFixture(t, 'unmapped-prefix')
  if (!value) return
  try {
    value.projections.update(value.taskId, {
      taskType: 'short_task', module: 'skill',
      expectedOutputs: ['required.txt'],
    })
    const nativeThread = completedNativeThread(value)
    nativeThread.turns.unshift({ id: 'earlier-unmapped-turn', status: 'completed', error: null, items: [] })
    const closed = await productionCloseout(value, false, nativeThread)
    assert.equal(closed.result.execution.success, false)
    assert.deepEqual(value.repository.readTerminalCloseoutEvidence(value.runId)?.terminalFacts.history.kind,
      'unknown_reset_required')
    assert.equal(value.repository.readActiveAliasBinding(value.scopeId)?.aliasGeneration, 1)
    assert.equal(value.db.prepare('SELECT COUNT(*) AS count FROM codex_thread_bindings')
      .get<{ count: number }>()?.count, 1)
  } finally { value.db.close() }
})

test('accepted current reply with unmapped earlier history publishes without inventing coverage', async (t) => {
  const value = await nativeTerminalFixture(t, 'accepted-unmapped-prefix')
  if (!value) return
  try {
    const nativeThread = completedNativeThread(value)
    nativeThread.turns.unshift({ id: 'earlier-unmapped-turn', status: 'completed', error: null, items: [] })
    const closed = await productionCloseout(value, false, nativeThread)
    assert.equal(closed.result.execution.success, true)
    assert.equal(closed.result.execution.finalText, value.finalText)
    assert.equal(value.repository.readTerminalCloseoutEvidence(value.runId)?.terminalFacts.history.kind,
      'unknown_reset_required')
    assert.equal(value.repository.readActiveAliasBinding(value.scopeId)?.aliasGeneration, 1)
    assert.equal(value.db.prepare('SELECT COUNT(*) AS count FROM codex_native_coverage_receipts')
      .get<{ count: number }>()?.count, 0)
  } finally { value.db.close() }
})

test('production accepted automatic compaction commits one compaction coverage head', async (t) => {
  const value = await nativeTerminalFixture(t, 'automatic-accepted')
  if (!value) return
  try {
    const product = value.repository.readProductTurnRuntime(value.runId)
    // Only the immutable Gateway wire evidence is substituted; QC and all writes are real.
    const rows = ([1, 3] as const).map((sequence) => {
      const automatic = sequence === 1
      const chars = automatic ? 1_000 : 100
      return {
        requestSequence: sequence, responseSequence: sequence + 1,
        receiptId: `gateway-${sequence}`,
        requestKind: automatic ? 'automatic_compaction' as const : 'product' as const,
        readyRunId: value.runId, codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
        upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
        requestDigest: sha256(`request-${sequence}`), instructionDigest: sha256('instructions'),
        inputDigest: sha256(`input-${sequence}`),
        inputItems: [{ digest: sha256(`item-${sequence}`), totalStringCharacters: chars, maxStringCharacters: chars }],
        inputTotalStringCharacters: chars, inputMaxStringCharacters: chars,
        toolsDigest: automatic ? digestCanonicalJson([]) : product.toolSurfaceDigest,
        toolCount: 0, bodyBytes: chars + 100,
        requestEvidenceDigest: sha256(`request-evidence-${sequence}`),
        responseId: `response-${sequence + 1}`,
        responseTerminalDigest: sha256(`terminal-${sequence + 1}`),
        responseOutputDigest: sha256(`output-${sequence + 1}`),
        responseUsageDigest: sha256(`usage-${sequence + 1}`),
        responseEvidenceDigest: sha256(`response-evidence-${sequence + 1}`),
        failure: null,
      }
    })
    t.mock.method(CodexModelGatewayRepository.prototype, 'readTurnGatewayEvidence', (identity: {
      readyRunId: string; codexThreadId: string; codexTurnId: string
    }) => {
      assert.deepEqual(identity, {
        readyRunId: value.runId, codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
      })
      return rows
    })
    const verified = verifyCodexAutomaticCompactionEvidence({
      gatewayRepository: { readTurnGatewayEvidence: () => rows },
      readyRunId: value.runId, codexThreadId: value.codexThreadId, codexTurnId: value.codexTurnId,
      upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
      productToolSurfaceDigest: product.toolSurfaceDigest, thread: completedNativeThread(value, true),
    })
    assert.ok(verified)
    const closed = await productionCloseout(value, true)
    assert.equal(closed.canonicalCommits, 1)
    assert.equal(closed.result.execution.success, true)
    assert.equal(closed.result.execution.terminalReason, 'done')
    const terminal = value.repository.readTerminalCloseoutEvidence(value.runId)
    assert.equal(terminal?.terminalFacts.product.terminal, 'done')
    assert.equal(terminal?.terminalFacts.history.kind, 'continuation_safe')
    assert.deepEqual(terminal?.nativeReadback.contextCompactionItemIds, ['compact-item'])
    assert.deepEqual(value.db.prepare(`
      SELECT producer_kind, accepted_native_head_kind, accepted_native_head_id,
             accepted_product_ready_run_id FROM codex_native_coverage_receipts
    `).all(), [{
      producer_kind: 'automatic_compaction', accepted_native_head_kind: 'compaction',
      accepted_native_head_id: value.codexTurnId, accepted_product_ready_run_id: value.runId,
    }])
    assert.equal(value.repository.readAcceptedNativePrefixHead(value.threadBindingId)?.acceptedNativeHeadKind, 'compaction')
    assert.equal(value.repository.readActiveAliasBinding(value.scopeId)?.aliasGeneration, 1)
    const projection = value.projections.get(value.taskId)
    assert.equal(projection?.status, 'completed')
    assert.equal(projection?.checkins?.length, 1)
    assert.equal(projection?.checkins?.[0].verdict, 'accept')
  } finally {
    value.db.close()
  }
})

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
      value.repository.completeVerifierAcceptedCloseoutInOpenTransaction({
        ...input,
        terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
          terminal: 'done',
          terminalReason: 'done',
          failureKind: null,
        }),
      })
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
        value.repository.completeVerifierAcceptedCloseoutInOpenTransaction({
          ...input,
          terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
            terminal: 'done',
            terminalReason: 'done',
            failureKind: null,
          }),
        })
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
    const terminalEvidence = value.repository.readTerminalCloseoutEvidence(value.runId)
    assert.equal(terminalEvidence?.terminalFacts.product.terminal, 'done')
    assert.equal(terminalEvidence?.terminalFacts.history.kind, 'continuation_safe')
    const acceptedHead = value.repository.readAcceptedNativePrefixHead(value.threadBindingId)
    assert.equal(acceptedHead?.acceptedProductReadyRunId, value.runId)
    assert.equal(acceptedHead?.acceptedNativeHeadId, value.begun.attempt.codexTurnId)
    assert.match(acceptedHead?.coverageReceiptRef.digest || '', /^[a-f0-9]{64}$/)
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
        value.repository.completeVerifierRejectedCloseoutInOpenTransaction({
          ...input,
          terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
            terminal: 'error', terminalReason: 'proof_gap', failureKind: 'protocol',
          }),
        })
      },
    })
    const committed = await commitCanonicalCodexFailure(closeout, {
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
      .get<{ count: number }>()?.count, 1)
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
      retirement_evidence_digest: value.repository.readEngineTerminalCandidate(value.runId)?.candidateDigest,
      continuation_blocked_reason: 'publication_diverged',
      continuation_blocked_evidence_digest: value.repository.readEngineTerminalCandidate(value.runId)?.candidateDigest,
    })
    const successor = value.repository.readActiveAliasBinding(value.scopeId)
    assert.equal(successor?.aliasGeneration, 2)
    assert.equal(successor?.materializationKind, 'fresh_root_with_tail')
    assert.equal(successor?.codexThreadId, null)
    assert.notEqual(successor?.threadBindingId, value.threadBindingId)
    assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE content = ?`)
      .get<{ count: number }>(value.finalText)?.count, 0)
  } finally {
    value.db.close()
  }
})

test('compacted verifier failures atomically block history without forking and allow reset', async (t) => {
  for (const outcome of ['block', 'provider_unavailable', 'result_unknown', 'identity_drift'] as const) {
    const value = await fixture(t, `compacted-${outcome}`)
    if (!value) return
    try {
      value.repository.recordToolPublicationReceipt({ readyRunId: value.runId, recordedAt: verifiedAt })
      const attempt = settle(value, outcome)
      const terminalReason = outcome === 'identity_drift' ? 'persistence_failed'
        : outcome === 'block' ? 'proof_gap' : 'blocked_external'
      const terminalEvidence = lifecycleTerminalEvidence(value.repository, value.runId, {
        terminal: 'error', terminalReason,
        failureKind: resolveCodexProductFailureKind({ terminal: 'error', terminalReason }),
        nativeThread: completedNativeThread(value, true),
      })
      assert.equal(terminalEvidence.terminalFacts.history.kind, 'unknown_reset_required')
      assert.deepEqual(terminalEvidence.nativeReadback.contextCompactionItemIds, ['compact-item'])
      let rollbackAfterHistoryWrite = true
      const closeout = new AgentSessionCheckpointRepository(value.accessor, {
        complete(input) {
          assert.equal(value.db.inTransaction, true)
          const result = value.repository.completeVerifierRejectedCloseoutInOpenTransaction({
            ...input, terminalEvidence,
          })
          assert.equal(result.forkTargetThreadBindingId, null)
          if (rollbackAfterHistoryWrite) throw new Error('test_after_history_write')
        },
      })
      const close = (verifierReceiptDigest = attempt.receiptDigest!) => commitCanonicalCodexFailure(closeout, {
        parentTaskId: value.taskId, ownerRunId: value.runId, conversationId: value.scopeId,
        status: 'error', terminalReason, initiator: 'codex_browser_verifier', durationMs: 1,
        taskType: 'direct_answer', module: 'system', error: `codex_browser_verifier_${outcome}`,
        verifierReceiptDigest, now: closeoutAt,
      })
      const priorHead = value.repository.readHeadActionFacts({
        aliasId: value.scopeId, aliasGeneration: 1,
        currentRuntimeManifestDigest: value.runtimeManifestDigest,
        currentProtocolSchemaDigest: value.protocolSchemaDigest,
      })
      await assert.rejects(() => close('f'.repeat(64)), /browser_verifier_failure_closeout_mismatch/)
      await assert.rejects(close, /test_after_history_write/)
      assert.equal(value.repository.readProductCloseout(value.runId), null)
      assert.equal(value.repository.readTerminalCloseoutEvidence(value.runId), null)
      assert.deepEqual(value.db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`).get(value.runId), { status: 'running' })
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 1)
      rollbackAfterHistoryWrite = false
      await close()
      const facts = value.repository.readTerminalCloseoutEvidence(value.runId)?.terminalFacts
      assert.equal(facts?.product.terminal, 'error')
      assert.equal(facts?.product.terminalReason, terminalReason)
      assert.equal(facts?.history.kind, 'unknown_reset_required')
      assert.deepEqual(value.db.prepare(`SELECT status, terminal_reason FROM run_meta WHERE run_id = ?`)
        .get(value.runId), { status: 'error', terminal_reason: terminalReason })
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`)
        .get<{ count: number }>()?.count, 1)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_native_coverage_receipts`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 0)
      const headFacts = value.repository.readHeadActionFacts({
        aliasId: value.scopeId, aliasGeneration: 1,
        currentRuntimeManifestDigest: priorHead.currentRuntimeManifestDigest,
        currentProtocolSchemaDigest: priorHead.currentProtocolSchemaDigest,
      })
      assert.equal(headFacts.actionProjectionSequence, priorHead.actionProjectionSequence + 1)
      const head = projectCodexHeadActionProjection(headFacts)
      assert.equal(head.historyState, 'terminal_unknown')
      assert.deepEqual(head.actions.send_new_message.blockers, ['terminal_history_unknown'])
      const read = value.repository.readLifecycleOperation({ aliasId: value.scopeId, aliasGeneration: 1 })
      const lifecycle = projectCodexLifecycleOperationV2({
        base: {
          identity: read.identity, activeReadyRunId: read.activeReadyRunId,
          latestReadyRunId: read.latestReadyRunId, snapshot: classifyLifecycleOperation(read.facts),
          interruptRequested: read.interruptRequested, interruptAcknowledged: read.interruptAcknowledged,
          requestedAction: read.requestedAction, evidenceDigest: digestCanonicalJson(read),
        },
        head, scopeEpoch: headFacts.scopeEpoch, threadBindingId: headFacts.threadBindingId,
        headRevision: headFacts.headRevision, materializationIntentRef: headFacts.materializationIntentRef ?? null,
      })
      assert.equal(lifecycle.actions.reset.availability, 'ready')
      assert.equal(lifecycle.actions.reset.requestRef?.ownerKind, 'head_owner')
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE content = ?`)
        .get<{ count: number }>(value.finalText)?.count, 0)
    } finally {
      value.db.close()
    }
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
          value.repository.completeLifecycleActionCloseoutInOpenTransaction({
            ...input,
            action,
            terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
              action, terminal: 'interrupted', terminalReason: 'cancelled_user',
              failureKind: 'cancelled',
            }),
          })
        },
      })
      const committed = await commitCanonicalCodexFailure(closeout, {
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
      assert.equal(lifecycle.newGeneration, action === 'close' ? null : 2)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
        .get<{ count: number }>()?.count, 1)
      assert.equal(value.db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 0)
      assert.deepEqual(value.db.prepare(`SELECT status FROM browser_tasks WHERE id = ?`)
        .get(value.route.browserTaskId), { status: 'cancelled' })
      const beforeIngress = value.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_thread_bindings
         WHERE ready_conversation_alias = ?
      `).get<{ count: number }>(value.scopeId)?.count
      assert.equal(beforeIngress, action === 'close' ? 1 : 2, action)
      const successor = value.repository.refreshPristineFreshStartHeadAtomic({
        aliasId: value.scopeId,
        runtimeManifestDigest: value.runtimeManifestDigest,
        protocolSchemaDigest: value.protocolSchemaDigest,
        createdAt: '2026-08-11T05:03:00.000Z',
      })
      if (action === 'close') {
        assert.equal(successor.kind, 'missing')
      } else {
        assert.equal(successor.kind, 'current')
        assert.ok('binding' in successor)
        assert.equal(successor.binding.aliasGeneration, 2)
        assert.equal(successor.binding.codexThreadId, null)
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
          terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
            action: 'reset', terminal: 'interrupted', terminalReason: 'cancelled_user',
            failureKind: 'cancelled',
          }),
        })
        throw new Error('forced_participant_failure')
      },
    })
    await assert.rejects(() => commitCanonicalCodexFailure(rejected, {
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
          terminalEvidence: lifecycleTerminalEvidence(value.repository, value.runId, {
            action: 'reset', terminal: 'interrupted', terminalReason: 'cancelled_user',
            failureKind: 'cancelled',
          }),
        })
      },
    })
    await commitCanonicalCodexFailure(retry, {
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
