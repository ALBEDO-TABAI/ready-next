import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'
import { ReadyMemoryRepository } from '../main/modules/agent-control/ready-memory/ready-memory-repository'
import { FrozenCallStore } from '../main/modules/agent-control/safety/frozen-call-store'
import { resolveExplicitRetryTailPlan } from '../main/modules/agent-control/codex-runtime/codex-history-continuity-policy'

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
  resolveCodexNativeModelSettings,
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
  isPreparedCodexProductRun,
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
import { digestCodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { CodexTurnInputBuilder } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { CodexTurnCollector } from '../main/modules/agent-control/codex-runtime/codex-turn-collector'
import {
  buildTerminalNativeReadbackReceipt,
  resolveCodexTerminalFacts,
  terminalEvidenceRef,
  terminalNativeReadbackEvidenceRef,
  terminalGatewayEvidenceRef,
  terminalIndeterminateEffectEvidenceRef,
} from '../main/modules/agent-control/codex-runtime/codex-terminal-facts'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'
import type { StartIdentityReservationSet } from '../main/modules/agent-control/send-scoped-confirmation'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { classifyLifecycleOperation } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import { workflowDigest } from '../main/modules/repositories/browser-workflow-codec'
import { ActiveAIProfileMutationGuard } from '../main/modules/settings-engine/active-ai-profile-mutation-guard'
import { closeCodexConversationScopeInOpenTransaction } from '../main/modules/agent-control/codex-runtime/codex-conversation-scope-closure'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'
import {
  CodexAppServerClient,
  type CodexJsonLineTransport,
} from '../main/modules/agent-control/codex-runtime/codex-app-server-client'
import { CodexThreadArchiveCleanupOwner } from '../main/modules/agent-control/codex-runtime/codex-thread-archive-owner'
import {
  CodexDurableThreadArchiveDispatchPort,
  CodexThreadArchiveIntentStore,
} from '../main/modules/agent-control/codex-runtime/codex-thread-archive-cleanup'
import {
  enqueueEligibleRetiredCodexThreadArchiveIntents,
  retireAllCodexThreadBindingsForConversationReset,
} from '../main/modules/agent-control/codex-runtime/codex-thread-retirement-cleanup-migration'
import {
  resolveReadyActionObligationSet,
  type ReadyActionObligationSetV1,
} from '../main/modules/agent-control/codex-runtime/codex-action-obligation'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'

type NativeDb = import('better-sqlite3').Database

const admittedAt = '2026-08-07T01:00:00.000Z'
import { fileURLToPath } from 'node:url'
import { createCodexProductionPorts } from './helpers/codex-production-composition-harness'
import { CodexProductRunPreparer } from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { buildReadyTurnToolAuthorization } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { resolveCodexThreadInstructionContract } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'

// Must resolve to the same native thread config the seeded head froze; a real
// difference is a real `thread_config_changed`, not something the test may relax.
const productionProfileConfig = {
  provider: 'openai',
  baseUrl: 'http://127.0.0.1:10532/v1',
  apiKey: 'ready-oauth-proxy-key-12345678901234567890',
  model: 'gpt-5.6-terra',
  authMode: 'chatgpt-oauth',
  agentProtocol: 'openai',
  wireApi: 'responses',
  reasoningEffort: 'high',
  contextWindowOverride: 272_000,
  maxOutputTokensOverride: 8_192,
  toolUseMode: 'on',
  nativeVideoMode: 'off',
}

const testRuntimeManifestDigest = digestCanonicalJson({ fixture: 'codex-binding-runtime-v1' })
const testRuntimeContract = {
  runtimeManifestDigest: testRuntimeManifestDigest,
  protocolSchemaDigest: 'protocol-schema-digest',
  runtimeContinuityCatalog: {
    contract: 'ready_runtime_continuity_catalog_v1' as const,
    targetManifestDigest: testRuntimeManifestDigest,
    transitions: [],
  },
}
let activeAdmissionRepository: CodexBindingRepository | null = null
let activeAdmissionDatabase: DatabaseConnection | null = null

class CleanupArchiveTransport implements CodexJsonLineTransport {
  readonly writes: Array<{ id?: number; method: string }> = []
  private lineListener: ((line: string) => void) | null = null
  private closeListener: ((error: Error | null) => void) | null = null

  write(line: string, callback: (error: Error | null) => void): void {
    const frame = JSON.parse(line) as { id?: number; method: string }
    this.writes.push(frame)
    queueMicrotask(() => {
      callback(null)
      if (frame.id === undefined) return
      setTimeout(() => {
        const result = frame.method === 'initialize'
          ? { userAgent: 'ready-cleanup-test/1' }
          : frame.method === 'thread/read'
            ? { thread: { ...rootThread(), status: { type: 'notLoaded' } } }
            : {}
        this.lineListener?.(JSON.stringify({ id: frame.id, result }))
      }, 0)
    })
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => { if (this.lineListener === listener) this.lineListener = null }
  }

  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListener = listener
    return () => { if (this.closeListener === listener) this.closeListener = null }
  }

  close(): void { this.closeListener?.(null) }
}

function prepared(runId = 'run-1'): PreparedCodexProductRun {
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-1',
    toolDefinitions: [],
  })
  return {
    preparationContract: 'codex_product_run_e2',
    sourceTrustedEnvironmentRef: {
      workbenchMode: 'browser',
      environmentDigest: 'e'.repeat(64),
    },
    readyMemorySnapshot: disabledReadyMemorySnapshot(),
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
      uncommittedTailAssignments: [],
      supersededUncommittedItems: [],
    },
    resourceAnchorDigest: createHash('sha256').update(JSON.stringify({
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
    })).digest('hex'),
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
  const repository = activeAdmissionRepository
  if (!repository) throw new Error('test_admission_repository_missing')
  const activeBinding = repository.readActiveAliasBinding(run.conversationAlias.aliasId)
  const needsContinuationCandidate = reservation.existingThread
    || activeBinding?.materializationKind === 'fresh_root_with_tail'
  const prepared = run.ingress.attemptKind === 'user_ingress'
    ? {
        ...run,
        ingress: {
          ...run.ingress,
          actionAdmissionRef: (() => {
            const projection = projectCodexHeadActionProjection(repository.readHeadActionFacts({
              aliasId: run.conversationAlias.aliasId,
              aliasGeneration: run.conversationAlias.aliasGeneration,
              currentRuntimeManifestDigest: overrides.runtimeManifestDigest
                || testRuntimeManifestDigest,
              currentProtocolSchemaDigest: overrides.protocolSchemaDigest
                || 'protocol-schema-digest',
            }))
            if (!projection.actionHeadIdentity) throw new Error('test_action_head_missing')
            return {
              headProjectionDigest: projection.evidenceDigest,
              actionProjectionVersion: projection.actionProjectionVersion,
              actionHeadIdentity: projection.actionHeadIdentity,
            }
          })(),
          uncommittedTailAssignments: run.ingress.uncommittedTailAssignments || [],
          supersededUncommittedItems: run.ingress.supersededUncommittedItems || [],
        },
      }
    : run
  const input = {
    prepared,
    reservation,
    ownerMainBootId: 'main-boot-1',
    admittedAt,
    ingressAdmittedRevision: 1,
    messageVisibilityEpoch: 0,
    threadBindingId: 'thread-binding-1',
    isolatedThreadCwd: '/tmp/ready-codex/thread-binding-1',
    turnRequestId: `turn-request-${run.runId}`,
    runtimeManifestDigest: testRuntimeManifestDigest,
    protocolSchemaDigest: 'protocol-schema-digest',
    instructionContractDigest: 'instruction-contract-digest',
    codexModel: 'ready-e0-model',
    upstreamProfileSnapshotRef: 'profile-ref-1',
    upstreamProfileSnapshotDigest: defaultThreadProfile.snapshotDigest,
    additionalContextDigest: `additional-context-${run.runId}`,
    turnContractDigest: `turn-contract-${run.runId}`,
    readyParentReceipt: {
      messageRole: 'user' as const,
      messageContent: 'hello',
      messageTimestamp: admittedAt,
      messageMetaDigest: digestCanonicalJson({}),
      executionBindingDigest: digestCanonicalJson({ schemaVersion: 1, runId: run.runId }),
    },
    continuationCandidate: needsContinuationCandidate
      ? {
          model: otherOverrides.codexModel || 'ready-e0-model',
          threadConfig: resolveCodexNativeModelSettings(
            new CodexModelGatewayRepository(activeAdmissionDatabase!).readSnapshot(
              otherOverrides.upstreamProfileSnapshotRef || 'profile-ref-1',
              otherOverrides.upstreamProfileSnapshotDigest || defaultThreadProfile.snapshotDigest,
            ),
          ).threadConfig,
          isolatedThreadCwd: otherOverrides.isolatedThreadCwd
            || '/tmp/ready-codex/thread-binding-1',
          cwdAvailable: true,
          instructionContractDigest: otherOverrides.instructionContractDigest
            || 'instruction-contract-digest',
          currentToolSurface: run.readyToolSurface,
        }
      : null,
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
  codexThreadId = 'thread-native-1',
  readyTaskId = `task-${readyRunId}`,
): string {
  const candidateText = 'done'
  const messageId = `assistant:${readyTaskId}:${readyRunId}:terminal`
  const meta = {
    taskId: readyTaskId,
    runId: readyRunId,
    terminalReason: 'done',
  }
  repository.recordEngineTerminalCandidate({
    readyRunId,
    codexThreadId,
    codexTurnId,
    engineOutcome: 'completed',
    candidate: {
      kind: 'native_terminal',
      readyTaskId,
      readyRunId,
      scopeId: 'scope-1',
      codexThreadId,
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
  db.prepare(`UPDATE run_meta SET status = 'done', terminal_reason = 'done' WHERE run_id = ?`).run(readyRunId)
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
    contextUsage: null,
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

function terminalCloseoutEvidence(
  run: PreparedCodexProductRun,
  candidate: ReturnType<typeof nativeFailureCandidate>,
  engineReceipt: { candidateDigest: string; revision: number },
  lifecycle?: {
    action: 'stop' | 'reset' | 'close'
    evidenceDigest: string
  },
  acceptedPrefixTurnIds: string[] = [],
) {
  const nativeThread: CodexThread = {
    ...rootThread(),
    id: candidate.codexThreadId,
    sessionId: candidate.codexThreadId,
    turns: [
      ...acceptedPrefixTurnIds.map((turnId) => ({
        id: turnId,
        status: 'completed' as const,
        error: null,
        items: [],
      })),
      {
      id: candidate.codexTurnId,
      status: candidate.engineOutcome,
      error: { message: 'failed' },
      items: [{
        type: 'userMessage',
        id: `native-${run.runId}`,
        clientId: run.ingress.kind === 'user_ingress'
          ? run.ingress.canonicalCurrentInputRef.messageId
          : `message-${run.runId}`,
        content: run.ingress.kind === 'user_ingress'
          ? run.ingress.canonicalCurrentInputRef.input
          : [],
      }, ...(candidate.candidateSelection.kind === 'accepted' ? [{
        type: 'agentMessage' as const,
        id: (candidate.candidateSelection as { itemId: string }).itemId,
        text: candidate.candidateText || '', phase: 'final_answer',
      }] : [])],
      },
    ],
  }
  const nativeReadback = buildTerminalNativeReadbackReceipt({
    candidate,
    prepared: run,
    aliasGeneration: run.conversationAlias.aliasGeneration,
    messageVisibilityEpoch: 0,
    connectionEpoch: 'epoch-diverged',
    turnRevision: engineReceipt.revision,
    thread: nativeThread,
  })
  const nativeTurnRef = terminalEvidenceRef({
    kind: 'native_turn',
    readyRunId: run.runId,
    readyScopeId: run.readyToolHostIdentity.scopeId,
    messageVisibilityEpoch: 0,
    aliasGeneration: run.conversationAlias.aliasGeneration,
    codexThreadId: candidate.codexThreadId,
    codexTurnId: candidate.codexTurnId,
    revision: 1,
    receiptId: `engine-terminal:${run.runId}`,
    digest: engineReceipt.candidateDigest,
    ownerIdentity: {
      nativeTurnId: candidate.codexTurnId,
      terminalStatus: candidate.engineOutcome,
    },
  })
  const nativeReadbackRef = terminalNativeReadbackEvidenceRef({
    readyRunId: run.runId,
    readyScopeId: run.readyToolHostIdentity.scopeId,
    messageVisibilityEpoch: 0,
    aliasGeneration: run.conversationAlias.aliasGeneration,
    codexThreadId: candidate.codexThreadId,
    codexTurnId: candidate.codexTurnId,
    revision: nativeReadback.turnRevision,
    receiptId: nativeReadback.receiptId,
    digest: nativeReadback.digest,
    ownerIdentity: {
      connectionEpoch: nativeReadback.connectionEpoch,
      readRevision: nativeReadback.turnRevision,
      verifiedThreadId: nativeReadback.codexThreadId,
      verifiedTurnId: nativeReadback.codexTurnId,
    },
  })
  const lifecycleRef = lifecycle ? {
    kind: 'lifecycle' as const,
    evidenceRefId: `lifecycle:${run.runId}:${lifecycle.action}`,
    readyRunId: run.runId,
    readyScopeId: run.readyToolHostIdentity.scopeId,
    messageVisibilityEpoch: 0,
    aliasGeneration: run.conversationAlias.aliasGeneration,
    codexThreadId: candidate.codexThreadId,
    codexTurnId: candidate.codexTurnId,
    revision: 1,
    receiptId: `lifecycle:${run.runId}:${lifecycle.action}`,
    digest: lifecycle.evidenceDigest,
    ownerIdentity: { lifecycleActionId: `${run.runId}:${lifecycle.action}` },
  } : null
  const history = lifecycle?.action === 'reset'
    ? { kind: 'reset' as const }
    : lifecycle?.action === 'close'
      ? { kind: 'closed' as const }
      : { kind: 'diverged' as const, reason: 'partial_assistant' as const }
  const identity = {
    readyRunId: run.runId, readyScopeId: run.readyToolHostIdentity.scopeId,
    messageVisibilityEpoch: 0, aliasGeneration: run.conversationAlias.aliasGeneration,
    codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId,
  }
  const gateway = new CodexModelGatewayRepository(activeAdmissionDatabase!)
  const gatewayRefs = gateway.readTurnGatewayEvidence(identity).map((row) => terminalGatewayEvidenceRef({
    ...identity, revision: row.responseSequence ?? row.requestSequence, receiptId: row.receiptId,
    digest: row.responseEvidenceDigest ?? row.requestEvidenceDigest,
    ownerIdentity: { gatewayRequestReceiptId: row.receiptId, eventSequence: row.responseSequence ?? row.requestSequence },
  }))
  const effects = new CodexToolActionJournal(activeAdmissionDatabase!).readSettledProductEffects(run.runId)
  const effectRefs = effects.map((effect) => terminalIndeterminateEffectEvidenceRef({
    ...identity, revision: effect.revision, digest: effect.evidenceDigest,
    effectEvidence: effect.state === 'confirmed'
      ? { state: 'confirmed', readyActionId: effect.readyActionId, actionIdentityDigest: effect.actionIdentityDigest, receiptId: effect.receiptId! }
      : { state: 'indeterminate', readyActionId: effect.readyActionId, actionIdentityDigest: effect.actionIdentityDigest,
          sourceRevision: effect.revision, resolutionEvidenceDigest: effect.evidenceDigest },
  }))
  return {
    nativeReadback,
    terminalFacts: resolveCodexTerminalFacts({
      product: {
        terminal: lifecycle ? 'interrupted' : 'error',
        terminalReason: lifecycle ? 'cancelled_user' : 'blocked_external',
        failureKind: lifecycle ? 'cancelled' : 'protocol',
        evidence: [nativeTurnRef, nativeReadbackRef, ...gatewayRefs, ...(lifecycleRef ? [lifecycleRef] : [])],
      },
      history,
      historyEvidence: history.kind === 'diverged'
        ? [nativeTurnRef, nativeReadbackRef, ...gatewayRefs]
        : [lifecycleRef as NonNullable<typeof lifecycleRef>],
      effect: effectRefs.length === 0 ? { state: 'none', evidence: [] }
        : { state: effects.some((effect) => effect.state === 'indeterminate') ? 'indeterminate' : 'confirmed', evidence: effectRefs },
    }),
  }
}

function completedCloseoutEvidence(repository: CodexBindingRepository, readyRunId = 'run-1', prefix: string[] = []) {
  const run = repository.readProductTurnRuntime(readyRunId).prepared
  const engine = repository.readEngineTerminalCandidate(readyRunId)!
  const evidence = terminalCloseoutEvidence(run, engine.candidate as ReturnType<typeof nativeFailureCandidate>, engine, undefined, prefix)
  evidence.terminalFacts = resolveCodexTerminalFacts({
    product: { terminal: 'done', terminalReason: 'done', failureKind: null, evidence: evidence.terminalFacts.product.evidence },
    history: {
      kind: 'continuation_safe', seamId: 'completed_product_accepted_v1',
      retainedFormalInputMappingDigest: digestCanonicalJson(run.ingress.canonicalCurrentInputRef),
    },
    historyEvidence: evidence.terminalFacts.history.evidence,
    effect: evidence.terminalFacts.effect,
  })
  return evidence
}

function admitStartedExistingTurn(
  db: NativeDb,
  repository: CodexBindingRepository,
  run: PreparedCodexProductRun,
  threadBindingId = 'thread-binding-1',
  cwd = '/tmp/ready-codex/thread-binding-1',
) {
  prepareReadyParentRowsOnly(db, run)
  if (run.ingress.attemptKind === 'explicit_retry') {
    db.prepare(`UPDATE chat_messages SET content = 'RETRY CONTROL ONLY' WHERE id = ?`).run(run.ingress.originUserMessageId)
  }
  const admitted = admission(run, existingReservation(run.runId), { threadBindingId, isolatedThreadCwd: cwd })
  repository.admitProductBindings(admitted)
  const connectionEpoch = `epoch-${run.runId}`
  const codexTurnId = `native-${run.runId}`
  repository.activateStartDispatch({
    connectionEpoch, rpcId: 1, method: 'turn/start', bindingLookupKey: run.runId,
    requestDigest: `request-${run.runId}`, dispatchedAt: admittedAt,
  })
  repository.markStartChildWriteConfirmed({ connectionEpoch, rpcId: 1, method: 'turn/start',
    bindingId: run.runId, childWriteDigest: `request-${run.runId}`, confirmedAt: admittedAt })
  repository.reconcileStartAccepted({
    connectionEpoch, rpcId: 1, method: 'turn/start', bindingId: run.runId, nativeId: codexTurnId,
    nativeResult: { turn: { ...activeTurn(), id: codexTurnId } },
    responseDigest: `response-${run.runId}`, responsePending: false, reconciledAt: admittedAt,
  })
  return { admitted, codexTurnId }
}

function recordFixtureGatewayRequest(db: NativeDb, repository: CodexBindingRepository, readyRunId: string): string {
  const runtime = repository.readProductTurnRuntime(readyRunId)
  const gateway = new CodexModelGatewayRepository(db as unknown as DatabaseConnection, repository)
  const inputDigest = digestCodexUserInput(runtime.prepared.ingress.canonicalCurrentInputRef.input)
  gateway.resolveBinding({
    metadata: { requestKind: 'turn', threadId: runtime.codexThreadId!, turnId: runtime.codexTurnId!, readyRunId,
      toolSurfaceDigest: runtime.prepared.readyToolSurface.toolSurfaceDigest, turnContractDigest: runtime.turnContractDigest,
      upstreamProfileSnapshotDigest: runtime.upstreamProfileSnapshotDigest, raw: { request_kind: 'turn' } },
    requestDigest: digestCanonicalJson({ readyRunId, kind: 'fixture_gateway_request' }), receivedAt: admittedAt,
    requestEvidence: { instructionDigest: 'a'.repeat(64), inputDigest,
      inputItems: [{ digest: inputDigest, totalStringCharacters: 5, maxStringCharacters: 5 }],
      inputTotalStringCharacters: 5, inputMaxStringCharacters: 5, toolsDigest: runtime.prepared.readyToolSurface.toolSurfaceDigest,
      toolCount: runtime.prepared.readyToolSurface.entries.length, bodyBytes: 200,
      memoryHistoryRedactionDigest: digestCanonicalJson([]), memoryHistoryRedactedItemCount: 0 },
    validate: () => new Set(),
  })
  return gateway.readTurnGatewayEvidence({ readyRunId, codexThreadId: runtime.codexThreadId!, codexTurnId: runtime.codexTurnId! }).at(-1)!.receiptId
}

function assertGatewayForkLineage(db: NativeDb, repository: CodexBindingRepository, input: {
  kind: 'product' | 'automatic_compaction' | 'manual_compaction'
  codexThreadId: string
  codexTurnId: string
  readyRunId: string | null
  forkedFromId: string | null
  toolSurfaceDigest: string | null
  turnContractDigest: string | null
  upstreamProfileSnapshotDigest: string | null
}): void {
  const gateway = new CodexModelGatewayRepository(db as unknown as DatabaseConnection, repository)
  const snapshot = () => ({
    claims: db.prepare('SELECT ready_run_id, gateway_claimed_codex_turn_id, revision FROM codex_turn_bindings ORDER BY ready_run_id').all(),
    manual: db.prepare('SELECT manual_compaction_id, codex_compaction_turn_id, revision FROM codex_manual_compaction_bindings ORDER BY manual_compaction_id').all(),
    receipts: db.prepare('SELECT receipt_id FROM ready_model_gateway_request_receipts ORDER BY receipt_id').all(),
  })
  const before = snapshot()
  const parents = [...new Set(['wrong-direct-parent', input.codexThreadId, 'thread-native-1', null])]
    .filter((parent) => parent !== input.forkedFromId).concat(input.forkedFromId)
  for (const parent of parents) {
    const raw = {
      request_kind: input.kind === 'product' ? 'turn' : 'compaction',
      ...(input.kind === 'product' ? {} : { compaction: {
        trigger: input.kind === 'manual_compaction' ? 'manual' : 'auto',
        reason: input.kind === 'manual_compaction' ? 'user_requested' : 'context_limit',
        implementation: 'responses',
        phase: input.kind === 'manual_compaction' ? 'standalone_turn' : 'pre_turn', strategy: 'memento',
      } }),
      ...(parent === null ? {} : { forked_from_thread_id: parent }),
    }
    assert.throws(() => gateway.resolveBinding({
      metadata: {
        requestKind: raw.request_kind, threadId: input.codexThreadId, turnId: input.codexTurnId,
        readyRunId: input.readyRunId, toolSurfaceDigest: input.toolSurfaceDigest,
        turnContractDigest: input.turnContractDigest,
        upstreamProfileSnapshotDigest: input.upstreamProfileSnapshotDigest, raw,
      },
      requestDigest: 'lineage-probe', receivedAt: admittedAt,
      get requestEvidence(): never { throw new Error('lineage_probe_must_stop_before_receipt') },
      validate() { throw new Error('lineage_owner_accepted') },
    }), parent === input.forkedFromId ? /lineage_owner_accepted/ : /gateway_(product|manual)_binding_mismatch/)
    assert.deepEqual(snapshot(), before, 'failed validation must leave no claim, receipt or revision')
  }
}

function prepareRetryOnCurrentHead(repository: CodexBindingRepository, rootRunId: string, retryRunId: string, predecessorRunId = rootRunId) {
  const root = repository.readProductTurnRuntime(rootRunId)
  const head = repository.readActiveAliasBinding(root.readyAliasId)!
  const tail = repository.readLiveUncommittedUserTail(head.threadBindingId)
  const origin = root.prepared.ingress.canonicalCurrentInputRef
  const rootRef = { sourceReadyRunId: rootRunId, sourceIngressContractDigest: digestCanonicalJson(root.prepared),
    originUserMessageId: origin.messageId, inputDigest: digestCodexUserInput(origin.input) }
  const plan = resolveExplicitRetryTailPlan(tail, rootRef)
  assert.equal(plan.kind, 'eligible')
  if (plan.kind !== 'eligible') throw new Error('retry_tail_not_eligible')
  const predecessor = repository.readProductTurnPresentation(predecessorRunId)
  const control = [{ type: 'text' as const, text: 'RETRY CONTROL ONLY', text_elements: [] }]
  const prepared = new CodexProductRunPreparer().prepare({
    taskId: `task-${retryRunId}`, runId: retryRunId, requestId: `request-${retryRunId}`,
    scopeId: root.readyScopeId, aliasId: root.readyAliasId, aliasGeneration: head.aliasGeneration,
    taskOrigin: 'user_root', runOrigin: 'initial', originUserMessageId: `control-${retryRunId}`,
    reservationSetId: `set-${retryRunId}`, reservationEvidenceDigest: `reservation-evidence-${retryRunId}`,
    currentInput: control, explicitResourceEnvelope: { input: [], resourceRefs: [] }, resourceAdditionalContext: [],
    trustedWorkbenchMode: 'browser', uncommittedUserTail: tail, uncommittedTailAssignments: plan.assignments,
    supersededUncommittedItems: [], readyMemorySnapshot: disabledReadyMemorySnapshot(),
    readyToolSurface: root.prepared.readyToolSurface, readyTurnToolAuthorization: root.prepared.readyTurnToolAuthorization,
    authorizationOwnerId: 'retry-owner', resourceOwnerId: 'retry-resource-owner',
    productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
    explicitRetry: {
      predecessorRunId, predecessorPresentationRef: { readyRunId: predecessorRunId, presentationDigest: predecessor.presentationDigest },
      controlAuditMessageRef: { messageId: `control-${retryRunId}`, inputDigest: digestCodexUserInput(control) },
      modelVisibleRootOriginRef: rootRef,
      selectedHistorySeedItemRef: { threadBindingId: head.threadBindingId, historySeedDigest: head.historySeedDigest!,
        originUserMessageId: plan.selected.originUserMessageId, inputDigest: plan.selected.inputDigest },
      currentTrustedEnvironmentRef: { requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
        modeDigest: digestCanonicalJson({ requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser' }) },
      sourceTrustedEnvironmentRef: root.prepared.sourceTrustedEnvironmentRef,
      historyParityEvidenceDigest: `parity-${retryRunId}`, currentThreadReadEvidenceDigest: `read-${retryRunId}`,
      continuationContractDigest: `continuation-${retryRunId}`, taskRootInput: origin.input, taskRootInputDigest: rootRef.inputDigest,
      artifactSources: [],
    },
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error(prepared.code)
  return prepared.prepared
}

function insertFailureTerminalMessage(
  db: NativeDb,
  run: PreparedCodexProductRun,
  content: string,
  terminalReason: string,
): string {
  const messageId = `assistant:${run.taskId}:${run.runId}:terminal`
  const meta = { taskId: run.taskId, runId: run.runId, terminalReason }
  db.prepare(`
    INSERT OR IGNORE INTO chat_messages (
      id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
    ) VALUES (?, ?, 'assistant', ?, ?, ?, 0)
  `).run(
    messageId,
    run.readyToolHostIdentity.scopeId,
    content,
    admittedAt,
    JSON.stringify(meta),
  )
  db.prepare(`
    UPDATE run_meta SET status = ?, terminal_reason = ?, updated_at = ?
     WHERE run_id = ? AND task_id = ?
  `).run(
    terminalReason === 'cancelled_user' ? 'interrupted' : 'error',
    terminalReason,
    Date.parse(admittedAt),
    run.runId,
    run.taskId,
  )
  return failureTerminalMessageDigest(run, content, terminalReason)
}

function failureTerminalMessageDigest(
  run: PreparedCodexProductRun,
  content: string,
  terminalReason: string,
): string {
  return workflowDigest({
    id: `assistant:${run.taskId}:${run.runId}:terminal`,
    conversationId: run.readyToolHostIdentity.scopeId,
    role: 'assistant',
    content,
    timestamp: admittedAt,
    meta: { taskId: run.taskId, runId: run.runId, terminalReason },
  })
}

function preparePublicationRecoveryFixture(
  db: NativeDb,
  repository: CodexBindingRepository,
  input: {
    runId: string
    admittedCalls?: Array<{ codexCallId: string; toolName: string; argsDigest: string }>
    pendingOutputContract?: boolean
    currentDocumentReadAuthorized?: boolean
    actionObligations?: ReadyActionObligationSetV1
    currentDocumentAnchor?: NonNullable<Extract<
      PreparedCodexProductRun['ingress'],
      { kind: 'user_ingress' }
    >['currentDocumentAnchor']>
    admissionOverrides?: Partial<CodexAdmittedBindingInput>
  },
) {
  const run = prepared(input.runId)
  run.actionObligations = input.actionObligations
  const admittedCalls = input.admittedCalls || []
  if (run.ingress.kind !== 'user_ingress') throw new Error('expected_user_ingress')
  if (input.pendingOutputContract) {
    run.outputContract = {
      contract: 'codex_output_contract_v1',
      destination: {
        logicalResourceId: 'local-directory:fixture',
        path: '/tmp/ready-codex/output',
        currentVersion: 'sha256:fixture',
        currentDigest: 'fixture',
        policyEpoch: 1,
        directoryIdentity: {
          device: '1', inode: '2', mode: 0o40755, mtimeMs: 1,
        },
      },
      activation: 'pending_confirmation',
      activationPredicateDigest: 'activation-fixture',
      maxExpectedOutputs: 8,
      targetPolicy: 'create_only',
    }
  }
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
    toolDefinitions: [
      {
        name: 'ready_read', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'Read fixture',
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      },
      ...(input.actionObligations?.requirements.flatMap((requirement) => (
        requirement.allowedToolNames.map((name) => ({
          name, groupId: 'pet', domain: 'pet', kind: 'write',
          concurrency: 'serial', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
          supportsTextBridge: true, projectionHint: null, description: 'Pet fixture',
          schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
        } as const))
      )) || []),
      ...(input.currentDocumentAnchor ? [{
        name: 'document_read_section', groupId: 'agent_interaction', domain: 'document', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: 'Read current document',
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      } as const] : []),
    ],
  })
  run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
    authorizationId: `authorization-${input.runId}`,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    toolSurface: run.readyToolSurface,
    ...(input.currentDocumentAnchor && input.currentDocumentReadAuthorized === false
      ? { allowedToolNames: ['ready_read'] }
      : {}),
  })
  prepareReadyParents(db, repository, run)
  repository.admitProductBindings(admission(run, lazyReservation(run.runId), input.admissionOverrides))
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
    const gatewayRequestReceiptId = recordFixtureGatewayRequest(db, repository, run.runId)
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
        provider_diagnostics_json TEXT,
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
      CREATE TABLE pending_confirmations (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        task_id TEXT,
        scope_id TEXT,
        tool_name TEXT NOT NULL,
        params_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        released_at TEXT
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
    __runMigrationForTests('111_codex_gateway_budget_lanes', db as unknown as MigrationDatabase)
    __runMigrationForTests('113_ready_memory_truth', db as unknown as MigrationDatabase)
    __runMigrationForTests('118_codex_native_continuity_terminal_head_v3', db as unknown as MigrationDatabase)
    __runMigrationForTests('119_gateway_exchange_redaction_admission_guard', db as unknown as MigrationDatabase)
    __runMigrationForTests('120_codex_conversation_context_boundaries', db as unknown as MigrationDatabase)
    const repository = new CodexBindingRepository(
      db as unknown as DatabaseConnection,
      testRuntimeContract,
    )
    new CodexModelGatewayRepository(db as unknown as DatabaseConnection, repository).storeSnapshot({
      ...defaultThreadProfile, snapshotRef: 'profile-ref-1', createdAt: admittedAt,
    })
    activeAdmissionRepository = repository
    activeAdmissionDatabase = db as unknown as DatabaseConnection
    await work(db, repository)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    activeAdmissionRepository = null
    activeAdmissionDatabase = null
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

const defaultThreadProfile = createThreadTransitionProfile({
  profileId: 'profile-test-default', model: 'gpt-5.6-terra', reasoningEffort: 'high',
  contextWindowOverride: 272_000, maxOutputTokensOverride: 8_192,
})

test('whole-history cleanup archives through the real repository and client after stale Ready state', async (t) => {
  await withRepository(t, async (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({
      connectionEpoch: 'cleanup-epoch', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'cleanup-thread-request', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'cleanup-epoch', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'cleanup-thread-response', responsePending: false,
      reconciledAt: admittedAt,
    })

    db.exec('BEGIN IMMEDIATE')
    retireAllCodexThreadBindingsForConversationReset(db as unknown as DatabaseConnection, {
      retiredAt: admittedAt,
      retirementEvidenceDigest: 'e'.repeat(64),
    })
    enqueueEligibleRetiredCodexThreadArchiveIntents(db as unknown as DatabaseConnection)
    db.exec('COMMIT')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_turn_bindings
       WHERE product_terminal_digest IS NULL AND host_failure_product_terminal_digest IS NULL
    `).get<{ count: number }>()?.count, 1)

    const store = new CodexThreadArchiveIntentStore(db as unknown as DatabaseConnection)
    const dispatchPort = new CodexDurableThreadArchiveDispatchPort({
      store,
      now: () => admittedAt,
    })
    const transport = new CleanupArchiveTransport()
    const client = new CodexAppServerClient({
      transport,
      connectionEpoch: 'cleanup-archive-epoch',
      requestTimeoutMs: 1_000,
      startDispatchPort: {} as never,
      manualCompactionDispatchPort: {} as never,
      threadArchiveDispatchPort: dispatchPort,
      inboundFramePort: {} as never,
      threadArchiveAuthorizationPort: {
        assertEligible: (threadId) => repository.assertThreadArchiveEligible(threadId),
      },
    })
    await client.initialize()
    const owner = new CodexThreadArchiveCleanupOwner({
      store,
      runtime: {
        threadRead: (input) => client.threadRead(input),
        threadArchive: (input) => client.threadArchive(input),
        threadList: (input) => client.threadList(input),
      },
      getConnectionEpoch: () => 'cleanup-archive-epoch',
      now: () => admittedAt,
    })
    assert.deepEqual(await owner.drain(), { processed: 1, acknowledged: 1, pending: 0 })
    assert.equal(store.readByThreadId('thread-native-1')?.state, 'acknowledged')
    assert.deepEqual(transport.writes.map((frame) => frame.method), [
      'initialize', 'initialized', 'thread/read', 'thread/archive',
    ])
  })
})

test('artifact storage retention protects an open product turn from collection', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-artifact-open')
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    assert.deepEqual(repository.readArtifactStorageRetention(), {
      protectedRunIds: ['run-artifact-open'],
      collectibleRunIds: [],
    })
  })
})

test('a retry cannot import a predecessor artifact receipt', () => {
  const retry = prepared('run-artifact-retry')
  retry.ingress = {
    kind: 'user_ingress',
    attemptKind: 'explicit_retry',
    originUserMessageId: 'message-run-artifact-retry',
    canonicalCurrentInputRef: {
      messageId: 'message-run-artifact-retry',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    },
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    predecessorRunId: 'run-artifact-source',
    historyParityEvidenceDigest: 'history-parity-retry-publication',
    currentThreadReadEvidenceDigest: 'thread-read-retry-publication',
    continuationContractDigest: 'continuation-retry-publication',
    taskRootInput: [{ type: 'text', text: 'hello', text_elements: [] }],
    taskRootInputDigest: createHash('sha256').update(JSON.stringify([
      { type: 'text', text: 'hello', text_elements: [] },
    ])).digest('hex'),
    artifactSources: [{
      sourceReadyRunId: 'run-artifact-source',
      relativePath: 'report.md',
      logicalArtifactRef: 'ready-artifact:run-artifact-source/report.md',
      version: `sha256:${'a'.repeat(64)}`,
      sha256: 'b'.repeat(64),
      state: 'staged',
    }],
  }
  assert.equal(isPreparedCodexProductRun(retry), false)
})

test('completed product turn cannot publish without its frozen product action', async (t) => {
  await withRepository(t, (db, repository) => {
    const actionObligations = resolveReadyActionObligationSet({
      intent: { primaryDomain: 'pet', actionSignals: ['pet-show-action'] },
      allowedToolNames: ['pet_show_sticky_note'],
      primaryInstruction: '把这句话贴到宠物便利贴上',
    })
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-missing-product-action',
      actionObligations,
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
      kind: 'incomplete',
      verifiedReceiptRefs: [],
      code: 'action_obligation_missing',
      callId: null,
    })
  })
})

test('nested product effects are bound to the exact call and settled before closeout', async (t) => {
  await withRepository(t, async (db, repository) => {
    const admittedCall = { codexCallId: 'call-effects', toolName: 'ready_read', argsDigest: 'args-effects' }
    const { run, executionBinding } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-nested-effects',
      admittedCalls: [admittedCall],
    })
    insertRawPublicationToolBinding(db, {
      run,
      executionBinding,
      admittedCall,
      readyActionId: 'parent-action-effects',
    })
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    await journal.begin({
      readyActionId: 'parent-action-effects',
      actionIdentityDigest: 'parent-action-identity',
      at: admittedAt,
    })
    const effect = (ordinal: number) => ({
      effectActionId: `effect-action-${ordinal}`,
      actionIdentityDigest: `effect-identity-${ordinal}`,
      readyRunId: run.runId,
      readyScopeId: 'scope-1',
      messageVisibilityEpoch: 0,
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-1',
      codexCallId: admittedCall.codexCallId,
      parentReadyActionId: 'parent-action-effects',
      toolName: admittedCall.toolName,
      productAction: `effect-${ordinal}`,
      actionOrdinal: ordinal,
      argsDigest: `effect-args-${ordinal}`,
      at: admittedAt,
    })
    assert.deepEqual(await journal.beginBoundProductEffect(effect(0)), { fresh: true })
    assert.deepEqual(await journal.beginBoundProductEffect(effect(1)), { fresh: true })
    const output = createToolExecutionOutput('effect confirmed', { data: { ok: true } })
    await journal.commit({
      readyActionId: 'effect-action-0',
      actionIdentityDigest: 'effect-identity-0',
      resultDigest: digestCanonicalJson(output),
      output,
      at: admittedAt,
    })

    const settled = journal.settleProductEffectsForCloseout({
      readyRunId: run.runId,
      closeoutAt: '2026-08-07T01:00:01.000Z',
    })
    assert.deepEqual(settled.map((entry) => [entry.readyActionId, entry.state]), [
      ['effect-action-0', 'confirmed'],
      ['effect-action-1', 'indeterminate'],
      ['parent-action-effects', 'indeterminate'],
    ])
    await assert.rejects(
      journal.beginBoundProductEffect(effect(2)),
      /codex_product_effect_parent_mismatch/,
    )
    assert.throws(
      () => db.prepare(`DELETE FROM codex_product_effect_bindings WHERE effect_action_id = ?`)
        .run('effect-action-0'),
      /codex_product_effect_binding_delete_forbidden/,
    )
  })
})

test('product turn successor lookup rejects a forged same-thread retry child', async (t) => {
  await withRepository(t, (db, repository) => {
    const root = prepared()
    prepareReadyParents(db, repository, root)
    repository.admitProductBindings(admission(root, lazyReservation(root.runId)))
    startAndCloseInitialProductTurn(db, repository)

    const retry = prepared('run-explicit-retry')
    retry.ingress = {
      kind: 'user_ingress',
      attemptKind: 'explicit_retry',
      originUserMessageId: 'message-run-explicit-retry',
      canonicalCurrentInputRef: {
        messageId: 'message-run-explicit-retry',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [],
      predecessorRunId: root.runId,
      historyParityEvidenceDigest: 'history-parity-retry',
      currentThreadReadEvidenceDigest: 'thread-read-retry',
      continuationContractDigest: 'continuation-retry',
      taskRootInput: [{ type: 'text', text: 'hello', text_elements: [] }],
      taskRootInputDigest: createHash('sha256').update(JSON.stringify([
        { type: 'text', text: 'hello', text_elements: [] },
      ])).digest('hex'),
      artifactSources: [],
    }
    prepareReadyParentRowsOnly(db, retry)
    assert.throws(() => repository.admitProductBindings(admission(
      retry,
      existingReservation(retry.runId),
    )), /ready_parent_mismatch/)
    assert.equal(repository.readProductTurnSuccessorId(root.runId), null)
  })
})

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
    terminalEvidence: completedCloseoutEvidence(repository),
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
  const sourceIngress = db.prepare(`SELECT ingress_json FROM codex_turn_bindings WHERE ready_run_id = 'run-1'`)
    .get<{ ingress_json: string }>()!
  run.ingress.actionAdmissionRef = JSON.parse(sourceIngress.ingress_json).prepared.ingress.actionAdmissionRef
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
      turn_start_request_digest, turn_start_dispatch_intent_at,
      turn_start_response_at, turn_start_reconciled_at,
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
      ?, ?, 3, ?, ?, ?, ?,
      ?,
      ?, ?, ?,
      1, ?, ?,
      'user_ingress', tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json, effective_codex_model,
      ?, ?,
      ?, ?, json_set(ingress_json, '$.prepared', json(?)),
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
    `turn-request-digest-${run.runId}`,
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
    JSON.stringify(run),
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
      materializationKind: 'fresh_start',
      materializationState: 'confirmed',
      historySeedDigest: null,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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

test('migrations 088-120 create Codex-owned tables and immutable binding evidence', async (t) => {
  await withRepository(t, (db, repository) => {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'codex_%' ORDER BY name
    `).all() as Array<{ name: string }>
    assert.deepEqual(tables.map((row) => row.name), [
      'codex_browser_verifier_attempts',
      'codex_conversation_context_boundaries',
      'codex_fence_owner_transfers',
      'codex_manual_compaction_bindings',
      'codex_manual_compaction_dispatch_attempts',
      'codex_native_coverage_receipts',
      'codex_product_effect_bindings',
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
      connectionEpoch: 'resume-epoch', runtimeManifestDigest: testRuntimeManifestDigest,
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
      connectionEpoch: 'closed-resume-epoch', runtimeManifestDigest: testRuntimeManifestDigest,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      sealClosedConversationInOpenTransaction: () => undefined,
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
      runtimeManifestDigest: testRuntimeManifestDigest,
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
    assert.equal(db.prepare(`SELECT native_inherited_contract_digest AS digest FROM codex_thread_bindings
      WHERE thread_binding_id = 'thread-binding-1'`).get<{ digest: string | null }>()?.digest, null)
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
      { overrides: { codexModel: 'changed-model' }, code: 'model_changed' },
      { overrides: { isolatedThreadCwd: '/tmp/changed-cwd' }, code: 'cwd_changed' },
      { overrides: { instructionContractDigest: 'changed-instructions' }, code: 'instruction_contract_changed' },
      { overrides: { runtimeManifestDigest: 'changed-runtime' }, code: 'current_runtime_contract_mismatch' },
      { overrides: { protocolSchemaDigest: 'changed-protocol' }, code: 'current_runtime_contract_mismatch' },
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
        && error.code === 'native_tool_surface_extension_required',
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
             ,native_inherited_contract_digest
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get()
    const inherited = db.prepare(`SELECT native_inherited_contract_digest AS digest FROM codex_thread_bindings
      WHERE thread_binding_id = 'thread-binding-1'`).get<{ digest: string }>()!.digest
    assert.match(inherited, /^[a-f0-9]{64}$/)
    assert.throws(() => db.prepare(`UPDATE codex_thread_bindings SET native_inherited_contract_digest = ?
      WHERE thread_binding_id = 'thread-binding-1'`).run('a'.repeat(64)), /materialization_identity_immutable/)

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
             ,native_inherited_contract_digest
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
        && error.code === 'thread_config_changed',
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
        expectedParentThreadId: null,
        expectedForkedFromId: null,
        expectedPrefixTurnIds: [],
        materializationRequestDigest: null,
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
      /action_admission_ref_stale/,
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

test('a run-local boot recovery rejection atomically blocks the same head for reset', async (t) => {
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
    assert.equal(repository.readActiveAliasBinding('scope-1')?.continuationBlockedReason, 'publication_diverged')

    const successorAlias = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T01:01:00.000Z',
    })
    assert.equal(successorAlias.kind, 'reset_required')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.continuationBlockedReason, 'publication_diverged')
  })
})

test('publication divergence creates and materializes one native-fork successor', async (t) => {
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
    seedClosedAuthoritativeTurn(db, {
      readyRunId: 'run-accepted-boundary',
      upstreamProfileSnapshotRef: 'profile-ref-1',
      upstreamProfileSnapshotDigest: defaultThreadProfile.snapshotDigest,
      createdAt: '2026-08-06T23:59:00.000Z',
    })
    const acceptedPrepared = prepared('run-accepted-boundary')
    db.prepare(`
      UPDATE codex_turn_bindings
         SET turn_start_reservation_released_at = ?,
             turn_start_reservation_release_reason = 'native_identity_reconciled'
       WHERE ready_run_id = 'run-accepted-boundary'
    `).run('2026-08-06T23:59:00.000Z')
    const acceptedFacts = resolveCodexTerminalFacts({
      product: { terminal: 'done', terminalReason: 'done', failureKind: null, evidence: [] },
      history: {
        kind: 'continuation_safe',
        seamId: 'completed_product_accepted_v1',
        retainedFormalInputMappingDigest: 'a'.repeat(64),
      },
      historyEvidence: [],
      effect: { state: 'none', evidence: [] },
    })
    const acceptedReadbackUnsigned = {
      contract: 'codex_terminal_native_readback_v1' as const,
      receiptId: 'native-readback:run-accepted-boundary:1',
      readyRunId: 'run-accepted-boundary',
      readyScopeId: 'scope-1',
      messageVisibilityEpoch: 0,
      aliasGeneration: 1,
      connectionEpoch: 'epoch-accepted-boundary',
      codexThreadId: 'thread-native-1',
      codexTurnId: 'turn-native-run-accepted-boundary',
      turnStatus: 'completed' as const,
      turnRevision: 1,
      threadStatus: { type: 'idle' as const },
      orderedTurnIds: ['turn-native-run-accepted-boundary'],
      terminalTurnItemDigests: [],
      contextCompactionItemIds: [],
    }
    const acceptedReadback = {
      ...acceptedReadbackUnsigned,
      digest: digestCanonicalJson(acceptedReadbackUnsigned),
    }
    db.prepare(`
      UPDATE codex_turn_bindings
         SET terminal_native_readback_receipt_json = ?,
             terminal_native_readback_receipt_digest = ?,
             terminal_native_readback_revision = ?,
             terminal_facts_json = ?, terminal_facts_digest = ?
       WHERE ready_run_id = 'run-accepted-boundary'
    `).run(
      JSON.stringify(acceptedReadback),
      acceptedReadback.digest,
      acceptedReadback.turnRevision,
      JSON.stringify(acceptedFacts),
      digestCanonicalJson(acceptedFacts),
    )
    repository.appendAcceptedNativeCoverageReceipt({
      threadBindingId: 'thread-binding-1',
      producerKind: 'product_closeout',
      producerOwnerId: 'run-accepted-boundary',
      codexThreadId: 'thread-native-1',
      acceptedNativeHeadKind: 'turn',
      acceptedNativeHeadId: 'turn-native-run-accepted-boundary',
      acceptedProductReadyRunId: 'run-accepted-boundary',
      newlyCovered: [{
        messageId: 'message-run-accepted-boundary',
        digest: digestCodexUserInput(acceptedPrepared.ingress.canonicalCurrentInputRef.input),
      }],
      createdAt: '2026-08-06T23:59:00.000Z',
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
    const receipt = repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId,
      engineOutcome: candidate.engineOutcome,
      candidate,
      recordedAt: admittedAt,
    })
    const terminalEvidence = terminalCloseoutEvidence(
      run,
      candidate,
      receipt,
      undefined,
      ['turn-native-run-accepted-boundary'],
    )
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    const productTerminalDigest = insertFailureTerminalMessage(
      db,
      run,
      '本次回答未通过发布核验，已保留本轮记录。',
      'blocked_external',
    )
    const closeout = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest,
      closeoutAt: admittedAt,
      terminalEvidence,
      forkSeed: {
        targetCwd: '/tmp/ready-codex/thread-binding-fork-2',
        reservationSetId: 'fork-set-2',
        reservationId: 'fork-member-2',
        reservationEvidenceDigest: 'fork-reservation-evidence-2',
      },
    })
    db.exec('COMMIT')
    assert.equal(closeout.handled, true)
    assert.equal(closeout.reservationSetId, `set-${run.runId}`)
    assert.ok(closeout.forkTargetThreadBindingId)

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
      .get<{ count: number }>()?.count, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.materializationKind, 'native_fork')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.materializationState, 'pending')
    assert.deepEqual(repository.readLatestLifecycleCloseout({
      aliasId: 'scope-1', aliasGeneration: 1,
    }), {
      aliasId: 'scope-1', aliasGeneration: 1,
      codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      terminal: 'failed', closeoutDigest: productTerminalDigest,
      fenceReleaseRevision: 2,
    })
    const targetId = closeout.forkTargetThreadBindingId as string
    const inheritedDigests = db.prepare(`SELECT native_inherited_contract_digest AS digest
      FROM codex_thread_bindings ORDER BY alias_generation`).all<{ digest: string }>()
    assert.equal(inheritedDigests[0].digest, inheritedDigests[1].digest)
    const forkSeed = repository.readNativeForkMaterialization(targetId)
    assert.equal(forkSeed?.acceptedThroughCodexTurnId, 'turn-native-run-accepted-boundary')
    assert.deepEqual(repository.readRecoverySnapshot(() => false).members.map((member) => ({
      method: member.method,
      bindingId: member.bindingId,
      requiredMemberCount: member.requiredMemberCount,
      state: member.state,
    })), [{
      method: 'thread/fork',
      bindingId: targetId,
      requiredMemberCount: 1,
      state: 'held',
    }])
    const forkDispatch = repository.activateStartDispatch({
      connectionEpoch: 'epoch-fork', rpcId: 3, method: 'thread/fork',
      bindingLookupKey: targetId, requestDigest: 'fork-request-digest', dispatchedAt: admittedAt,
    })
    assert.equal(forkDispatch.inboundIdentity.method, 'thread/fork')
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-fork', rpcId: 3, method: 'thread/fork', bindingId: targetId,
      childWriteDigest: 'fork-request-digest', confirmedAt: admittedAt,
    })
    const childThread = {
      ...rootThread(),
      id: 'thread-native-child-2',
      sessionId: 'thread-native-child-2',
      cwd: '/tmp/ready-codex/thread-binding-fork-2',
      parentThreadId: null,
      forkedFromId: 'thread-native-1',
      turns: [{ id: 'turn-native-run-accepted-boundary', status: 'completed', error: null, items: [] }],
    } as CodexThread
    const forkRecoveryInput = {
      connectionEpoch: 'epoch-fork', rpcId: 3, method: 'thread/fork', bindingId: targetId,
      nativeId: childThread.id,
      nativeResult: {
        thread: childThread,
        cwd: childThread.cwd,
        model: 'ready-e0-model',
        modelProvider: 'ready_gateway',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null,
        serviceTier: null,
        instructionSources: [],
      },
      responseDigest: 'fork-recovery-digest', responsePending: true, reconciledAt: admittedAt,
      forkRecoveryEvidence: {
        connectionEpoch: 'epoch-fork-recovery',
        preResumeThreadReadDigest: 'pre-resume-fork-digest',
        resumedThreadDigest: 'resumed-fork-digest',
      },
    } as const
    assert.throws(
      () => repository.reconcileStartAccepted(forkRecoveryInput),
      /fork_recovery_connection_not_live/,
    )
    assert.equal(repository.readActiveAliasBinding('scope-1')?.materializationState, 'pending')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_resume_evidence`)
      .get<{ count: number }>()?.count, 0)
    let forkLease = repository.createProcessLeaseIntent({
      processLeaseId: 'fork-recovery-lease', ownerMainBootId: 'main-boot-fork', ownerMainPid: 20,
      ownerMainProcessStartIdentity: 'main-fork-process', sidecarSpawnInstanceId: 'fork-spawn',
      connectionEpoch: 'epoch-fork-recovery', runtimeManifestDigest: testRuntimeManifestDigest,
      binarySha256: 'binary-digest', executablePath: '/opt/ready/codex',
      isolatedStateDir: '/tmp/ready-codex', spawnIntentAt: admittedAt,
      spawnVisibilityDeadlineAt: admittedAt,
    })
    forkLease = repository.confirmProcessLeaseOwnership({
      processLeaseId: forkLease.processLeaseId, expectedRevision: forkLease.revision,
      pid: 21, processGroupId: 21, processStartIdentity: 'fork-sidecar-process',
      confirmedAt: admittedAt,
    })
    repository.markProcessConnectionOpened({
      processLeaseId: forkLease.processLeaseId, expectedRevision: forkLease.revision,
      openedAt: admittedAt,
    })
    db.exec(`CREATE TRIGGER test_fork_archive_abort BEFORE INSERT ON codex_thread_archive_intents
      BEGIN SELECT RAISE(ABORT, 'test_archive_write_failure'); END;`)
    assert.throws(() => repository.reconcileStartAccepted(forkRecoveryInput), /test_archive_write_failure/)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.materializationState, 'pending')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_resume_evidence`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 0)
    db.exec('DROP TRIGGER test_fork_archive_abort')
    repository.reconcileStartAccepted(forkRecoveryInput)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.materializationState, 'confirmed')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.codexThreadId, childThread.id)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_resume_evidence`)
      .get<{ count: number }>()?.count, 1)
    assert.equal(repository.readNativeForkMaterialization(targetId)?.materializationState, 'confirmed')
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 1, 'fork confirmation and source archive intent commit together')
    const liveTail = repository.readLiveUncommittedUserTail(targetId)
    assert.equal(liveTail.length, 1)
    const childRun = prepared('run-child-ordinary-c')
    childRun.conversationAlias = { aliasId: 'scope-1', aliasGeneration: 2 }
    childRun.ingress = {
      ...childRun.ingress,
      uncommittedUserTail: liveTail,
      uncommittedTailAssignments: liveTail.map((item) => ({
        originUserMessageId: item.originUserMessageId,
        inputDigest: item.inputDigest,
        plan: 'deliver_untrusted_history' as const,
      })),
      supersededUncommittedItems: [],
    }
    prepareReadyParentRowsOnly(db, childRun)
    const childAdmission = admission(
      childRun,
      existingReservation(childRun.runId),
      {
        threadBindingId: targetId,
        isolatedThreadCwd: childThread.cwd,
      },
    )
    repository.admitProductBindings(childAdmission)
    const built = new CodexTurnInputBuilder().build(childAdmission.prepared.ingress, {
      threadId: childThread.id,
      turnRequestId: childAdmission.turnRequestId,
      reasoningEffort: 'high',
      readyRunId: childAdmission.prepared.runId,
      toolSurfaceDigest: childAdmission.prepared.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: childAdmission.turnContractDigest,
      upstreamProfileSnapshotDigest: childAdmission.upstreamProfileSnapshotDigest,
      readyMemorySnapshot: childAdmission.prepared.readyMemorySnapshot,
    })
    assert.equal(built.ok, true)
    if (!built.ok) throw new Error(built.code)
    assert.equal(built.params.input.length, 1)
    const tailContext = Object.values(built.params.additionalContext).filter((entry) => (
      entry.kind === 'untrusted'
    ))
    assert.equal(tailContext.length, 1)
    assert.match(tailContext[0].value, new RegExp(liveTail[0].originUserMessageId))
    assert.equal(repository.readUncommittedTailDeliveryAudit(childRun.runId).state, 'unknown')
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-child-c', rpcId: 4, method: 'turn/start',
      bindingLookupKey: childRun.runId, requestDigest: 'child-turn-request',
      dispatchedAt: admittedAt,
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-child-c', rpcId: 4, method: 'turn/start',
      bindingId: childRun.runId, childWriteDigest: 'child-turn-request',
      confirmedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-child-c', rpcId: 4, method: 'turn/start',
      bindingId: childRun.runId, nativeId: 'turn-native-child-c',
      nativeResult: { turn: { ...activeTurn(), id: 'turn-native-child-c' } },
      responseDigest: 'child-turn-response', responsePending: false,
      reconciledAt: admittedAt,
    })
    for (const kind of ['product', 'automatic_compaction'] as const) {
      assertGatewayForkLineage(db, repository, {
        kind, codexThreadId: childThread.id, codexTurnId: 'turn-native-child-c',
        readyRunId: childRun.runId, forkedFromId: childThread.forkedFromId,
        toolSurfaceDigest: childRun.readyToolSurface.toolSurfaceDigest,
        turnContractDigest: childAdmission.turnContractDigest,
        upstreamProfileSnapshotDigest: childAdmission.upstreamProfileSnapshotDigest,
      })
    }
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(childRun.runId).items, [{
      originUserMessageId: liveTail[0].originUserMessageId,
      inputDigest: liveTail[0].inputDigest,
      assignment: 'deliver_untrusted_history',
      disposition: 'additional_context',
    }])
    assert.equal(repository.readLiveUncommittedUserTail(targetId).length, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_archive_intents`)
      .get<{ count: number }>()?.count, 1)

    const childDigest = recordCompletedTerminal(db, repository, childRun.runId, 'turn-native-child-c', [], childThread.id)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(childRun.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: childRun.runId, productTerminalDigest: childDigest, closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(repository, childRun.runId, ['turn-native-run-accepted-boundary']),
    })
    assert.deepEqual(repository.readLiveUncommittedUserTail(targetId), [])
    assert.deepEqual(repository.readHandoffUncommittedUserTail(targetId), [])
    const covered = db.prepare(`SELECT newly_covered_json FROM codex_native_coverage_receipts
      WHERE thread_binding_id = ?`).get<{ newly_covered_json: string }>(targetId)!
    assert.deepEqual(JSON.parse(covered.newly_covered_json).map((item: { messageId: string }) => item.messageId),
      [run.ingress.canonicalCurrentInputRef.messageId, childRun.ingress.canonicalCurrentInputRef.messageId])
    assert.equal(repository.readProductTurnPresentation(run.runId).actionProjection.retry_failed_task.availability,
      'not_applicable', 'a past failure is not Retry-ready after the direct successor accepted its origin')
    // Clone the genuine confirmed child to exercise standalone compaction without changing the later fork scenario.
    const Database = loadSqliteAfterGuardForTest()
    const manualDb = new Database(db.serialize())
    try {
      const manualRepository = new CodexBindingRepository(
        manualDb as unknown as DatabaseConnection,
        testRuntimeContract,
      )
      manualRepository.beginManualCompaction({
        manualCompactionId: 'fork-metadata-manual', threadBindingId: targetId, ownerMainBootId: 'main-boot-1',
        codexModel: 'ready-e0-model', upstreamProfileSnapshotRef: 'profile-ref-1',
        upstreamProfileSnapshotDigest: defaultThreadProfile.snapshotDigest,
        providerSnapshot: defaultThreadProfile.snapshot,
        credentialReferenceId: defaultThreadProfile.snapshot.credentialReferenceId,
        expectedToolsDigest: digestCanonicalJson([]), preDispatchThreadReadDigest: 'fork-manual-read',
        preDispatchTurnIds: childThread.turns.map((turn) => turn.id).concat('turn-native-child-c'),
        expiresAt: '2026-08-07T03:00:00.000Z', createdAt: admittedAt,
      })
      assertGatewayForkLineage(manualDb, manualRepository, {
        kind: 'manual_compaction', codexThreadId: childThread.id, codexTurnId: 'fork-manual-turn',
        readyRunId: null, forkedFromId: childThread.forkedFromId,
        toolSurfaceDigest: null, turnContractDigest: null, upstreamProfileSnapshotDigest: null,
      })
    } finally {
      manualDb.close()
    }
    const later = prepared('run-child-later-e')
    later.conversationAlias = { aliasId: 'scope-1', aliasGeneration: 2 }
    const laterStart = admitStartedExistingTurn(db, repository, later, targetId, childThread.cwd)
    const laterCandidate = { ...nativeFailureCandidate(later, 'failed'), codexThreadId: childThread.id, codexTurnId: laterStart.codexTurnId }
    const laterReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: later.runId, codexThreadId: childThread.id, codexTurnId: laterCandidate.codexTurnId,
      engineOutcome: 'failed', candidate: laterCandidate, recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(later.taskId)
    const laterCloseout = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: later.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, later, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: terminalCloseoutEvidence(later, laterCandidate, laterReceipt, undefined,
        ['turn-native-run-accepted-boundary', 'turn-native-child-c']),
      forkSeed: { targetCwd: '/tmp/ready-codex/fork-third', reservationSetId: 'fork-third', reservationId: 'fork-third-member', reservationEvidenceDigest: 'fork-third-evidence' },
    })
    db.exec('COMMIT')
    assert.deepEqual(repository.readLiveUncommittedUserTail(laterCloseout.forkTargetThreadBindingId!)
      .map((item) => item.originUserMessageId), [later.ingress.canonicalCurrentInputRef.messageId],
    'covered origins from the first fork cannot reappear in a later fork')
  })
})

function prepareRetainedFailureFixture(db: Parameters<typeof prepareReadyParents>[0], repository: CodexBindingRepository) {
    const accepted = prepared()
    prepareReadyParents(db, repository, accepted)
    repository.admitProductBindings(admission(accepted, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    const beforeHead = repository.readAcceptedNativePrefixHead('thread-binding-1')
    const b = prepared('run-safe-b')
    const bStart = admitStartedExistingTurn(db, repository, b)
    const bCandidate = { ...nativeFailureCandidate(b, 'failed'), codexTurnId: bStart.codexTurnId }
    const bReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: b.runId, codexThreadId: bCandidate.codexThreadId, codexTurnId: bCandidate.codexTurnId,
      engineOutcome: 'failed', candidate: bCandidate, recordedAt: admittedAt,
    })
    const bEvidence = terminalCloseoutEvidence(b, bCandidate, bReceipt, undefined, ['turn-native-1'])
    bEvidence.terminalFacts = resolveCodexTerminalFacts({
      product: bEvidence.terminalFacts.product,
      history: { kind: 'continuation_safe', seamId: 'failed_user_only_no_suffix_v1',
        retainedFormalInputMappingDigest: digestCanonicalJson(b.ingress.canonicalCurrentInputRef) },
      historyEvidence: bEvidence.terminalFacts.history.evidence, effect: { state: 'none', evidence: [] },
    })
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(b.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: b.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, b, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: bEvidence,
    })
    assert.deepEqual(repository.readAcceptedNativePrefixHead('thread-binding-1'), beforeHead,
      'retention is not accepted coverage')
    assert.deepEqual(repository.readLiveUncommittedUserTail('thread-binding-1'), [], 'native already retains B')
    assert.deepEqual(repository.readHandoffUncommittedUserTail('thread-binding-1').map((item) => item.originUserMessageId),
      [b.ingress.canonicalCurrentInputRef.messageId])
  return { b, bStart }
}

test('formal-origin handoff carries safe failed B and divergent C once without resending B on the same native thread', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)
    const c = prepared('run-diverged-c')
    const cStart = admitStartedExistingTurn(db, repository, c)
    assert.deepEqual(cStart.admitted.prepared.ingress.uncommittedUserTail || [], [])
    const cCandidate = { ...nativeFailureCandidate(c, 'failed'), codexTurnId: cStart.codexTurnId }
    const cReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: c.runId, codexThreadId: cCandidate.codexThreadId, codexTurnId: cCandidate.codexTurnId,
      engineOutcome: 'failed', candidate: cCandidate, recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(c.taskId)
    const result = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: c.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, c, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: terminalCloseoutEvidence(c, cCandidate, cReceipt, undefined, ['turn-native-1', bStart.codexTurnId]),
      forkSeed: { targetCwd: '/tmp/ready-codex/tail-b-c', reservationSetId: 'fork-b-c', reservationId: 'fork-b-c-member', reservationEvidenceDigest: 'fork-b-c-evidence' },
    })
    db.exec('COMMIT')
    assert.deepEqual(repository.readLiveUncommittedUserTail(result.forkTargetThreadBindingId!)
      .map((item) => item.originUserMessageId), [b.ingress.canonicalCurrentInputRef.messageId, c.ingress.canonicalCurrentInputRef.messageId])
    const targetId = result.forkTargetThreadBindingId!
    repository.activateStartDispatch({ connectionEpoch: 'tail-b-c-fork', rpcId: 1, method: 'thread/fork',
      bindingLookupKey: targetId, requestDigest: 'tail-b-c-fork-request', dispatchedAt: admittedAt })
    repository.markStartChildWriteConfirmed({ connectionEpoch: 'tail-b-c-fork', rpcId: 1, method: 'thread/fork',
      bindingId: targetId, childWriteDigest: 'tail-b-c-fork-request', confirmedAt: admittedAt })
    const child = { ...rootThread(), id: 'tail-b-c-child', sessionId: 'tail-b-c-child', forkedFromId: 'thread-native-1',
      cwd: '/tmp/ready-codex/tail-b-c', turns: [{ id: 'turn-native-1', status: 'completed', error: null, items: [] }] }
    repository.reconcileStartAccepted({ connectionEpoch: 'tail-b-c-fork', rpcId: 1, method: 'thread/fork',
      bindingId: targetId, nativeId: child.id, responseDigest: 'tail-b-c-fork-result', responsePending: false, reconciledAt: admittedAt,
      nativeResult: { thread: child, cwd: child.cwd, model: 'ready-e0-model', modelProvider: 'ready_gateway',
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null, serviceTier: null, instructionSources: [] } })
    assert.equal(repository.readProductTurnPresentation(c.runId).actionProjection.retry_failed_task.availability, 'ready')
    const memory = new ReadyMemoryRepository(db as unknown as DatabaseConnection)
    memory.addManualMemory({ entryId: 'expiring-retry-memory', category: 'preference', content: 'Time cannot grant Retry',
      createdAt: admittedAt, expiresAt: '2100-01-01T00:00:00.000Z' })
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2099-12-31T23:59:59.000Z') })
    const beforeExpiry = repository.readProductTurnPresentation(c.runId).actionProjection
    t.mock.timers.tick(2000)
    const afterExpiry = repository.readProductTurnPresentation(c.runId).actionProjection
    assert.deepEqual(afterExpiry, beforeExpiry, 'wall-clock expiry is not an eligibility revision')
    assert.notEqual(afterExpiry.retry_failed_task.availability, 'ready')
    assert.equal(memory.buildSnapshot(new Date().toISOString()).entries.length, 0, 'prompt may filter expired rows independently')
    memory.expireMemories(new Date().toISOString())
    t.mock.timers.reset()
    assert.equal(repository.readProductTurnPresentation(c.runId).actionProjection.retry_failed_task.availability, 'ready')
    const retry = prepareRetryOnCurrentHead(repository, c.runId, 'run-retry-selected-c')
    assert.equal(isPreparedCodexProductRun({ ...retry, ingress: { ...retry.ingress,
      uncommittedTailAssignments: retry.ingress.uncommittedTailAssignments?.map((item, index) => ({ ...item,
        plan: index === 0 ? 'replace_with_explicit_retry' : 'deliver_untrusted_history' })) } }), false,
    'a forged assignment cannot replace earlier B while delivering selected C again')
    const retryStart = admitStartedExistingTurn(db, repository, retry, targetId, child.cwd)
    assert.deepEqual(retry.ingress.uncommittedTailAssignments?.map((item) => [item.originUserMessageId, item.plan]), [
      [b.ingress.canonicalCurrentInputRef.messageId, 'deliver_untrusted_history'],
      [c.ingress.canonicalCurrentInputRef.messageId, 'replace_with_explicit_retry'],
    ])
    const built = new CodexTurnInputBuilder().build(retry.ingress, {
      threadId: child.id, turnRequestId: retryStart.admitted.turnRequestId, reasoningEffort: 'high', readyRunId: retry.runId,
      toolSurfaceDigest: retry.readyToolSurface.toolSurfaceDigest, turnContractDigest: retryStart.admitted.turnContractDigest,
      upstreamProfileSnapshotDigest: retryStart.admitted.upstreamProfileSnapshotDigest, readyMemorySnapshot: retry.readyMemorySnapshot,
    })
    assert.equal(built.ok, true)
    if (!built.ok) throw new Error(built.code)
    assert.deepEqual(built.params.input, c.ingress.canonicalCurrentInputRef.input)
    assert.equal(Object.values(built.params.additionalContext).filter((item) => item.kind === 'untrusted').length, 1)
    assert.doesNotMatch(JSON.stringify(built.params), /RETRY CONTROL ONLY/)
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(retry.runId).items.map((item) => item.disposition),
      ['additional_context', 'current_input'])
    const gateway = new CodexModelGatewayRepository(db as unknown as DatabaseConnection, repository)
    const beforeGateway = {
      claims: db.prepare('SELECT ready_run_id, gateway_claimed_codex_turn_id, revision FROM codex_turn_bindings ORDER BY ready_run_id').all(),
      receipts: db.prepare('SELECT receipt_id FROM ready_model_gateway_request_receipts ORDER BY receipt_id').all(),
    }
    assert.throws(() => gateway.resolveBinding({
      metadata: { requestKind: 'turn', threadId: child.id, turnId: retryStart.codexTurnId, readyRunId: retry.runId,
        toolSurfaceDigest: retry.readyToolSurface.toolSurfaceDigest, turnContractDigest: retryStart.admitted.turnContractDigest,
        upstreamProfileSnapshotDigest: retryStart.admitted.upstreamProfileSnapshotDigest,
        raw: { request_kind: 'turn', forked_from_thread_id: child.forkedFromId } },
      requestDigest: 'frozen-tail-consumer-probe', receivedAt: admittedAt,
      get requestEvidence(): never { throw new Error('tail_probe_must_stop_before_receipt') },
      validate(binding) {
        assert.deepEqual(binding.deliveredUserTail, [{ contract: 'ready_uncommitted_user_tail_v1',
          originUserMessageId: b.ingress.canonicalCurrentInputRef.messageId,
          input: b.ingress.canonicalCurrentInputRef.input,
          inputDigest: digestCodexUserInput(b.ingress.canonicalCurrentInputRef.input) }],
        'real gateway authority must consume frozen older B only; selected C and control R are not additional context')
        assert.deepEqual(JSON.parse(built.params.additionalContext['ready-uncommitted-user-tail:0'].value), binding.deliveredUserTail[0])
        throw new Error('frozen_tail_owner_accepted')
      },
    }), /frozen_tail_owner_accepted/)
    assert.deepEqual({
      claims: db.prepare('SELECT ready_run_id, gateway_claimed_codex_turn_id, revision FROM codex_turn_bindings ORDER BY ready_run_id').all(),
      receipts: db.prepare('SELECT receipt_id FROM ready_model_gateway_request_receipts ORDER BY receipt_id').all(),
    }, beforeGateway, 'validator rejection rolls back gateway claim and writes no request receipt')
    const retryCandidate = { ...nativeFailureCandidate(retry, 'failed'), codexThreadId: child.id, codexTurnId: retryStart.codexTurnId }
    const retryEngine = repository.recordEngineTerminalCandidate({ readyRunId: retry.runId,
      codexThreadId: child.id, codexTurnId: retryStart.codexTurnId, engineOutcome: 'failed', candidate: retryCandidate, recordedAt: admittedAt })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(retry.taskId)
    const repeated = repository.completePublicationDivergenceCloseoutInOpenTransaction({ readyRunId: retry.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, retry, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: terminalCloseoutEvidence(retry, retryCandidate, retryEngine, undefined, ['turn-native-1']),
      forkSeed: { targetCwd: '/tmp/ready-codex/tail-b-c-again', reservationSetId: 'fork-b-c-again', reservationId: 'fork-b-c-again-member', reservationEvidenceDigest: 'fork-b-c-again-evidence' } })
    db.exec('COMMIT')
    const repeatedId = repeated.forkTargetThreadBindingId!
    assert.deepEqual(repository.readLiveUncommittedUserTail(repeatedId).map((item) => item.originUserMessageId),
      [b.ingress.canonicalCurrentInputRef.messageId, c.ingress.canonicalCurrentInputRef.messageId], 'failed Retry keeps B and C once and no R')
    repository.activateStartDispatch({ connectionEpoch: 'tail-b-c-again', rpcId: 1, method: 'thread/fork',
      bindingLookupKey: repeatedId, requestDigest: 'tail-b-c-again-request', dispatchedAt: admittedAt })
    repository.markStartChildWriteConfirmed({ connectionEpoch: 'tail-b-c-again', rpcId: 1, method: 'thread/fork',
      bindingId: repeatedId, childWriteDigest: 'tail-b-c-again-request', confirmedAt: admittedAt })
    const grandchild = { ...child, id: 'tail-b-c-grandchild', sessionId: 'tail-b-c-grandchild', forkedFromId: child.id, cwd: '/tmp/ready-codex/tail-b-c-again' }
    repository.reconcileStartAccepted({ connectionEpoch: 'tail-b-c-again', rpcId: 1, method: 'thread/fork',
      bindingId: repeatedId, nativeId: grandchild.id, responseDigest: 'tail-b-c-again-result', responsePending: false, reconciledAt: admittedAt,
      nativeResult: { thread: grandchild, cwd: grandchild.cwd, model: 'ready-e0-model', modelProvider: 'ready_gateway',
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: null, serviceTier: null, instructionSources: [] } })
    assert.equal(repository.readProductTurnPresentation(retry.runId).actionProjection.retry_failed_task.availability, 'ready')
    assert.equal(repository.readProductTurnPresentation(c.runId).actionProjection.retry_failed_task.availability, 'not_applicable')
    const retryAgain = prepareRetryOnCurrentHead(repository, c.runId, 'run-retry-c-again', retry.runId)
    const retryAgainStart = admitStartedExistingTurn(db, repository, retryAgain, repeatedId, grandchild.cwd)
    const retryAgainRuntime = repository.readProductTurnRuntime(retryAgain.runId)
    for (const kind of ['product', 'automatic_compaction'] as const) {
      assertGatewayForkLineage(db, repository, {
        kind, codexThreadId: grandchild.id, codexTurnId: retryAgainStart.codexTurnId,
        readyRunId: retryAgain.runId, forkedFromId: child.id,
        toolSurfaceDigest: retryAgain.readyToolSurface.toolSurfaceDigest,
        turnContractDigest: retryAgainRuntime.turnContractDigest,
        upstreamProfileSnapshotDigest: retryAgainRuntime.upstreamProfileSnapshotDigest,
      })
    }
    assert.equal(retryAgain.ingress.modelVisibleRootOriginRef?.sourceReadyRunId, c.runId)
    assert.equal(retryAgain.ingress.predecessorRunId, retry.runId)
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(retryAgain.runId).items.map((item) => item.disposition),
      ['additional_context', 'current_input'])
  })
})

test('Retry source memory remains disqualifying after current memory is disabled', async (t) => {
  await withRepository(t, (db, repository) => {
    const memory = new ReadyMemoryRepository(db as unknown as DatabaseConnection)
    memory.addManualMemory({ entryId: 'source-memory', category: 'preference', content: 'Use the source context', createdAt: admittedAt })
    const run = prepared()
    run.readyMemorySnapshot = memory.buildSnapshot(admittedAt)
    assert.equal(run.readyMemorySnapshot.entries.length, 1)
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    repository.activateStartDispatch({ connectionEpoch: 'memory', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1', requestDigest: 'memory-thread', dispatchedAt: admittedAt })
    repository.reconcileStartAccepted({ connectionEpoch: 'memory', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1', nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'memory-thread-result', responsePending: false, reconciledAt: admittedAt })
    repository.activateStartDispatch({ connectionEpoch: 'memory', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'memory-turn', dispatchedAt: admittedAt })
    repository.reconcileStartAccepted({ connectionEpoch: 'memory', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'memory-turn-result', responsePending: false, reconciledAt: admittedAt })
    const candidate = nativeFailureCandidate(run, 'failed')
    const engine = repository.recordEngineTerminalCandidate({ readyRunId: run.runId, codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId, engineOutcome: 'failed', candidate, recordedAt: admittedAt })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    const result = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, run, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: terminalCloseoutEvidence(run, candidate, engine),
    })
    db.exec('COMMIT')
    memory.setGlobalPolicy({ useMemories: false, updatedAt: admittedAt })
    const projection = repository.readProductTurnPresentation(run.runId).actionProjection
    assert.equal(projection.retryEvidenceKind, 'complete')
    if (projection.retryEvidenceKind !== 'complete') throw new Error('expected complete projection')
    assert.equal(projection.currentReadyMemoryRef.modelVisiblePayloadEmpty, true)
    assert.ok(projection.retry_failed_task.blockers.includes('current_memory_restatement_required'))
    assert.notEqual(projection.retry_failed_task.availability, 'ready')
    assert.equal(repository.readLiveUncommittedUserTail(result.forkTargetThreadBindingId!)[0].policy, 'task_restatement_required')
  })
})

test('handoff budget is resolved before closeout so nine origins commit one reset-required failure without a stuck fence', async (t) => {
  await withRepository(t, (db, repository) => {
    const a = prepared()
    prepareReadyParents(db, repository, a)
    repository.admitProductBindings(admission(a, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    const accepted = repository.readAcceptedNativePrefixHead('thread-binding-1')
    const nativeIds = ['turn-native-1']
    for (let index = 1; index <= 8; index += 1) {
      const b = prepared(`budget-b-${index}`)
      const started = admitStartedExistingTurn(db, repository, b)
      const candidate = { ...nativeFailureCandidate(b, 'failed'), codexTurnId: started.codexTurnId }
      const engine = repository.recordEngineTerminalCandidate({ readyRunId: b.runId,
        codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId,
        engineOutcome: 'failed', candidate, recordedAt: admittedAt })
      const evidence = terminalCloseoutEvidence(b, candidate, engine, undefined, nativeIds)
      evidence.terminalFacts = resolveCodexTerminalFacts({ product: evidence.terminalFacts.product,
        history: { kind: 'continuation_safe', seamId: 'failed_user_only_no_suffix_v1',
          retainedFormalInputMappingDigest: digestCanonicalJson(b.ingress.canonicalCurrentInputRef) },
        historyEvidence: evidence.terminalFacts.history.evidence, effect: evidence.terminalFacts.effect })
      db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(b.taskId)
      repository.completeProductTurnCloseout({ readyRunId: b.runId, closeoutAt: admittedAt,
        productTerminalDigest: insertFailureTerminalMessage(db, b, '本轮未能完成。', 'blocked_external'), terminalEvidence: evidence })
      nativeIds.push(started.codexTurnId)
    }
    const c = prepared('budget-diverged-c')
    const started = admitStartedExistingTurn(db, repository, c)
    const candidate = { ...nativeFailureCandidate(c, 'failed'), codexTurnId: started.codexTurnId }
    const engine = repository.recordEngineTerminalCandidate({ readyRunId: c.runId,
      codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId,
      engineOutcome: 'failed', candidate, recordedAt: admittedAt })
    const evidence = terminalCloseoutEvidence(c, candidate, engine, undefined, nativeIds)
    assert.equal(repository.readHandoffUncommittedUserTail('thread-binding-1').length, 8)
    assert.deepEqual(repository.readAcceptedNativePrefixResolution({ readyRunId: c.runId, nativeReadback: evidence.nativeReadback }),
      { kind: 'unknown', reason: 'uncommitted_tail_budget_exceeded' }, 'precloseout snapshot includes the ninth current origin')
    evidence.terminalFacts = resolveCodexTerminalFacts({ product: evidence.terminalFacts.product,
      history: { kind: 'unknown_reset_required', reason: 'uncommitted_tail_budget_exceeded' },
      historyEvidence: evidence.terminalFacts.history.evidence, effect: evidence.terminalFacts.effect })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(c.taskId)
    repository.completeHistoryResetRequiredCloseoutInOpenTransaction({ readyRunId: c.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, c, '本轮未能完成。', 'blocked_external'), terminalEvidence: evidence })
    db.exec('COMMIT')
    assert.ok(repository.readProductCloseout(c.runId))
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences`).get<{ count: number }>()?.count, 0)
    assert.deepEqual(repository.readAcceptedNativePrefixHead('thread-binding-1'), accepted)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.aliasGeneration, 1)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.continuationBlockedReason, 'publication_diverged')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.retiredAt, null)
  })
})

test('first-turn fresh root requires both native and Ready to prove an empty earlier prefix', async (t) => {
  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, { runId: 'run-unmapped-native-prefix' })
    const candidate = nativeFailureCandidate(run, 'failed')
    const engine = repository.recordEngineTerminalCandidate({ readyRunId: run.runId,
      codexThreadId: candidate.codexThreadId, codexTurnId: candidate.codexTurnId, engineOutcome: 'failed', candidate, recordedAt: admittedAt })
    const evidence = terminalCloseoutEvidence(run, candidate, engine, undefined, ['earlier-unmapped-native-turn'])
    assert.deepEqual(repository.readAcceptedNativePrefixResolution({ readyRunId: run.runId, nativeReadback: evidence.nativeReadback }), { kind: 'unknown' })
    db.exec('BEGIN IMMEDIATE')
    assert.throws(() => repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId, closeoutAt: admittedAt, productTerminalDigest: 'not-committed', terminalEvidence: evidence,
    }), /publication_divergence_prefix_unknown/)
    db.exec('ROLLBACK')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.aliasGeneration, 1)
    assert.equal(repository.readActiveAliasBinding('scope-1')?.retiredAt, null)
  })
})

test('first-turn divergence creates a fresh root with one immutable text tail', async (t) => {
  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-first-turn-divergence',
    })
    const candidate = nativeFailureCandidate(run, 'failed')
    const receipt = repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId,
      engineOutcome: candidate.engineOutcome,
      candidate,
      recordedAt: admittedAt,
    })
    const terminalEvidence = terminalCloseoutEvidence(run, candidate, receipt)
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    const productTerminalDigest = insertFailureTerminalMessage(
      db,
      run,
      '本轮未能完成。',
      'blocked_external',
    )
    const closeout = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest,
      closeoutAt: admittedAt,
      terminalEvidence,
    })
    db.exec('COMMIT')
    assert.ok(closeout.forkTargetThreadBindingId)
    const head = repository.readActiveAliasBinding('scope-1')
    assert.equal(head?.materializationKind, 'fresh_root_with_tail')
    assert.equal(head?.codexThreadId, null)
    assert.deepEqual(repository.readUncommittedUserTail(head!.threadBindingId), [{
      originUserMessageId: run.ingress.originUserMessageId,
      input: run.ingress.canonicalCurrentInputRef.input,
      inputDigest: digestCodexUserInput(run.ingress.canonicalCurrentInputRef.input),
      policy: 'untrusted_text_history',
    }])
    const tail = repository.readLiveUncommittedUserTail(head!.threadBindingId)
    const persistedRoot = repository.readProductTurnRuntime(run.runId)
    const predecessorPresentation = repository.readProductTurnPresentation(run.runId, {
      requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
    })
    assert.equal(predecessorPresentation.actionProjection.retry_failed_task.availability, 'ready')
    const controlInput = [{ type: 'text' as const, text: '再试一次', text_elements: [] }]
    const retryResult = new CodexProductRunPreparer().prepare({
      taskId: 'task-fresh-root-retry', runId: 'run-fresh-root-retry',
      requestId: 'request-fresh-root-retry', scopeId: 'scope-1', aliasId: 'scope-1',
      aliasGeneration: 2, taskOrigin: 'user_root', runOrigin: 'initial',
      originUserMessageId: 'message-fresh-root-retry-control',
      reservationSetId: 'set-run-fresh-root-retry',
      reservationEvidenceDigest: 'reservation-evidence-run-fresh-root-retry',
      currentInput: controlInput,
      explicitResourceEnvelope: { input: [], resourceRefs: [] },
      resourceAdditionalContext: [], trustedWorkbenchMode: 'browser',
      uncommittedUserTail: tail,
      uncommittedTailAssignments: [{
        originUserMessageId: tail[0].originUserMessageId,
        inputDigest: tail[0].inputDigest,
        plan: 'replace_with_explicit_retry',
      }],
      supersededUncommittedItems: [],
      readyMemorySnapshot: disabledReadyMemorySnapshot(),
      readyToolSurface: run.readyToolSurface,
      readyTurnToolAuthorization: run.readyTurnToolAuthorization,
      authorizationOwnerId: 'owner-retry', resourceOwnerId: 'resource-owner-retry',
      productBudgetSeed: { maxIterations: 8, maxToolCalls: 4, maxParallelToolGroups: 1 },
      explicitRetry: {
        predecessorRunId: run.runId,
        predecessorPresentationRef: {
          readyRunId: run.runId,
          presentationDigest: predecessorPresentation.presentationDigest,
        },
        controlAuditMessageRef: {
          messageId: 'message-fresh-root-retry-control',
          inputDigest: digestCodexUserInput(controlInput),
        },
        modelVisibleRootOriginRef: {
          sourceReadyRunId: run.runId,
          sourceIngressContractDigest: digestCanonicalJson(persistedRoot.prepared),
          originUserMessageId: persistedRoot.ingress.canonicalCurrentInputRef.messageId,
          inputDigest: tail[0].inputDigest,
        },
        selectedHistorySeedItemRef: {
          threadBindingId: head!.threadBindingId,
          historySeedDigest: head!.historySeedDigest!,
          originUserMessageId: tail[0].originUserMessageId,
          inputDigest: tail[0].inputDigest,
        },
        currentTrustedEnvironmentRef: {
          requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
          modeDigest: digestCanonicalJson({
            requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
          }),
        },
        sourceTrustedEnvironmentRef: persistedRoot.prepared.sourceTrustedEnvironmentRef,
        historyParityEvidenceDigest: 'history-parity-fresh-root-retry',
        currentThreadReadEvidenceDigest: 'thread-read-fresh-root-retry',
        continuationContractDigest: 'continuation-fresh-root-retry',
        taskRootInput: tail[0].input,
        taskRootInputDigest: tail[0].inputDigest,
        artifactSources: [],
      },
    })
    assert.equal(retryResult.ok, true)
    if (!retryResult.ok) throw new Error(retryResult.code)
    const retry = retryResult.prepared
    assert.equal(retry.ingress.originUserMessageId, 'message-fresh-root-retry-control')
    assert.equal(retry.ingress.canonicalCurrentInputRef.messageId, tail[0].originUserMessageId)
    prepareReadyParentRowsOnly(db, retry)
    db.prepare(`UPDATE chat_messages SET content = '再试一次' WHERE id = ?`)
      .run(retry.ingress.originUserMessageId)
    const retryAdmission = admission(retry, lazyReservation(retry.runId), {
      threadBindingId: head!.threadBindingId,
      isolatedThreadCwd: '/tmp/ready-codex/fresh-root-retry',
    })
    const changedContext = createThreadTransitionProfile({ profileId: 'retry-changed-context', model: 'gpt-5.6-terra',
      reasoningEffort: 'high', contextWindowOverride: 500_000, maxOutputTokensOverride: 8_192 })
    new CodexModelGatewayRepository(db as unknown as DatabaseConnection, repository).storeSnapshot({ ...changedContext, createdAt: admittedAt })
    assert.throws(() => repository.admitProductBindings(admission(retry, lazyReservation(retry.runId), {
      threadBindingId: head!.threadBindingId, isolatedThreadCwd: '/tmp/ready-codex/fresh-root-retry',
      upstreamProfileSnapshotRef: changedContext.snapshotRef, upstreamProfileSnapshotDigest: changedContext.snapshotDigest,
    })), /thread_config_changed/)
    assert.equal(db.prepare(`SELECT native_inherited_contract_digest AS digest FROM codex_thread_bindings WHERE thread_binding_id = ?`)
      .get<{ digest: string | null }>(head!.threadBindingId)?.digest, null)
    repository.admitProductBindings(retryAdmission)
    const builtRetry = new CodexTurnInputBuilder().build(retryAdmission.prepared.ingress, {
      threadId: 'thread-fresh-root-retry', turnRequestId: retryAdmission.turnRequestId,
      reasoningEffort: 'high', readyRunId: retry.runId,
      toolSurfaceDigest: retry.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: retryAdmission.turnContractDigest,
      upstreamProfileSnapshotDigest: retryAdmission.upstreamProfileSnapshotDigest,
      readyMemorySnapshot: retry.readyMemorySnapshot,
    })
    assert.equal(builtRetry.ok, true)
    if (!builtRetry.ok) throw new Error(builtRetry.code)
    assert.deepEqual(builtRetry.params.input, tail[0].input)
    assert.doesNotMatch(JSON.stringify(builtRetry.params), /再试一次/)
    assert.equal(repository.readProductTurnSuccessorId(run.runId), retry.runId)
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 10, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/fresh-root-retry',
      requestDigest: 'fresh-root-thread-request', dispatchedAt: admittedAt,
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 10, method: 'thread/start',
      bindingId: head!.threadBindingId, childWriteDigest: 'fresh-root-thread-request',
      confirmedAt: admittedAt,
    })
    const retryThread = {
      ...rootThread(),
      id: 'thread-fresh-root-retry', sessionId: 'thread-fresh-root-retry',
      cwd: '/tmp/ready-codex/fresh-root-retry',
    }
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 10, method: 'thread/start',
      bindingId: head!.threadBindingId, nativeId: retryThread.id,
      nativeResult: { thread: retryThread, instructionSources: [] },
      responseDigest: 'fresh-root-thread-response', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 11, method: 'turn/start',
      bindingLookupKey: retry.runId, requestDigest: 'fresh-root-turn-request',
      dispatchedAt: admittedAt,
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 11, method: 'turn/start',
      bindingId: retry.runId, childWriteDigest: 'fresh-root-turn-request',
      confirmedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-fresh-root-retry', rpcId: 11, method: 'turn/start',
      bindingId: retry.runId, nativeId: 'turn-fresh-root-retry',
      nativeResult: { turn: { ...activeTurn(), id: 'turn-fresh-root-retry' } },
      responseDigest: 'fresh-root-turn-response', responsePending: false,
      reconciledAt: admittedAt,
    })
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(retry.runId).items, [{
      originUserMessageId: tail[0].originUserMessageId,
      inputDigest: tail[0].inputDigest,
      assignment: 'replace_with_explicit_retry',
      disposition: 'current_input',
    }])
    assert.equal(repository.readLiveUncommittedUserTail(head!.threadBindingId).length, 1)
  })
})

test('ordinary admission supersedes a structured tail item without sending it to the model', async (t) => {
  const currentDigest = 'd'.repeat(64)
  const currentDocumentAnchor = {
    kind: 'current_document' as const,
    logicalResourceId: 'ready-current-document:scope-1:tail-doc',
    tabId: 'tail-doc', title: 'Tail document', pane: 'primary' as const,
    pathDigest: 'e'.repeat(64), incarnationKey: 'f'.repeat(64),
    currentVersion: `sha256:${currentDigest}`, currentDigest,
    supersedesVersion: null, policyEpoch: 1,
    readScope: { operation: 'read_section' as const, maxChars: 30_000 as const },
  }
  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-structured-tail-source', currentDocumentAnchor,
    })
    const candidate = nativeFailureCandidate(run, 'failed')
    const receipt = repository.recordEngineTerminalCandidate({
      readyRunId: run.runId, codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId, engineOutcome: candidate.engineOutcome,
      candidate, recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    const productTerminalDigest = insertFailureTerminalMessage(
      db, run, '本轮未能完成。', 'blocked_external',
    )
    const closed = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest,
      closeoutAt: admittedAt,
      terminalEvidence: terminalCloseoutEvidence(run, candidate, receipt),
    })
    db.exec('COMMIT')
    const targetId = closed.forkTargetThreadBindingId as string
    const tail = repository.readLiveUncommittedUserTail(targetId)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].policy, 'resource_restatement_required')
    const before = projectCodexHeadActionProjection(repository.readHeadActionFacts({
      aliasId: 'scope-1', aliasGeneration: 2,
      currentRuntimeManifestDigest: testRuntimeManifestDigest,
      currentProtocolSchemaDigest: 'protocol-schema-digest',
    }))
    assert.deepEqual(before.actions.send_new_message.consequence, {
      kind: 'supersedes_uncommitted_structured_tail',
      omittedItemCount: 1,
      resourceReattachItemCount: 1,
      itemsDigest: digestCanonicalJson([{
        messageId: tail[0].originUserMessageId,
        digest: tail[0].inputDigest,
        policy: 'resource_restatement_required',
      }]),
    })

    const ordinary = prepared('run-after-structured-tail')
    ordinary.conversationAlias = { aliasId: 'scope-1', aliasGeneration: 2 }
    ordinary.ingress = {
      ...ordinary.ingress,
      uncommittedUserTail: tail,
      uncommittedTailAssignments: [{
        originUserMessageId: tail[0].originUserMessageId,
        inputDigest: tail[0].inputDigest,
        plan: 'omit_from_current_run',
      }],
      supersededUncommittedItems: [{
        originUserMessageId: tail[0].originUserMessageId,
        inputDigest: tail[0].inputDigest,
        policy: 'resource_restatement_required',
      }],
    }
    prepareReadyParentRowsOnly(db, ordinary)
    repository.admitProductBindings(admission(
      ordinary,
      lazyReservation(ordinary.runId),
      {
        threadBindingId: targetId,
        isolatedThreadCwd: '/tmp/ready-codex/structured-tail-target',
      },
    ))
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(ordinary.runId).items, [{
      originUserMessageId: tail[0].originUserMessageId,
      inputDigest: tail[0].inputDigest,
      assignment: 'omit_from_current_run',
      disposition: 'superseded',
    }])
    assert.deepEqual(repository.readLiveUncommittedUserTail(targetId), [])
    const after = projectCodexHeadActionProjection(repository.readHeadActionFacts({
      aliasId: 'scope-1', aliasGeneration: 2,
      currentRuntimeManifestDigest: testRuntimeManifestDigest,
      currentProtocolSchemaDigest: 'protocol-schema-digest',
    }))
    assert.equal(after.actions.send_new_message.consequence, null)

    repository.activateStartDispatch({
      connectionEpoch: 'epoch-lazy', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/structured-tail-target',
      requestDigest: 'structured-successor-thread-request', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-lazy', rpcId: 1, method: 'thread/start',
      bindingId: targetId, nativeId: 'structured-successor-native',
      nativeResult: { thread: {
        ...rootThread(), id: 'structured-successor-native', sessionId: 'structured-successor-native',
        cwd: '/tmp/ready-codex/structured-tail-target',
      }, instructionSources: [] },
      responseDigest: 'structured-successor-thread-response', responsePending: false, reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-lazy', rpcId: 2, method: 'turn/start',
      bindingLookupKey: ordinary.runId,
      requestDigest: 'structured-successor-turn-request', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-lazy', rpcId: 2, method: 'turn/start',
      bindingId: ordinary.runId, nativeId: 'structured-successor-turn',
      nativeResult: { turn: { ...activeTurn(), id: 'structured-successor-turn' } },
      responseDigest: 'structured-successor-turn-response', responsePending: false, reconciledAt: admittedAt,
    })
    const successorCandidate = {
      ...nativeFailureCandidate(ordinary, 'failed'),
      codexThreadId: 'structured-successor-native', codexTurnId: 'structured-successor-turn',
    }
    const successorReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: ordinary.runId, codexThreadId: successorCandidate.codexThreadId,
      codexTurnId: successorCandidate.codexTurnId, engineOutcome: 'failed',
      candidate: successorCandidate, recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(ordinary.taskId)
    const successorCloseout = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: ordinary.runId,
      productTerminalDigest: insertFailureTerminalMessage(db, ordinary, '本轮未能完成。', 'blocked_external'),
      closeoutAt: admittedAt,
      terminalEvidence: terminalCloseoutEvidence(ordinary, successorCandidate, successorReceipt),
    })
    db.exec('COMMIT')
    assert.deepEqual(repository.readLiveUncommittedUserTail(successorCloseout.forkTargetThreadBindingId!), [{
      originUserMessageId: ordinary.ingress.canonicalCurrentInputRef.messageId,
      input: ordinary.ingress.canonicalCurrentInputRef.input,
      inputDigest: digestCodexUserInput(ordinary.ingress.canonicalCurrentInputRef.input),
      policy: 'untrusted_text_history',
    }], 'supersession is inherited by the next head; the structured origin cannot return')
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

    const resolved = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: testRuntimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: '2026-08-07T00:02:00.000Z',
    })
    assert.equal(resolved.kind, 'refreshed')
    assert.ok('binding' in resolved)
    assert.equal(resolved.binding.aliasGeneration, 3)
    assert.equal(resolved.binding.codexThreadId, null)
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
        retired_reason: 'pristine_contract_refresh',
      },
      {
        alias_generation: 3,
        runtime_manifest_digest: testRuntimeManifestDigest,
        protocol_schema_digest: 'protocol-schema-digest',
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
          threadBindingId: resolved.binding.threadBindingId,
          runtimeManifestDigest: 'runtime-manifest-digest-v1',
          protocolSchemaDigest: 'protocol-schema-digest-v1',
          messageVisibilityEpoch: 1,
        },
      )),
      (error: unknown) => error instanceof CodexBindingRepositoryError
        && error.code === 'current_runtime_contract_mismatch',
    )
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<{ count: number }>(run.runId)?.count, 0)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ?
    `).get<{ count: number }>(resolved.binding.threadBindingId)?.count, 0)
    assert.deepEqual(repository.admitProductBindings(admission(
      run,
      lazyReservation(run.runId),
      {
        threadBindingId: resolved.binding.threadBindingId,
        runtimeManifestDigest: testRuntimeManifestDigest,
        protocolSchemaDigest: 'protocol-schema-digest',
        messageVisibilityEpoch: 1,
      },
    )), {
      threadBindingId: resolved.binding.threadBindingId,
      readyRunId: run.runId,
      threadState: 'unstarted',
    })
  })
})

test('pristine refresh excludes settled confirmations only through their exact earlier-epoch Codex owner', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))
    const confirmations = new FrozenCallStore(db as unknown as DatabaseConnection, {
      now: () => Date.parse(admittedAt),
    })
    const confirmation = confirmations.freeze({
      toolName: 'file_copy', params: { source: 'fixture-source', target: 'fixture-target' },
      runId: run.runId, taskId: run.taskId, scopeId: 'scope-1',
    })
    assert.ok(confirmation.ok)
    assert.equal(confirmations.release(confirmation.id, confirmation.token).ok, true)
    startAndCloseInitialProductTurn(db, repository)
    const reset = repository.resetIdleAlias({
      aliasId: 'scope-1', expectedGeneration: 1,
      retirementEvidenceDigest: digestCanonicalJson({ action: 'explicit-user-reset' }),
      resetAt: '2026-08-07T01:01:00.000Z',
    })
    assert.equal(reset.messageVisibilityEpoch, 1)
    const auditBefore = db.prepare('SELECT * FROM pending_confirmations').all()
    const refreshed = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1', runtimeManifestDigest: 'runtime-v2', protocolSchemaDigest: 'protocol-v2',
      createdAt: '2026-08-07T01:02:00.000Z',
    })
    assert.equal(refreshed.kind, 'refreshed')
    assert.ok('binding' in refreshed)
    assert.equal(refreshed.binding.aliasGeneration, 3)
    assert.deepEqual(db.prepare('SELECT * FROM pending_confirmations').all(), auditBefore)
    assert.equal(db.prepare('SELECT message_visibility_epoch FROM codex_turn_bindings WHERE ready_run_id = ?')
      .get<{ message_visibility_epoch: number }>(run.runId)?.message_visibility_epoch, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ? AND message_visibility_epoch = 0')
      .get<{ n: number }>('scope-1')?.n, 2)
  })
})

test('user ingress preserves a started alias and its existing fence when runtime changes', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation()))

    const resolved = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: 'runtime-manifest-digest-v2',
      protocolSchemaDigest: 'protocol-schema-digest-v2',
      createdAt: '2026-08-07T00:02:00.000Z',
    })
    assert.equal(resolved.kind, 'reset_required')
    assert.equal(repository.readActiveAliasBinding('scope-1')?.hasActiveFence, true)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
    `).get<{ count: number }>()?.count, 1)
  })
})

test('user ingress blocks an idle used thread when the root tool surface changes', async (t) => {
  await withRepository(t, (db, repository) => {
    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    const frozen = db.prepare(`
      SELECT alias_generation, tool_surface_digest, retired_at
        FROM codex_thread_bindings WHERE thread_binding_id = 'thread-binding-1'
    `).get<{
      alias_generation: number
      tool_surface_digest: string
      retired_at: string | null
    }>()
    assert.equal(frozen?.alias_generation, 1)
    assert.equal(frozen?.retired_at, null)
    const messagesBefore = db.prepare(`
      SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = 'scope-1'
    `).get<{ count: number }>()?.count

    const resolved = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: testRuntimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: '2026-08-07T00:02:00.000Z',
      currentToolSurfaceDigest: digestCanonicalJson([{ name: 'calendar_update_event' }]),
    })
    assert.equal(resolved.kind, 'reset_required')
    assert.deepEqual(db.prepare(`
      SELECT alias_generation, retired_reason, continuation_blocked_reason
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = 'scope-1'
       ORDER BY alias_generation
    `).all(), [{
      alias_generation: 1,
      retired_reason: null,
      continuation_blocked_reason: null,
    }])
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = 'scope-1'
    `).get<{ count: number }>()?.count, messagesBefore)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_archive_intents
       WHERE thread_binding_id = 'thread-binding-1'
    `).get<{ count: number }>()?.count, 0)

    const sameSurface = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: testRuntimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: '2026-08-07T00:03:00.000Z',
      currentToolSurfaceDigest: digestCanonicalJson([{ name: 'calendar_update_event' }]),
    })
    assert.equal(sameSurface.kind, 'reset_required')
  })
})

test('user ingress keeps a matching idle started thread on the same generation', async (t) => {
  await withRepository(t, (db, repository) => {
    const first = prepared()
    prepareReadyParents(db, repository, first)
    repository.admitProductBindings(admission(first, lazyReservation()))
    startAndCloseInitialProductTurn(db, repository)
    const digest = db.prepare(`
      SELECT tool_surface_digest FROM codex_thread_bindings
       WHERE thread_binding_id = 'thread-binding-1'
    `).get<{ tool_surface_digest: string }>()?.tool_surface_digest
    assert.ok(digest)

    const resolved = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-1',
      runtimeManifestDigest: testRuntimeManifestDigest,
      protocolSchemaDigest: 'protocol-schema-digest',
      createdAt: '2026-08-07T00:02:00.000Z',
      currentToolSurfaceDigest: digest,
    })
    assert.equal(resolved.kind, 'current')
    assert.ok('binding' in resolved)
    assert.equal(resolved.binding.aliasGeneration, 1)
    assert.equal(resolved.binding.codexThreadId, 'thread-native-1')
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
      connectionEpoch: 'old-epoch', runtimeManifestDigest: testRuntimeManifestDigest,
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
      connectionEpoch: 'new-epoch', runtimeManifestDigest: testRuntimeManifestDigest,
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
      runId: 'run-failed-before-output-declaration',
      pendingOutputContract: true,
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

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-before-output-declaration',
      pendingOutputContract: true,
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
      code: 'folder_output_intent_receipt_missing', callId: null,
    })
  })

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

  await withRepository(t, (db, repository) => {
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-completed-tag-forge-with-ambient-document',
      currentDocumentAnchor,
      currentDocumentReadAuthorized: false,
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
      kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null,
    })
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
      const productTerminalDigest = insertFailureTerminalMessage(
        db,
        run,
        '已停止本轮任务，已完成的记录仍保留。',
        'cancelled_user',
      )
      const engine = repository.readEngineTerminalCandidate(run.runId)
      const lifecycle = repository.readProductLifecycleAction(run.runId)
      if (!engine || !lifecycle) throw new Error('lifecycle_evidence_fixture_missing')
      const result = repository.completeLifecycleActionCloseoutInOpenTransaction({
        action: 'close',
        readyRunId: run.runId,
        productTerminalDigest,
        closeoutAt: admittedAt,
        terminalEvidence: terminalCloseoutEvidence(
          run,
          engine.candidate as ReturnType<typeof nativeFailureCandidate>,
          engine,
          { action: 'close', evidenceDigest: lifecycle.lifecycleActionEvidenceDigest },
        ),
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
      /product_effect_settlement_incomplete/,
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
    const productTerminalDigest = failureTerminalMessageDigest(
      run,
      '已停止本轮任务，已完成的记录仍保留。',
      'cancelled_user',
    )
    db.exec('BEGIN IMMEDIATE')
    repository.completeLifecycleActionCloseoutInOpenTransaction({
      action: 'close',
      readyRunId: run.runId,
      productTerminalDigest,
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
        const productTerminalDigest = insertFailureTerminalMessage(
          db,
          run,
          '已停止本轮任务，已完成的记录仍保留。',
          'cancelled_user',
        )
        const engine = repository.readEngineTerminalCandidate(run.runId)
        const lifecycle = repository.readProductLifecycleAction(run.runId)
        if (!engine || !lifecycle) throw new Error('lifecycle_evidence_fixture_missing')
        repository.completeLifecycleActionCloseoutInOpenTransaction({
          action,
          readyRunId: run.runId,
          productTerminalDigest,
          closeoutAt: admittedAt,
          terminalEvidence: terminalCloseoutEvidence(
            run,
            engine.candidate as ReturnType<typeof nativeFailureCandidate>,
            engine,
            { action, evidenceDigest: lifecycle.lifecycleActionEvidenceDigest },
          ),
        })
        db.exec('COMMIT')
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK')
        throw error
      }

      const closeout = repository.readLifecycleActionCloseout(run.runId)
      assert.equal(closeout.action, action)
      if (action === 'reset') assert.match(closeout.archiveIntentDigest, /^[0-9a-f]{64}$/)
      else assert.equal(closeout.archiveIntentDigest, null)
      assert.equal(closeout.scopeClosureEvidenceDigest, null)
      assert.deepEqual(db.prepare(`
        SELECT closed_at, closed_reason, close_evidence_digest
          FROM chat_conversations WHERE id = ?
      `).get(run.readyToolHostIdentity.scopeId), {
        closed_at: null,
        closed_reason: null,
        close_evidence_digest: null,
      })
      assert.equal(repository.readActiveAliasBinding(run.conversationAlias.aliasId)?.aliasGeneration, 2)
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
    const gatewayRequestReceiptId = recordFixtureGatewayRequest(db, repository, run.runId)
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId,
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
    assert.deepEqual(repository.readPublishedToolOutputs(call.readyRunId), [])
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
    assert.deepEqual(repository.readPublishedToolOutputs(call.readyRunId), [{
      itemId: call.codexCallId,
      toolName: call.toolName,
      output,
      completedAt: admittedAt,
    }])
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
      terminalEvidence: completedCloseoutEvidence(repository, run.runId),
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
    successor.productBudgetSeed = {
      maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1,
      lanes: {
        ordinary: { maxIterations: 7, maxToolCalls: 1, maxParallelToolGroups: 1 },
        delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
        final: { maxIterations: 1 },
      },
    }
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

test('the final Browser tool slot is observe-only at both gateway and durable admission', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared('run-browser-observation-reserve')
    run.readyToolSurface = buildReadyToolSurface({
      surfaceId: 'surface-browser-observation-reserve',
      toolDefinitions: ['browser_snapshot', 'browser_press_key', 'ready_read'].map((name) => ({
        name, groupId: 'agent_interaction', domain: 'browser', kind: 'read',
        concurrency: 'parallel_read_safe', interruptBehavior: 'abort_signal', timeoutProfile: 'default',
        supportsTextBridge: true, projectionHint: null, description: `Fixture ${name}`,
        schema: { type: 'object' }, executionVisibility: 'model', resultShape: 'json',
      })),
    })
    run.readyTurnToolAuthorization = buildReadyTurnToolAuthorization({
      authorizationId: 'authorization-browser-observation-reserve',
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      toolSurface: run.readyToolSurface,
    })
    run.productBudgetSeed = {
      maxIterations: 3, maxToolCalls: 2, maxParallelToolGroups: 1,
      lanes: {
        ordinary: { maxIterations: 2, maxToolCalls: 2, maxParallelToolGroups: 1 },
        delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
        final: { maxIterations: 1 },
      },
    }
    prepareReadyParents(db, repository, run)
    repository.admitProductBindings(admission(run, lazyReservation(run.runId)))
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-browser-reserve', rpcId: 1, method: 'thread/start',
      bindingLookupKey: '/tmp/ready-codex/thread-binding-1',
      requestDigest: 'thread-request-browser-reserve', dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-browser-reserve', rpcId: 1, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
      nativeResult: { thread: rootThread(), instructionSources: [] },
      responseDigest: 'thread-response-browser-reserve', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-browser-reserve', rpcId: 2, method: 'turn/start',
      bindingLookupKey: run.runId, requestDigest: 'turn-request-browser-reserve',
      dispatchedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-browser-reserve', rpcId: 2, method: 'turn/start',
      bindingId: run.runId, nativeId: 'turn-native-1', nativeResult: { turn: activeTurn() },
      responseDigest: 'turn-response-browser-reserve', responsePending: false,
      reconciledAt: admittedAt,
    })
    const gatewayInput = {
      kind: 'product' as const,
      codexThreadId: 'thread-native-1',
      codexForkedFromId: null,
      codexTurnId: 'turn-native-1',
      readyRunId: run.runId,
      toolSurfaceDigest: run.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: `turn-contract-${run.runId}`,
      upstreamProfileSnapshotDigest: defaultThreadProfile.snapshotDigest,
      receivedAt: admittedAt,
    }
    for (const kind of ['product', 'automatic_compaction'] as const) {
      assertGatewayForkLineage(db, repository, { ...gatewayInput, kind, forkedFromId: null })
    }
    assert.deepEqual(
      [...(repository.readModelGatewayBinding(gatewayInput).allowedToolNames || [])].sort(),
      ['browser_press_key', 'browser_snapshot', 'ready_read'],
    )

    const insertGatewayReceipt = (receiptId: string) => db.prepare(`
      INSERT INTO ready_model_gateway_request_receipts (
        receipt_id, request_kind, codex_thread_id, codex_turn_id, ready_run_id,
        manual_compaction_id, upstream_profile_snapshot_ref,
        upstream_profile_snapshot_digest, request_digest, accepted_at
      ) VALUES (?, 'product', 'thread-native-1', 'turn-native-1', ?, NULL, ?, ?, ?, ?)
    `).run(
      receiptId, run.runId, 'profile-ref-1', defaultThreadProfile.snapshotDigest,
      `request-${receiptId}`, admittedAt,
    )
    insertGatewayReceipt('gateway-browser-mutation-1')
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-browser-mutation-1',
      readyRunId: run.runId, codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      calls: [{ codexCallId: 'call-browser-mutation-1', toolName: 'browser_press_key', argsDigest: 'args-1' }],
      admittedAt,
    })
    const reserved = repository.readModelGatewayBinding(gatewayInput)
    assert.deepEqual(reserved.allowedToolNames, ['browser_snapshot'])
    assert.equal(reserved.toolCallsExhausted, false)

    insertGatewayReceipt('gateway-browser-mutation-2')
    assert.throws(
      () => repository.admitToolResponseGroup({
        gatewayRequestReceiptId: 'gateway-browser-mutation-2',
        readyRunId: run.runId, codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
        calls: [{ codexCallId: 'call-browser-mutation-2', toolName: 'browser_press_key', argsDigest: 'args-2' }],
        admittedAt,
      }),
      (error) => error instanceof CodexBindingRepositoryError
        && error.code === 'ordinary_tool_call_reserved_for_browser_observation',
    )

    insertGatewayReceipt('gateway-browser-observation-2')
    repository.admitToolResponseGroup({
      gatewayRequestReceiptId: 'gateway-browser-observation-2',
      readyRunId: run.runId, codexThreadId: 'thread-native-1', codexTurnId: 'turn-native-1',
      calls: [{ codexCallId: 'call-browser-observation-2', toolName: 'browser_snapshot', argsDigest: 'args-3' }],
      admittedAt,
    })
    const exhausted = repository.readModelGatewayBinding(gatewayInput)
    assert.deepEqual(exhausted.allowedToolNames, [])
    assert.equal(exhausted.toolCallsExhausted, true)
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
    run.productBudgetSeed = {
      maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1,
      lanes: {
        ordinary: { maxIterations: 7, maxToolCalls: 1, maxParallelToolGroups: 1 },
        delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
        final: { maxIterations: 1 },
      },
    }
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
      mode: 'commit',
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
      trustedWorkbenchMode: 'browser',
      actionAdmissionRef: {
        headProjectionDigest: 'f'.repeat(64),
        actionProjectionVersion: {
          scopeEpoch: 0,
          headGeneration: 1,
          actionProjectionSequence: 0,
        },
        actionHeadIdentity: {
          aliasId: sessionId,
          aliasGeneration: 1,
          threadBindingId: 'thread-binding-1',
          headRevision: 1,
        },
      },
      uncommittedTailAssignments: [],
      supersededUncommittedItems: [],
      readyMemorySnapshot: disabledReadyMemorySnapshot(),
      actionAuthorizationMode: readActionAuthorizationModeFromEnvelope(
        resolvedIngress.requestEnvelope,
      ),
      readyToolSurface,
      readyTurnToolAuthorization,
      authorizationOwnerId: 'owner-1',
      resourceOwnerId: 'resource-owner-1',
      productBudgetSeed: {
        maxIterations: 8, maxToolCalls: 1, maxParallelToolGroups: 1,
      },
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
      mode: 'commit',
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

    const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection)
    const persistedProduct = restarted.readProductTurnRuntime(runId)
    assert.deepEqual(readCodexPreparedActionAuthorizationEnvelope(persistedProduct), {
      actionAuthorizationMode: 'auto',
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
    const providerSnapshot = defaultThreadProfile.snapshot
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
      credentialReferenceId: providerSnapshot.credentialReferenceId,
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
    assertGatewayForkLineage(db, repository, {
      kind: 'manual_compaction', codexThreadId: 'thread-native-1', codexTurnId: 'manual-lineage-turn',
      readyRunId: null, forkedFromId: null,
      toolSurfaceDigest: null, turnContractDigest: null, upstreamProfileSnapshotDigest: null,
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
    const manualCoverage = db.prepare(`
      SELECT producer_kind, accepted_native_head_kind, accepted_native_head_id,
             newly_covered_json
        FROM codex_native_coverage_receipts
       WHERE producer_owner_id = 'manual-1'
    `).get<{
      producer_kind: string
      accepted_native_head_kind: string
      accepted_native_head_id: string
      newly_covered_json: string
    }>()
    assert.equal(manualCoverage?.producer_kind, 'manual_compaction')
    assert.equal(manualCoverage?.accepted_native_head_kind, 'compaction')
    assert.equal(manualCoverage?.accepted_native_head_id, 'compact-turn-1')
    assert.deepEqual(JSON.parse(manualCoverage?.newly_covered_json || 'null'), [{
      messageId: run.ingress.originUserMessageId,
      digest: digestCodexUserInput(run.ingress.canonicalCurrentInputRef.input),
    }])
  })
})

test('unknown manual compaction remains quarantined until late terminal readback', async (t) => {
  await withRepository(t, (db, repository) => {
    const run = prepared()
    const providerSnapshot = defaultThreadProfile.snapshot
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
      providerSnapshot, credentialReferenceId: providerSnapshot.credentialReferenceId,
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


test('a failed input changes restatement reason only after formal manual compaction covers it', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)

    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])
    const route = repository.readManualCompactionRoute({ aliasId: 'scope-1', aliasGeneration: 1 })!
    const providerSnapshot = defaultThreadProfile.snapshot
    repository.beginManualCompaction({
      ...route, manualCompactionId: 'manual-safe-b', ownerMainBootId: 'main-boot-1',
      providerSnapshot, credentialReferenceId: providerSnapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]), preDispatchThreadReadDigest: 'safe-b-read',
      preDispatchTurnIds: ['turn-native-1', bStart.codexTurnId],
      expiresAt: '2026-08-07T03:00:00.000Z', createdAt: admittedAt,
    })
    repository.activateManualCompactionDispatch({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      codexThreadId: 'thread-native-1', requestDigest: 'manual-safe-b-request', dispatchIntentAt: admittedAt })
    repository.markManualCompactionWriteAttempted({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', attemptedAt: admittedAt })
    repository.markManualCompactionWriteConfirmed({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', childWriteDigest: 'manual-safe-b-request', confirmedAt: admittedAt })
    repository.consumeManualCompaction({ manualCompactionId: 'manual-safe-b', codexCompactionTurnId: 'compact-safe-b',
      notificationContextCompactionItemId: 'compact-safe-b-item', contextCompactionItemId: 'compact-safe-b-item',
      threadReadDigest: 'compacted-safe-b-read', terminalEvidenceDigest: 'compact-terminal',
      gatewayRequestReceiptId: 'compact-request', gatewayRequestEvidenceDigest: 'compact-request-evidence',
      gatewayResponseEvidenceDigest: 'compact-response-evidence', consumedAt: admittedAt })
    const projected = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.equal(projected.availability, 'not_applicable')
    assert.deepEqual(projected.blockers, ['compacted_failed_turn_restatement_required'])
    assert.deepEqual(repository.readHandoffUncommittedUserTail('thread-binding-1'), [])
    assert.equal(repository.readTerminalCloseoutEvidence(b.runId)!.terminalFacts.history.kind, 'continuation_safe')
  })
})

test('product Retry presentation consumes the canonical current head contract decision', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b } = prepareRetainedFailureFixture(db, repository)
    let calls = 0
    const currentRepository = new CodexBindingRepository(
      db as unknown as DatabaseConnection,
      {
        ...testRuntimeContract,
        resolveHeadContractBlocker(input) {
          calls += 1
          assert.equal(input.aliasId, 'scope-1')
          assert.equal(input.workbenchMode, 'document')
          return 'native_tool_definition_changed'
        },
      },
    )
    const currentEnvironment = {
      requestedWorkbenchMode: 'document',
      trustedWorkbenchMode: 'document',
    } as const
    const context = currentRepository.readProductTurnActionContext(b.runId, currentEnvironment)
    assert.equal(context?.headFacts.headContractBlocker, 'native_tool_definition_changed')
    const presentation = currentRepository.readProductTurnPresentation(b.runId, currentEnvironment)
    assert.equal(calls, 2)
    assert.notEqual(presentation.actionProjection.retry_failed_task.availability, 'ready')
    assert.ok(presentation.actionProjection.retry_failed_task.blockers.length > 0,
      JSON.stringify(presentation.actionProjection.retry_failed_task.blockers))
  })
})

test('ordinary accepted coverage does not claim a failure was compacted', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)

    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])

    const c = prepared('run-accepted-c')
    const cStart = admitStartedExistingTurn(db, repository, c)
    const productTerminalDigest = recordCompletedTerminal(db, repository, c.runId, cStart.codexTurnId)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(c.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: c.runId, productTerminalDigest, closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(repository, c.runId, ['turn-native-1', bStart.codexTurnId]),
    })
    const projected = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.equal(db.prepare(`SELECT count(*) AS n FROM codex_native_coverage_receipts WHERE producer_kind != 'product_closeout'`).get().n, 0)
    assert.deepEqual(projected.blockers, ['same_thread_failed_turn_restatement_required'])
  })
})

test('compaction then ordinary success preserves compacted reason', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)

    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])
    const route = repository.readManualCompactionRoute({ aliasId: 'scope-1', aliasGeneration: 1 })!
    const providerSnapshot = defaultThreadProfile.snapshot
    repository.beginManualCompaction({
      ...route, manualCompactionId: 'manual-safe-b', ownerMainBootId: 'main-boot-1',
      providerSnapshot, credentialReferenceId: providerSnapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]), preDispatchThreadReadDigest: 'safe-b-read',
      preDispatchTurnIds: ['turn-native-1', bStart.codexTurnId],
      expiresAt: '2026-08-07T03:00:00.000Z', createdAt: admittedAt,
    })
    repository.activateManualCompactionDispatch({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      codexThreadId: 'thread-native-1', requestDigest: 'manual-safe-b-request', dispatchIntentAt: admittedAt })
    repository.markManualCompactionWriteAttempted({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', attemptedAt: admittedAt })
    repository.markManualCompactionWriteConfirmed({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', childWriteDigest: 'manual-safe-b-request', confirmedAt: admittedAt })
    repository.consumeManualCompaction({ manualCompactionId: 'manual-safe-b', codexCompactionTurnId: 'compact-safe-b',
      notificationContextCompactionItemId: 'compact-safe-b-item', contextCompactionItemId: 'compact-safe-b-item',
      threadReadDigest: 'compacted-safe-b-read', terminalEvidenceDigest: 'compact-terminal',
      gatewayRequestReceiptId: 'compact-request', gatewayRequestEvidenceDigest: 'compact-request-evidence',
      gatewayResponseEvidenceDigest: 'compact-response-evidence', consumedAt: admittedAt })

    const c = prepared('run-accepted-c')
    const cStart = admitStartedExistingTurn(db, repository, c)
    const productTerminalDigest = recordCompletedTerminal(db, repository, c.runId, cStart.codexTurnId)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(c.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: c.runId, productTerminalDigest, closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(repository, c.runId, ['turn-native-1', bStart.codexTurnId, 'compact-safe-b']),
    })
    const projected = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.equal(repository.readAcceptedNativePrefixHead('thread-binding-1')!.acceptedNativeHeadKind, 'turn')
    assert.equal(projected.availability, 'not_applicable')
    assert.deepEqual(projected.blockers, ['compacted_failed_turn_restatement_required'])
    assert.deepEqual(repository.readHandoffUncommittedUserTail('thread-binding-1'), [])
    assert.equal(repository.readTerminalCloseoutEvidence(b.runId)!.terminalFacts.history.kind, 'continuation_safe')
  })
})


test('ordinary accepted failure then compaction gains compacted reason', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)

    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])

    const c = prepared('run-accepted-c')
    const cStart = admitStartedExistingTurn(db, repository, c)
    const productTerminalDigest = recordCompletedTerminal(db, repository, c.runId, cStart.codexTurnId)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(c.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: c.runId, productTerminalDigest, closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(repository, c.runId, ['turn-native-1', bStart.codexTurnId]),
    })
    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])
    const route = repository.readManualCompactionRoute({ aliasId: 'scope-1', aliasGeneration: 1 })!
    const providerSnapshot = defaultThreadProfile.snapshot
    repository.beginManualCompaction({
      ...route, manualCompactionId: 'manual-safe-b', ownerMainBootId: 'main-boot-1',
      providerSnapshot, credentialReferenceId: providerSnapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]), preDispatchThreadReadDigest: 'safe-b-read',
      preDispatchTurnIds: ['turn-native-1', bStart.codexTurnId, cStart.codexTurnId],
      expiresAt: '2026-08-07T03:00:00.000Z', createdAt: admittedAt,
    })
    repository.activateManualCompactionDispatch({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      codexThreadId: 'thread-native-1', requestDigest: 'manual-safe-b-request', dispatchIntentAt: admittedAt })
    repository.markManualCompactionWriteAttempted({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', attemptedAt: admittedAt })
    repository.markManualCompactionWriteConfirmed({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', childWriteDigest: 'manual-safe-b-request', confirmedAt: admittedAt })
    repository.consumeManualCompaction({ manualCompactionId: 'manual-safe-b', codexCompactionTurnId: 'compact-safe-b',
      notificationContextCompactionItemId: 'compact-safe-b-item', contextCompactionItemId: 'compact-safe-b-item',
      threadReadDigest: 'compacted-safe-b-read', terminalEvidenceDigest: 'compact-terminal',
      gatewayRequestReceiptId: 'compact-request', gatewayRequestEvidenceDigest: 'compact-request-evidence',
      gatewayResponseEvidenceDigest: 'compact-response-evidence', consumedAt: admittedAt })
    const projected = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.equal(projected.availability, 'not_applicable')
    assert.deepEqual(projected.blockers, ['compacted_failed_turn_restatement_required'])
    assert.deepEqual(repository.readHandoffUncommittedUserTail('thread-binding-1'), [])
    assert.equal(repository.readTerminalCloseoutEvidence(b.runId)!.terminalFacts.history.kind, 'continuation_safe')
  })
})


test('fork inherits compacted facts before and after bind', async (t) => {
  await withRepository(t, (db, repository) => {
    const { b, bStart } = prepareRetainedFailureFixture(db, repository)

    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['same_thread_failed_turn_restatement_required'])
    const route = repository.readManualCompactionRoute({ aliasId: 'scope-1', aliasGeneration: 1 })!
    const providerSnapshot = defaultThreadProfile.snapshot
    repository.beginManualCompaction({
      ...route, manualCompactionId: 'manual-safe-b', ownerMainBootId: 'main-boot-1',
      providerSnapshot, credentialReferenceId: providerSnapshot.credentialReferenceId,
      expectedToolsDigest: digestCanonicalJson([]), preDispatchThreadReadDigest: 'safe-b-read',
      preDispatchTurnIds: ['turn-native-1', bStart.codexTurnId],
      expiresAt: '2026-08-07T03:00:00.000Z', createdAt: admittedAt,
    })
    repository.activateManualCompactionDispatch({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      codexThreadId: 'thread-native-1', requestDigest: 'manual-safe-b-request', dispatchIntentAt: admittedAt })
    repository.markManualCompactionWriteAttempted({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', attemptedAt: admittedAt })
    repository.markManualCompactionWriteConfirmed({ connectionEpoch: 'manual-safe-b-epoch', rpcId: 1,
      manualCompactionId: 'manual-safe-b', childWriteDigest: 'manual-safe-b-request', confirmedAt: admittedAt })
    repository.consumeManualCompaction({ manualCompactionId: 'manual-safe-b', codexCompactionTurnId: 'compact-safe-b',
      notificationContextCompactionItemId: 'compact-safe-b-item', contextCompactionItemId: 'compact-safe-b-item',
      threadReadDigest: 'compacted-safe-b-read', terminalEvidenceDigest: 'compact-terminal',
      gatewayRequestReceiptId: 'compact-request', gatewayRequestEvidenceDigest: 'compact-request-evidence',
      gatewayResponseEvidenceDigest: 'compact-response-evidence', consumedAt: admittedAt })

    const c = prepared('run-accepted-c')
    const cStart = admitStartedExistingTurn(db, repository, c)
    const productTerminalDigest = recordCompletedTerminal(db, repository, c.runId, cStart.codexTurnId)
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE task_id = ?`).run(c.taskId)
    repository.completeProductTurnCloseout({
      readyRunId: c.runId, productTerminalDigest, closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(repository, c.runId, ['turn-native-1', bStart.codexTurnId, 'compact-safe-b']),
    })
    const projected = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.equal(repository.readAcceptedNativePrefixHead('thread-binding-1')!.acceptedNativeHeadKind, 'turn')
    assert.equal(projected.availability, 'not_applicable')
    assert.deepEqual(projected.blockers, ['compacted_failed_turn_restatement_required'])
    assert.deepEqual(repository.readHandoffUncommittedUserTail('thread-binding-1'), [])
    assert.equal(repository.readTerminalCloseoutEvidence(b.runId)!.terminalFacts.history.kind, 'continuation_safe')

    const d = prepared('run-diverged-d')
    const dStart = admitStartedExistingTurn(db, repository, d)
    const dCandidate = { ...nativeFailureCandidate(d, 'failed'), codexTurnId: dStart.codexTurnId }
    const dReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: d.runId, codexThreadId: dCandidate.codexThreadId, codexTurnId: dCandidate.codexTurnId,
      engineOutcome: 'failed', candidate: dCandidate, recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(d.taskId)
    const result = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: d.runId, closeoutAt: admittedAt,
      productTerminalDigest: insertFailureTerminalMessage(db, d, '本轮未能完成。', 'blocked_external'),
      terminalEvidence: terminalCloseoutEvidence(d, dCandidate, dReceipt, undefined,
        ['turn-native-1', bStart.codexTurnId, 'compact-safe-b', cStart.codexTurnId]),
      forkSeed: { targetCwd: '/tmp/ready-codex/review-fork-after-compact', reservationSetId: 'review-fork', reservationId: 'review-fork-member', reservationEvidenceDigest: 'review-fork-evidence' },
    })
    db.exec('COMMIT')
    const targetId = result.forkTargetThreadBindingId!
    assert.ok(targetId)
    assert.equal(repository.readProductTurnActionContext(b.runId)!.sourceRootCompacted, true)
    const beforeBind = repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task
    assert.deepEqual(beforeBind.blockers, ['compacted_failed_turn_restatement_required'])
    repository.activateStartDispatch({ connectionEpoch: 'review-fork-epoch', rpcId: 1, method: 'thread/fork',
      bindingLookupKey: targetId, requestDigest: 'review-fork-request', dispatchedAt: admittedAt })
    repository.markStartChildWriteConfirmed({ connectionEpoch: 'review-fork-epoch', rpcId: 1, method: 'thread/fork',
      bindingId: targetId, childWriteDigest: 'review-fork-request', confirmedAt: admittedAt })
    const child = { ...rootThread(), id: 'review-fork-child', sessionId: 'review-fork-child', forkedFromId: 'thread-native-1',
      cwd: '/tmp/ready-codex/review-fork-after-compact',
      turns: ['turn-native-1', bStart.codexTurnId, 'compact-safe-b', cStart.codexTurnId]
        .map((id) => ({ id, status: 'completed', error: null, items: [] })) }
    repository.reconcileStartAccepted({ connectionEpoch: 'review-fork-epoch', rpcId: 1, method: 'thread/fork',
      bindingId: targetId, nativeId: child.id, responseDigest: 'review-fork-result', responsePending: false, reconciledAt: admittedAt,
      nativeResult: { thread: child, cwd: child.cwd, model: 'ready-e0-model', modelProvider: 'ready_gateway',
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null, serviceTier: null, instructionSources: [] } })
    assert.equal(repository.readProductTurnActionContext(b.runId)!.sourceRootCompacted, true)
    assert.deepEqual(repository.readProductTurnPresentation(b.runId).actionProjection.retry_failed_task.blockers,
      ['compacted_failed_turn_restatement_required'])
    assert.equal(repository.readProductTurnPresentation(d.runId).actionProjection.retry_failed_task.availability, 'ready')
  })
})

// P1-3: the one seam the split fixtures never joined — a production `prepareIngress`
// result admitted by the REAL repository on a REAL fresh_root_with_tail head, then
// dispatched natively and read back by a reopened repository. No stub repository and
// no hand-built prepare.
//
// Scope this test does NOT claim: there is no real gateway/provider hop. The
// provider leg stays covered separately by `probe-codex-runtime-continuity.mjs`.
test('production ingress admits a real fresh-root tail, closes it out and continues after restart', async (t) => {
  await withRepository(t, async (db, repository) => {
    const productionAssetRoot = fileURLToPath(new URL('../../assets/codex-runtime', import.meta.url))
    // The seeded head must be one this build could itself have written: same
    // instruction contract and a cwd that still exists. Anything else is a real
    // requires-new-context, not something the fixture may paper over.
    const productionInstruction = resolveCodexThreadInstructionContract({
      assetRoot: productionAssetRoot, host: null, skillAuthorization: { mode: 'none' },
    })
    // The fixture's dispatch lookup key is its default cwd, so make that path
    // reachable rather than relocating the binding.
    const seededCwd = '/tmp/ready-codex/thread-binding-1'
    const seededCwdExisted = existsSync(seededCwd)
    if (!seededCwdExisted) mkdirSync(seededCwd, { recursive: true })
    t.after(() => { if (!seededCwdExisted) rmSync(seededCwd, { recursive: true, force: true }) })
    const { run } = preparePublicationRecoveryFixture(db, repository, {
      runId: 'run-production-fresh-root',
      admissionOverrides: {
        instructionContractDigest: productionInstruction.instructionContractDigest,
      },
    })
    const candidate = nativeFailureCandidate(run, 'failed')
    const engineReceipt = repository.recordEngineTerminalCandidate({
      readyRunId: run.runId,
      codexThreadId: candidate.codexThreadId,
      codexTurnId: candidate.codexTurnId,
      engineOutcome: candidate.engineOutcome,
      candidate,
      recordedAt: admittedAt,
    })
    db.exec('BEGIN IMMEDIATE')
    db.prepare(`UPDATE task_projections SET status = 'failed' WHERE task_id = ?`).run(run.taskId)
    const productTerminalDigest = insertFailureTerminalMessage(db, run, '本轮未能完成。', 'blocked_external')
    const closeout = repository.completePublicationDivergenceCloseoutInOpenTransaction({
      readyRunId: run.runId,
      productTerminalDigest,
      closeoutAt: admittedAt,
      terminalEvidence: terminalCloseoutEvidence(run, candidate, engineReceipt),
    })
    db.exec('COMMIT')

    const head = repository.readActiveAliasBinding('scope-1')
    assert.equal(head?.materializationKind, 'fresh_root_with_tail')
    assert.equal(head?.codexThreadId, null)
    const tail = repository.readLiveUncommittedUserTail(head!.threadBindingId)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].policy, 'untrusted_text_history')

    const output = mkdtempSync(join(tmpdir(), 'ready-production-fresh-root-'))
    t.after(() => rmSync(output, { recursive: true, force: true }))
    const writes = { count: 0 }
    const database = {
      getRawDb: () => db,
      addChatMessage(id: string, scopeId: string, role: string, content: string,
        timestamp: string, meta: object, epoch: number) {
        writes.count += 1
        db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, scopeId, role, content, timestamp, JSON.stringify(meta), epoch)
      },
    }
    const scope = {
      id: 'scope-1', aliasGeneration: head!.aliasGeneration, messageVisibilityEpoch: 0,
      agent: 'butler', activeAgentId: 'butler', sourceKind: 'local', meta: {},
    }
    const host = {
      getScope: () => scope,
      runtime: { async resolveTrustedRequestEnvironment() { return { workbenchMode: 'browser' } } },
      resolveSkillAuthorizationForTurn: () => buildExplicitNoSkillAuthorization('no_skill_signal'),
      resolveToolTurnSnapshot: (value: {
        authorizationId: string
        authorization: ReturnType<typeof buildExplicitNoSkillAuthorization>
      }) => ({
        readyToolSurface: run.readyToolSurface,
        readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
          ...value, toolSurface: run.readyToolSurface,
        }),
      }),
      async createInitialExecutionBinding(value: { runId: string }) {
        return { schemaVersion: 1 as const, runId: value.runId }
      },
      // Real parent rows: the production path and every later readback expect a
      // projection and run-meta row to exist for the admitted run.
      getTaskProjectionStore: () => ({
        create(value: { taskId: string; runId: string; scopeId: string; executionBinding: unknown }) {
          writes.count += 1
          db.prepare(`INSERT INTO task_projections (task_id, run_id, scope_id, status, execution_binding_json, message_visibility_epoch)
            VALUES (?, ?, ?, 'running', ?, 0)`)
            .run(value.taskId, value.runId, value.scopeId, JSON.stringify(value.executionBinding))
        },
      }),
      createCodexActiveRunMetaInOpenTransaction(value: {
        runId: string; taskId: string; scopeId: string; executionBinding: unknown
      }) {
        writes.count += 1
        db.prepare(`INSERT INTO run_meta (run_id, task_id, scope_id, status, execution_binding_json, message_visibility_epoch)
          VALUES (?, ?, ?, 'running', ?, 0)`)
          .run(value.runId, value.taskId, value.scopeId, JSON.stringify(value.executionBinding))
      },
    }
    const buildPorts = (activeRepository: CodexBindingRepository) => createCodexProductionPorts({
      input: {
        database,
        settings: {
          getAIWorkspace: () => ({ profiles: [{ id: 'profile-test-default', config: productionProfileConfig }] }),
          getActiveAIProfileId: () => 'profile-test-default',
        },
        providerReadiness: { async ensureReady() {} },
      },
      host,
      repository: activeRepository,
      rawDb: db,
      resolveHeadContinuation: () => null,
      issueBeginNewContextAction: (action: { scopeId: string; scopeEpoch: number
        candidateEvidenceDigest: string; consequenceDigest: string; draftRevision: number | null }) => {
        const unsigned = {
          contract: 'codex_begin_new_context_action_v1' as const,
          operationId: `begin-context-${action.candidateEvidenceDigest}`,
          scopeId: action.scopeId, scopeEpoch: action.scopeEpoch,
          sourceThreadBindingId: head!.threadBindingId, sourceAliasGeneration: head!.aliasGeneration,
          sourceRevision: 1, sourceEvidenceDigest: '5'.repeat(64),
          candidateEvidenceDigest: action.candidateEvidenceDigest,
          consequenceDigest: action.consequenceDigest, draftRevision: action.draftRevision,
        }
        return { ...unsigned, digest: digestCanonicalJson(unsigned) }
      },
      verified: {
        manifestDigest: testRuntimeManifestDigest,
        manifest: { stableV2SchemaSha256: 'protocol-schema-digest' },
        assetRoot: productionAssetRoot,
      },
      gate: { assertOpen() {} },
      state: { threadCwdRoot: output },
      preparer: new CodexProductRunPreparer(),
      preparedDetails: new Map(),
      detailPrepared: new Map(),
      registry: new CodexStartIdentityRegistry({ capacity: 8 }),
      readyMemoryRepository: new ReadyMemoryRepository(db as unknown as DatabaseConnection),
      gatewayRepository: new CodexModelGatewayRepository(db as unknown as DatabaseConnection, activeRepository),
      ownerMainBootId: 'fresh-root-boot',
      nativeRuntime: { async threadRead() { throw new Error('unexpected_native_read') } },
    })

    const sendOnce = async (
      ports: Awaited<ReturnType<typeof buildPorts>>,
      activeRepositoryForSend: CodexBindingRepository,
      requestId: string,
      text: string,
    ) => {
      const activeHead = projectCodexHeadActionProjection(activeRepositoryForSend.readHeadActionFacts({
        aliasId: 'scope-1',
        aliasGeneration: activeRepositoryForSend.readActiveAliasBinding('scope-1')!.aliasGeneration,
        currentRuntimeManifestDigest: testRuntimeManifestDigest,
        currentProtocolSchemaDigest: 'protocol-schema-digest',
      }))
      assert.equal(activeHead.actions.send_new_message.availability, 'ready',
        JSON.stringify(activeHead.actions.send_new_message.blockers))
      const request = {
        scopeId: 'scope-1', requestId, message: text,
        expectedMessageVisibilityEpoch: 0,
        actionAdmissionRef: {
          headProjectionDigest: activeHead.evidenceDigest,
          actionProjectionVersion: activeHead.actionProjectionVersion,
          actionHeadIdentity: activeHead.actionHeadIdentity!,
        },
        userMessage: {
          id: `message-${requestId}`, content: text, timestamp: admittedAt,
          meta: { sourceKind: 'local', sourceId: 'app', threadKey: 'scope-1', direction: 'local-input', workbenchMode: 'browser' },
          attachmentConfirmation: { selectedCount: 0, metadataCount: 0, inputIncludedCount: 0, inputFailedCount: 0 },
        },
      }
      const methods = ports.startIdentityPort.resolveMethods('scope-1', 'browser')
      const reserved = await ports.startIdentityPort.reserve({
        scopeId: 'scope-1', requestId, methods,
      } as never)
      assert.equal(reserved.ok, true, JSON.stringify(reserved))
      if (!reserved.ok) throw new Error('reservation_failed')
      const preparedResult = await ports.ingressPort.prepareIngress({
        scope: scope as never, request: request as never, reservation: reserved.reservation,
      })
      assert.equal(preparedResult.ok, true, JSON.stringify(preparedResult).slice(0, 300))
      if (!preparedResult.ok) throw new Error(preparedResult.error)
      const persisted = await ports.ingressPort.persistIngressAtomic({
        scope: scope as never, request: request as never,
        reservation: reserved.reservation, prepared: preparedResult.dispatchContext,
      })
      return { prepared: preparedResult.dispatchContext, persisted }
    }

    // First ordinary turn on the fresh root: the production prepare carries the tail
    // assignment, and the REAL repository admission accepts it.
    const first = await sendOnce(await buildPorts(repository), repository, 'request-fresh-root-1', '继续讲这本书')
    assert.equal(first.prepared.ingress.attemptKind, 'user_ingress')
    assert.deepEqual(
      first.prepared.ingress.uncommittedTailAssignments,
      [{
        originUserMessageId: tail[0].originUserMessageId,
        inputDigest: tail[0].inputDigest,
        plan: 'deliver_untrusted_history',
      }],
      'the failed first-turn text is delivered exactly once as untrusted history',
    )
    const builtFirst = new CodexTurnInputBuilder().build(first.prepared.ingress, {
      threadId: 'thread-production-fresh-root', turnRequestId: 'turn-request-fresh-root-1',
      reasoningEffort: null, readyRunId: first.prepared.runId,
      toolSurfaceDigest: first.prepared.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: 'turn-contract-fresh-root-1',
      upstreamProfileSnapshotDigest: first.prepared.upstreamProfileSnapshotDigest
        ?? defaultThreadProfile.snapshotDigest,
      readyMemorySnapshot: first.prepared.readyMemorySnapshot,
    })
    assert.equal(builtFirst.ok, true, builtFirst.ok ? '' : builtFirst.code)
    if (!builtFirst.ok) throw new Error(builtFirst.code)
    // The current input appears exactly once, the delivered tail exactly once, and
    // nothing carries the retired thread's native prefix into the fresh root.
    assert.deepEqual(builtFirst.params.input, first.prepared.ingress.canonicalCurrentInputRef.input)
    const wire = JSON.stringify(builtFirst.params)
    assert.equal(wire.split('ready-uncommitted-user-tail').length - 1, 1)
    assert.doesNotMatch(wire, /thread-native-1|turn-native-1/)

    // Drive the real native start/turn dispatch for the admitted run so the
    // fresh root actually acquires its thread identity.
    const admittedCwd = db.prepare(`SELECT isolated_thread_cwd AS cwd FROM codex_thread_bindings WHERE thread_binding_id = ?`)
      .get<{ cwd: string | null }>(head!.threadBindingId)!.cwd!
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 20, method: 'thread/start',
      bindingLookupKey: admittedCwd, requestDigest: 'fresh-root-production-thread-request',
      dispatchedAt: admittedAt,
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 20, method: 'thread/start',
      bindingId: head!.threadBindingId, childWriteDigest: 'fresh-root-production-thread-request',
      confirmedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 20, method: 'thread/start',
      bindingId: head!.threadBindingId, nativeId: 'thread-production-fresh-root',
      nativeResult: {
        thread: {
          ...rootThread(), id: 'thread-production-fresh-root',
          sessionId: 'thread-production-fresh-root', cwd: admittedCwd,
        },
        instructionSources: [],
      },
      responseDigest: 'fresh-root-production-thread-response', responsePending: false,
      reconciledAt: admittedAt,
    })
    repository.activateStartDispatch({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 21, method: 'turn/start',
      bindingLookupKey: first.prepared.runId, requestDigest: 'fresh-root-production-turn-request',
      dispatchedAt: admittedAt,
    })
    repository.markStartChildWriteConfirmed({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 21, method: 'turn/start',
      bindingId: first.prepared.runId, childWriteDigest: 'fresh-root-production-turn-request',
      confirmedAt: admittedAt,
    })
    repository.reconcileStartAccepted({
      connectionEpoch: 'epoch-production-fresh-root', rpcId: 21, method: 'turn/start',
      bindingId: first.prepared.runId, nativeId: 'turn-production-fresh-root',
      nativeResult: { turn: { ...activeTurn(), id: 'turn-production-fresh-root' } },
      responseDigest: 'fresh-root-production-turn-response', responsePending: false,
      reconciledAt: admittedAt,
    })
    assert.deepEqual(repository.readUncommittedTailDeliveryAudit(first.prepared.runId).items, [{
      originUserMessageId: tail[0].originUserMessageId,
      inputDigest: tail[0].inputDigest,
      assignment: 'deliver_untrusted_history',
      disposition: 'additional_context',
    }], 'the seeded tail reaches the model exactly once, as untrusted history rather than current input')

    // Restart: a new repository instance over the same database must read the
    // committed run back and accept the next ordinary turn on the same head.
    const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection, testRuntimeContract)
    const runtimeAfterRestart = restarted.readProductTurnRuntime(first.prepared.runId)
    assert.equal(runtimeAfterRestart.readyRunId, first.prepared.runId)
    assert.equal(restarted.readActiveAliasBinding('scope-1')?.threadBindingId, head!.threadBindingId)
    // Delivery is not commitment: the item stays in the handoff tail until a
    // product closeout covers it, so a later fork still carries it. What must not
    // happen is a second delivery into the same native thread.
    assert.equal(restarted.readLiveUncommittedUserTail(head!.threadBindingId).length, 1,
      'an admitted-but-not-closed-out turn does not retire the handoff tail')

    // Before closeout the in-flight run holds the fence, so a reopened head
    // reports thread_busy rather than admitting a concurrent user run.
    const busyHead = projectCodexHeadActionProjection(restarted.readHeadActionFacts({
      aliasId: 'scope-1',
      aliasGeneration: restarted.readActiveAliasBinding('scope-1')!.aliasGeneration,
      currentRuntimeManifestDigest: testRuntimeManifestDigest,
      currentProtocolSchemaDigest: 'protocol-schema-digest',
    }))
    assert.deepEqual(busyHead.actions.send_new_message.blockers, ['thread_busy'])
    assert.equal(restarted.readActiveAliasBinding('scope-1')?.codexThreadId, 'thread-production-fresh-root',
      'the fresh root kept the native thread it acquired before the restart')

    // Close the first run out as an accepted product turn on the reopened
    // repository, then run the next ordinary turn: same scope, same native
    // thread, and the seeded tail is now covered rather than delivered again.
    const firstTerminalDigest = recordCompletedTerminal(
      db, restarted, first.prepared.runId, 'turn-production-fresh-root', [],
      'thread-production-fresh-root', first.prepared.taskId,
    )
    db.prepare(`UPDATE task_projections SET status = 'completed' WHERE run_id = ?`)
      .run(first.prepared.runId)
    restarted.completeProductTurnCloseout({
      readyRunId: first.prepared.runId,
      productTerminalDigest: firstTerminalDigest,
      closeoutAt: admittedAt,
      terminalEvidence: completedCloseoutEvidence(restarted, first.prepared.runId),
    })
    assert.equal(restarted.readLiveUncommittedUserTail(head!.threadBindingId).length, 0,
      'an accepted product closeout covers the delivered tail, so it is no longer live')

    // The discriminator split that broke the read paths in production: the head
    // keeps the `fresh_root_with_tail` kind forever, but the fresh-root
    // inheritance contract only describes the window before the inherited tail
    // was delivered. Anything that branches on the kind alone therefore calls
    // `resolveFreshRootInheritance` outside its window and gets an exception
    // instead of a continuation verdict — which is what left a settled
    // fresh-root head's closeout readback without a terminal. The live
    // predicate is `freshRootRequiresReseed`.
    assert.equal(restarted.readActiveAliasBinding('scope-1')?.materializationKind,
      'fresh_root_with_tail', 'the materialization kind is never rewritten')
    assert.equal(restarted.freshRootRequiresReseed(head!.threadBindingId), false,
      'the reseed window closes as soon as the delivered tail is covered')
    assert.throws(() => restarted.resolveFreshRootInheritance({
      threadBindingId: head!.threadBindingId,
      candidate: {
        model: 'ready-e0-model',
        threadConfig: resolveCodexNativeModelSettings(
          new CodexModelGatewayRepository(db as never)
            .readSnapshot('profile-ref-1', defaultThreadProfile.snapshotDigest),
        ).threadConfig,
        isolatedThreadCwd: admittedCwd,
        cwdAvailable: true,
        instructionContractDigest: productionInstruction.instructionContractDigest,
        currentToolSurface: run.readyToolSurface,
      },
    }), /fresh_root_reseed_not_required/,
    'calling the inheritance contract outside its window is an error, not a verdict')

    const second = await sendOnce(await buildPorts(restarted), restarted, 'request-fresh-root-2', '再补充一点')
    assert.deepEqual(second.prepared.ingress.uncommittedTailAssignments, [],
      'the covered tail is never delivered a second time')
    assert.notEqual(second.prepared.runId, first.prepared.runId)
    assert.equal(restarted.readActiveAliasBinding('scope-1')?.codexThreadId, 'thread-production-fresh-root',
      'the next ordinary turn continues the same native thread after restart')
  })
})
