import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  CodexBindingRepositoryError,
  type CodexAdmittedBindingInput,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  clearLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import {
  buildReadyToolSurface,
  buildReadyTurnToolAuthorization,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import {
  buildReadyToolActionAbsenceEvidenceDigest,
  CodexToolActionJournal,
} from '../main/modules/agent-control/codex-runtime/codex-tool-action-journal'
import { buildCodexToolActionIdentity } from '../main/modules/agent-control/codex-runtime/codex-tool-action-identity'
import {
  CodexReadyToolBridge,
  CodexToolBridgeError,
  mapReadyToolOutput,
} from '../main/modules/agent-control/codex-runtime/codex-tool-bridge'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import { CodexDurableStartDispatchPort } from '../main/modules/agent-control/codex-runtime/codex-durable-start-dispatch'
import {
  CodexProductRunPreparer,
  type PreparedCodexProductRun,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { DELEGABLE_LARK_CLI_VERSION } from '../main/modules/agent-control/safety/lark-cli-command-policy'
import {
  readCodexPreparedActionAuthorizationEnvelope,
  retireCodexAliasForClose,
  resolveCodexProductTurnAuthorization,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import { readActionAuthorizationModeFromEnvelope } from '../shared/action-authorization-mode'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import type {
  CodexNativeNotification,
  CodexNativeRuntime,
  CodexThread,
  CodexTurn,
} from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { normalizeCodexTurn } from '../main/modules/agent-control/codex-runtime/codex-native-runtime'
import { CodexTurnCollector } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { classifyLifecycleOperation } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import { ActiveAIProfileMutationGuard } from '../main/modules/settings-engine/active-ai-profile-mutation-guard'
import { closeCodexConversationScopeInOpenTransaction } from '../main/modules/agent-control/codex-runtime/codex-conversation-scope-closure'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

type NativeDb = import('better-sqlite3').Database

const admittedAt = '2026-08-07T01:00:00.000Z'

function prepared(runId = 'run-1'): PreparedCodexProductRun {
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-1',
    toolDefinitions: [],
  })
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
    readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-1',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: readyToolSurface,
    }),
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
  const { ingressAdmittedDigest: overrideDigest, ...otherOverrides } = overrides
  const input = {
    prepared: run,
    reservation,
    ownerMainBootId: 'main-boot-1',
    admittedAt,
    ingressAdmittedRevision: 1,
    messageVisibilityEpoch: 0,
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
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: 'hello',
      messageTimestamp: admittedAt,
      messageMetaDigest: digestCanonicalJson({}),
      executionBindingDigest: digestCanonicalJson({ schemaVersion: 1, runId: run.runId }),
    },
    ...otherOverrides,
  }
  return {
    ...input,
    ingressAdmittedDigest: overrideDigest || buildCodexIngressAdmittedDigest(input),
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

function recordCompletedTerminal(
  db: NativeDb,
  repository: CodexBindingRepository,
  readyRunId = 'run-1',
  codexTurnId = 'turn-native-1',
  usedToolCalls: Array<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
    responseDigest?: string | null
  }> = [],
): string {
  const candidateText = 'done'
  const messageId = `assistant:task-${readyRunId}:${readyRunId}:terminal`
  const meta = {
    taskId: `task-${readyRunId}`,
    runId: readyRunId,
    terminalReason: 'completed',
  }
  repository.recordEngineTerminalCandidate({
    readyRunId,
    codexThreadId: 'thread-native-1',
    codexTurnId,
    engineOutcome: 'completed',
    candidate: {
      kind: 'native_terminal',
      readyTaskId: `task-${readyRunId}`,
      readyRunId,
      scopeId: 'scope-1',
      codexThreadId: 'thread-native-1',
      codexTurnId,
      engineOutcome: 'completed',
      candidateSelection: { kind: 'accepted', itemId: 'final-1' },
      candidateText,
      candidateDigest: createHash('sha256').update(candidateText).digest('hex'),
      usedToolCalls,
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
        finalDeltaItemIds: [],
        commentaryItemIds: [],
        nativeTurnError: null,
      },
    },
    recordedAt: admittedAt,
  })
  repository.recordToolPublicationReceipt({
    readyRunId,
    recordedAt: admittedAt,
  })
  db.prepare(`
    INSERT OR IGNORE INTO chat_messages (
      id, conversation_id, role, content, timestamp, meta_json,
      message_visibility_epoch
    ) VALUES (?, 'scope-1', 'assistant', ?, ?, ?, 0)
  `).run(messageId, candidateText, admittedAt, JSON.stringify(meta))
  return workflowDigest({
    id: messageId,
    conversationId: 'scope-1',
    role: 'assistant',
    content: candidateText,
    timestamp: admittedAt,
    meta,
  })
}

function nativeFailureCandidate(
  run: PreparedCodexProductRun,
  engineOutcome: 'completed' | 'interrupted' | 'failed',
  usedToolCalls: Array<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
  }> = [],
) {
  return {
    kind: 'native_terminal' as const,
    readyTaskId: run.taskId,
    readyRunId: run.runId,
    scopeId: run.readyToolHostIdentity.scopeId,
    codexThreadId: 'thread-native-1',
    codexTurnId: 'turn-native-1',
    engineOutcome,
    candidateSelection: { kind: 'none' as const, code: 'no_legal_candidate' },
    candidateText: null,
    candidateDigest: null,
    usedToolCalls,
    actionReceiptRefs: [],
    interactionState: null,
    waitingFor: null,
    terminalReasonCandidate: engineOutcome === 'interrupted' ? 'cancelled_runtime' : 'blocked_external',
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
      finalDeltaItemIds: [],
      commentaryItemIds: [],
      nativeTurnError: engineOutcome,
    },
  }
}

function preparePublicationRecoveryFixture(
  db: NativeDb,
  repository: CodexBindingRepository,
  input: {
    runId: string
    admittedCalls?: Array<{ codexCallId: string; toolName: string; argsDigest: string }>
    currentDocumentAnchor?: NonNullable<Extract<
      PreparedCodexProductRun['ingress'],
      { kind: 'user_ingress' }
    >['currentDocumentAnchor']>
  },
) {
  const run = prepared(input.runId)
  const admittedCalls = input.admittedCalls || []
  if (run.ingress.kind !== 'user_ingress') throw new Error('expected_user_ingress')
  if (input.currentDocumentAnchor) {
    const anchor = input.currentDocumentAnchor
    const reference = {
      logicalResourceId: anchor.logicalResourceId,
      currentVersion: anchor.currentVersion,
      currentDigest: anchor.currentDigest,
      supersedesVersion: anchor.supersedesVersion,
      policyEpoch: anchor.policyEpoch,
    }
    run.ingress.explicitResourceEnvelope.resourceRefs = [reference]
    run.ingress.resourceAdditionalContext = [reference]
    run.ingress.currentDocumentAnchor = anchor
    run.resourceAnchorDigest = createHash('sha256').update(JSON.stringify({
      explicitResourceEnvelope: run.ingress.explicitResourceEnvelope,
      resourceAdditionalContext: run.ingress.resourceAdditionalContext,
      currentDocumentAnchor: anchor,
    })).digest('hex')
  }
  run.readyToolSurface = buildReadyToolSurface({
    surfaceId: `surface-${input.runId}`,
    toolDefinitions: [{
      name: 'ready_read', groupId: 'agent_interaction', domain: 'document', kind: 'read',
      concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
      supportsTextBridge: true, projectionHint: null, description: 'Read fixture',
      schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
    }],
  })
  run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
    authorizationId: `authorization-${input.runId}`,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    toolSurface: run.readyToolSurface,
  })
  prepareReadyParents(db, repository, run)
  repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
  repository.activateStartDispatch({
    connectionEpoch: 'epoch-recovery', rpcId: 1, method: 'thread/start',
    bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
    requestDigest: `thread-request-${input.runId}`, dispatchedAt: admittedAt,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: 'epoch-recovery', rpcId: 1, method: 'thread/start',
    bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
    nativeResult: { thread: rootThread(), instructionSources: [] },
    responseDigest: `thread-response-${input.runId}`, responsePending: false, reconciledAt: admittedAt,
  })
  repository.activateStartDispatch({
    connectionEpoch: 'epoch-recovery', rpcId: 2, method: 'turn/start',
    bindingLookupKey: run.runId, requestDigest: `turn-request-${input.runId}`,
    dispatchedAt: admittedAt,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: 'epoch-recovery', rpcId: 2, method: 'turn/start',
    bindingId: run.runId, nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
    responseDigest: `turn-response-${input.runId}`, responsePending: false, reconciledAt: admittedAt,
  })
  if (admittedCalls.length > 0) {
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', 'thread-native-1', 'turn-native-1', ?, NULL, ?, ?, ?, ?)
    `).run(
      `gateway-${input.runId}`, input.runId, 'snapshot-ref', 'snapshot-digest',
      `request-digest-${input.runId}`, admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: `gateway-${input.runId}`,
      readyRunId: input.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      calls: admittedCalls,
      admittedAt,
    })
  }
  return { run, executionBinding: repository.readToolBridgeExecutionBinding(run.runId) }
}

function insertRawPublicationToolBinding(
  db: NativeDb,
  input: {
    run: PreparedCodexProductRun
    executionBinding: ReturnType<CodexBindingRepository['readToolBridgeExecutionBinding']>
    admittedCall: { codexCallId: string; toolName: string; argsDigest: string }
    readyActionId: string
    readyTaskId?: string
  },
): void {
  db.prepare(`
    INSERT INTO codex_tool_call_bindings (
      codex_thread_id, codex_turn_id, codex_call_id, ready_run_id, ready_action_id,
      tool_name, args_digest, turn_contract_digest, ready_alias_id, codex_session_id,
      ready_task_id, surface_snapshot_digest, tool_surface_digest,
      authorization_snapshot_digest, tool_schema_digest, request_connection_epoch,
      request_rpc_id, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    'thread-native-1', 'turn-native-1', input.admittedCall.codexCallId, input.run.runId,
    input.readyActionId, input.admittedCall.toolName, input.admittedCall.argsDigest,
    `turn-contract-${input.run.runId}`, input.run.conversationAlias.aliasId,
    'thread-native-1', input.readyTaskId || input.run.taskId,
    input.executionBinding.toolSurface.surfaceSnapshotDigest,
    input.executionBinding.toolSurface.toolSurfaceDigest,
    input.executionBinding.authorization.authorizationSnapshotDigest,
    input.executionBinding.toolSurface.entries[0].schemaDigest,
    'epoch-recovery', '3', admittedAt, admittedAt,
  )
}

function prepareReadyParentRowsOnly(
  db: NativeDb,
  run: PreparedCodexProductRun,
  messageVisibilityEpoch = 0,
): void {
  const executionBinding = JSON.stringify({ schemaVersion: 1, runId: run.runId })
  db.prepare(`INSERT OR IGNORE INTO chat_conversations (id) VALUES (?)`).run(
    run.readyToolHostIdentity.scopeId,
  )
  db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, message_visibility_epoch
    ) VALUES (?, ?, ?)
  `).run(
    run.ingress.originUserMessageId,
    run.readyToolHostIdentity.scopeId,
    messageVisibilityEpoch,
  )
  db.prepare(`
    INSERT INTO task_projections (
      task_id, run_id, scope_id, status, execution_binding_json,
      message_visibility_epoch
    ) VALUES (?, ?, ?, 'running', ?, ?)
  `).run(
    run.taskId,
    run.runId,
    run.readyToolHostIdentity.scopeId,
    executionBinding,
    messageVisibilityEpoch,
  )
  db.prepare(`
    INSERT INTO run_meta (
      run_id, task_id, scope_id, status, execution_binding_json,
      message_visibility_epoch
    ) VALUES (?, ?, ?, 'running', ?, ?)
  `).run(
    run.runId,
    run.taskId,
    run.readyToolHostIdentity.scopeId,
    executionBinding,
    messageVisibilityEpoch,
  )
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
  options: { includeToolResponseEvidence?: boolean } = {},
): Promise<void> {
  if (skipIfSqliteUnavailable(t, 'Codex binding repository')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'local',
        source_id TEXT NOT NULL DEFAULT '',
        thread_key TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT 'ready',
        meta_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT '2026-08-07T01:00:00.000Z'
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL DEFAULT 'hello',
        timestamp TEXT NOT NULL DEFAULT '2026-08-07T01:00:00.000Z',
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        interaction_state TEXT NOT NULL DEFAULT 'running',
        waiting_for TEXT NOT NULL DEFAULT 'none',
        degradation_reason TEXT,
        blocked_reason TEXT,
        continuation_ref_json TEXT,
        resumable_actions_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 0,
        execution_binding_json TEXT
      );
      CREATE TABLE run_meta (
        run_id TEXT PRIMARY KEY,
        task_id TEXT,
        scope_id TEXT,
        status TEXT NOT NULL,
        terminal_reason TEXT,
        initiator TEXT,
        duration_ms INTEGER,
        continuation_ref_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        execution_binding_json TEXT
      );
      CREATE TABLE browser_tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL
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
    __runMigrationForTests('099_codex_thread_resume_evidence', db as unknown as MigrationDatabase)
    __runMigrationForTests('100_codex_thread_resume_active_lease', db as unknown as MigrationDatabase)
    __runMigrationForTests('101_codex_manual_compaction_item_identity', db as unknown as MigrationDatabase)
    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)
    if (options.includeToolResponseEvidence !== false) {
      __runMigrationForTests('103_codex_tool_response_evidence', db as unknown as MigrationDatabase)
    }
    __runMigrationForTests('104_codex_product_recovery_failure', db as unknown as MigrationDatabase)
    __runMigrationForTests('105_codex_tool_response_delivery_attempts', db as unknown as MigrationDatabase)
    __runMigrationForTests('106_codex_browser_verifier_receipts', db as unknown as MigrationDatabase)
    __runMigrationForTests('107_codex_turn_lifecycle_action', db as unknown as MigrationDatabase)
    __runMigrationForTests('108_codex_thread_retirement_cleanup', db as unknown as MigrationDatabase)
    __runMigrationForTests('110_codex_tool_request_rpc_binding', db as unknown as MigrationDatabase)
    await work(db, new CodexBindingRepository(db as unknown as DatabaseConnection))
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
}

function createThreadTransitionProfile(input: {
  profileId: string
  model: string
  reasoningEffort: 'medium' | 'high'
  contextWindowOverride: number
  maxOutputTokensOverride: number
}) {
  return createCodexUpstreamProfileSnapshot({
    profileId: input.profileId,
    config: {
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:10532/v1',
      apiKey: 'ready-oauth-proxy-key-12345678901234567890',
      model: input.model,
      authMode: 'chatgpt-oauth',
      agentProtocol: 'openai',
      wireApi: 'responses',
      reasoningEffort: input.reasoningEffort,
      contextWindowOverride: input.contextWindowOverride,
      maxOutputTokensOverride: input.maxOutputTokensOverride,
      toolUseMode: 'on',
      nativeVideoMode: 'off',
    },
    maxRetries: 0,
  })
}

function startAndCloseInitialProductTurn(
  db: NativeDb,
  repository: CodexBindingRepository,
): void {
  repository.activateStartDispatch({
    connectionEpoch: 'epoch-transition', rpcId: 1, method: 'thread/start',
    bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
    requestDigest: 'thread-transition-request', dispatchedAt: admittedAt,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: 'epoch-transition', rpcId: 1, method: 'thread/start',
    bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
    nativeResult: { thread: rootThread(), instructionSources: [] },
    responseDigest: 'thread-transition-response', responsePending: false,
    reconciledAt: admittedAt,
  })
  repository.activateStartDispatch({
    connectionEpoch: 'epoch-transition', rpcId: 2, method: 'turn/start',
    bindingLookupKey: 'run-1', requestDigest: 'turn-transition-request',
    dispatchedAt: admittedAt,
  })
  repository.reconcileStartAccepted({
    connectionEpoch: 'epoch-transition', rpcId: 2, method: 'turn/start',
    bindingId: 'run-1', nativeId: 'turn-native-1',
    nativeResult: { turn: activeTurn() }, responseDigest: 'turn-transition-response',
    responsePending: false, reconciledAt: admittedAt,
  })
  const productTerminalDigest = recordCompletedTerminal(db, repository)
  db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
  repository.completeProductTurnCloseout({
    readyRunId: 'run-1', productTerminalDigest, closeoutAt: admittedAt,
  })
}

function seedClosedAuthoritativeTurn(
  db: NativeDb,
  input: {
    readyRunId: string
    upstreamProfileSnapshotRef: string
    upstreamProfileSnapshotDigest: string
    createdAt: string
  },
): void {
  const run = prepared(input.readyRunId)
  prepareReadyParentRowsOnly(db, run)
  db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(run.taskId)
  db.prepare(`UPDATE run_meta SET status = 'completed' WHERE run_id = ?`).run(run.runId)
  const terminalCandidate = { type: 'assistant_message', text: 'latest turn complete' }
  const terminalDigest = digestCanonicalJson(terminalCandidate)
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id, codex_thread_id, codex_turn_id,
      start_reservation_set_id, start_reservation_required_member_count,
      turn_start_reservation_member_id, turn_start_reservation_admitted_at,
      turn_request_id, turn_start_rpc_connection_epoch, turn_start_rpc_id,
      turn_start_dispatch_intent_at, turn_start_response_at, turn_start_reconciled_at,
      turn_start_reconciliation_evidence_digest,
      product_terminal_digest, product_closeout_at, origin_user_message_id,
      ingress_admitted_revision, ingress_admitted_digest, ingress_admitted_at,
      attempt_kind, tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json, effective_codex_model,
      effective_upstream_snapshot_ref, effective_upstream_snapshot_digest,
      additional_context_digest, turn_contract_digest, ingress_json,
      engine_terminal_status, engine_terminal_candidate_json,
      engine_terminal_candidate_digest, engine_terminal_recorded_at,
      fence_release_revision, revision, created_at, updated_at
    )
    SELECT
      ?, ?, thread_binding_id, codex_thread_id, ?,
      ?, 1, ?, ?,
      ?, ?, 3, ?, ?, ?,
      ?,
      ?, ?, ?,
      1, ?, ?,
      'user_ingress', tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json, effective_codex_model,
      ?, ?,
      ?, ?, ingress_json,
      'completed', ?, ?, ?,
      2, 1, ?, ?
      FROM codex_turn_bindings
     WHERE ready_run_id = 'run-1'
  `).run(
    run.runId,
    run.taskId,
    `turn-native-${run.runId}`,
    `set-${run.runId}`,
    `turn-member-${run.runId}`,
    input.createdAt,
    `turn-request-${run.runId}`,
    `epoch-${run.runId}`,
    input.createdAt,
    input.createdAt,
    input.createdAt,
    `reconciliation-${run.runId}`,
    terminalDigest,
    input.createdAt,
    run.ingress.originUserMessageId,
    `ingress-${run.runId}`,
    input.createdAt,
    input.upstreamProfileSnapshotRef,
    input.upstreamProfileSnapshotDigest,
    `additional-context-${run.runId}`,
    `turn-contract-${run.runId}`,
    JSON.stringify(terminalCandidate),
    terminalDigest,
    input.createdAt,
    input.createdAt,
    input.createdAt,
  )
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
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_tool_execution') },
        confirmServerResponseTransportWrite() {},
      },
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
    await assert.rejects(inboundBuffer.routeNotification({
      connectionEpoch: 'epoch-unknown',
      frame: conflicting,
      notification: conflicting,
    }), /thread_metadata_conflict/)
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

test('provisional capacity rejects start before writing a durable dispatch intent', async (t) => {
  await withRepository(t, async (db, repository) => {
    const registry = new CodexStartIdentityRegistry({ capacity: 4 })
    const reserved = registry.reserve({ scopeId: 'scope-1', existingThread: false })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) throw new Error(reserved.code)
    const run = prepared('run-capacity-preflight')
    run.ingressBinding = {
      requestId: 'request-run-capacity-preflight',
      reservationSetId: reserved.reservation.reservationSetId,
      reservationEvidenceDigest: reserved.reservation.reservationEvidenceDigest,
    }
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, reserved.reservation))
    const inboundBuffer = new CodexProvisionalInboundBuffer({
      maxFramesPerOwner: 8,
      maxBytesPerOwner: 16_384,
      maxActiveOwners: 1,
      nowMs: () => Date.parse(admittedAt),
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_tool_execution') },
        confirmServerResponseTransportWrite() {},
      },
      startInboundQuarantinePort: { quarantine() {} },
    })
    inboundBuffer.registerProvisionalTurn({
      bindingId: 'capacity-holder',
      connectionEpoch: 'epoch-holder',
      threadId: 'thread-holder',
      clientUserMessageId: 'message-holder',
      deadlineAtMs: Date.parse(admittedAt) + 5_000,
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

    await assert.rejects(dispatch.activate({
      connectionEpoch: 'epoch-capacity',
      rpcId: 1,
      method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-capacity',
    }), /provisional_owner_capacity_exhausted/)
    assert.deepEqual(db.prepare(`
      SELECT thread_start_dispatch_intent_at, thread_start_rpc_connection_epoch,
             thread_start_rpc_id
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), {
      thread_start_dispatch_intent_at: null,
      thread_start_rpc_connection_epoch: null,
      thread_start_rpc_id: null,
    })
    assert.equal(registry.snapshot().members.every((member) => member.state === 'held'), true)
  })
})

test('product admission can join the Ready ingress transaction and rolls back every child row', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-ingress-uow')
    db.prepare(`INSERT INTO chat_conversations (id) VALUES (?)`).run('scope-1')
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      readyScopeId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })

    assert.throws(
      () => repository.admitProductBindingsInOpenTransaction(
        admission(run, lazyReservation(run.runId)),
      ),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'product_admission_transaction_missing',
    )

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`
      INSERT INTO chat_messages (
        id, conversation_id, message_visibility_epoch
      ) VALUES (?, ?, 0)
    `)
      .run(run.ingress.originUserMessageId, 'scope-1')
    db.prepare(`
      INSERT INTO task_projections (
        task_id, run_id, scope_id, status, execution_binding_json,
        message_visibility_epoch
      ) VALUES (?, ?, ?, 'running', ?, 0)
    `).run(run.taskId, run.runId, 'scope-1', JSON.stringify({ schemaVersion: 1, runId: run.runId }))
    db.prepare(`
      INSERT INTO run_meta (
        run_id, task_id, scope_id, status, execution_binding_json,
        message_visibility_epoch
      ) VALUES (?, ?, ?, 'running', ?, 0)
    `).run(run.runId, run.taskId, 'scope-1', JSON.stringify({ schemaVersion: 1, runId: run.runId }))
    assert.deepEqual(
      repository.admitProductBindingsInOpenTransaction(
        admission(run, lazyReservation(run.runId)),
      ),
      { threadBindingId: 'thread-binding-1', readyRunId: run.runId, threadState: 'unstarted' },
    )
    db.exec('ROLLBACK')

    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM task_projections`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM run_meta`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.deepEqual(repository.readActiveAliasBinding('scope-1'), {
      threadBindingId: 'thread-binding-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      readyScopeId: 'scope-1',
      codexThreadId: null,
      codexSessionId: null,
      isolatedThreadCwd: null,
      toolSurface: null,
      hasActiveFence: false,
      continuationBlockedAt: null,
      continuationBlockedReason: null,
      retiredAt: null,
    })
  })
})

test('empty alias creation joins the canonical conversation transaction', async (t) => {
  await withRepository(t, (db, repository) => {
    const alias = {
      threadBindingId: 'thread-binding-atomic-alias',
      aliasId: 'scope-atomic-alias',
      aliasGeneration: 1,
      readyScopeId: 'scope-atomic-alias',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    }
    assert.throws(
      () => repository.createEmptyAliasGenerationInOpenTransaction(alias),
      /alias_create_transaction_missing/,
    )
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`INSERT INTO chat_conversations (id) VALUES (?)`).run(alias.aliasId)
    repository.createEmptyAliasGenerationInOpenTransaction(alias)
    db.exec('ROLLBACK')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_conversations`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`)
      .get<{ count: number }>()?.count, 0)
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
      serverRequestExecutor: {
        async executeServerRequest() { throw new Error('unexpected_tool_execution') },
        confirmServerResponseTransportWrite() {},
      },
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
    assert.throws(() => inboundBuffer.expireDue(), /provisional_buffer_deadline_exceeded/)
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

test('migrations 088-110 create Codex-owned tables and immutable binding evidence', async (t) => {
  await withRepository(t, (db, repository) => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'codex_%' ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(tables.map((row) => row.name), [
      'codex_browser_verifier_attempts',
      'codex_fence_owner_transfers',
      'codex_manual_compaction_bindings',
      'codex_manual_compaction_dispatch_attempts',
      'codex_sidecar_process_leases',
      'codex_thread_archive_attempts',
      'codex_thread_archive_intents',
      'codex_thread_bindings',
      'codex_thread_dispatch_fences',
      'codex_thread_resume_evidence',
      'codex_tool_call_admissions',
      'codex_tool_call_bindings',
      'codex_tool_group_admissions',
      'codex_tool_request_rpc_bindings',
      'codex_tool_response_delivery_attempts',
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
      () => db.prepare(`
        UPDATE codex_turn_bindings SET lifecycle_action = 'stop'
         WHERE ready_run_id = 'run-1'
      `).run(),
      /codex_turn_lifecycle_action_pair_invalid|CHECK constraint failed/,
    )
    db.prepare(`
      UPDATE codex_turn_bindings
         SET lifecycle_action = 'stop', lifecycle_action_requested_at = ?,
             lifecycle_action_evidence_digest = ?
       WHERE ready_run_id = 'run-1'
    `).run(admittedAt, 'a'.repeat(64))
    assert.throws(
      () => db.prepare(`
        UPDATE codex_turn_bindings SET lifecycle_action = 'close'
         WHERE ready_run_id = 'run-1'
      `).run(),
      /codex_turn_lifecycle_action_immutable/,
    )
    assert.throws(
      () => db.prepare(`DELETE FROM codex_thread_bindings WHERE thread_binding_id = ?`).run(
        'thread-binding-1',
      ),
      /codex_thread_binding_delete_forbidden/,
    )
  })
})

test('migration 103 marks only open legacy failed delivery evidence for safe retirement', async (t) => {
  for (const variant of ['legacy_failed', 'completed', 'closed', 'not_delivered', 'new_digest'] as const) {
    await withRepository(t, async (db, repository) => {
      const admittedCall = {
        codexCallId: `call-migration-103-${variant}`,
        toolName: 'ready_read',
        argsDigest: `args-migration-103-${variant}`,
      }
      const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
        runId: `run-migration-103-${variant}`,
        admittedCalls: [admittedCall],
      })
      const callWithoutActionId = {
        codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
        codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
        readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
        readyTaskId: run.taskId, toolName: admittedCall.toolName,
        argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
        surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
        toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
        authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
        toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
        requestConnectionEpoch: 'epoch-recovery', requestRpcId: '6', at: admittedAt,
      }
      const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
      const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
      repository.bindToolCall(call)
      const output = createToolExecutionOutput('blocked', {
        data: { errorKind: 'denied_manual_only' },
      })
      const resultDigest = digestCanonicalJson(output)
      const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
      await journal.begin({
        readyActionId: call.readyActionId,
        actionIdentityDigest: actionIdentity.actionIdentityDigest,
        at: admittedAt,
      })
      const receipt = await journal.commit({
        readyActionId: call.readyActionId,
        actionIdentityDigest: actionIdentity.actionIdentityDigest,
        resultDigest,
        output,
        at: admittedAt,
      })
      repository.completeToolCall({
        codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId, receiptId: receipt.receiptId,
        resultDigest, at: admittedAt,
      })
      const toolResponseDigest = digestCanonicalJson(mapReadyToolOutput(output))
      if (variant !== 'not_delivered') {
        db.prepare(`
          UPDATE codex_tool_call_bindings
             SET delivered_connection_epoch = ?, delivered_rpc_id = ?,
                 tool_response_digest = ?, delivery_intent_at = ?,
                 revision = revision + 1, updated_at = ?
           WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
        `).run(
          call.requestConnectionEpoch,
          call.requestRpcId,
          variant === 'new_digest' ? toolResponseDigest : null,
          admittedAt,
          admittedAt,
          call.codexThreadId,
          call.codexTurnId,
          call.codexCallId,
        )
      }
      const completed = variant === 'completed'
      const usedToolCalls = [{
        itemId: call.codexCallId,
        tool: call.toolName,
        status: completed ? 'completed' : 'failed',
        success: false,
        ...(variant === 'new_digest' ? { responseDigest: toolResponseDigest } : {}),
      }]
      repository.recordEngineTerminalCandidate({
        readyRunId: run.runId, codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId,
        engineOutcome: completed ? 'completed' : 'failed',
        candidate: nativeFailureCandidate(run, completed ? 'completed' : 'failed', usedToolCalls),
        recordedAt: admittedAt,
      })
      if (variant === 'closed') {
        db.prepare(`
          UPDATE codex_turn_bindings
             SET product_terminal_digest = ?, product_closeout_at = ?,
                 revision = revision + 1, updated_at = ?
           WHERE ready_run_id = ?
        `).run('legacy-product-terminal', admittedAt, admittedAt, run.runId)
      }

      __runMigrationForTests('103_codex_tool_response_evidence', db as unknown as MigrationDatabase)
      const marked = db.prepare(`
        SELECT legacy_delivery_evidence_unverifiable AS marked
          FROM codex_tool_call_bindings WHERE ready_action_id = ?
      `).get<{ marked: number }>(call.readyActionId)?.marked
      assert.equal(marked, variant === 'legacy_failed' ? 1 : 0)
      if (variant === 'legacy_failed') {
        assert.throws(
          () => db.prepare(`
            INSERT INTO codex_tool_call_bindings (
              codex_thread_id, codex_turn_id, codex_call_id, ready_run_id,
              ready_action_id, tool_name, args_digest, turn_contract_digest,
              ready_alias_id, codex_session_id, ready_task_id,
              surface_snapshot_digest, tool_surface_digest,
              authorization_snapshot_digest, tool_schema_digest,
              request_connection_epoch, request_rpc_id,
              delivered_connection_epoch, delivered_rpc_id,
              tool_response_digest, legacy_delivery_evidence_unverifiable,
              delivery_intent_at, revision, created_at, updated_at
            )
            SELECT codex_thread_id, codex_turn_id, codex_call_id || '-fresh', ready_run_id,
                   ready_action_id || '-fresh', tool_name, args_digest, turn_contract_digest,
                   ready_alias_id, codex_session_id, ready_task_id,
                   surface_snapshot_digest, tool_surface_digest,
                   authorization_snapshot_digest, tool_schema_digest,
                   request_connection_epoch, request_rpc_id,
                   delivered_connection_epoch, delivered_rpc_id,
                   NULL, 1, delivery_intent_at, 1, created_at, updated_at
              FROM codex_tool_call_bindings WHERE ready_action_id = ?
          `).run(call.readyActionId),
          /codex_call_delivery_evidence_invalid/,
        )
        assert.deepEqual(repository.readToolPublicationBarrier({
          readyRunId: run.runId, codexThreadId: call.codexThreadId,
          codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
        }), {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'legacy_failed_tool_delivery_unverifiable', callId: call.codexCallId,
        })
      }
    }, { includeToolResponseEvidence: false })
  }
})

test('migration 102 returns only an open Codex run from generic restart ownership', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-owner-handoff')
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    db.prepare(`
      UPDATE run_meta
         SET status = 'interrupted', initiator = 'process_exit',
             terminal_reason = 'main_process_restarted', duration_ms = 1000
       WHERE run_id = ?
    `).run(run.runId)
    db.prepare(`
      UPDATE task_projections
         SET status = 'failed', interaction_state = 'suspended', waiting_for = 'none',
             degradation_reason = 'main_process_restarted',
             blocked_reason = 'stale generic restart', resumable_actions_json = '["none"]'
       WHERE run_id = ?
    `).run(run.runId)
    db.prepare(`
      INSERT INTO task_projections (
        task_id, run_id, scope_id, status, interaction_state, waiting_for,
        degradation_reason, blocked_reason, resumable_actions_json, execution_binding_json,
        message_visibility_epoch
      ) VALUES (?, ?, ?, 'failed', 'suspended', 'none',
        'main_process_restarted', 'decoy projection', '["none"]', '{}', 0)
    `).run('task-owner-handoff-decoy', run.runId, run.readyToolHostIdentity.scopeId)

    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)

    assert.deepEqual(db.prepare(`
      SELECT status, terminal_reason, initiator, duration_ms
        FROM run_meta WHERE run_id = ?
    `).get(run.runId), {
      status: 'running', terminal_reason: null, initiator: null, duration_ms: null,
    })
    assert.deepEqual(db.prepare(`
      SELECT status, interaction_state, waiting_for, degradation_reason,
             blocked_reason, resumable_actions_json
        FROM task_projections WHERE task_id = ?
    `).get(run.taskId), {
      status: 'running', interaction_state: 'running', waiting_for: 'none',
      degradation_reason: null, blocked_reason: null, resumable_actions_json: '[]',
    })
    assert.deepEqual(db.prepare(`
      SELECT status, degradation_reason, blocked_reason
        FROM task_projections WHERE task_id = 'task-owner-handoff-decoy'
    `).get(), {
      status: 'failed',
      degradation_reason: 'main_process_restarted',
      blocked_reason: 'decoy projection',
    })

    db.prepare(`
      UPDATE task_projections
         SET status = 'failed', degradation_reason = 'main_process_restarted',
             blocked_reason = 'not paired with the generic run marker'
       WHERE run_id = ?
    `).run(run.runId)
    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)
    assert.deepEqual(db.prepare(`
      SELECT status, degradation_reason, blocked_reason
        FROM task_projections WHERE run_id = ?
    `).get(run.runId), {
      status: 'failed',
      degradation_reason: 'main_process_restarted',
      blocked_reason: 'not paired with the generic run marker',
    })
  })

  await withRepository(t, (db, repository) => {
    const run = prepared('run-owner-handoff-task-mismatch')
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    db.prepare(`
      UPDATE run_meta
         SET task_id = 'task-mismatched-owner', status = 'interrupted',
             initiator = 'process_exit', terminal_reason = 'main_process_restarted',
             duration_ms = 1000
       WHERE run_id = ?
    `).run(run.runId)
    db.prepare(`
      UPDATE task_projections
         SET status = 'failed', degradation_reason = 'main_process_restarted',
             blocked_reason = 'owner task mismatch'
       WHERE task_id = ?
    `).run(run.taskId)

    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)

    assert.deepEqual(db.prepare(`
      SELECT status, initiator, terminal_reason FROM run_meta WHERE run_id = ?
    `).get(run.runId), {
      status: 'interrupted', initiator: 'process_exit',
      terminal_reason: 'main_process_restarted',
    })
    assert.deepEqual(db.prepare(`
      SELECT status, degradation_reason, blocked_reason
        FROM task_projections WHERE task_id = ?
    `).get(run.taskId), {
      status: 'failed', degradation_reason: 'main_process_restarted',
      blocked_reason: 'owner task mismatch',
    })
  })

  await withRepository(t, (db, repository) => {
    const run = prepared('run-owner-handoff-negative-matrix')
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    db.prepare(`
      UPDATE run_meta
         SET status = 'interrupted', initiator = 'user',
             terminal_reason = 'main_process_restarted', duration_ms = 1000
       WHERE run_id = ?
    `).run(run.runId)
    db.prepare(`
      UPDATE task_projections
         SET status = 'failed', degradation_reason = 'main_process_restarted',
             blocked_reason = 'wrong initiator'
       WHERE task_id = ?
    `).run(run.taskId)
    db.prepare(`
      INSERT INTO run_meta (
        run_id, task_id, scope_id, status, initiator, terminal_reason, duration_ms,
        message_visibility_epoch
      ) VALUES (
        'run-non-codex-restart', 'task-non-codex-restart', 'scope-1',
        'interrupted', 'process_exit', 'main_process_restarted', 1000, 0
      )
    `).run()
    db.prepare(`
      INSERT INTO task_projections (
        task_id, run_id, scope_id, status, degradation_reason, blocked_reason,
        message_visibility_epoch
      ) VALUES (
        'task-non-codex-restart', 'run-non-codex-restart', 'scope-1',
        'failed', 'main_process_restarted', 'non Codex', 0
      )
    `).run()

    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)
    assert.equal(db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get<{ status: string }>(run.runId)?.status, 'interrupted')
    assert.equal(db.prepare(`SELECT status FROM task_projections WHERE task_id = ?`)
      .get<{ status: string }>(run.taskId)?.status, 'failed')
    assert.equal(db.prepare(`SELECT status FROM run_meta WHERE run_id = 'run-non-codex-restart'`)
      .get<{ status: string }>()?.status, 'interrupted')
    assert.equal(db.prepare(`
      SELECT status FROM task_projections WHERE task_id = 'task-non-codex-restart'
    `).get<{ status: string }>()?.status, 'failed')

    db.prepare(`
      UPDATE run_meta
         SET initiator = 'process_exit', terminal_reason = 'different_restart_reason'
       WHERE run_id = ?
    `).run(run.runId)
    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)
    assert.equal(db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get<{ status: string }>(run.runId)?.status, 'interrupted')
    assert.equal(db.prepare(`SELECT status FROM task_projections WHERE task_id = ?`)
      .get<{ status: string }>(run.taskId)?.status, 'failed')

    db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = 'closed-product', product_closeout_at = ?
       WHERE ready_run_id = ?
    `).run(admittedAt, run.runId)
    db.prepare(`
      UPDATE run_meta
         SET initiator = 'process_exit', terminal_reason = 'main_process_restarted'
       WHERE run_id = ?
    `).run(run.runId)
    __runMigrationForTests('102_codex_startup_owner_handoff', db as unknown as MigrationDatabase)
    assert.equal(db.prepare(`SELECT status FROM run_meta WHERE run_id = ?`)
      .get<{ status: string }>(run.runId)?.status, 'interrupted')
    assert.equal(db.prepare(`SELECT status FROM task_projections WHERE task_id = ?`)
      .get<{ status: string }>(run.taskId)?.status, 'failed')
  })
})

test('thread resume evidence binds a same-connection read before resume and is immutable', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-resume-evidence')
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    repository.activateStartDispatch({
      connectionEpoch: 'start-epoch', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-resume', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'start-epoch', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-resume', responsePending: false, reconciledAt: admittedAt,
    })
    let lease = repository.createProcessLeaseIntent({
      processLeaseId: 'resume-lease', ownerMainBootId: 'main-boot-1', ownerMainPid: 10,
      ownerMainProcessStartIdentity: 'main-process', sidecarSpawnInstanceId: 'resume-spawn',
      connectionEpoch: 'resume-epoch', runtimeManifestDigest: 'runtime-manifest-digest',
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex', spawnIntentAt: admittedAt,
      spawnVisibilityDeadlineAt: admittedAt,
    })
    lease = repository.confirmProcessLeaseOwnership({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      pid: 11, processGroupId: 11, processStartIdentity: 'sidecar-process',
      confirmedAt: admittedAt,
    })
    lease = repository.markProcessConnectionOpened({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      openedAt: admittedAt,
    })
    const evidence = repository.recordThreadResumeEvidence({
      aliasId: 'scope-1', aliasGeneration: 1, threadId: 'thread-native-1',
      connectionEpoch: 'resume-epoch',
      preResumeThreadReadDigest: 'pre-resume-read-digest',
      resumedThreadDigest: 'resumed-thread-digest', recordedAt: admittedAt,
    })
    assert.match(evidence.resumeEvidenceId, /^resume-[a-f0-9]{64}$/)
    assert.match(evidence.evidenceDigest, /^[a-f0-9]{64}$/)
    assert.deepEqual(repository.recordThreadResumeEvidence({
      aliasId: 'scope-1', aliasGeneration: 1, threadId: 'thread-native-1',
      connectionEpoch: 'resume-epoch',
      preResumeThreadReadDigest: 'pre-resume-read-digest',
      resumedThreadDigest: 'resumed-thread-digest', recordedAt: admittedAt,
    }), evidence)
    assert.throws(() => repository.recordThreadResumeEvidence({
      aliasId: 'scope-1', aliasGeneration: 1, threadId: 'thread-native-1',
      connectionEpoch: 'resume-epoch',
      preResumeThreadReadDigest: 'changed-read-digest',
      resumedThreadDigest: 'resumed-thread-digest', recordedAt: admittedAt,
    }), /thread_resume_evidence_conflict/)
    assert.throws(() => db.prepare(`
      UPDATE codex_thread_resume_evidence SET recorded_at = 'changed'
    `).run(), /codex_thread_resume_evidence_immutable/)
    assert.throws(() => db.prepare(`DELETE FROM codex_thread_resume_evidence`).run(),
      /codex_thread_resume_evidence_immutable/)

    lease = repository.markProcessConnectionClosed({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      closedAt: admittedAt,
    })
    repository.recordProcessTreeZero({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      treeZeroAt: admittedAt, matcherMode: 'post_cas',
      sampleTranscriptDigest: 'resume-tree-zero-samples',
      evidenceDigest: 'resume-tree-zero-evidence',
    })
    let closedLease = repository.createProcessLeaseIntent({
      processLeaseId: 'closed-resume-lease', ownerMainBootId: 'main-boot-1', ownerMainPid: 10,
      ownerMainProcessStartIdentity: 'main-process', sidecarSpawnInstanceId: 'closed-resume-spawn',
      connectionEpoch: 'closed-resume-epoch', runtimeManifestDigest: 'runtime-manifest-digest',
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex', spawnIntentAt: admittedAt,
      spawnVisibilityDeadlineAt: admittedAt,
    })
    closedLease = repository.confirmProcessLeaseOwnership({
      processLeaseId: closedLease.processLeaseId, expectedRevision: closedLease.revision,
      pid: 12, processGroupId: 12, processStartIdentity: 'closed-sidecar-process',
      confirmedAt: admittedAt,
    })
    closedLease = repository.markProcessConnectionOpened({
      processLeaseId: closedLease.processLeaseId, expectedRevision: closedLease.revision,
      openedAt: admittedAt,
    })
    repository.markProcessConnectionClosed({
      processLeaseId: closedLease.processLeaseId, expectedRevision: closedLease.revision,
      closedAt: admittedAt,
    })
    assert.throws(() => repository.recordThreadResumeEvidence({
      aliasId: 'scope-1', aliasGeneration: 1, threadId: 'thread-native-1',
      connectionEpoch: 'closed-resume-epoch',
      preResumeThreadReadDigest: 'closed-pre-resume-read-digest',
      resumedThreadDigest: 'closed-resumed-thread-digest', recordedAt: admittedAt,
    }), /thread_resume_evidence_parent_mismatch/)
  })
})

test('migration 094 upgrades a legacy host-failure closeout with durable readback', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex host-failure closeout migration')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE codex_turn_bindings (
        ready_run_id TEXT PRIMARY KEY,
        host_failure_product_terminal_digest TEXT,
        product_terminal_digest TEXT,
        product_closeout_at TEXT,
        turn_start_reservation_released_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO codex_turn_bindings (
        ready_run_id, host_failure_product_terminal_digest,
        turn_start_reservation_released_at, updated_at
      ) VALUES (
        'legacy-run', 'legacy-terminal',
        '2026-08-07T00:01:00.000Z', '2026-08-07T00:02:00.000Z'
      );
    `)
    __runMigrationForTests(
      '094_codex_host_failure_closeout_readback',
      db as unknown as MigrationDatabase,
    )
    assert.deepEqual(db.prepare(`
      SELECT host_failure_closeout_at FROM codex_turn_bindings
       WHERE ready_run_id = 'legacy-run'
    `).get(), { host_failure_closeout_at: '2026-08-07T00:01:00.000Z' })
    assert.throws(() => db.prepare(`
      UPDATE codex_turn_bindings SET host_failure_closeout_at = '2026-08-07T00:03:00.000Z'
       WHERE ready_run_id = 'legacy-run'
    `).run(), /codex_turn_terminal_immutable/)
    assert.throws(() => db.prepare(`
      INSERT INTO codex_turn_bindings (
        ready_run_id, host_failure_product_terminal_digest, updated_at
      ) VALUES ('invalid-pair', 'terminal-without-time', '2026-08-07T00:04:00.000Z')
    `).run(), /codex_turn_host_failure_terminal_pair_invalid/)
  } finally {
    db.close()
  }
})

test('migration 095 refuses forged lifecycle evidence on legacy closeout rows', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex lifecycle evidence migration')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE codex_turn_bindings (
        ready_run_id TEXT PRIMARY KEY,
        thread_binding_id TEXT NOT NULL,
        product_terminal_digest TEXT,
        host_failure_product_terminal_digest TEXT
      );
      CREATE TABLE codex_thread_dispatch_fences (
        thread_binding_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        owner_ready_run_id TEXT,
        owner_manual_compaction_id TEXT,
        quarantined_at TEXT,
        revision INTEGER NOT NULL
      );
      INSERT INTO codex_turn_bindings (
        ready_run_id, thread_binding_id, product_terminal_digest
      ) VALUES ('legacy-closed', 'legacy-thread', 'legacy-terminal');
    `)
    __runMigrationForTests(
      '095_codex_lifecycle_recovery_evidence',
      db as unknown as MigrationDatabase,
    )
    assert.throws(() => db.prepare(`
      UPDATE codex_turn_bindings SET fence_release_revision = 2
       WHERE ready_run_id = 'legacy-closed'
    `).run(), /codex_turn_fence_release_transition_invalid/)
    assert.throws(() => db.prepare(`
      UPDATE codex_turn_bindings
         SET engine_terminal_status = 'completed',
             engine_terminal_candidate_json = '{}',
             engine_terminal_candidate_digest = 'forged',
             engine_terminal_recorded_at = '2026-08-07T01:00:00.000Z'
       WHERE ready_run_id = 'legacy-closed'
    `).run(), /codex_turn_engine_terminal_transition_invalid/)
  } finally {
    db.close()
  }
})

test('empty alias generations charge no start capacity and idle reset inserts the successor atomically', async (t) => {
  await withRepository(t, (db, repository) => {
    db.prepare(`INSERT INTO chat_conversations (id) VALUES (?)`).run('scope-empty')
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

test('production close retires every supported idle state without creating a successor', async (t) => {
  await withRepository(t, async (db, repository) => {
    db.prepare(`INSERT INTO chat_conversations (id, thread_key) VALUES (?, ?)`)
      .run('scope-close-empty', 'scope-close-empty')
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-close-empty',
      aliasId: 'scope-close-empty',
      aliasGeneration: 1,
      readyScopeId: 'scope-close-empty',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })
    const noNativeCalls: string[] = []
    const noNativeRuntime = {
      threadRead: async () => {
        noNativeCalls.push('threadRead')
        throw new Error('unexpected_thread_read')
      },
      threadArchive: async () => {
        noNativeCalls.push('threadArchive')
        return {}
      },
    } as unknown as CodexNativeRuntime
    const neverStarted = await retireCodexAliasForClose({
      repository,
      nativeRuntime: noNativeRuntime,
      loadedThreads: new Set(),
      identity: { aliasId: 'scope-close-empty', aliasGeneration: 1 },
      snapshot: 'idle_never_started',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => undefined,
    })
    assert.equal(neverStarted.archiveDisposition, 'not_required')
    assert.equal(neverStarted.lastCommittedReadyTerminalTransactionDigest, null)
    assert.equal(neverStarted.lastCommittedProductTerminalDigest, null)
    assert.equal(neverStarted.idleThreadReadDigest, null)
    assert.deepEqual(noNativeCalls, [])
    assert.equal(repository.readActiveAliasBinding('scope-close-empty'), null)
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = 'scope-close-empty'
    `).get(), {
      closed_at: admittedAt,
      closed_reason: 'closed',
      close_evidence_digest: neverStarted.scopeClosureEvidenceDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 0)
    assert.deepEqual(db.prepare(`
      SELECT alias_generation, retired_reason FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-close-empty'
    `).all(), [{ alias_generation: 1, retired_reason: 'closed' }])
  })

  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.recordHostFailureEvidence({
      readyRunId: run.runId,
      kind: 'sidecar_spawn_failed',
      evidenceDigest: 'ready-terminal-no-native-evidence',
      recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest: 'ready-terminal-no-native',
      closeoutAt: admittedAt,
    })
    db.exec('COMMIT')
    assert.equal(classifyLifecycleOperation(repository.readLifecycleOperation({
      aliasId: 'scope-1', aliasGeneration: 1,
    }).facts), 'idle_ready_terminal_no_native')
    const readyTerminal = await retireCodexAliasForClose({
      repository,
      nativeRuntime: {} as CodexNativeRuntime,
      loadedThreads: new Set(),
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      snapshot: 'idle_ready_terminal_no_native',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => undefined,
    })
    assert.equal(readyTerminal.archiveDisposition, 'not_required')
    assert.equal(
      readyTerminal.lastCommittedReadyTerminalTransactionDigest,
      'ready-terminal-no-native',
    )
    assert.equal(readyTerminal.lastCommittedProductTerminalDigest, null)
    assert.equal(repository.readActiveAliasBinding('scope-1'), null)
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = 'scope-1'
    `).get(), {
      closed_at: admittedAt,
      closed_reason: 'closed',
      close_evidence_digest: readyTerminal.scopeClosureEvidenceDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
    `).get<{ count: number }>()?.count, 1)
  })

  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    const idleThread: CodexThread = {
      ...rootThread(),
      turns: [{ ...activeTurn(), status: 'completed' }],
    }
    const calls: string[] = []
    let cleanupSchedules = 0
    const loadedThreads = new Set(['thread-native-1'])
    const runtime = {
      threadRead: async (input: { threadId: string; includeTurns: true }) => {
        calls.push(`read:${input.threadId}`)
        return { thread: idleThread }
      },
      threadArchive: async (input: { threadId: string }) => {
        calls.push(`archive:${input.threadId}`)
        repository.assertThreadArchiveEligible(input.threadId)
        return {}
      },
    } as unknown as CodexNativeRuntime
    const nativeIdle = await retireCodexAliasForClose({
      repository,
      nativeRuntime: runtime,
      loadedThreads,
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      snapshot: 'idle_native_thread',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => { cleanupSchedules += 1 },
    })
    assert.equal(nativeIdle.archiveDisposition, 'durable_cleanup_pending')
    assert.match(nativeIdle.archiveIntentDigest || '', /^[0-9a-f]{64}$/)
    assert.match(nativeIdle.scopeClosureEvidenceDigest, /^[0-9a-f]{64}$/)
    assert.equal(nativeIdle.idleThreadReadDigest, digestCanonicalJson(idleThread))
    assert.equal(nativeIdle.lastCommittedProductTerminalDigest !== null, true)
    assert.deepEqual(calls, ['read:thread-native-1'])
    assert.equal(cleanupSchedules, 1)
    assert.equal(loadedThreads.has('thread-native-1'), false)
    assert.equal(repository.readActiveAliasBinding('scope-1'), null)
    assert.doesNotThrow(() => repository.assertThreadArchiveEligible('thread-native-1'))
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = 'scope-1'
    `).get(), {
      closed_at: admittedAt,
      closed_reason: 'closed',
      close_evidence_digest: nativeIdle.scopeClosureEvidenceDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(db.prepare(`
      SELECT alias_generation, retired_reason FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
    `).all(), [{ alias_generation: 1, retired_reason: 'closed' }])
  })

  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    db.exec(`
      CREATE TRIGGER force_idle_scope_close_failure
      BEFORE UPDATE OF closed_at ON chat_conversations
      WHEN NEW.closed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'forced_idle_scope_close_failure'); END;
    `)
    let cleanupSchedules = 0
    await assert.rejects(() => retireCodexAliasForClose({
      repository,
      nativeRuntime: {
        threadRead: async () => ({
          thread: { ...rootThread(), turns: [{ ...activeTurn(), status: 'completed' }] },
        }),
      } as CodexNativeRuntime,
      loadedThreads: new Set(['thread-native-1']),
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      snapshot: 'idle_native_thread',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => { cleanupSchedules += 1 },
    }), /persistence_failed/)
    db.exec('DROP TRIGGER force_idle_scope_close_failure')

    assert.deepEqual(db.prepare(`
      SELECT retired_at, retired_reason FROM codex_thread_bindings
       WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { retired_at: null, retired_reason: null })
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = 'scope-1'
    `).get(), { closed_at: null, closed_reason: null, close_evidence_digest: null })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.aliasGeneration, 1)
    assert.equal(cleanupSchedules, 0)
  })
})

test('production close preserves the alias on pending work, native activity, or generation drift', async (t) => {
  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    await assert.rejects(() => retireCodexAliasForClose({
      repository,
      nativeRuntime: {} as CodexNativeRuntime,
      loadedThreads: new Set(),
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      snapshot: 'idle_never_started',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => undefined,
    }), /thread_busy/)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.aliasGeneration, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
  })

  await withRepository(t, async (_db, repository) => {
    _db.prepare(`INSERT INTO chat_conversations (id) VALUES (?)`).run('scope-close-drift')
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-close-drift',
      aliasId: 'scope-close-drift',
      aliasGeneration: 1,
      readyScopeId: 'scope-close-drift',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })
    repository.resetIdleAlias({
      aliasId: 'scope-close-drift',
      expectedGeneration: 1,
      retirementEvidenceDigest: 'generation-drift-reset',
      resetAt: admittedAt,
    })
    await assert.rejects(() => retireCodexAliasForClose({
      repository,
      nativeRuntime: {} as CodexNativeRuntime,
      loadedThreads: new Set(),
      identity: { aliasId: 'scope-close-drift', aliasGeneration: 1 },
      snapshot: 'idle_never_started',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => undefined,
    }), /binding_conflict/)
    assert.equal(repository.readActiveAliasBinding('scope-close-drift')?.aliasGeneration, 2)
  })

  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    let archiveCalls = 0
    const runtime = {
      threadRead: async () => ({
        thread: { ...rootThread(), turns: [activeTurn()] },
      }),
      threadArchive: async () => {
        archiveCalls += 1
        return {}
      },
    } as unknown as CodexNativeRuntime
    await assert.rejects(() => retireCodexAliasForClose({
      repository,
      nativeRuntime: runtime,
      loadedThreads: new Set(['thread-native-1']),
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      snapshot: 'idle_native_thread',
      retiredAt: admittedAt,
      scheduleThreadArchiveCleanup: () => undefined,
    }), /thread_busy/)
    assert.equal(archiveCalls, 0)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.aliasGeneration, 1)
    assert.throws(() => repository.assertThreadArchiveEligible('thread-native-1'), /not_retired/)
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

test('product admission rejects missing or divergent Ready run ownership without child rows', async (t) => {
  await withRepository(t, (db, repository) => {
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      readyScopeId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest',
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: admittedAt,
    })
    const cases = [
      {
        runId: 'run-parent-missing',
        mutate(db: NativeDb, run: PreparedCodexProductRun) {
          db.prepare(`DELETE FROM run_meta WHERE run_id = ?`).run(run.runId)
        },
      },
      {
        runId: 'run-parent-binding-mismatch',
        mutate(db: NativeDb, run: PreparedCodexProductRun) {
          db.prepare(`UPDATE run_meta SET execution_binding_json = ? WHERE run_id = ?`)
            .run(JSON.stringify({ schemaVersion: 1, runId: 'different-run' }), run.runId)
        },
      },
      {
        runId: 'run-parent-not-running',
        mutate(db: NativeDb, run: PreparedCodexProductRun) {
          db.prepare(`UPDATE run_meta SET status = 'error' WHERE run_id = ?`).run(run.runId)
        },
      },
    ] as const

    for (const scenario of cases) {
      const run = prepared(scenario.runId)
      prepareReadyParentRowsOnly(db, run)
      scenario.mutate(db, run)
      assert.throws(
        () => repository.admitProductBindings(admission(run, lazyReservation(run.runId))),
        /ready_parent_mismatch/,
      )
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
        .get<{ count: number }>()?.count, 0)
      assert.equal(repository.readActiveAliasBinding('scope-1')?.hasActiveFence, false)
    }
  })
})

test('product admission rejects a closed Ready scope before creating turn or fence rows', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-closed-parent')
    prepareReadyParents(db, repository, run)
    db.exec('BEGIN IMMEDIATE')
    closeCodexConversationScopeInOpenTransaction(db as unknown as DatabaseConnection, {
      scopeId: run.readyToolHostIdentity.scopeId,
      closedAt: admittedAt,
      closeEvidenceDigest: digestCanonicalJson({ kind: 'closed-parent-ingress' }),
    })
    db.exec('COMMIT')

    assert.throws(
      () => repository.admitProductBindings(admission(
        run,
        lazyReservation(run.runId),
      )),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'ready_parent_mismatch',
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`)
      .get<{ count: number }>()?.count, 1)
  })
})

test('admission rejects a validly signed tool authorization outside the frozen surface', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-forged-tool-auth')
    const skillAuthorization = { mode: 'none' as const, reason: 'no_skill_signal' as const }
    const unsigned = {
      authorizationId: 'authorization-forged',
      allowedToolNames: ['unknown_tool'],
      skillAuthorization,
    }
    run.readyTurnToolAuthorization = {
      ...unsigned,
      authorizationDigest: digestCanonicalJson(unsigned),
    }
    prepareReadyParents(db, repository, run)
    assert.throws(
      () => repository.admitProductBindings(admission(run, lazyReservation(run.runId))),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'admission_tool_authorization_mismatch',
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`).get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
  })
})

test('existing thread rejects route and runtime drift without durable side effects', async (t) => {
  await withRepository(t, (db, repository) => {
    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-drift', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-drift-request', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-drift', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-drift-response', responsePending: false, reconciledAt: admittedAt,
    })
    db.prepare(`DELETE FROM codex_thread_dispatch_fences WHERE thread_binding_id = 'thread-binding-1'`).run()
    const frozen = db.prepare(`
      SELECT isolated_thread_cwd, runtime_manifest_digest, protocol_schema_digest,
             tool_surface_digest, tool_surface_snapshot_digest, tool_surface_json,
             instruction_contract_digest, codex_model, upstream_profile_snapshot_ref,
             upstream_profile_snapshot_digest, revision
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get()
    const drifts: Array<{
      overrides: Partial<CodexAdmittedBindingInput>
      code: string
    }> = [
      { overrides: { codexModel: 'changed-model' }, code: 'model_change_requires_new_thread' },
      { overrides: { isolatedThreadCwd: '/tmp/changed-cwd' }, code: 'thread_contract_change_requires_new_thread' },
      { overrides: { instructionContractDigest: 'changed-instructions' }, code: 'thread_contract_change_requires_new_thread' },
      { overrides: { runtimeManifestDigest: 'changed-runtime' }, code: 'thread_contract_change_requires_new_thread' },
      { overrides: { protocolSchemaDigest: 'changed-protocol' }, code: 'thread_contract_change_requires_new_thread' },
    ]
    drifts.forEach(({ overrides, code }, index) => {
      const run = prepared(`run-drift-${index}`)
      prepareReadyParentRowsOnly(db, run)
      assert.throws(
        () => repository.admitProductBindings(admission(
          run,
          existingReservation(run.runId),
          overrides,
        )),
        (error: unknown) => error instanceof CodexBindingRepositoryError && error.code === code,
      )
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`).get<{ count: number }>()?.count, 1)
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
      assert.deepEqual(db.prepare(`
        SELECT isolated_thread_cwd, runtime_manifest_digest, protocol_schema_digest,
               tool_surface_digest, tool_surface_snapshot_digest, tool_surface_json,
               instruction_contract_digest, codex_model, upstream_profile_snapshot_ref,
               upstream_profile_snapshot_digest, revision
          FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
      `).get(), frozen)
    })
    const surfaceRun = prepared('run-drift-surface')
    surfaceRun.readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-changed',
      toolDefinitions: [{
        name: 'changed_tool', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'changed',
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      }],
    })
    surfaceRun.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-changed',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: surfaceRun.readyToolSurface,
    })
    prepareReadyParentRowsOnly(db, surfaceRun)
    assert.throws(
      () => repository.admitProductBindings(admission(
        surfaceRun,
        existingReservation(surfaceRun.runId),
      )),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'tool_surface_change_requires_new_thread',
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`).get<{ count: number }>()?.count, 1)
  })
})

test('existing native thread accepts per-turn profile model reasoning and output changes when thread config is unchanged', async (t) => {
  await withRepository(t, (db, repository) => {
    const firstProfile = createThreadTransitionProfile({
      profileId: 'profile-turn-first',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 8_192,
    })
    const secondProfile = createThreadTransitionProfile({
      profileId: 'profile-turn-second',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 16_384,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...firstProfile, createdAt: admittedAt })
    gatewayRepository.storeSnapshot({ ...secondProfile, createdAt: admittedAt })

    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation(), {
      upstreamProfileSnapshotRef: firstProfile.snapshotRef,
      upstreamProfileSnapshotDigest: firstProfile.snapshotDigest,
    }))
    startAndCloseInitialProductTurn(db, repository)
    const frozenRoot = db.prepare(`
      SELECT codex_model, upstream_profile_snapshot_ref, upstream_profile_snapshot_digest,
             isolated_thread_cwd, instruction_contract_digest, runtime_manifest_digest,
             protocol_schema_digest, tool_surface_digest
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get()

    const second = prepared('run-profile-transition')
    prepareReadyParentRowsOnly(db, second)
    repository.admitProductBindings(admission(second, existingReservation(second.runId), {
      upstreamProfileSnapshotRef: secondProfile.snapshotRef,
      upstreamProfileSnapshotDigest: secondProfile.snapshotDigest,
    }))

    assert.deepEqual(db.prepare(`
      SELECT codex_model, upstream_profile_snapshot_ref, upstream_profile_snapshot_digest,
             isolated_thread_cwd, instruction_contract_digest, runtime_manifest_digest,
             protocol_schema_digest, tool_surface_digest
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), frozenRoot)
    assert.deepEqual(db.prepare(`
      SELECT effective_codex_model, effective_upstream_snapshot_ref,
             effective_upstream_snapshot_digest
        FROM codex_turn_bindings WHERE ready_run_id = 'run-profile-transition'
    `).get(), {
      effective_codex_model: 'ready-e0-model',
      effective_upstream_snapshot_ref: secondProfile.snapshotRef,
      effective_upstream_snapshot_digest: secondProfile.snapshotDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`)
      .get<{ count: number }>()?.count, 2)
  })
})

test('existing native thread rejects context-window drift with an explicit generation-transition signal and no partial admission', async (t) => {
  await withRepository(t, (db, repository) => {
    const firstProfile = createThreadTransitionProfile({
      profileId: 'profile-context-first',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 8_192,
    })
    const changedContextProfile = createThreadTransitionProfile({
      profileId: 'profile-context-second',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      contextWindowOverride: 128_000,
      maxOutputTokensOverride: 8_192,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...firstProfile, createdAt: admittedAt })
    gatewayRepository.storeSnapshot({ ...changedContextProfile, createdAt: admittedAt })

    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation(), {
      upstreamProfileSnapshotRef: firstProfile.snapshotRef,
      upstreamProfileSnapshotDigest: firstProfile.snapshotDigest,
    }))
    startAndCloseInitialProductTurn(db, repository)

    const second = prepared('run-context-transition')
    prepareReadyParentRowsOnly(db, second)
    assert.throws(
      () => repository.admitProductBindings(admission(
        second,
        existingReservation(second.runId),
        {
          upstreamProfileSnapshotRef: changedContextProfile.snapshotRef,
          upstreamProfileSnapshotDigest: changedContextProfile.snapshotDigest,
        },
      )),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'native_thread_config_change_requires_new_generation',
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_turn_bindings`)
      .get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_bindings`)
      .get<{ count: number }>()?.count, 1)
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
    assert.deepEqual(repository.resolveProductInterruptOwner({
      aliasId: 'scope-1', aliasGeneration: 1,
      readyRunId: 'run-1',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
    }), {
      readyRunId: 'run-1', readyTaskId: 'task-run-1',
      readyScopeId: 'scope-1', readyAliasId: 'scope-1',
    })
    assert.throws(() => repository.resolveProductInterruptOwner({
      aliasId: 'scope-1', aliasGeneration: 1,
      readyRunId: 'run-next',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
    }), /product_interrupt_owner_mismatch/)
    assert.throws(() => repository.resolveProductInterruptOwner({
      aliasId: 'scope-1', aliasGeneration: 1,
      readyRunId: 'run-1',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-forged',
    }), /product_interrupt_owner_mismatch/)
    assert.doesNotThrow(() => repository.readToolBridgeExecutionBinding('run-1'))
    assert.deepEqual(repository.requestProductInterrupt({
      aliasId: 'scope-1', aliasGeneration: 1,
      readyRunId: 'run-1',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      requestedAt: admittedAt,
    }), {
      readyRunId: 'run-1', readyTaskId: 'task-run-1',
      readyScopeId: 'scope-1', readyAliasId: 'scope-1',
    })
    assert.throws(
      () => repository.readToolBridgeExecutionBinding('run-1'),
      /tool_bridge_binding_inactive/,
    )
    repository.acknowledgeProductInterrupt({
      readyRunId: 'run-1', acknowledgedAt: '2026-08-07T01:00:01.000Z',
    })
    repository.markProductInterruptUnknown({
      readyRunId: 'run-1', unknownAt: '2026-08-07T01:00:02.000Z',
    })
    assert.deepEqual(db.prepare(`
      SELECT interrupt_requested_at, interrupt_ack_at, interrupt_state_unknown_at
        FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
    `).get(), {
      interrupt_requested_at: admittedAt,
      interrupt_ack_at: '2026-08-07T01:00:01.000Z',
      interrupt_state_unknown_at: '2026-08-07T01:00:02.000Z',
    })
    const canonicalTerminalDigest = recordCompletedTerminal(db, repository)

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: canonicalTerminalDigest, closeoutAt: admittedAt,
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

    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    db.exec(`
      CREATE TRIGGER codex_test_fence_delete_failure
      BEFORE DELETE ON codex_thread_dispatch_fences
      BEGIN SELECT RAISE(ABORT, 'forced_fence_delete_failure'); END;
    `)
    assert.throws(() => repository.completeProductTurnCloseout({
      readyRunId: 'run-1',
      productTerminalDigest: canonicalTerminalDigest,
      closeoutAt: admittedAt,
    }), /forced_fence_delete_failure/)
    db.exec('DROP TRIGGER codex_test_fence_delete_failure')
    assert.deepEqual(db.prepare(`
      SELECT product_terminal_digest, product_closeout_at, fence_release_revision
        FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
    `).get(), {
      product_terminal_digest: null,
      product_closeout_at: null,
      fence_release_revision: null,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    assert.deepEqual(repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: canonicalTerminalDigest, closeoutAt: admittedAt,
    }), { handled: true, reservationSetId: 'set-run-1' })
    db.exec('COMMIT')
    assert.deepEqual(db.prepare(`
      SELECT product_terminal_digest, product_closeout_at, fence_release_revision
        FROM codex_turn_bindings
       WHERE ready_run_id = 'run-1'
    `).get(), {
      product_terminal_digest: canonicalTerminalDigest,
      product_closeout_at: admittedAt,
      fence_release_revision: 2,
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
      retirementEvidenceDigest: digestCanonicalJson({ kind: 'archive-retirement-evidence' }),
      resetAt: admittedAt,
    })
    assert.doesNotThrow(() => repository.assertThreadArchiveEligible('thread-native-1'))
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1', productTerminalDigest: canonicalTerminalDigest, closeoutAt: admittedAt,
    })
  })
})

test('a run-local boot recovery rejection atomically ends only that run and admits its successor', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-recovery-local', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-recovery-local', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-recovery-local', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-recovery-local', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-recovery-local', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'turn-request-recovery-local',
      dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-recovery-local', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response-recovery-local', responsePending: false,
      reconciledAt: admittedAt,
    })
    const evidenceDigest = digestCanonicalJson({
      readyRunId: run.runId,
      code: 'codex_recovered_turn_readback_ambiguous',
    })

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    repository.completeRecoveryFailureCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest: 'ready-recovery-failure-terminal',
      closeoutAt: admittedAt,
      recoveryFailureCode: 'codex_recovered_turn_readback_ambiguous',
      recoveryFailureEvidenceDigest: evidenceDigest,
    })
    db.exec('ROLLBACK')
    assert.deepEqual(
      db.prepare(`SELECT status FROM task_projections WHERE task_id = ?`).get(run.taskId),
      { status: 'running' },
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    assert.deepEqual(repository.completeRecoveryFailureCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest: 'ready-recovery-failure-terminal',
      closeoutAt: admittedAt,
      recoveryFailureCode: 'codex_recovered_turn_readback_ambiguous',
      recoveryFailureEvidenceDigest: evidenceDigest,
    }), { handled: true, reservationSetId: `set-${run.runId}` })
    db.exec('COMMIT')

    assert.deepEqual(db.prepare(`
      SELECT recovery_failure_code, recovery_failure_evidence_digest,
             product_terminal_digest, fence_release_revision
        FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get(run.runId), {
      recovery_failure_code: 'codex_recovered_turn_readback_ambiguous',
      recovery_failure_evidence_digest: evidenceDigest,
      product_terminal_digest: 'ready-recovery-failure-terminal',
      fence_release_revision: 2,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(repository.readActiveAliasBinding('scope-1'), null)

    const successorAlias = repository.resolveUserIngressAliasBinding({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T01:01:00.000Z',
    })
    assert.equal(successorAlias?.aliasGeneration, 2)
    const successor = {
      ...prepared('run-successor'),
      conversationAlias: { aliasId: 'scope-1', aliasGeneration: 2 },
    }
    prepareReadyParentRowsOnly(db, successor)
    assert.deepEqual(repository.admitProductBindings(admission(
      successor,
      lazyReservation(successor.runId),
      {
        threadBindingId: successorAlias!.threadBindingId,
        isolatedThreadCwd: '/tmp/ready-codex/thread-binding-successor',
        runtimeManifestDigest: 'runtime-manifest-digest-v2',
        protocolSchemaDigest: 'protocol-schema-digest-v2',
      },
    )), {
      threadBindingId: successorAlias!.threadBindingId,
      readyRunId: successor.runId,
      threadState: 'unstarted',
    })
  })
})

test('publication divergence retires the native thread and closes without a canonical answer', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-diverged', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-diverged', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-diverged', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-diverged', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-diverged', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'turn-request-diverged', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-diverged', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1',
      nativeResult: { turn: activeTurn() }, responseDigest: 'turn-response-diverged',
      responsePending: false, reconciledAt: admittedAt,
    })
    const candidateText = 'native answer rejected by Ready evidence'
    const candidate = {
      kind: 'native_terminal' as const,
      readyTaskId: run.taskId,
      readyRunId: run.runId,
      scopeId: run.readyToolHostIdentity.scopeId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'completed' as const,
      candidateSelection: { kind: 'accepted' as const, itemId: 'final-diverged' },
      candidateText,
      candidateDigest: createHash('sha256').update(candidateText).digest('hex'),
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
    }
    const receipt = repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId,
      engineOutcome: candidate.engineOutcome,
      candidate,
      recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    assert.deepEqual(repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest: 'ready-failure-terminal-diverged',
      closeoutAt: admittedAt,
    }), { handled: true, reservationSetId: `set-${run.runId}` })
    db.exec('COMMIT')

    assert.deepEqual(db.prepare(`
      SELECT retired_at, retired_reason, retirement_evidence_digest,
             continuation_blocked_reason, continuation_blocked_evidence_digest
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), {
      retired_at: admittedAt,
      retired_reason: 'publication_diverged',
      retirement_evidence_digest: receipt.candidateDigest,
      continuation_blocked_reason: 'publication_diverged',
      continuation_blocked_evidence_digest: receipt.candidateDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM chat_messages WHERE role = 'assistant'`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(repository.readActiveAliasBinding('scope-1'), null)
    assert.deepEqual(repository.readLatestLifecycleCloseout({
      aliasId: 'scope-1', aliasGeneration: 1,
    }), {
      aliasId: 'scope-1', aliasGeneration: 1,
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      terminal: 'failed', closeoutDigest: 'ready-failure-terminal-diverged',
      fenceReleaseRevision: 2,
    })
    const restored = repository.resolveUserIngressAliasBinding({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T00:01:00.000Z',
    })
    assert.equal(restored?.aliasGeneration, 2)
    assert.equal(restored?.codexThreadId, null)
    assert.equal(
      repository.resolveUserIngressAliasBinding({
        aliasId: 'scope-1',
        runtimeManifestDigest: 'runtime-manifest-digest-v2',
        protocolSchemaDigest: 'protocol-schema-digest-v2',
        createdAt: '2026-08-07T00:02:00.000Z',
      })?.threadBindingId,
      restored?.threadBindingId,
    )
    db.exec('BEGIN IMMEDIATE')
    assert.deepEqual(repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest: 'ready-failure-terminal-diverged',
      closeoutAt: admittedAt,
    }), { handled: true, reservationSetId: `set-${run.runId}` })
    db.exec('COMMIT')

    const nextRun = {
      ...prepared('run-2'),
      conversationAlias: { aliasId: 'scope-1', aliasGeneration: 2 },
    }
    prepareReadyParentRowsOnly(db, nextRun)
    assert.deepEqual(repository.admitProductBindings(admission(
      nextRun,
      lazyReservation(nextRun.runId),
      {
        threadBindingId: restored!.threadBindingId,
        isolatedThreadCwd: '/tmp/ready-codex/thread-binding-2',
        runtimeManifestDigest: 'runtime-manifest-digest-v2',
        protocolSchemaDigest: 'protocol-schema-digest-v2',
      },
    )), {
      threadBindingId: restored!.threadBindingId,
      readyRunId: nextRun.runId,
      threadState: 'unstarted',
    })
  })
})

test('user ingress replaces a stranded pristine alias from an older runtime contract', async (t) => {
  await withRepository(t, (db, repository) => {
    db.prepare(`INSERT INTO chat_conversations (id) VALUES (?)`).run('scope-1')
    repository.createEmptyAliasGeneration({
      threadBindingId: 'thread-binding-old-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      readyScopeId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v1',
      protocolSchemaDigest: 'protocol-schema-digest-v1',
      createdAt: admittedAt,
    })
    const reset = repository.resetIdleAlias({
      aliasId: 'scope-1',
      expectedGeneration: 1,
      retirementEvidenceDigest: 'user-reset-evidence',
      resetAt: '2026-08-07T00:01:00.000Z',
    })
    assert.equal(reset.newGeneration, 2)

    const resolved = repository.resolveUserIngressAliasBinding({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T00:02:00.000Z',
    })
    assert.equal(resolved?.aliasGeneration, 3)
    assert.equal(resolved?.codexThreadId, null)
    assert.deepEqual(db.prepare(`
      SELECT alias_generation, runtime_manifest_digest, protocol_schema_digest,
             retired_reason
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
       ORDER BY alias_generation
    `).all(), [
      {
        alias_generation: 1,
        runtime_manifest_digest: 'runtime-manifest-digest-v1',
        protocol_schema_digest: 'protocol-schema-digest-v1',
        retired_reason: 'user_reset',
      },
      {
        alias_generation: 2,
        runtime_manifest_digest: 'runtime-manifest-digest-v1',
        protocol_schema_digest: 'protocol-schema-digest-v1',
        retired_reason: 'cleanup',
      },
      {
        alias_generation: 3,
        runtime_manifest_digest: 'runtime-manifest-digest-v2',
        protocol_schema_digest: 'protocol-schema-digest-v2',
        retired_reason: null,
      },
    ])

    const run = {
      ...prepared('run-current-runtime'),
      conversationAlias: { aliasId: 'scope-1', aliasGeneration: 3 },
    }
    prepareReadyParentRowsOnly(db, run, 1)
    assert.throws(
      () => repository.admitProductBindings(admission(
        run,
        lazyReservation(run.runId),
        {
          threadBindingId: resolved!.threadBindingId,
          runtimeManifestDigest: 'runtime-manifest-digest-v1',
          protocolSchemaDigest: 'protocol-schema-digest-v1',
          messageVisibilityEpoch: 1,
        },
      )),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'empty_alias_binding_mismatch',
    )
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<{ count: number }>(run.runId)?.count, 0)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ?
    `).get<{ count: number }>(resolved!.threadBindingId)?.count, 0)
    assert.deepEqual(repository.admitProductBindings(admission(
      run,
      lazyReservation(run.runId),
      {
        threadBindingId: resolved!.threadBindingId,
        runtimeManifestDigest: 'runtime-manifest-digest-v2',
        protocolSchemaDigest: 'protocol-schema-digest-v2',
        messageVisibilityEpoch: 1,
      },
    )), {
      threadBindingId: resolved!.threadBindingId,
      readyRunId: run.runId,
      threadState: 'unstarted',
    })
  })
})

test('user ingress preserves a started alias and its existing fence when runtime changes', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))

    const resolved = repository.resolveUserIngressAliasBinding({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T00:02:00.000Z',
    })
    assert.equal(resolved?.aliasGeneration, 1)
    assert.equal(resolved?.hasActiveFence, true)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
    `).get<{ count: number }>()?.count, 1)
  })
})

test('new Main claims a product fence only from exact dead-owner and tree-zero evidence', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    assert.throws(() => repository.claimProductFenceForBoot({
      threadBindingId: 'thread-binding-1', readyRunId: run.runId,
      expectedOwnerMainBootId: 'main-boot-1', newOwnerMainBootId: 'main-boot-2',
      claimedAt: admittedAt,
    }), /product_fence_old_owner_unproven/)
    assert.throws(() => db.prepare(`
      INSERT INTO codex_fence_owner_transfers (
        transfer_id, thread_binding_id, operation_kind, owner_ready_run_id,
        owner_manual_compaction_id, previous_owner_main_boot_id,
        new_owner_main_boot_id, previous_fence_revision, new_fence_revision,
        process_lease_id, new_process_lease_id, evidence_digest, transferred_at
      ) VALUES (
        'forged-transfer', 'thread-binding-1', 'product_turn', 'run-1', NULL,
        'main-boot-1', 'main-boot-2', 1, 2, 'fake-lease', 'fake-new-lease',
        'fake-evidence', ?
      )
    `).run(admittedAt), /codex_fence_owner_transfer_evidence_invalid/)

    let lease = repository.createProcessLeaseIntent({
      processLeaseId: 'old-main-lease', ownerMainBootId: 'main-boot-1', ownerMainPid: 10,
      ownerMainProcessStartIdentity: 'old-main-process', sidecarSpawnInstanceId: 'old-spawn',
      connectionEpoch: 'old-epoch', runtimeManifestDigest: 'runtime-manifest-digest',
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex', spawnIntentAt: admittedAt,
      spawnVisibilityDeadlineAt: admittedAt,
    })
    lease = repository.recordOldMainDeath({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      deadAt: admittedAt, evidenceDigest: 'old-main-death-evidence',
    })
    repository.recordProcessTreeZero({
      processLeaseId: lease.processLeaseId, expectedRevision: lease.revision,
      treeZeroAt: admittedAt, matcherMode: 'pre_cas',
      sampleTranscriptDigest: 'stable-zero-transcript', evidenceDigest: 'tree-zero-evidence',
    })
    let newLease = repository.createProcessLeaseIntent({
      processLeaseId: 'new-main-lease', ownerMainBootId: 'main-boot-2', ownerMainPid: 20,
      ownerMainProcessStartIdentity: 'new-main-process', sidecarSpawnInstanceId: 'new-spawn',
      connectionEpoch: 'new-epoch', runtimeManifestDigest: 'runtime-manifest-digest',
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex', spawnIntentAt: admittedAt,
      spawnVisibilityDeadlineAt: admittedAt,
    })
    newLease = repository.confirmProcessLeaseOwnership({
      processLeaseId: newLease.processLeaseId, expectedRevision: newLease.revision,
      pid: 21, processGroupId: 21, processStartIdentity: 'new-sidecar-process',
      confirmedAt: admittedAt,
    })
    repository.markProcessConnectionOpened({
      processLeaseId: newLease.processLeaseId, expectedRevision: newLease.revision,
      openedAt: admittedAt,
    })
    assert.throws(() => db.prepare(`
      INSERT INTO codex_fence_owner_transfers (
        transfer_id, thread_binding_id, operation_kind, owner_ready_run_id,
        owner_manual_compaction_id, previous_owner_main_boot_id,
        new_owner_main_boot_id, previous_fence_revision, new_fence_revision,
        process_lease_id, new_process_lease_id, evidence_digest, transferred_at
      ) VALUES (
        'arbitrary-owner-transfer', 'thread-binding-1', 'product_turn', 'run-1', NULL,
        'main-boot-1', 'main-boot-3', 1, 2, 'old-main-lease', 'new-main-lease',
        'fake-evidence', ?
      )
    `).run(admittedAt), /codex_fence_owner_transfer_evidence_invalid/)
    const claimed = repository.claimProductFenceForBoot({
      threadBindingId: 'thread-binding-1', readyRunId: run.runId,
      expectedOwnerMainBootId: 'main-boot-1', newOwnerMainBootId: 'main-boot-2',
      claimedAt: admittedAt,
    })
    assert.equal(claimed.transferred, true)
    assert.equal(claimed.revision, 2)
    assert.match(claimed.evidenceDigest || '', /^[a-f0-9]{64}$/)
    assert.deepEqual(db.prepare(`
      SELECT owner_main_boot_id, revision FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { owner_main_boot_id: 'main-boot-2', revision: 2 })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_fence_owner_transfers`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(repository.claimProductFenceForBoot({
      threadBindingId: 'thread-binding-1', readyRunId: run.runId,
      expectedOwnerMainBootId: 'main-boot-2', newOwnerMainBootId: 'main-boot-2',
      claimedAt: admittedAt,
    }), {
      readyRunId: run.runId,
      previousOwnerMainBootId: 'main-boot-2', ownerMainBootId: 'main-boot-2',
      revision: 2, transferred: false, evidenceDigest: null,
    })
  })
})

test('lifecycle facts move through start, interrupt unknown, and durable closeout', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'idle_never_started')

    repository.admitProductBindings(admission(run, lazyReservation()))
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'thread_start_pending')

    repository.activateStartDispatch({
      connectionEpoch: 'epoch-lifecycle', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-lifecycle', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-lifecycle', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-lifecycle', responsePending: false, reconciledAt: admittedAt,
    })
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'turn_start_pending')

    repository.activateStartDispatch({
      connectionEpoch: 'epoch-lifecycle', rpcId: 2, method: 'turn/start',
      bindingLookupKey: 'run-1', requestDigest: 'turn-request-lifecycle', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-lifecycle', rpcId: 2, method: 'turn/start',
      bindingId: 'run-1', nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response-lifecycle', responsePending: false, reconciledAt: admittedAt,
    })
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'product_turn_interruptible')
    const beforeInterrupt = repository.readLifecycleOperation({
      aliasId: 'scope-1', aliasGeneration: 1,
    })
    assert.equal(beforeInterrupt.activeReadyRunId, 'run-1')
    assert.equal(beforeInterrupt.latestReadyRunId, 'run-1')
    assert.equal(beforeInterrupt.interruptRequested, false)
    assert.equal(beforeInterrupt.interruptAcknowledged, false)

    repository.requestProductInterrupt({
      aliasId: 'scope-1', aliasGeneration: 1,
      readyRunId: 'run-1',
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1', requestedAt: admittedAt,
    })
    const afterInterruptRequest = repository.readLifecycleOperation({
      aliasId: 'scope-1', aliasGeneration: 1,
    })
    assert.equal(afterInterruptRequest.interruptRequested, true)
    assert.equal(afterInterruptRequest.interruptAcknowledged, false)
    repository.markProductInterruptUnknown({
      readyRunId: 'run-1', unknownAt: '2026-08-07T01:00:01.000Z',
    })
    repository.acknowledgeProductInterrupt({
      readyRunId: 'run-1', acknowledgedAt: '2026-08-07T01:00:02.000Z',
    })
    assert.equal(repository.readLifecycleOperation({
      aliasId: 'scope-1', aliasGeneration: 1,
    }).interruptAcknowledged, true)
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'product_turn_interrupt_unknown')
    const terminalLifecycleDigest = recordCompletedTerminal(db, repository)
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'product_turn_engine_terminal_closeout_pending')

    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeCanonicalProductCloseoutInOpenTransaction({
      readyRunId: 'run-1', productTerminalDigest: terminalLifecycleDigest, closeoutAt: admittedAt,
    })
    db.exec('COMMIT')
    assert.equal(classifyLifecycleOperation(
      repository.readLifecycleOperation({ aliasId: 'scope-1', aliasGeneration: 1 }).facts,
    ), 'idle_native_thread')
    assert.deepEqual(repository.readLatestLifecycleCloseout({
      aliasId: 'scope-1', aliasGeneration: 1, readyRunId: 'run-1',
    }), {
      aliasId: 'scope-1', aliasGeneration: 1,
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      terminal: 'completed', closeoutDigest: terminalLifecycleDigest, fenceReleaseRevision: 2,
    })
    assert.throws(() => repository.readLatestLifecycleCloseout({
      aliasId: 'scope-1', aliasGeneration: 1, readyRunId: 'run-next',
    }), /lifecycle_closeout_readback_missing/)
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
    assert.deepEqual(repository.readProductCloseout('run-1'), {
      productTerminalDigest: 'product-terminal-digest',
      productCloseoutAt: admittedAt,
    })
    assert.throws(() => repository.completeHostFailureCloseout({
      readyRunId: 'run-1', productTerminalDigest: 'product-terminal-digest',
      continuationBlockedReason: 'start_delivery_absent',
      closeoutAt: '2026-08-07T01:00:01.000Z',
    }), /host_failure_terminal_immutable/)
    assert.throws(() => repository.completeHostFailureCloseout({
      readyRunId: 'run-1', productTerminalDigest: 'product-terminal-digest',
      continuationBlockedReason: 'publication_diverged', closeoutAt: admittedAt,
    }), /host_failure_closeout_immutable/)
  })
})

test('sidecar failure blocker follows persisted native thread existence', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.recordHostFailureEvidence({
      readyRunId: 'run-1', kind: 'sidecar_spawn_failed',
      evidenceDigest: 'sidecar-before-thread-evidence', recordedAt: admittedAt,
    })
    assert.equal(
      repository.readRecoverySnapshot(() => false).hostFailureCloseouts[0]
        ?.continuationBlockedReason,
      'start_delivery_absent',
    )
  })

  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-sidecar-after-thread', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-sidecar-after-thread', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-sidecar-after-thread', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-sidecar-after-thread',
      responsePending: false, reconciledAt: admittedAt,
    })
    repository.recordHostFailureEvidence({
      readyRunId: 'run-1', kind: 'sidecar_spawn_failed',
      evidenceDigest: 'sidecar-after-thread-evidence', recordedAt: admittedAt,
    })
    assert.equal(
      repository.readRecoverySnapshot(() => false).hostFailureCloseouts[0]
        ?.continuationBlockedReason,
      'publication_diverged',
    )
  })
})

test('publication recovery only abandons calls that never reached the Ready host', async (t) => {
  const admittedCall = {
    codexCallId: 'call-abandoned',
    toolName: 'ready_read',
    argsDigest: 'args-abandoned',
  }

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-abandoned',
      admittedCalls: [admittedCall],
    })
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null,
    })
    assert.deepEqual(repository.recordToolPublicationReceipt({
      readyRunId: run.runId,
      recordedAt: admittedAt,
    }).verifiedReceiptRefs, [])
  })

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-missing',
      admittedCalls: [admittedCall],
    })
    const candidate = nativeFailureCandidate(run, 'completed')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'completed',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'admitted_tool_call_missing_from_terminal', callId: admittedCall.codexCallId,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
      effectSettlementOnly: true,
    }), {
      kind: 'diverged', verifiedReceiptRefs: [],
      code: 'settled_tool_call_missing_from_failed_terminal', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-failed-abandoned',
      admittedCalls: [admittedCall],
    })
    const candidate = nativeFailureCandidate(run, 'failed')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'failed',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null,
    })
  })

  await withRepository(t, async (db, repository) => {
    const admittedCalls = [
      { codexCallId: 'call-settled-confirmed-1', toolName: 'ready_read', argsDigest: 'args-1' },
      { codexCallId: 'call-settled-confirmed-2', toolName: 'ready_read', argsDigest: 'args-2' },
      { codexCallId: 'call-settled-confirmed-3', toolName: 'ready_read', argsDigest: 'args-3' },
      { codexCallId: 'call-settled-proven-absent', toolName: 'ready_read', argsDigest: 'args-4' },
    ]
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-settled-calls-missing', admittedCalls,
    })
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    for (const [index, admittedCall] of admittedCalls.entries()) {
      const callWithoutActionId = {
        codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
        codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
        readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
        readyTaskId: run.taskId, toolName: admittedCall.toolName,
        argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
        surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
        toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
        authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
        toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
        requestConnectionEpoch: 'epoch-recovery', requestRpcId: String(index + 3), at: admittedAt,
      }
      const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
      const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
      repository.bindToolCall(call)
      await journal.begin({
        readyActionId: call.readyActionId,
        actionIdentityDigest: actionIdentity.actionIdentityDigest,
        at: admittedAt,
      })
      if (index === admittedCalls.length - 1) {
        const reason = 'tool_abort_before_action'
        journal.markProvenAbsent({
          readyActionId: call.readyActionId,
          actionIdentityDigest: actionIdentity.actionIdentityDigest,
          reason,
          evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
            readyActionId: call.readyActionId,
            actionIdentityDigest: actionIdentity.actionIdentityDigest,
            connectionEpoch: call.requestConnectionEpoch,
            reason,
          }),
          at: admittedAt,
        })
        continue
      }
      const output = createToolExecutionOutput('completed', { data: { index } })
      const resultDigest = digestCanonicalJson(output)
      const receipt = await journal.commit({
        readyActionId: call.readyActionId,
        actionIdentityDigest: actionIdentity.actionIdentityDigest,
        resultDigest,
        output,
        at: admittedAt,
      })
      repository.completeToolCall({
        codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId, receiptId: receipt.receiptId,
        resultDigest, at: admittedAt,
      })
      if (index === admittedCalls.length - 2) continue
      repository.markToolCallDeliveryIntent({
        codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId, connectionEpoch: call.requestConnectionEpoch,
        requestRpcId: call.requestRpcId,
        toolResponseDigest: digestCanonicalJson(mapReadyToolOutput(output)),
        at: admittedAt,
      })
    }
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId, codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1', engineOutcome: 'interrupted',
      candidate, recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1', candidateCalls: [],
    }), {
      kind: 'diverged', verifiedReceiptRefs: [],
      code: 'settled_tool_call_missing_from_failed_terminal',
      callId: admittedCalls[0].codexCallId,
    })
    assert.throws(() => repository.recordToolPublicationReceipt({
      readyRunId: run.runId, recordedAt: admittedAt,
    }), /tool_publication_diverged/)
  })

  await withRepository(t, async (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-completed-proven-absent',
      toolName: 'ready_read',
      argsDigest: 'args-completed-proven-absent',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-proven-absent', admittedCalls: [admittedCall],
    })
    const callWithoutActionId = {
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId, toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-recovery', requestRpcId: '3', at: admittedAt,
    }
    const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
    const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
    repository.bindToolCall(call)
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      at: admittedAt,
    })
    const reason = 'tool_abort_before_action'
    journal.markProvenAbsent({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      reason,
      evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
        readyActionId: call.readyActionId,
        actionIdentityDigest: actionIdentity.actionIdentityDigest,
        connectionEpoch: call.requestConnectionEpoch,
        reason,
      }),
      at: admittedAt,
    })
    const candidate = nativeFailureCandidate(run, 'completed')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId, codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1', engineOutcome: 'completed',
      candidate, recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1', candidateCalls: [],
    }), {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'admitted_tool_call_missing_from_terminal', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-bound',
      admittedCalls: [admittedCall],
    })
    const boundCall = {
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId,
      toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-recovery',
      requestRpcId: '3',
      at: admittedAt,
    }
    const boundActionIdentity = buildCodexToolActionIdentity(boundCall)
    repository.bindToolCall({ ...boundCall, readyActionId: boundActionIdentity.readyActionId })
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'admitted_tool_call_missing_from_terminal', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-mismatched-binding',
      admittedCalls: [admittedCall],
    })
    db.prepare(`
      INSERT INTO codex_tool_call_bindings (
        codex_thread_id, codex_turn_id, codex_call_id, ready_run_id, ready_action_id,
        tool_name, args_digest, turn_contract_digest, ready_alias_id, codex_session_id,
        ready_task_id, surface_snapshot_digest, tool_surface_digest,
        authorization_snapshot_digest, tool_schema_digest, request_connection_epoch,
        request_rpc_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      'thread-native-1', 'turn-native-1', admittedCall.codexCallId, run.runId,
      'action-mismatched-binding', 'different_tool', admittedCall.argsDigest,
      `turn-contract-${run.runId}`, run.conversationAlias.aliasId, 'thread-native-1',
      run.taskId, executionBinding.toolSurface.surfaceSnapshotDigest,
      executionBinding.toolSurface.toolSurfaceDigest,
      executionBinding.authorization.authorizationSnapshotDigest,
      executionBinding.toolSurface.entries[0].schemaDigest,
      'epoch-recovery', '3', admittedAt, admittedAt,
    )
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'bound_tool_name_mismatch', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-mismatched-args',
      admittedCalls: [admittedCall],
    })
    db.prepare(`
      INSERT INTO codex_tool_call_bindings (
        codex_thread_id, codex_turn_id, codex_call_id, ready_run_id, ready_action_id,
        tool_name, args_digest, turn_contract_digest, ready_alias_id, codex_session_id,
        ready_task_id, surface_snapshot_digest, tool_surface_digest,
        authorization_snapshot_digest, tool_schema_digest, request_connection_epoch,
        request_rpc_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      'thread-native-1', 'turn-native-1', admittedCall.codexCallId, run.runId,
      'action-mismatched-args', admittedCall.toolName, 'different-args-digest',
      `turn-contract-${run.runId}`, run.conversationAlias.aliasId, 'thread-native-1',
      run.taskId, executionBinding.toolSurface.surfaceSnapshotDigest,
      executionBinding.toolSurface.toolSurfaceDigest,
      executionBinding.authorization.authorizationSnapshotDigest,
      executionBinding.toolSurface.entries[0].schemaDigest,
      'epoch-recovery', '3', admittedAt, admittedAt,
    )
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'bound_args_digest_mismatch', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-mismatched-action-id',
      admittedCalls: [admittedCall],
    })
    const actionIdentity = buildCodexToolActionIdentity({
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      readyTaskId: run.taskId,
      readyRunId: run.runId,
      toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
    })
    const forgedActionId = `${actionIdentity.readyActionId}-forged`
    insertRawPublicationToolBinding(db, {
      run, executionBinding, admittedCall, readyActionId: forgedActionId,
    })
    db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, revision, created_at, updated_at
      ) VALUES (?, ?, 'pending', 1, ?, ?)
    `).run(forgedActionId, actionIdentity.actionIdentityDigest, admittedAt, admittedAt)
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'bound_action_identity_mismatch', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-mismatched-action-receipt',
      admittedCalls: [admittedCall],
    })
    const actionIdentity = buildCodexToolActionIdentity({
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      readyTaskId: run.taskId,
      readyRunId: run.runId,
      toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
    })
    insertRawPublicationToolBinding(db, {
      run, executionBinding, admittedCall, readyActionId: actionIdentity.readyActionId,
    })
    db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, revision, created_at, updated_at
      ) VALUES (?, ?, 'pending', 1, ?, ?)
    `).run(actionIdentity.readyActionId, 'f'.repeat(64), admittedAt, admittedAt)
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'action_receipt_identity_mismatch', callId: admittedCall.codexCallId,
    })
  })

  await withRepository(t, (db, repository) => {
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-forged-frozen-binding',
      admittedCalls: [admittedCall],
    })
    const forgedTaskId = 'task-forged-frozen-binding'
    const forgedIdentity = buildCodexToolActionIdentity({
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      readyTaskId: forgedTaskId,
      readyRunId: run.runId,
      toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
    })
    insertRawPublicationToolBinding(db, {
      run,
      executionBinding,
      admittedCall,
      readyActionId: forgedIdentity.readyActionId,
      readyTaskId: forgedTaskId,
    })
    db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, revision, created_at, updated_at
      ) VALUES (?, ?, 'pending', 1, ?, ?)
    `).run(
      forgedIdentity.readyActionId,
      forgedIdentity.actionIdentityDigest,
      admittedAt,
      admittedAt,
    )
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'bound_frozen_identity_mismatch', callId: admittedCall.codexCallId,
    })
  })

  const currentDigest = 'd'.repeat(64)
  const currentDocumentAnchor = {
    kind: 'current_document' as const,
    logicalResourceId: 'ready-current-document:scope-1:recovery-doc',
    tabId: 'recovery-doc',
    title: 'Recovery document',
    pane: 'primary' as const,
    pathDigest: 'e'.repeat(64),
    incarnationKey: 'f'.repeat(64),
    currentVersion: `sha256:${currentDigest}`,
    currentDigest,
    supersedesVersion: null,
    policyEpoch: 1,
    readScope: { operation: 'read_section' as const, maxChars: 30_000 as const },
  }
  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-interrupted-current-document',
      currentDocumentAnchor,
    })
    const candidate = nativeFailureCandidate(run, 'interrupted')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'interrupted',
      candidate,
      recordedAt: admittedAt,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }).kind, 'accepted')
  })

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-current-document',
      currentDocumentAnchor,
    })
    const candidate = nativeFailureCandidate(run, 'completed')
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'completed',
      candidate,
      recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'current_document_read_required', callId: null,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
      effectSettlementOnly: true,
    }).kind, 'accepted')
  })
})

test('publication treats a delivered failed tool result as terminal evidence', async (t) => {
  await withRepository(t, async (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-failed-tool-result',
      toolName: 'ready_read',
      argsDigest: 'args-failed-tool-result',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-failed-tool-result',
      admittedCalls: [admittedCall],
    })
    const callWithoutActionId = {
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId,
      toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-recovery',
      requestRpcId: '3',
      at: admittedAt,
    }
    const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
    const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
    repository.bindToolCall(call)

    const output = createToolExecutionOutput('blocked', {
      data: { errorKind: 'denied_manual_only' },
    })
    const resultDigest = digestCanonicalJson(output)
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      at: admittedAt,
    })
    const receipt = await journal.commit({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      resultDigest,
      output,
      at: admittedAt,
    })
    const response = mapReadyToolOutput(output)
    const toolResponseDigest = digestCanonicalJson(response)
    repository.completeToolCall({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      receiptId: receipt.receiptId,
      resultDigest,
      at: admittedAt,
    })
    repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      connectionEpoch: call.requestConnectionEpoch,
      requestRpcId: call.requestRpcId,
      toolResponse: response,
      toolResponseDigest,
      at: admittedAt,
    })

    const usedToolCalls = [{
      itemId: call.codexCallId,
      tool: call.toolName,
      status: 'failed',
      success: false,
      responseDigest: toolResponseDigest,
    }]
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      engineOutcome: 'failed',
      candidate: nativeFailureCandidate(run, 'failed', usedToolCalls),
      recordedAt: admittedAt,
    })

    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: usedToolCalls,
    }), {
      kind: 'accepted', verifiedReceiptRefs: [receipt.receiptId], code: null, callId: null,
    })
  })
})

test('lifecycle action closeout holds unsettled effects and releases the fence only after exact evidence', async (t) => {
  const currentDigest = '7'.repeat(64)
  const currentDocumentAnchor = {
    kind: 'current_document' as const,
    logicalResourceId: 'ready-current-document:scope-1:lifecycle-effect',
    tabId: 'lifecycle-effect',
    title: 'Lifecycle effect document',
    pane: 'primary' as const,
    pathDigest: '8'.repeat(64),
    incarnationKey: '9'.repeat(64),
    currentVersion: `sha256:${currentDigest}`,
    currentDigest,
    supersedesVersion: null,
    policyEpoch: 1,
    readScope: { operation: 'read_section' as const, maxChars: 30_000 as const },
  }
  const commitLifecycleCloseout = (
    db: NativeDb,
    repository: CodexBindingRepository,
    run: PreparedCodexProductRun,
  ) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`
        UPDATE task_projections
           SET status = 'killed', interaction_state = 'suspended',
               continuation_ref_json = NULL, resumable_actions_json = '["none"]'
         WHERE task_id = ? AND run_id = ?
      `).run(run.taskId, run.runId)
      db.prepare(`
        UPDATE run_meta
           SET status = 'interrupted', terminal_reason = 'cancelled_user',
               initiator = 'user_close', continuation_ref_json = NULL, updated_at = ?
         WHERE run_id = ? AND task_id = ?
      `).run(Date.parse(admittedAt), run.runId, run.taskId)
      const result = repository.completeLifecycleActionCloseoutInOpenTransaction({
        action: 'close',
        readyRunId: run.runId,
        productTerminalDigest: `lifecycle-closeout-${run.runId}`,
        closeoutAt: admittedAt,
      })
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    }
  }
  const buildCall = (
    run: PreparedCodexProductRun,
    executionBinding: ReturnType<CodexBindingRepository['readToolBridgeExecutionBinding']>,
    admittedCall: { codexCallId: string; toolName: string; argsDigest: string },
  ) => {
    const withoutActionId = {
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId, toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-recovery', requestRpcId: '3', at: admittedAt,
    }
    const identity = buildCodexToolActionIdentity(withoutActionId)
    return { call: { ...withoutActionId, readyActionId: identity.readyActionId }, identity }
  }
  const recordLifecycleCandidate = (
    repository: CodexBindingRepository,
    run: PreparedCodexProductRun,
    usedToolCalls: Array<{
      itemId: string
      tool: string
      status: 'completed'
      success: true
      responseDigest: string
    }>,
  ) => {
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      engineOutcome: 'completed',
      candidate: nativeFailureCandidate(run, 'completed', usedToolCalls),
      recordedAt: admittedAt,
    })
    repository.requestProductInterrupt({
      action: 'close', aliasId: run.conversationAlias.aliasId, aliasGeneration: 1,
      readyRunId: run.runId, codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      requestedAt: admittedAt,
    })
  }

  await withRepository(t, async (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-lifecycle-late-receipt',
      toolName: 'ready_read',
      argsDigest: 'args-lifecycle-late-receipt',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-lifecycle-late-receipt',
      admittedCalls: [admittedCall],
      currentDocumentAnchor,
    })
    const { call, identity } = buildCall(run, executionBinding, admittedCall)
    repository.bindToolCall(call)
    const output = createToolExecutionOutput('done')
    const resultDigest = digestCanonicalJson(output)
    const toolResponseDigest = digestCanonicalJson(mapReadyToolOutput(output))
    const usedToolCalls = [{
      itemId: call.codexCallId, tool: call.toolName, status: 'completed' as const,
      success: true as const, responseDigest: toolResponseDigest,
    }]
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({
      readyActionId: call.readyActionId,
      actionIdentityDigest: identity.actionIdentityDigest,
      at: admittedAt,
    })
    recordLifecycleCandidate(repository, run, usedToolCalls)

    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
      effectSettlementOnly: true,
    }).kind, 'indeterminate')
    assert.throws(
      () => commitLifecycleCloseout(db, repository, run),
      /codex_tool_publication_indeterminate/,
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(db.prepare(`
      SELECT retired_at FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { retired_at: null })
    assert.deepEqual(db.prepare(`
      SELECT status FROM task_projections WHERE task_id = ?
    `).get(run.taskId), { status: 'running' })

    const receipt = await journal.commit({
      readyActionId: call.readyActionId,
      actionIdentityDigest: identity.actionIdentityDigest,
      resultDigest,
      output,
      at: admittedAt,
    })
    repository.completeToolCall({
      codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId, receiptId: receipt.receiptId,
      resultDigest, at: admittedAt,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
      effectSettlementOnly: true,
    }).kind, 'accepted')
    db.exec(`
      CREATE TRIGGER force_active_scope_close_failure
      BEFORE UPDATE OF closed_at ON chat_conversations
      WHEN NEW.closed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'forced_active_scope_close_failure'); END;
    `)
    assert.throws(
      () => commitLifecycleCloseout(db, repository, run),
      /forced_active_scope_close_failure/,
    )
    db.exec('DROP TRIGGER force_active_scope_close_failure')
    assert.deepEqual(db.prepare(`
      SELECT retired_at, retired_reason FROM codex_thread_bindings
       WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { retired_at: null, retired_reason: null })
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = ?
    `).get(run.readyToolHostIdentity.scopeId), {
      closed_at: null,
      closed_reason: null,
      close_evidence_digest: null,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(db.prepare(`
      SELECT status FROM task_projections WHERE task_id = ?
    `).get(run.taskId), { status: 'running' })

    assert.deepEqual(commitLifecycleCloseout(db, repository, run), {
      handled: true,
      reservationSetId: `set-${run.runId}`,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.deepEqual(db.prepare(`
      SELECT retired_reason FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { retired_reason: 'closed' })
    const closeout = repository.readLifecycleActionCloseout(run.runId)
    assert.equal(closeout.action, 'close')
    assert.match(closeout.archiveIntentDigest, /^[0-9a-f]{64}$/)
    assert.match(closeout.scopeClosureEvidenceDigest || '', /^[0-9a-f]{64}$/)
    assert.equal(closeout.scopeClosureEvidenceDigest, closeout.retirementTransactionDigest)
    assert.deepEqual(db.prepare(`
      SELECT closed_at, closed_reason, close_evidence_digest
        FROM chat_conversations WHERE id = ?
    `).get(run.readyToolHostIdentity.scopeId), {
      closed_at: admittedAt,
      closed_reason: 'closed',
      close_evidence_digest: closeout.scopeClosureEvidenceDigest,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 1)
    const revision = db.prepare(`
      SELECT revision FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get<{ revision: number }>()?.revision
    db.exec('BEGIN IMMEDIATE')
    repository.completeLifecycleActionCloseoutInOpenTransaction({
      action: 'close',
      readyRunId: run.runId,
      productTerminalDigest: `lifecycle-closeout-${run.runId}`,
      closeoutAt: admittedAt,
    })
    db.exec('COMMIT')
    assert.equal(db.prepare(`
      SELECT revision FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get<{ revision: number }>()?.revision, revision)
  })

  await withRepository(t, (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-lifecycle-never-bound',
      toolName: 'ready_read',
      argsDigest: 'args-lifecycle-never-bound',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-lifecycle-never-bound',
      admittedCalls: [admittedCall],
    })
    const { call } = buildCall(run, executionBinding, admittedCall)
    recordLifecycleCandidate(repository, run, [])
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: [], effectSettlementOnly: true,
    }).kind, 'diverged')
    commitLifecycleCloseout(db, repository, run)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.throws(() => repository.bindToolCall(call), /tool_call_owner_inactive/)
  })

  await withRepository(t, (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-lifecycle-fabricated',
      toolName: 'ready_read',
      argsDigest: 'args-lifecycle-fabricated',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-lifecycle-fabricated',
      admittedCalls: [admittedCall],
    })
    const { call, identity } = buildCall(run, executionBinding, admittedCall)
    repository.bindToolCall(call)
    const output = createToolExecutionOutput('done')
    const forgedResultDigest = 'f'.repeat(64)
    const forgedReceiptId = `ready-tool-receipt-${digestCanonicalJson({
      readyActionId: call.readyActionId,
      resultDigest: forgedResultDigest,
    })}`
    db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, receipt_id,
        result_digest, result_json, revision, created_at, updated_at
      ) VALUES (?, ?, 'confirmed', ?, ?, ?, 1, ?, ?)
    `).run(
      call.readyActionId, identity.actionIdentityDigest, forgedReceiptId,
      forgedResultDigest, JSON.stringify(output), admittedAt, admittedAt,
    )
    repository.completeToolCall({
      codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId, receiptId: forgedReceiptId,
      resultDigest: forgedResultDigest, at: admittedAt,
    })
    const toolResponseDigest = digestCanonicalJson(mapReadyToolOutput(output))
    const usedToolCalls = [{
      itemId: call.codexCallId, tool: call.toolName, status: 'completed' as const,
      success: true as const, responseDigest: toolResponseDigest,
    }]
    recordLifecycleCandidate(repository, run, usedToolCalls)
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
      effectSettlementOnly: true,
    }).kind, 'fabricated')
    assert.throws(
      () => commitLifecycleCloseout(db, repository, run),
      /codex_tool_publication_fabricated/,
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.deepEqual(db.prepare(`
      SELECT retired_at FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get(), { retired_at: null })
  })
})

test('stop and reset retire their native generation without closing the conversation scope', async (t) => {
  for (const action of ['stop', 'reset'] as const) {
    await withRepository(t, (db, repository) => {
      const run = prepared(`run-engine-${action}`)
      prepareReadyParents(db, repository, run)
      repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
      repository.activateStartDispatch({
        connectionEpoch: `epoch-engine-${action}`,
        rpcId: 1,
        method: 'thread/start',
        bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
        requestDigest: `thread-request-engine-${action}`,
        dispatchedAt: admittedAt,
      })
      repository.reconcileStartAccepted({
        connectionEpoch: `epoch-engine-${action}`,
        rpcId: 1,
        method: 'thread/start',
        bindingId: 'thread-binding-1',
        nativeId: 'thread-native-1',
        nativeResult: { thread: rootThread(), instructionSources: [] },
        responseDigest: `thread-response-engine-${action}`,
        responsePending: false,
        reconciledAt: admittedAt,
      })
      repository.activateStartDispatch({
        connectionEpoch: `epoch-engine-${action}`,
        rpcId: 2,
        method: 'turn/start',
        bindingLookupKey: run.runId,
        requestDigest: `turn-request-engine-${action}`,
        dispatchedAt: admittedAt,
      })
      repository.reconcileStartAccepted({
        connectionEpoch: `epoch-engine-${action}`,
        rpcId: 2,
        method: 'turn/start',
        bindingId: run.runId,
        nativeId: 'turn-native-1',
        nativeResult: { turn: activeTurn() },
        responseDigest: `turn-response-engine-${action}`,
        responsePending: false,
        reconciledAt: admittedAt,
      })
      repository.recordEngineTerminalCandidate({
        readyRunId: run.runId,
        codexThreadId: 'thread-native-1',
        codexTurnId: 'turn-native-1',
        engineOutcome: 'interrupted',
        candidate: nativeFailureCandidate(run, 'interrupted', []),
        recordedAt: admittedAt,
      })
      repository.requestProductInterrupt({
        action,
        aliasId: run.conversationAlias.aliasId,
        aliasGeneration: 1,
        readyRunId: run.runId,
        codexThreadId: 'thread-native-1',
        codexTurnId: 'turn-native-1',
        requestedAt: admittedAt,
      })

      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          UPDATE task_projections
             SET status = 'killed', interaction_state = 'suspended',
                 continuation_ref_json = NULL, resumable_actions_json = '["none"]'
           WHERE task_id = ? AND run_id = ?
        `).run(run.taskId, run.runId)
        db.prepare(`
          UPDATE run_meta
             SET status = 'interrupted', terminal_reason = 'cancelled_user',
                 initiator = ?, continuation_ref_json = NULL, updated_at = ?
           WHERE run_id = ? AND task_id = ?
        `).run(`user_${action}`, Date.parse(admittedAt), run.runId, run.taskId)
        repository.completeLifecycleActionCloseoutInOpenTransaction({
          action,
          readyRunId: run.runId,
          productTerminalDigest: digestCanonicalJson({ action, readyRunId: run.runId }),
          closeoutAt: admittedAt,
        })
        db.exec('COMMIT')
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK')
        throw error
      }

      const closeout = repository.readLifecycleActionCloseout(run.runId)
      assert.equal(closeout.action, action)
      assert.match(closeout.archiveIntentDigest, /^[0-9a-f]{64}$/)
      assert.equal(closeout.scopeClosureEvidenceDigest, null)
      assert.deepEqual(db.prepare(`
        SELECT closed_at, closed_reason, close_evidence_digest
          FROM chat_conversations WHERE id = ?
      `).get(run.readyToolHostIdentity.scopeId), {
        closed_at: null,
        closed_reason: null,
        close_evidence_digest: null,
      })
      if (action === 'reset') {
        assert.equal(repository.readActiveAliasBinding(run.conversationAlias.aliasId)?.aliasGeneration, 2)
      }
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
        .get<{ count: number }>()?.count, 1)
    })
  }
})

test('publication rejects failed native status when only delivery intent was recorded', async (t) => {
  await withRepository(t, async (db, repository) => {
    const admittedCall = {
      codexCallId: 'call-failed-before-delivery',
      toolName: 'ready_read',
      argsDigest: 'args-failed-before-delivery',
    }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-failed-before-delivery',
      admittedCalls: [admittedCall],
    })
    const callWithoutActionId = {
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId, toolName: admittedCall.toolName,
      argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-recovery', requestRpcId: '4', at: admittedAt,
    }
    const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
    const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
    repository.bindToolCall(call)
    const output = createToolExecutionOutput('blocked', { data: { errorKind: 'denied_manual_only' } })
    const resultDigest = digestCanonicalJson(output)
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      at: admittedAt,
    })
    const receipt = await journal.commit({
      readyActionId: call.readyActionId,
      actionIdentityDigest: actionIdentity.actionIdentityDigest,
      resultDigest,
      output,
      at: admittedAt,
    })
    repository.completeToolCall({
      codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId, receiptId: receipt.receiptId,
      resultDigest, at: admittedAt,
    })
    const expectedResponse = mapReadyToolOutput(output)
    const expectedResponseDigest = digestCanonicalJson(expectedResponse)
    repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId, connectionEpoch: call.requestConnectionEpoch,
      requestRpcId: call.requestRpcId, toolResponse: expectedResponse,
      toolResponseDigest: expectedResponseDigest, at: admittedAt,
    })
    const usedToolCalls = [{
      itemId: call.codexCallId, tool: call.toolName, status: 'failed', success: false,
      responseDigest: digestCanonicalJson({ contentItems: [], success: false }),
    }]
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, engineOutcome: 'failed',
      candidate: nativeFailureCandidate(run, 'failed', usedToolCalls), recordedAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
    }), {
      kind: 'incomplete', verifiedReceiptRefs: [],
      code: 'candidate_tool_result_not_delivered', callId: call.codexCallId,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: run.runId, codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
      effectSettlementOnly: true,
    }).kind, 'accepted')
  })
})

test('publication rejects forged action result and receipt identities', async (t) => {
  for (const variant of ['result_digest', 'receipt_id'] as const) {
    await withRepository(t, async (db, repository) => {
      const admittedCall = {
        codexCallId: `call-forged-${variant}`,
        toolName: 'ready_read',
        argsDigest: `args-forged-${variant}`,
      }
      const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
        runId: `run-forged-${variant}`,
        admittedCalls: [admittedCall],
      })
      const callWithoutActionId = {
        codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
        codexCallId: admittedCall.codexCallId, readyRunId: run.runId,
        readyAliasId: run.conversationAlias.aliasId, codexSessionId: 'thread-native-1',
        readyTaskId: run.taskId, toolName: admittedCall.toolName,
        argsDigest: admittedCall.argsDigest, turnContractDigest: `turn-contract-${run.runId}`,
        surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
        toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
        authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
        toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
        requestConnectionEpoch: 'epoch-recovery', requestRpcId: '5', at: admittedAt,
      }
      const actionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
      const call = { ...callWithoutActionId, readyActionId: actionIdentity.readyActionId }
      repository.bindToolCall(call)
      const output = createToolExecutionOutput('done')
      const actualResultDigest = digestCanonicalJson(output)
      const storedResultDigest = variant === 'result_digest'
        ? 'f'.repeat(64)
        : actualResultDigest
      const deterministicReceiptId = `ready-tool-receipt-${digestCanonicalJson({
        readyActionId: call.readyActionId,
        resultDigest: storedResultDigest,
      })}`
      const storedReceiptId = variant === 'receipt_id'
        ? `ready-tool-receipt-${'0'.repeat(64)}`
        : deterministicReceiptId
      db.prepare(`
        INSERT INTO ready_tool_action_receipts (
          ready_action_id, action_identity_digest, state, receipt_id,
          result_digest, result_json, revision, created_at, updated_at
        ) VALUES (?, ?, 'confirmed', ?, ?, ?, 1, ?, ?)
      `).run(
        call.readyActionId,
        actionIdentity.actionIdentityDigest,
        storedReceiptId,
        storedResultDigest,
        JSON.stringify(output),
        admittedAt,
        admittedAt,
      )
      repository.completeToolCall({
        codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId, receiptId: storedReceiptId,
        resultDigest: storedResultDigest, at: admittedAt,
      })
      const toolResponse = mapReadyToolOutput(output)
      const toolResponseDigest = digestCanonicalJson(toolResponse)
      repository.beginToolCallDeliveryAttempt({
        codexThreadId: call.codexThreadId, codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId, connectionEpoch: call.requestConnectionEpoch,
        requestRpcId: call.requestRpcId, toolResponse, toolResponseDigest, at: admittedAt,
      })
      const usedToolCalls = [{
        itemId: call.codexCallId, tool: call.toolName, status: 'completed', success: true,
        responseDigest: toolResponseDigest,
      }]
      repository.recordEngineTerminalCandidate({
        readyRunId: run.runId, codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId, engineOutcome: 'completed',
        candidate: nativeFailureCandidate(run, 'completed', usedToolCalls),
        recordedAt: admittedAt,
      })
      assert.deepEqual(repository.readToolPublicationBarrier({
        readyRunId: run.runId, codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
      }), {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: variant === 'result_digest'
          ? 'tool_action_result_digest_mismatch'
          : 'tool_action_receipt_identity_mismatch',
        callId: call.codexCallId,
      })
      assert.equal(repository.readToolPublicationBarrier({
        readyRunId: run.runId, codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId, candidateCalls: usedToolCalls,
        effectSettlementOnly: true,
      }).kind, 'fabricated')
    })
  }
})

test('tool-call binding is exact-once and process leases require stable tree-zero before replacement', async (t) => {
  await withRepository(t, async (db, repository) => {
    const run = prepared()
    run.readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-call-binding',
      toolDefinitions: [{
        name: 'ready_read', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'Read the call fixture',
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      }],
    })
    run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-call-binding',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: run.readyToolSurface,
    })
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
    const bridgeBinding = repository.readToolBridgeExecutionBinding('run-1')
    assert.equal(bridgeBinding.codexSessionId, 'thread-native-1')
    assert.equal(bridgeBinding.toolSurface.surfaceId, 'surface-call-binding')
    assert.equal(
      bridgeBinding.authorization.authorizationDigest,
      run.readyTurnToolAuthorization.authorizationDigest,
    )
    const callWithoutActionId = {
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1', codexCallId: 'call-1',
      readyRunId: 'run-1', readyAliasId: 'scope-1',
      codexSessionId: 'thread-native-1', readyTaskId: 'task-run-1', toolName: 'ready_read',
      argsDigest: 'args-digest', turnContractDigest: 'turn-contract-run-1',
      surfaceSnapshotDigest: bridgeBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: bridgeBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: bridgeBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: bridgeBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-1', requestRpcId: '3',
      at: admittedAt,
    }
    const callActionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
    const call = { ...callWithoutActionId, readyActionId: callActionIdentity.readyActionId }
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'gateway-receipt-call-1', call.codexThreadId, call.codexTurnId, call.readyRunId,
      'snapshot-ref', 'snapshot-digest', 'request-digest-call-1', admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-receipt-call-1',
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      calls: [{ codexCallId: call.codexCallId, toolName: call.toolName, argsDigest: call.argsDigest }],
      admittedAt,
    })
    const output = createToolExecutionOutput('done')
    const resultDigest = digestCanonicalJson(output)
    const toolResponseDigest = digestCanonicalJson(mapReadyToolOutput(output))
    const terminalToolCalls = [{
      itemId: call.codexCallId,
      tool: call.toolName,
      status: 'completed',
      success: true,
      responseDigest: toolResponseDigest,
    }]
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: [{
        ...terminalToolCalls[0],
        itemId: 'call-fabricated',
      }],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'candidate_tool_call_not_admitted', callId: 'call-fabricated',
    })
    const forgedCalls: Array<[string, Partial<typeof call>]> = [
      ['thread', { codexThreadId: 'thread-forged' }],
      ['turn', { codexTurnId: 'turn-forged' }],
      ['run', { readyRunId: 'run-forged' }],
      ['alias', { readyAliasId: 'scope-forged' }],
      ['session', { codexSessionId: 'session-forged' }],
      ['task', { readyTaskId: 'task-forged' }],
      ['turn contract', { turnContractDigest: 'turn-contract-forged' }],
      ['surface snapshot', { surfaceSnapshotDigest: 'surface-snapshot-forged' }],
      ['surface', { toolSurfaceDigest: 'tool-surface-forged' }],
      ['authorization', { authorizationSnapshotDigest: 'authorization-forged' }],
      ['schema', { toolSchemaDigest: 'schema-forged' }],
    ]
    for (const [name, overrides] of forgedCalls) {
      assert.throws(
        () => repository.bindToolCall({
          ...call,
          ...overrides,
          codexCallId: `call-forged-${name}`,
          readyActionId: `action-forged-${name}`,
        }),
        (error) => error instanceof CodexBindingRepositoryError
          && ['tool_call_parent_identity_mismatch', 'tool_call_frozen_contract_mismatch']
            .includes(error.code),
      )
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_tool_call_bindings`)
        .get<{ count: number }>()?.count, 0)
    }
    assert.throws(
      () => repository.bindToolCall({ ...call, readyActionId: 'action-forged' }),
      /tool_call_action_identity_mismatch/,
    )
    assert.deepEqual(repository.bindToolCall(call), { duplicate: false })
    assert.throws(() => repository.bindToolCall(call), /tool_request_rpc_reused/)
    assert.throws(
      () => repository.bindToolCall({ ...call, requestRpcId: ' 3 ' }),
      /tool_request_rpc_reused/,
    )
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
    }).kind, 'incomplete')
    assert.throws(
      () => repository.bindToolCall({ ...call, toolName: 'different-tool' }),
      /tool_call_frozen_contract_mismatch/,
    )
    assert.throws(
      () => repository.bindToolCall({ ...call, argsDigest: 'different-args' }),
      /tool_call_not_admitted/,
    )
    const actionJournal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await actionJournal.begin({
      readyActionId: call.readyActionId,
      actionIdentityDigest: callActionIdentity.actionIdentityDigest,
      at: admittedAt,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
    }).kind, 'indeterminate')
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
      effectSettlementOnly: true,
    }).kind, 'indeterminate')
    const receipt = await actionJournal.commit({
      readyActionId: call.readyActionId,
      actionIdentityDigest: callActionIdentity.actionIdentityDigest,
      resultDigest,
      output,
      at: admittedAt,
    })
    repository.completeToolCall({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      receiptId: receipt.receiptId,
      resultDigest,
      at: admittedAt,
    })
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
    }).kind, 'incomplete')
    assert.equal(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
      effectSettlementOnly: true,
    }).kind, 'accepted')
    assert.equal(repository.readToolCallBinding(call)?.resultDigest, resultDigest)
    assert.throws(
      () => repository.markToolCallDeliveryIntent({
        codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId,
        connectionEpoch: 'epoch-forged-first-delivery',
        requestRpcId: '999',
        toolResponseDigest,
        at: admittedAt,
      }),
      /tool_result_replay_forbidden/,
    )
    assert.deepEqual(db.prepare(`
      SELECT delivered_connection_epoch, delivered_rpc_id, delivery_intent_at
        FROM codex_tool_call_bindings
       WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
    `).get(call.codexThreadId, call.codexTurnId, call.codexCallId), {
      delivered_connection_epoch: null,
      delivered_rpc_id: null,
      delivery_intent_at: null,
    })
    const toolResponse = mapReadyToolOutput(output)
    const firstDelivery = repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      connectionEpoch: 'epoch-1',
      requestRpcId: '3',
      toolResponse,
      toolResponseDigest,
      at: admittedAt,
    })
    assert.equal(firstDelivery.duplicate, false)
    assert.deepEqual(repository.bindToolCall({
      ...call,
      requestConnectionEpoch: 'epoch-2',
      requestRpcId: '4',
      at: '2026-08-07T01:00:01.000Z',
    }), { duplicate: true })
    const recoveredDelivery = repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      connectionEpoch: 'epoch-2',
      requestRpcId: '4',
      toolResponse,
      toolResponseDigest,
      at: '2026-08-07T01:00:01.000Z',
    })
    assert.equal(recoveredDelivery.duplicate, false)
    repository.confirmToolCallDeliveryTransportWrite({
      ...recoveredDelivery.attempt,
      at: '2026-08-07T01:00:02.000Z',
    })
    assert.deepEqual(repository.readToolCallBinding(call), {
      readyActionId: call.readyActionId,
      receiptId: receipt.receiptId,
      resultDigest,
      requestConnectionEpoch: 'epoch-1',
      requestRpcId: '3',
      deliveredConnectionEpoch: 'epoch-1',
      deliveredRpcId: '3',
      toolResponseDigest,
    })
    const deliveryAttempts = repository.readToolCallDeliveryAttempts(call)
    assert.equal(deliveryAttempts.length, 2)
    assert.equal(deliveryAttempts[0].transportWriteConfirmedAt, null)
    assert.equal(deliveryAttempts[1].transportWriteConfirmedAt, '2026-08-07T01:00:02.000Z')
    assert.deepEqual(deliveryAttempts[1].toolResponse, toolResponse)
    assert.deepEqual(repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      connectionEpoch: 'epoch-2',
      requestRpcId: '4',
      toolResponse,
      toolResponseDigest,
      at: '2026-08-07T01:00:03.000Z',
    }), { attempt: recoveredDelivery.attempt, duplicate: true })
    const conflictingResponse = { contentItems: [], success: false }
    assert.throws(
      () => repository.beginToolCallDeliveryAttempt({
        codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId,
        connectionEpoch: 'epoch-2',
        requestRpcId: '4',
        toolResponse: conflictingResponse,
        toolResponseDigest: digestCanonicalJson(conflictingResponse),
        at: '2026-08-07T01:00:03.000Z',
      }),
      /tool_delivery_attempt_identity_conflict/,
    )
    assert.throws(
      () => db.prepare(`
        UPDATE codex_tool_response_delivery_attempts
           SET tool_response_json = '{"success":false}'
         WHERE attempt_id = ?
      `).run(recoveredDelivery.attempt.attemptId),
      /codex_tool_delivery_attempt_immutable/,
    )
    assert.throws(
      () => db.prepare(`DELETE FROM codex_tool_response_delivery_attempts WHERE attempt_id = ?`)
        .run(recoveredDelivery.attempt.attemptId),
      /codex_tool_delivery_attempt_delete_forbidden/,
    )
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: terminalToolCalls,
    }), {
      kind: 'accepted', verifiedReceiptRefs: [receipt.receiptId], code: null, callId: null,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: [{ ...terminalToolCalls[0], success: false }],
    }), {
      kind: 'fabricated', verifiedReceiptRefs: [],
      code: 'candidate_tool_success_mismatch', callId: call.codexCallId,
    })
    assert.throws(
      () => repository.markToolCallDeliveryIntent({
        codexThreadId: call.codexThreadId,
        codexTurnId: call.codexTurnId,
        codexCallId: call.codexCallId,
        connectionEpoch: 'epoch-2',
        requestRpcId: '4',
        toolResponseDigest,
        at: admittedAt,
      }),
      /tool_result_replay_forbidden/,
    )

    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`)
      .run(run.taskId)
    const toolTerminalDigest = recordCompletedTerminal(
      db,
      repository,
      run.runId,
      call.codexTurnId,
      terminalToolCalls,
    )
    repository.completeProductTurnCloseout({
      readyRunId: run.runId,
      productTerminalDigest: toolTerminalDigest,
      closeoutAt: admittedAt,
    })
    assert.throws(
      () => repository.bindToolCall({
        ...call,
        codexCallId: 'call-after-closeout',
        readyActionId: 'action-after-closeout',
      }),
      (error) => error instanceof CodexBindingRepositoryError
        && ['tool_call_owner_inactive', 'tool_bridge_binding_inactive'].includes(error.code),
    )

    const successor = prepared('run-2')
    successor.readyToolSurface = run.readyToolSurface
    successor.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-call-binding-successor',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: successor.readyToolSurface,
    })
    successor.productBudgetSeed = { maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1 }
    prepareReadyParentRowsOnly(db, successor)
    repository.admitProductBindings(admission(successor, existingReservation(successor.runId)))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-1', rpcId: 5, method: 'turn/start',
      bindingLookupKey: successor.runId, requestDigest: 'turn-request-successor',
      dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-1', rpcId: 5, method: 'turn/start', bindingId: successor.runId,
      nativeId: 'turn-native-2', nativeResult: { turn: { ...activeTurn(), id: 'turn-native-2' } },
      responseDigest: 'turn-response-successor', responsePending: false, reconciledAt: admittedAt,
    })
    const successorBinding = repository.readToolBridgeExecutionBinding(successor.runId)
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'gateway-receipt-call-successor', 'thread-native-1', 'turn-native-2', successor.runId,
      'snapshot-ref', 'snapshot-digest', 'request-digest-call-successor', admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-receipt-call-successor',
      readyRunId: successor.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-2',
      calls: [{
        codexCallId: 'call-1', toolName: call.toolName, argsDigest: call.argsDigest,
      }],
      admittedAt,
    })
    const successorCallWithoutActionId = {
      ...call,
      codexTurnId: 'turn-native-2',
      readyRunId: successor.runId,
      readyTaskId: successor.taskId,
      turnContractDigest: `turn-contract-${successor.runId}`,
      authorizationSnapshotDigest: successorBinding.authorization.authorizationSnapshotDigest,
      requestRpcId: '6',
    }
    const successorActionIdentity = buildCodexToolActionIdentity(successorCallWithoutActionId)
    assert.throws(() => repository.bindToolCall({
      ...successorCallWithoutActionId,
      requestRpcId: ' 3 ',
      readyActionId: successorActionIdentity.readyActionId,
    }), /tool_request_rpc_reused/)
    assert.deepEqual(repository.bindToolCall({
      ...successorCallWithoutActionId,
      readyActionId: successorActionIdentity.readyActionId,
    }), { duplicate: false })
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_tool_call_bindings WHERE codex_call_id = 'call-1'
    `).get<{ count: number }>()?.count, 2)

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

test('current-document turns cannot publish without an exact successful read receipt', async (t) => {
  await withRepository(t, async (db, repository) => {
    const run = prepared('run-document-barrier')
    const currentDigest = 'a'.repeat(64)
    const currentDocumentAnchor = {
      kind: 'current_document' as const,
      logicalResourceId: 'ready-current-document:scope-1:doc-1',
      tabId: 'doc-1',
      title: 'Current',
      pane: 'primary' as const,
      pathDigest: 'b'.repeat(64),
      incarnationKey: 'c'.repeat(64),
      currentVersion: `sha256:${currentDigest}`,
      currentDigest,
      supersedesVersion: null,
      policyEpoch: 1,
      readScope: { operation: 'read_section' as const, maxChars: 30_000 as const },
    }
    const reference = {
      logicalResourceId: currentDocumentAnchor.logicalResourceId,
      currentVersion: currentDocumentAnchor.currentVersion,
      currentDigest: currentDocumentAnchor.currentDigest,
      supersedesVersion: null,
      policyEpoch: currentDocumentAnchor.policyEpoch,
    }
    if (run.ingress.kind !== 'user_ingress') throw new Error('expected_user_ingress')
    run.ingress.explicitResourceEnvelope.resourceRefs = [reference]
    run.ingress.resourceAdditionalContext = [reference]
    run.ingress.currentDocumentAnchor = currentDocumentAnchor
    run.resourceAnchorDigest = createHash('sha256').update(JSON.stringify({
      explicitResourceEnvelope: run.ingress.explicitResourceEnvelope,
      resourceAdditionalContext: run.ingress.resourceAdditionalContext,
      currentDocumentAnchor,
    })).digest('hex')
    run.readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-document-barrier',
      toolDefinitions: [{
        name: 'document_read_section', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'Read current document',
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      }],
    })
    run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-document-barrier',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: run.readyToolSurface,
      allowedToolNames: ['document_read_section'],
    })
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-document', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-document', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-document', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-document', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-document', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'turn-request-document', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-document', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response-document', responsePending: false, reconciledAt: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      candidateCalls: [],
    }), {
      kind: 'incomplete',
      verifiedReceiptRefs: [],
      code: 'current_document_read_required',
      callId: null,
    })

    const executionBinding = repository.readToolBridgeExecutionBinding(run.runId)
    const callWithoutActionId = {
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: 'call-document-read',
      readyRunId: run.runId,
      readyAliasId: run.conversationAlias.aliasId,
      codexSessionId: 'thread-native-1',
      readyTaskId: run.taskId,
      toolName: 'document_read_section',
      argsDigest: digestCanonicalJson({ range: 'full' }),
      turnContractDigest: 'turn-contract-run-document-barrier',
      surfaceSnapshotDigest: executionBinding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: executionBinding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: executionBinding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: executionBinding.toolSurface.entries[0].schemaDigest,
      requestConnectionEpoch: 'epoch-document',
      requestRpcId: '3',
      at: admittedAt,
    }
    const callActionIdentity = buildCodexToolActionIdentity(callWithoutActionId)
    const call = { ...callWithoutActionId, readyActionId: callActionIdentity.readyActionId }
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'gateway-receipt-document-read', call.codexThreadId, call.codexTurnId, call.readyRunId,
      'snapshot-ref', 'snapshot-digest', 'request-digest-document-read', admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-receipt-document-read',
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      calls: [{
        codexCallId: call.codexCallId,
        toolName: call.toolName,
        argsDigest: call.argsDigest,
      }],
      admittedAt,
    })
    repository.bindToolCall(call)
    const modelVisibleText = 'CURRENT_DOCUMENT_BODY'
    const actionIdentityDigest = callActionIdentity.actionIdentityDigest
    const unsignedReceipt = {
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      readyActionId: call.readyActionId,
      actionIdentityDigest,
      logicalResourceId: currentDocumentAnchor.logicalResourceId,
      currentVersion: currentDocumentAnchor.currentVersion,
      currentDigest: currentDocumentAnchor.currentDigest,
      policyEpoch: currentDocumentAnchor.policyEpoch,
      tabId: currentDocumentAnchor.tabId,
      pane: currentDocumentAnchor.pane,
      pathDigest: currentDocumentAnchor.pathDigest,
      incarnationKey: currentDocumentAnchor.incarnationKey,
      operation: 'read_section',
      summaryDigest: createHash('sha256').update(modelVisibleText).digest('hex'),
      bodyBytes: Buffer.byteLength(modelVisibleText),
    }
    const output = createToolExecutionOutput(modelVisibleText, {
      data: {
        ok: true,
        resourceReadReceipt: {
          ...unsignedReceipt,
          receiptDigest: digestCanonicalJson(unsignedReceipt),
        },
      },
    })
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({ readyActionId: call.readyActionId, actionIdentityDigest, at: admittedAt })
    const committed = await journal.commit({
      readyActionId: call.readyActionId,
      actionIdentityDigest,
      resultDigest: digestCanonicalJson(output),
      output,
      at: admittedAt,
    })
    repository.completeToolCall({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      receiptId: committed.receiptId,
      resultDigest: committed.resultDigest,
      at: admittedAt,
    })
    repository.beginToolCallDeliveryAttempt({
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      codexCallId: call.codexCallId,
      connectionEpoch: call.requestConnectionEpoch,
      requestRpcId: call.requestRpcId,
      toolResponse: mapReadyToolOutput(output),
      toolResponseDigest: digestCanonicalJson(mapReadyToolOutput(output)),
      at: admittedAt,
    })
    assert.deepEqual(repository.readToolPublicationBarrier({
      readyRunId: call.readyRunId,
      codexThreadId: call.codexThreadId,
      codexTurnId: call.codexTurnId,
      candidateCalls: [{
        itemId: call.codexCallId,
        tool: call.toolName,
        status: 'completed',
        success: true,
        responseDigest: digestCanonicalJson(mapReadyToolOutput(output)),
      }],
    }), {
      kind: 'accepted',
      verifiedReceiptRefs: [committed.receiptId],
      code: null,
      callId: null,
    })
  })
})

test('native bridge joins a failed Ready result to exact native readback and publication', async (t) => {
  await withRepository(t, async (db, repository) => {
    const run = prepared()
    run.readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-native-bridge',
      toolDefinitions: [{
        name: 'ready_read_probe', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'Read the native bridge fixture',
        schema: {
          type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
          additionalProperties: false,
        },
        executionVisibility: 'model', resultShape: 'json',
      }],
    })
    run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-native-bridge',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: run.readyToolSurface,
    })
    run.productBudgetSeed = { maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1 }
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-native-bridge', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-native-bridge', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-native-bridge', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-native-bridge', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-native-bridge', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'turn-request-native-bridge',
      dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-native-bridge', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1',
      nativeResult: { turn: activeTurn() }, responseDigest: 'turn-response-native-bridge',
      responsePending: false, reconciledAt: admittedAt,
    })

    let executions = 0
    const runAbortAuthority = new CodexHostOrchestrator({})
    runAbortAuthority.beginActiveProductRun({
      agent: 'ready',
      scopeId: run.readyToolHostIdentity.scopeId,
      aliasId: run.conversationAlias.aliasId,
      requestId: run.ingressBinding.requestId,
      runId: run.runId,
    })
    const connectionAbortController = new AbortController()
    t.after(() => runAbortAuthority.finishActiveProductRun({
      agent: 'ready',
      scopeId: run.readyToolHostIdentity.scopeId,
      requestId: run.ingressBinding.requestId,
      runId: run.runId,
    }))
    const bridge = new CodexReadyToolBridge({
      persistence: repository,
      receipts: new CodexToolActionJournal(db as unknown as DatabaseConnection),
      validateToolArguments: (_binding, _name, args) => {
        assert.equal(typeof args.id, 'string')
      },
      loadToolExecutor: async () => async (_name, args, context) => {
        executions += 1
        assert.deepEqual(args, { id: 'doc-1' })
        assert.equal(context.runId, run.runId)
        assert.equal(context.sessionId, run.conversationAlias.aliasId)
        assert.equal(context.scopeId, run.readyToolHostIdentity.scopeId)
        assert.equal(context.allowedToolNames instanceof Set, true)
        return createToolExecutionOutput('native bridge blocked', {
          data: { errorKind: 'denied_manual_only' },
        })
      },
      buildToolContext: () => ({}),
      getAbortSignal: (binding) => runAbortAuthority.getActiveRunAbortSignal({
        readyRunId: binding.readyRunId,
        readyScopeId: binding.readyScopeId,
        readyAliasId: binding.readyAliasId,
      }),
      getSensitiveValues: () => [],
      awaitInteractionResolution: async () => {
        throw new CodexToolBridgeError('fixture_interaction_resolution_unexpected')
      },
      isConnectionLive: (connectionEpoch) => connectionEpoch === 'epoch-native-bridge',
      getConnectionAbortSignal: (connectionEpoch) => connectionEpoch === 'epoch-native-bridge'
        ? connectionAbortController.signal
        : null,
      now: () => admittedAt,
      timeoutMs: 1_000,
    })
    const request = {
      bindingId: run.runId,
      connectionEpoch: 'epoch-native-bridge',
      requestId: 3,
      params: {
        threadId: 'thread-native-1', turnId: 'turn-native-1', callId: 'call-native-bridge',
        namespace: null, tool: 'ready_read_probe', arguments: { id: 'doc-1' },
      },
    }
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'gateway-receipt-native-bridge', request.params.threadId, request.params.turnId, run.runId,
      'snapshot-ref', 'snapshot-digest', 'request-digest-native-bridge', admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-receipt-native-bridge',
      readyRunId: run.runId,
      codexThreadId: request.params.threadId,
      codexTurnId: request.params.turnId,
      calls: [{
        codexCallId: request.params.callId,
        toolName: request.params.tool,
        argsDigest: digestCanonicalJson(request.params.arguments),
      }],
      admittedAt,
    })
    const response = await bridge.execute(request)
    assert.equal(response.success, false)
    assert.equal(executions, 1)
    assert.deepEqual(db.prepare(`
      SELECT c.receipt_id IS NOT NULL AS call_confirmed,
             c.delivery_intent_at IS NOT NULL AS delivery_intended,
             c.tool_response_digest,
             r.state AS action_state
        FROM codex_tool_call_bindings c
        JOIN ready_tool_action_receipts r ON r.ready_action_id = c.ready_action_id
       WHERE c.codex_call_id = 'call-native-bridge'
    `).get(), {
      call_confirmed: 1,
      delivery_intended: 1,
      tool_response_digest: digestCanonicalJson(response),
      action_state: 'confirmed',
    })
    const normalizedTurn = normalizeCodexTurn({
      id: request.params.turnId,
      status: 'failed',
      error: null,
      items: [{
        type: 'dynamicToolCall',
        id: request.params.callId,
        tool: request.params.tool,
        namespace: null,
        arguments: request.params.arguments,
        status: 'failed',
        success: response.success,
        contentItems: response.contentItems,
      }],
    })
    assert.ok(normalizedTurn)
    const collectedCandidate = new CodexTurnCollector({} as CodexNativeRuntime)
      .buildReadbackCandidate({
        readyTaskId: run.taskId,
        readyRunId: run.runId,
        scopeId: run.readyToolHostIdentity.scopeId,
        codexThreadId: request.params.threadId,
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
        allowNullPhaseFallback: false,
      }, normalizedTurn)
    const usedToolCalls = collectedCandidate.usedToolCalls
    assert.equal(usedToolCalls[0]?.responseDigest, digestCanonicalJson(response))
    repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: request.params.threadId,
      codexTurnId: request.params.turnId,
      engineOutcome: 'failed',
      candidate: collectedCandidate,
      recordedAt: admittedAt,
    })
    const publication = repository.readToolPublicationBarrier({
      readyRunId: run.runId,
      codexThreadId: request.params.threadId,
      codexTurnId: request.params.turnId,
      candidateCalls: usedToolCalls,
    })
    assert.equal(publication.kind, 'accepted')
    await assert.rejects(
      () => bridge.execute({ ...request, requestId: 5 }),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_result_replay_forbidden',
    )
    assert.equal(executions, 1)
    assert.equal(
      db.prepare(`PRAGMA table_info(codex_tool_call_bindings)`).all()
        .some((row) => (row as { name: string }).name === 'result_json'),
      false,
    )
    await assert.rejects(
      () => bridge.execute({
        ...request,
        requestId: 4,
        params: { ...request.params, callId: 'call-native-over-budget' },
      }),
      (error) => error instanceof CodexBindingRepositoryError
        && error.code === 'tool_call_not_admitted',
    )
    assert.equal(executions, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_tool_call_bindings`)
      .get<{ count: number }>()?.count, 1)
  })
})

test('persisted conversation authorization mode survives restart and controls the real Codex tool gate', async (t) => {
  await withRepository(t, async (db, repository) => {
    const runId = 'run-action-mode-auto'
    const sessionId = 'scope-1'
    __setScopeContextEpochDatabaseForTests({ getRawDb: () => db })
    rememberLastReferenceSkill(sessionId, {
      id: 'lark-cli',
      name: 'lark-cli',
      messageVisibilityEpoch: 0,
    })
    t.after(() => {
      clearLastReferenceSkill(sessionId)
      __setScopeContextEpochDatabaseForTests(null)
    })
    const skillAuthorization = buildSelectedSkillToolAuthorization({
      skillId: 'lark-cli',
      allowedTypedActions: [],
      allowedPrimitives: ['skill_run_shell'],
      source: 'explicit',
      reason: 'explicit_user_mention',
    })
    const currentDefinition = defaultToolRegistry.getToolDefinitionsForGroup(
      'skills',
      sessionId,
      skillAuthorization,
      sessionId,
    ).find((definition) => definition.name === 'skill_run_shell')
    assert.ok(currentDefinition)
    const frozenDefinition = { ...currentDefinition, codexExecutionSafe: true }
    const readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-action-mode-auto',
      toolDefinitions: [frozenDefinition],
    })
    const readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-action-mode-auto',
      authorization: skillAuthorization,
      toolSurface: readyToolSurface,
    })
    db.prepare(`
      INSERT OR REPLACE INTO chat_conversations (id, source_kind, meta_json)
      VALUES (?, 'local', ?)
    `).run(sessionId, JSON.stringify({ actionAuthorizationMode: 'auto' }))
    const request: SendScopedRequest = {
      scopeId: sessionId,
      requestId: `request-${runId}`,
      message: '在空单元格写入一个普通值',
      userMessage: {
        id: `message-${runId}`,
        content: 'hello',
        timestamp: admittedAt,
        meta: { actionAuthorizationMode: 'full' },
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    }
    const readPersistedScope = () => {
      const row = db.prepare(`
        SELECT source_kind, meta_json FROM chat_conversations WHERE id = ?
      `).get<{ source_kind: 'local' | 'channel'; meta_json: string }>(sessionId)
      assert.ok(row)
      return {
        id: sessionId,
        aliasGeneration: 1,
        agent: 'butler',
        activeAgentId: 'butler',
        handoffGeneration: 0,
        title: 'Mode fixture',
        sourceKind: row.source_kind,
        sourceId: row.source_kind === 'local' ? 'app' : 'channel-1',
        threadKey: sessionId,
        meta: JSON.parse(row.meta_json) as Record<string, unknown>,
        createdAt: admittedAt,
        updatedAt: admittedAt,
      }
    }
    const resolvedIngress = resolveCodexProductTurnAuthorization({
      host: {
        getScope: readPersistedScope,
        resolveSkillAuthorizationForTurn: () => skillAuthorization,
      },
      request,
      scopeId: sessionId,
      externalReadSlice: null,
    })
    assert.equal(resolvedIngress.requestEnvelope.actionAuthorizationMode, 'auto')
    assert.deepEqual(resolvedIngress.requestEnvelope.resources, [])
    assert.deepEqual(resolvedIngress.requestEnvelope.environmentHints.workspaceRoots, undefined)
    const preparedResult = new CodexProductRunPreparer().prepare({
      taskId: `task-${runId}`,
      runId,
      requestId: `request-${runId}`,
      scopeId: sessionId,
      aliasId: sessionId,
      aliasGeneration: 1,
      taskOrigin: 'user_root',
      runOrigin: 'initial',
      originUserMessageId: `message-${runId}`,
      reservationSetId: `set-${runId}`,
      reservationEvidenceDigest: `reservation-evidence-${runId}`,
      currentInput: [{ type: 'text', text: 'hello', text_elements: [] }],
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
      actionAuthorizationMode: readActionAuthorizationModeFromEnvelope(
        resolvedIngress.requestEnvelope,
      ),
      readyToolSurface,
      readyTurnToolAuthorization,
      authorizationOwnerId: 'owner-1',
      resourceOwnerId: 'resource-owner-1',
      productBudgetSeed: { maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1 },
    })
    assert.equal(preparedResult.ok, true)
    if (!preparedResult.ok) return
    const run = preparedResult.prepared
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(runId)))

    db.prepare(`
      UPDATE chat_conversations
         SET source_kind = 'channel', meta_json = ?
       WHERE id = ?
    `).run(JSON.stringify({ actionAuthorizationMode: 'full' }), sessionId)
    const remoteIngress = resolveCodexProductTurnAuthorization({
      host: {
        getScope: readPersistedScope,
        resolveSkillAuthorizationForTurn: () => skillAuthorization,
      },
      request: { ...request, requestId: 'request-remote-mode' },
      scopeId: sessionId,
      externalReadSlice: null,
    })
    assert.equal(remoteIngress.requestEnvelope.actionAuthorizationMode, 'ask')
    assert.deepEqual(remoteIngress.requestEnvelope.resources, [])
    assert.deepEqual(remoteIngress.requestEnvelope.environmentHints.workspaceRoots, undefined)
    db.prepare(`
      UPDATE chat_conversations
         SET source_kind = 'local', meta_json = ?
       WHERE id = ?
    `).run(JSON.stringify({ actionAuthorizationMode: 'ask' }), sessionId)

    const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const persistedProduct = restarted.readProductTurnRuntime(runId)
    assert.deepEqual(readCodexPreparedActionAuthorizationEnvelope(persistedProduct), {
      actionAuthorizationMode: 'auto',
    })

    repository.activateStartDispatch({
      connectionEpoch: 'epoch-action-mode', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-action-mode', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-action-mode', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-action-mode',
      nativeResult: { thread: { ...rootThread(), id: 'thread-native-action-mode', sessionId: 'thread-native-action-mode' }, instructionSources: [] },
      responseDigest: 'thread-response-action-mode', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-action-mode', rpcId: 2, method: 'turn/start',
      bindingLookupKey: runId, requestDigest: 'turn-request-action-mode',
      dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-action-mode', rpcId: 2, method: 'turn/start',
      bindingId: runId, nativeId: 'turn-native-action-mode',
      nativeResult: { turn: { ...activeTurn(), id: 'turn-native-action-mode' } },
      responseDigest: 'turn-response-action-mode', responsePending: false,
      reconciledAt: admittedAt,
    })

    let observedErrorKind: unknown = null
    const runAbortAuthority = new CodexHostOrchestrator({})
    runAbortAuthority.beginActiveProductRun({
      agent: 'ready', scopeId: sessionId, aliasId: sessionId,
      requestId: run.ingressBinding.requestId, runId,
    })
    t.after(() => runAbortAuthority.finishActiveProductRun({
      agent: 'ready', scopeId: sessionId, requestId: run.ingressBinding.requestId,
      runId: run.runId,
    }))
    const bridge = new CodexReadyToolBridge({
      persistence: restarted,
      receipts: new CodexToolActionJournal(db as unknown as DatabaseConnection),
      validateToolArguments: (_binding, _toolName, args) => {
        assert.equal(typeof args.command, 'string')
      },
      loadToolExecutor: async () => async (toolName, args, context) => {
        const output = await executeToolCall(toolName, args, context)
        observedErrorKind = output.data?.errorKind
        return output
      },
      buildToolContext: () => ({
        requestEnvelope: readCodexPreparedActionAuthorizationEnvelope(
          restarted.readProductTurnRuntime(runId),
        ),
        larkCliExecutableAuthority: { version: DELEGABLE_LARK_CLI_VERSION } as never,
      }),
      getAbortSignal: (binding) => runAbortAuthority.getActiveRunAbortSignal({
        readyRunId: binding.readyRunId,
        readyScopeId: binding.readyScopeId,
        readyAliasId: binding.readyAliasId,
      }),
      getSensitiveValues: () => [],
      awaitInteractionResolution: async () => {
        throw new CodexToolBridgeError('fixture_interaction_resolution_unexpected')
      },
      isConnectionLive: (epoch) => epoch === 'epoch-action-mode',
      getConnectionAbortSignal: () => new AbortController().signal,
      now: () => admittedAt,
      timeoutMs: 1_000,
    })
    const arguments_ = {
      command: `lark-cli sheets +cells-set --url "https://example.feishu.cn/sheets/token" --range "Sheet1!H1:H1" --cells '[[{"value":"Ready"}]]' --allow-overwrite=false --as user`,
    }
    db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'gateway-receipt-action-mode', 'thread-native-action-mode', 'turn-native-action-mode', runId,
      'snapshot-ref', 'snapshot-digest', 'request-digest-action-mode', admittedAt,
    )
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-receipt-action-mode',
      readyRunId: runId,
      codexThreadId: 'thread-native-action-mode',
      codexTurnId: 'turn-native-action-mode',
      calls: [{
        codexCallId: 'call-action-mode',
        toolName: 'skill_run_shell',
        argsDigest: digestCanonicalJson(arguments_),
      }],
      admittedAt,
    })
    await bridge.execute({
      bindingId: runId,
      connectionEpoch: 'epoch-action-mode',
      requestId: 3,
      params: {
        threadId: 'thread-native-action-mode',
        turnId: 'turn-native-action-mode',
        callId: 'call-action-mode',
        namespace: null,
        tool: 'skill_run_shell',
        arguments: arguments_,
      },
    })
    assert.notEqual(observedErrorKind, 'denied_pending_confirmation')
  })
})

test('manual compaction uses the latest closed authoritative turn snapshot instead of the thread creation snapshot', async (t) => {
  await withRepository(t, (db, repository) => {
    const firstProfile = createThreadTransitionProfile({
      profileId: 'profile-compaction-first',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 8_192,
    })
    const latestProfile = createThreadTransitionProfile({
      profileId: 'profile-compaction-latest',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 16_384,
    })
    const gatewayRepository = new CodexModelGatewayRepository(
      db as unknown as DatabaseConnection,
      repository,
    )
    gatewayRepository.storeSnapshot({ ...firstProfile, createdAt: admittedAt })
    gatewayRepository.storeSnapshot({
      ...latestProfile,
      createdAt: '2026-08-07T02:00:00.000Z',
    })

    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation(), {
      upstreamProfileSnapshotRef: firstProfile.snapshotRef,
      upstreamProfileSnapshotDigest: firstProfile.snapshotDigest,
    }))
    startAndCloseInitialProductTurn(db, repository)
    seedClosedAuthoritativeTurn(db, {
      readyRunId: 'run-latest-authoritative',
      upstreamProfileSnapshotRef: latestProfile.snapshotRef,
      upstreamProfileSnapshotDigest: latestProfile.snapshotDigest,
      createdAt: '2026-08-07T02:00:00.000Z',
    })

    const route = repository.readManualCompactionRoute({
      aliasId: 'scope-1',
      aliasGeneration: 1,
    })
    let beginResult: { manualCompactionId: string; codexThreadId: string } | null = null
    let beginError: string | null = null
    try {
      beginResult = repository.beginManualCompaction({
        manualCompactionId: 'manual-latest-profile',
        threadBindingId: 'thread-binding-1',
        ownerMainBootId: 'main-boot-1',
        codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: latestProfile.snapshotRef,
        upstreamProfileSnapshotDigest: latestProfile.snapshotDigest,
        providerSnapshot: latestProfile.snapshot,
        credentialReferenceId: latestProfile.snapshot.credentialReferenceId,
        expectedToolsDigest: digestCanonicalJson([]),
        preDispatchThreadReadDigest: 'pre-dispatch-latest-profile',
        preDispatchTurnIds: ['turn-native-1', 'turn-native-run-latest-authoritative'],
        expiresAt: '2026-08-07T04:00:00.000Z',
        createdAt: '2026-08-07T03:00:00.000Z',
      })
    } catch (error) {
      beginError = error instanceof CodexBindingRepositoryError ? error.code : String(error)
    }
    const persisted = db.prepare(`
      SELECT upstream_profile_snapshot_ref, upstream_profile_snapshot_digest,
             provider_snapshot_json
        FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-latest-profile'
    `).get()

    assert.deepEqual({ route, beginResult, beginError, persisted }, {
      route: {
        threadBindingId: 'thread-binding-1',
        aliasId: 'scope-1',
        aliasGeneration: 1,
        codexThreadId: 'thread-native-1',
        codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: latestProfile.snapshotRef,
        upstreamProfileSnapshotDigest: latestProfile.snapshotDigest,
      },
      beginResult: {
        manualCompactionId: 'manual-latest-profile',
        codexThreadId: 'thread-native-1',
      },
      beginError: null,
      persisted: {
        upstream_profile_snapshot_ref: latestProfile.snapshotRef,
        upstream_profile_snapshot_digest: latestProfile.snapshotDigest,
        provider_snapshot_json: JSON.stringify(latestProfile.snapshot),
      },
    })
  })
})

test('manual compaction owns the idle-thread fence and consume is all-or-nothing', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    const providerSnapshot = {
      model: 'ready-e0-model', credentialReferenceId: 'credential-ref-1', route: 'fixture',
    }
    const providerSnapshotDigest = digestCanonicalJson(providerSnapshot)
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(), {
      upstreamProfileSnapshotDigest: providerSnapshotDigest,
    }))
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
    const productTerminalDigest = recordCompletedTerminal(db, repository)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = 'task-run-1'`).run()
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1', productTerminalDigest, closeoutAt: admittedAt,
    })

    const manualInput = {
      manualCompactionId: 'manual-1',
      threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1',
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-1',
      upstreamProfileSnapshotDigest: providerSnapshotDigest,
      providerSnapshot,
      credentialReferenceId: 'credential-ref-1',
      expectedToolsDigest: digestCanonicalJson([]),
      preDispatchThreadReadDigest: 'pre-dispatch-thread-read',
      preDispatchTurnIds: ['turn-native-1'],
      expiresAt: '2026-08-07T03:00:00.000Z',
      createdAt: admittedAt,
    }
    assert.deepEqual(repository.readManualCompactionRoute({
      aliasId: 'scope-1',
      aliasGeneration: 1,
    }), {
      threadBindingId: 'thread-binding-1',
      aliasId: 'scope-1',
      aliasGeneration: 1,
      codexThreadId: 'thread-native-1',
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-1',
      upstreamProfileSnapshotDigest: providerSnapshotDigest,
    })
    for (const [index, overrides] of [
      { codexModel: 'changed-model' },
      { upstreamProfileSnapshotRef: 'changed-ref' },
      { upstreamProfileSnapshotDigest: 'changed-digest' },
      { providerSnapshot: { ...providerSnapshot, route: 'changed' } },
      { credentialReferenceId: 'changed-credential' },
    ].entries()) {
      assert.throws(
        () => repository.beginManualCompaction({
          ...manualInput, ...overrides, manualCompactionId: `manual-drift-${index}`,
        }),
        (error: unknown) => error instanceof CodexBindingRepositoryError
          && error.code === 'manual_compaction_route_mismatch',
      )
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings`).get<{ count: number }>()?.count, 0)
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
    }
    assert.throws(
      () => repository.beginManualCompaction({
        ...manualInput, manualCompactionId: 'manual-tools-drift', expectedToolsDigest: 'not-empty',
      }),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'manual_compaction_tool_surface_invalid',
    )
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings`).get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
    assert.deepEqual(repository.beginManualCompaction(manualInput), {
      manualCompactionId: 'manual-1', codexThreadId: 'thread-native-1',
    })
    assert.deepEqual(repository.activateManualCompactionDispatch({
      connectionEpoch: 'manual-epoch-1', rpcId: 7, codexThreadId: 'thread-native-1',
      requestDigest: 'manual-request-digest', dispatchIntentAt: admittedAt,
    }), { manualCompactionId: 'manual-1' })
    repository.renewManualCompactionRecoveryWindow({
      manualCompactionId: 'manual-1',
      expiresAt: '2026-08-07T04:00:00.000Z',
      renewedAt: admittedAt,
    })
    assert.throws(
      () => repository.activateManualCompactionDispatch({
        connectionEpoch: 'manual-epoch-2', rpcId: 8, codexThreadId: 'thread-native-1',
        requestDigest: 'manual-request-duplicate', dispatchIntentAt: admittedAt,
      }),
      /UNIQUE constraint failed/,
    )
    repository.markManualCompactionWriteAttempted({
      connectionEpoch: 'manual-epoch-1', rpcId: 7, manualCompactionId: 'manual-1',
      attemptedAt: admittedAt,
    })
    repository.markManualCompactionWriteConfirmed({
      connectionEpoch: 'manual-epoch-1', rpcId: 7, manualCompactionId: 'manual-1',
      childWriteDigest: 'manual-request-digest', confirmedAt: admittedAt,
    })
    repository.markManualCompactionDispatchUnresolved({
      connectionEpoch: 'manual-epoch-1', rpcId: 7, manualCompactionId: 'manual-1',
      reason: 'response_timeout', unresolvedAt: admittedAt,
    })
    assert.equal(repository.consumeLateManualCompactionResponse({
      connectionEpoch: 'manual-epoch-1', rpcId: 7, responseKind: 'accepted',
      responseDigest: 'manual-response-digest', responseAt: admittedAt,
    }), true)
    assert.deepEqual(db.prepare(`
      SELECT child_write_attempted_at, child_write_confirmed_at,
             unresolved_reason, response_kind
        FROM codex_manual_compaction_dispatch_attempts
       WHERE manual_compaction_id = 'manual-1'
    `).get(), {
      child_write_attempted_at: admittedAt,
      child_write_confirmed_at: admittedAt,
      unresolved_reason: 'response_timeout',
      response_kind: 'accepted',
    })
    repository.completeProductTurnCloseout({
      readyRunId: 'run-1',
      productTerminalDigest,
      closeoutAt: admittedAt,
    })
    assert.deepEqual(db.prepare(`
      SELECT operation_kind, owner_manual_compaction_id
        FROM codex_thread_dispatch_fences WHERE thread_binding_id = 'thread-binding-1'
    `).get(), {
      operation_kind: 'manual_compaction',
      owner_manual_compaction_id: 'manual-1',
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
        notificationContextCompactionItemId: 'compact-notification-item-1',
        contextCompactionItemId: 'compact-item-1', threadReadDigest: 'thread-read-1',
        terminalEvidenceDigest: 'terminal-evidence-1', gatewayRequestReceiptId: 'gateway-receipt-1',
        gatewayRequestEvidenceDigest: 'gateway-request-evidence-1',
        gatewayResponseEvidenceDigest: 'gateway-response-evidence-1',
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
      notificationContextCompactionItemId: 'compact-notification-item-1',
      contextCompactionItemId: 'compact-item-1', threadReadDigest: 'thread-read-1',
      terminalEvidenceDigest: 'terminal-evidence-1', gatewayRequestReceiptId: 'gateway-receipt-1',
      gatewayRequestEvidenceDigest: 'gateway-request-evidence-1',
      gatewayResponseEvidenceDigest: 'gateway-response-evidence-1',
      consumedAt: admittedAt,
    })
    assert.deepEqual(db.prepare(`
      SELECT codex_compaction_turn_id, notification_context_compaction_item_id,
             context_compaction_item_id, consumed_at FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-1'
    `).get(), {
      codex_compaction_turn_id: 'compact-turn-1',
      notification_context_compaction_item_id: 'compact-notification-item-1',
      context_compaction_item_id: 'compact-item-1',
      consumed_at: admittedAt,
    })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
  })
})

test('unknown manual compaction remains quarantined until late terminal readback', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    const providerSnapshot = {
      model: 'ready-e0-model', credentialReferenceId: 'credential-ref-1', route: 'fixture',
    }
    const providerSnapshotDigest = digestCanonicalJson(providerSnapshot)
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(), {
      upstreamProfileSnapshotDigest: providerSnapshotDigest,
    }))
    startAndCloseInitialProductTurn(db, repository)
    repository.beginManualCompaction({
      manualCompactionId: 'manual-unknown', threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'profile-ref-1', upstreamProfileSnapshotDigest: providerSnapshotDigest,
      providerSnapshot, credentialReferenceId: 'credential-ref-1',
      expectedToolsDigest: digestCanonicalJson([]), expiresAt: '2026-08-07T03:00:00.000Z',
      preDispatchThreadReadDigest: 'pre-dispatch-thread-read',
      preDispatchTurnIds: ['turn-native-1'],
      createdAt: admittedAt,
    })
    assert.throws(
      () => repository.quarantineUnknownManualCompaction({
        aliasId: 'scope-1', aliasGeneration: 1,
        manualCompactionId: 'manual-unknown', reason: 'not-yet-unknown',
        evidenceDigest: 'premature-quarantine', quarantinedAt: admittedAt,
      }),
      /manual_compaction_not_quarantinable/,
    )
    repository.recordManualCompactionUnknown({
      manualCompactionId: 'manual-unknown', reason: 'compaction_state_unknown',
      evidenceDigest: 'unknown-evidence', unknownAt: admittedAt,
    })
    repository.recordManualCompactionUnknown({
      manualCompactionId: 'manual-unknown', reason: 'compaction_state_unknown',
      evidenceDigest: 'unknown-evidence', unknownAt: admittedAt,
    })
    const unknownLifecycle = repository.readLifecycleOperation({
      aliasId: 'scope-1', aliasGeneration: 1,
    })
    assert.equal(unknownLifecycle.activeManualCompactionId, 'manual-unknown')
    assert.throws(
      () => repository.quarantineUnknownManualCompaction({
        aliasId: 'scope-1', aliasGeneration: 2,
        manualCompactionId: 'manual-unknown', reason: 'stale-generation-reset',
        evidenceDigest: 'stale-generation-evidence', quarantinedAt: admittedAt,
      }),
      /manual_quarantine_alias_mismatch/,
    )
    assert.throws(
      () => repository.recordManualCompactionUnknown({
        manualCompactionId: 'manual-unknown', reason: 'different-reason',
        evidenceDigest: 'different-evidence', unknownAt: admittedAt,
      }),
      /manual_unknown_conflict/,
    )
    const quarantine = repository.quarantineUnknownManualCompaction({
      aliasId: 'scope-1', aliasGeneration: 1,
      manualCompactionId: 'manual-unknown', reason: 'compaction_state_unknown',
      evidenceDigest: digestCanonicalJson({ kind: 'quarantine-evidence' }),
      quarantinedAt: admittedAt,
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
    const activeAfterLateReadback = repository.readActiveAliasBinding('scope-1')
    assert.equal(activeAfterLateReadback?.threadBindingId, quarantine.newThreadBindingId)
    assert.equal(activeAfterLateReadback?.aliasGeneration, 2)
    assert.equal(activeAfterLateReadback?.hasActiveFence, false)
    assert.equal(activeAfterLateReadback?.retiredAt, null)
    assert.deepEqual(db.prepare(`
      SELECT abandoned_reconciled_at FROM codex_manual_compaction_bindings
       WHERE manual_compaction_id = 'manual-unknown'
    `).get(), { abandoned_reconciled_at: '2026-08-07T02:05:00.000Z' })
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
  })
})

test('active upstream profile usage is derived from the exact open product fence snapshot', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-active-profile-usage')
    prepareReadyParents(db, repository, run)
    const upstream = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-active',
      config: {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'secret',
        model: 'model-a',
        agentProtocol: 'openai',
        wireApi: 'chat/completions',
        toolUseMode: 'on',
      },
      maxRetries: 6,
    })
    new CodexModelGatewayRepository(db).storeSnapshot({
      ...upstream,
      createdAt: admittedAt,
    })
    repository.admitProductBindings(admission(run, lazyReservation(run.runId), {
      upstreamProfileSnapshotRef: upstream.snapshotRef,
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
    }))

    assert.deepEqual(repository.readActiveUpstreamProfileUsages(), [{
      profileId: 'profile-active',
      snapshotDigest: upstream.snapshotDigest,
    }])
  })
})

test('pending and unknown manual compaction protect their frozen profile until quarantine', async (t) => {
  await withRepository(t, (db, repository) => {
    const config = {
      provider: 'openai-compatible' as const,
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret-a',
      model: 'model-a',
      agentProtocol: 'openai' as const,
      wireApi: 'chat/completions' as const,
      toolUseMode: 'on' as const,
    }
    const upstream = createCodexUpstreamProfileSnapshot({
      profileId: 'profile-manual-active',
      config,
      maxRetries: 6,
    })
    new CodexModelGatewayRepository(db).storeSnapshot({
      ...upstream,
      createdAt: admittedAt,
    })
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(), {
      upstreamProfileSnapshotRef: upstream.snapshotRef,
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
    }))
    startAndCloseInitialProductTurn(db, repository)
    repository.beginManualCompaction({
      manualCompactionId: 'manual-profile-guard',
      threadBindingId: 'thread-binding-1',
      ownerMainBootId: 'main-boot-1',
      codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: upstream.snapshotRef,
      upstreamProfileSnapshotDigest: upstream.snapshotDigest,
      providerSnapshot: upstream.snapshot,
      credentialReferenceId: upstream.snapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]),
      preDispatchThreadReadDigest: 'manual-profile-guard-read',
      preDispatchTurnIds: ['turn-native-1'],
      expiresAt: '2026-08-07T03:00:00.000Z',
      createdAt: admittedAt,
    })

    const currentWorkspace = {
      version: 1 as const,
      activeProfileId: 'profile-manual-active',
      profiles: [{
        id: 'profile-manual-active',
        category: 'custom' as const,
        name: 'Manual profile',
        builtIn: false,
        showInChatSwitcher: true,
        config,
      }, {
        id: 'profile-fallback',
        category: 'custom' as const,
        name: 'Fallback profile',
        builtIn: false,
        showInChatSwitcher: true,
        config: { ...config, baseUrl: 'https://fallback.example/v1', model: 'model-b' },
      }],
    }
    const guard = new ActiveAIProfileMutationGuard(
      () => repository.readActiveUpstreamProfileUsages(),
    )
    assert.deepEqual(repository.readActiveUpstreamProfileUsages(), [{
      profileId: 'profile-manual-active',
      snapshotDigest: upstream.snapshotDigest,
    }])
    assert.doesNotThrow(() => guard.assertWorkspaceMutationAllowed(currentWorkspace, {
      ...currentWorkspace,
      profiles: currentWorkspace.profiles.map((profile) => profile.id === 'profile-manual-active'
        ? { ...profile, config: { ...profile.config, apiKey: 'rotated-secret' } }
        : profile),
    }))
    assert.throws(() => guard.assertWorkspaceMutationAllowed(currentWorkspace, {
      ...currentWorkspace,
      profiles: currentWorkspace.profiles.map((profile) => profile.id === 'profile-manual-active'
        ? { ...profile, config: { ...profile.config, model: 'model-changed' } }
        : profile),
    }), /ai_profile_in_use_by_active_turn/)
    assert.throws(() => guard.assertWorkspaceMutationAllowed(currentWorkspace, {
      ...currentWorkspace,
      activeProfileId: 'profile-fallback',
      profiles: currentWorkspace.profiles.filter((profile) => profile.id !== 'profile-manual-active'),
    }), /ai_profile_in_use_by_active_turn/)

    repository.recordManualCompactionUnknown({
      manualCompactionId: 'manual-profile-guard',
      reason: 'compaction_state_unknown',
      evidenceDigest: 'manual-profile-guard-unknown',
      unknownAt: admittedAt,
    })
    assert.equal(repository.readActiveUpstreamProfileIds().has('profile-manual-active'), true)

    repository.quarantineUnknownManualCompaction({
      aliasId: 'scope-1',
      aliasGeneration: 1,
      manualCompactionId: 'manual-profile-guard',
      reason: 'compaction_state_unknown',
      evidenceDigest: 'manual-profile-guard-quarantine',
      quarantinedAt: admittedAt,
    })
    assert.deepEqual(repository.readActiveUpstreamProfileUsages(), [])
    assert.doesNotThrow(() => guard.assertWorkspaceMutationAllowed(currentWorkspace, {
      ...currentWorkspace,
      activeProfileId: 'profile-fallback',
      profiles: currentWorkspace.profiles.filter((profile) => profile.id !== 'profile-manual-active'),
    }))
  })
})
