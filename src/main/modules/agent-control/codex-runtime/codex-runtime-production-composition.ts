import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  readActionAuthorizationModeFromEnvelope,
} from '../../../../shared/action-authorization-mode'
import { persistableCalendarEventId } from '../../../../shared/calendar-event-identity'
import type { ProductTurnReceipt, SendScopedRequest } from '../../../../shared/ipc-contracts/agent-runtime'
import { classifyLifecycleOperation } from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { ExecutionHostResult, TaskProjectionRecord } from '../contracts/run-contracts'
import { classifyIntent } from '../intent-classifier'
import {
  classifyMapSemanticIntentFallback,
  isMapSemanticIntentActive,
} from '../map-semantic-intent'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from './codex-product-action-map'
import { createCodexProductActionRequester } from './codex-product-action-requester'
import { createProductionProductActionHandlers } from './codex-product-action-handlers'
import { composeCodexTurnToolSnapshot } from './codex-tool-surface-composition'
import {
  buildBrowserAdmissionAuthoritySnapshot,
  resolveBrowserExecutionPageRef,
} from './codex-browser-admission'
import { resolveReadyCapabilityTurnAvailability } from './codex-capability-turn-availability'
import { IngressPersistenceError, PrePersistenceAdmissionError, resolveAttachmentConfirmation } from '../send-scoped-confirmation'
import type { DatabaseManager } from '../../database'
import type { AppSettingsRepository } from '../../repositories/app-settings-repository'
import type {
  BrowserWorkflowVerifierBundle,
} from '../../repositories/agent-session-checkpoint-types'
import { logAgentMetric } from '../metrics'
import { readExistingTerminalQualityPatch } from '../runtime-core/run-finalizer-adjudication'
import { collectToolOutputProofs } from '../quality/proof-collector'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import {
  buildCodexIngressAdmittedDigest,
  CodexBindingRepository,
  type CodexHostFailureRecovery,
  type CodexBrowserVerifierAttemptRead,
  type CodexBrowserVerifierAttemptOutcome,
  type CodexBrowserVerifierVerdict,
  type CodexLifecycleAction, type CodexProductTurnRuntimeRead
} from './codex-binding-repository'
import { CodexDefaultBootRecoveryActions } from './codex-boot-recovery-actions'
import {
  verifyCodexAutomaticCompactionEvidence
} from './codex-automatic-compaction-evidence'
import { CodexModelGatewayRepository, CodexDatabaseModelGatewayAuthority, ReadySettingsModelGatewayCredentialStore } from './codex-model-gateway-authority'
import { digestCanonicalJson, digestReadyAdditionalContext, resolveCodexNativeModelSettings } from './codex-model-gateway-contract'
import { CodexModelGateway, type CodexModelGatewayAddress } from './codex-model-gateway'
import {
  assertCodexProfileRouteCurrent,
  createCodexProfileRouteSnapshot,
} from './codex-profile-admission'
import type { CodexTurn } from './codex-native-runtime'
import { StableNativeRuntime } from './codex-stable-native-runtime'
import { CodexProductRunPreparer, type PreparedCodexProductRun } from './codex-product-run-preparer'
import {
  classifyCodexProductRecoveryFailure,
  buildCodexProductReadbackCandidate,
  CodexProductBootRecovery,
  proveCodexStableStartAbsence,
  routeCodexBootRecoveryFailure,
} from './codex-product-boot-recovery'
import { CodexRuntimeBootReconciler } from './codex-runtime-boot-reconciler'
import type { CodexAliasBindingPort, CodexIngressPort, CodexPreparedRunContextPort, CodexRuntimeComposition, CodexRuntimeHostPort, CodexStartIdentityPort, ReadyClosedCodexProductRun } from './codex-runtime-composition'
import { activateCodexGatewaySpawnConfig, buildCodexChildEnvironment, loadVerifiedCodexRuntime, prepareCodexRuntimeState, resolveCodexRuntimePaths, type PreparedCodexRuntimeState } from './codex-runtime-host'
import { CodexSidecarSession } from './codex-sidecar-session'
import { CodexSidecarRecoveryOwner } from './codex-sidecar-recovery-owner'
import {
  CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT,
  CodexSidecarSupervisor,
  MacCodexProcessInspector,
  NodeCodexSidecarSpawnPort,
} from './codex-sidecar-supervisor'
import { type CodexStartIdentityRegistry } from './codex-start-identity-registry'
import { CodexLiveStartRejectionResolver } from './codex-live-start-rejection-resolver'
import { classifyCodexIngressPreparationError } from './codex-ingress-preparation-error'
import { listLiveCodexThreadToolDefinitions } from '../runtime-core/agent-sdk-tool-executor'
import {
  assertCodexPendingInteractionRestartSweepComplete,
  buildCodexPendingInteractionRestartCandidate,
  cancelCodexPendingInteractionsWithoutRunCloseout,
  completeCodexPendingInteractionRestartInOpenTransaction,
  scanCodexPendingInteractionsForRestart,
  settleCodexPendingInteractionsInMemoryAfterCommit,
  type CodexPendingInteractionRestartPlan,
} from './codex-pending-interaction-restart'
import type { CodexProviderReadinessPort } from './codex-provider-readiness'
import { CodexManualCompactionController } from './codex-manual-compaction-controller'
import {
  CodexDurableThreadArchiveDispatchPort,
  CodexThreadArchiveIntentStore,
} from './codex-thread-archive-cleanup'
import { CodexThreadArchiveCleanupOwner } from './codex-thread-archive-owner'
import { CodexToolActionJournal } from './codex-tool-action-journal'
import { CodexThreadResumeAuthority } from './codex-thread-resume-authority'
import { recoverCodexTerminalAfterInterrupt } from './codex-terminal-readback-recovery'
import { createCodexReadyToolBridge, CodexToolBridgeError } from './codex-tool-bridge'
import {
  digestCodexRootToolSurface,
} from './codex-tool-surface'
import { CodexTurnCollector, type CoreTurnCandidate } from './codex-turn-collector'
import { createCodexTaskActivityProjector } from './codex-task-activity-projector'
import { codexTerminalPublicMessage } from './codex-product-turn-presentation'
import { buildCodexExplicitRetryContext, CodexTurnInputBuilder } from './codex-turn-input-builder'
import {
  externalReadResourceReference,
  parseCodexExternalReadSliceRequest,
  readLarkCliAuthReadback,
} from './codex-external-read-slice'
import {
  ReadyCodexLifecycleAdapter,
  ReadyCodexLifecyclePortError,
  type ProductTurnCloseoutEvidence,
} from './ready-codex-lifecycle-adapter'
import { workflowDigest } from '../../repositories/browser-workflow-codec'
import {
  buildCodexThreadDeveloperInstructions,
} from './codex-thread-instructions'
import { createBrowserTurnLease, type BrowserTurnLease } from '../../browser-engine/agent-browser-turn-lease'
import {
  recoverCodexRetryLocalResourceSelections,
  recoverCodexRetrySkillSelection,
  resolveCodexExplicitResources,
} from './codex-explicit-resources'
import { resolveCodexExplicitRetryLineage } from './codex-explicit-retry-lineage'
import { resolveTrustedBrowserReference } from '../runtime-core/trusted-browser-environment'
import {
  codexBrowserVerifierFailureCode,
  codexBrowserVerifierFrozenIdentityDigest,
  verifyCodexBrowserWorkflowCandidate,
} from './codex-browser-workflow-verifier'

import {
  assertWidgetTargetsMatchAnchor,
  extractProductSurfaceTargets,
  sha256,
  trustedBrowserReferenceInput,
  trustedCalendarReferenceInput,
  trustedRssItemInput,
  trustedRssSourceInput,
  type CodexRendererToolActionRequester,
} from './codex-product-surface-ingress'
import {
  buildCodexEngineTerminalFinalizationKey,
  CodexCloseCandidateInFlightOwner,
  CodexProductCloseoutExpectationGuard,
  requestCodexEngineTerminalLifecycleActionBeforeCloseout,
  finalizeCodexProductCloseout,
  runCodexEngineTerminalFinalization,
  type CodexProductCloseoutMode,
} from './codex-product-closeout-support'
import {
  codexAllowsDirectProvisionalStream,
  createCodexProductUpstreamProfileSnapshot,
  createCurrentDocumentReadRequester,
  hasExplicitCurrentDocumentWriteIntent,
  readCodexPreparedActionAuthorizationEnvelope,
  resolveCodexBrowserWorkflowVerifierBundle,
  resolveCodexProductTurnAuthorization,
  resolveCodexThreadInstructionContract,
  resourceReferenceForAnchor,
  RuntimeGate,
  toCodexInput,
  toRunMessage,
} from './codex-product-turn-authorization'
import {
  createCodexProductBudgetSeed,
  resolveCodexBrowserWorkflowTaskFacts,
  resolveCodexProductCloseoutTaskFacts,
  resolveCodexProductTaskFacts,
} from './codex-product-task-facts'
import {
  createLifecycleStore,
  terminalEvent,
} from './codex-product-lifecycle-store'
import { ArtifactMaterializer } from '../../tools/artifact-materializer'
import { readCodexFolderOutputActivation } from './codex-folder-output-activation'
import {
  ReadyMemoryGenerationCoordinator,
  ReadyMemoryGenerationStore,
  ReadyMemoryIdleWorker,
  isReadyMemoryProductionIdle,
  ReadyMemoryProductionProvider,
  ReadyMemoryRepository,
  ReadyMemoryRuntimeService,
  ReadyMemorySqliteEvidenceLoader,
  READY_MEMORY_SEARCH_TOOL_NAME,
  readyMemoryPromptPayload,
} from '../ready-memory'

export type { CodexRendererToolActionRequester } from './codex-product-surface-ingress'
export type { CodexProductCloseoutMode } from './codex-product-closeout-support'
export {
  buildCodexEngineTerminalFinalizationKey,
  CodexCloseCandidateInFlightOwner,
  CodexProductCloseoutExpectationGuard,
  requestCodexEngineTerminalLifecycleActionBeforeCloseout,
  requestCodexEngineTerminalUserStopBeforeCloseout,
  runCodexEngineTerminalFinalization,
} from './codex-product-closeout-support'
export {
  buildCodexProductRequestEnvelope,
  buildCurrentDocumentReadToolSnapshot,
  buildExplicitResourceReadToolSnapshot,
  buildExternalReadToolSnapshot,
  codexAllowsDirectProvisionalStream,
  createCodexProductUpstreamProfileSnapshot,
  createCurrentDocumentReadRequester,
  hasExplicitCurrentDocumentWriteIntent,
  readCodexInstructionContractDigest,
  readCodexPreparedActionAuthorizationEnvelope,
  resolveCodexBrowserWorkflowVerifierBundle,
  resolveCodexProductTurnAuthorization,
  resolveCodexThreadInstructionContract,
  resourceReferenceForAnchor,
  RuntimeGate,
  toCodexInput,
  toRunMessage,
  validateCurrentDocumentReadPayload,
} from './codex-product-turn-authorization'
export { buildCodexThreadDeveloperInstructions, createCodexProductBudgetSeed }
export { retireCodexAliasForClose } from './codex-product-lifecycle-store'

function isoNow(): string {
  return new Date().toISOString()
}

function codexFailureDiagnostics(input: {
  error: string
  module: string
  verifierReceiptDigest?: string
}): Record<string, unknown> {
  return {
    provider: 'ready_gateway',
    agentProtocol: 'openai',
    wireApi: 'responses',
    codexFailure: {
      contract: 'codex_failure_evidence_v1',
      error: input.error,
      module: input.module,
      ...(input.verifierReceiptDigest
        ? { verifierReceiptDigest: input.verifierReceiptDigest }
        : {}),
    },
  }
}

type FactoryInput = {
  appPath: string
  resourcesPath: string
  userDataPath: string
  isPackaged: boolean
  database: DatabaseManager
  settings: AppSettingsRepository
  requestRendererToolAction: CodexRendererToolActionRequester
  providerReadiness: CodexProviderReadinessPort
}

type PreparedDetail = {
  preparedAtMs: number
  executionBinding: Awaited<ReturnType<CodexRuntimeHostPort['createInitialExecutionBinding']>>
  threadBindingId: string
  isolatedThreadCwd: string
  turnRequestId: string
  upstream: ReturnType<typeof createCodexProfileRouteSnapshot>
  developerInstructions: string
  instructionContractDigest: string
  turnContractDigest: string
  productTaskFacts: ReturnType<typeof resolveCodexProductTaskFacts>
}

function stableErrorCode(error: unknown, fallback: string): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[a-z0-9_:-]{1,96}$/i.test(candidate) ? candidate : fallback
}

function recoverableBrowserWorkflowCode(error: unknown): string | null {
  const code = error instanceof Error ? error.message : String(error)
  return code === 'codex_browser_workflow_observation_required'
    || code === 'codex_browser_workflow_action_in_flight'
    || code === 'codex_browser_workflow_research_incomplete'
    ? code
    : null
}

function codexBrowserVerifierBlockingVerdict(
  description: string,
  summary: string,
): CodexBrowserVerifierVerdict {
  return {
    version: 1,
    verdict: 'block',
    gaps: [{ kind: 'text', description }],
    summary,
  }
}

function codexBrowserVerifierIdentityDigest(input: {
  product: CodexProductTurnRuntimeRead
  workflowBundle: BrowserWorkflowVerifierBundle
  projection: TaskProjectionRecord
}): string {
  const { product, projection } = input
  return codexBrowserVerifierFrozenIdentityDigest({
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
    workflowBundle: input.workflowBundle,
    projection: {
      taskId: projection.taskId,
      runId: projection.runId,
      revision: projection.revision,
      requestAnchor: projection.requestAnchor,
      criteria: projection.criteria,
      modelCriteria: projection.modelCriteria,
      proofRefs: projection.proofRefs,
      recentArtifacts: projection.recentArtifacts,
      expectedOutputs: projection.expectedOutputs,
    },
  })
}

function codexBrowserVerifierOutcome(input: Awaited<
  ReturnType<typeof verifyCodexBrowserWorkflowCandidate>
>): CodexBrowserVerifierAttemptOutcome {
  if (input.verificationKind === 'invalid_output') return 'invalid'
  return input.verdict.verdict
}

function isAbortFailure(error: unknown, signal: AbortSignal | null): boolean {
  return Boolean(signal?.aborted)
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError')
    || (error instanceof Error && error.message === 'browser_verifier_settlement_interrupted')
}
function readE5ProofSentinels(): string[] {
  const raw = String(process.env.READY_CODEX_E5_PROOF_SENTINELS_JSON || '').trim()
  const values = raw
    ? JSON.parse(raw) as unknown
    : [String(process.env.READY_CODEX_E5_PROOF_SENTINEL || '')]
  if (!Array.isArray(values) || values.length < 1 || values.length > 4
    || values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 256)
    || new Set(values).size !== values.length) {
    throw new Error('codex_e5_proof_sentinels_invalid')
  }
  return values
}

function activeProfile(settings: AppSettingsRepository): { profileId: string; config: AIModelConfig } {
  const workspace = settings.getAIWorkspace()
  const profileId = settings.getActiveAIProfileId()
  const profile = profileId ? workspace.profiles.find((entry) => entry.id === profileId) : null
  if (!profile) throw new Error('codex_active_profile_missing')
  return { profileId: profileId as string, config: profile.config }
}

export function createCodexRuntimeComposition(input: FactoryInput): CodexRuntimeComposition {
  const rawDb = input.database.getRawDb()
  if (!rawDb) throw new Error('codex_database_unavailable')

  const paths = resolveCodexRuntimePaths(input)
  const verified = loadVerifiedCodexRuntime(paths)
  const repository = new CodexBindingRepository(rawDb)
  const readyMemoryRepository = new ReadyMemoryRepository(rawDb)
  const gatewayRepository = new CodexModelGatewayRepository(rawDb, repository)
  const credentialStore = new ReadySettingsModelGatewayCredentialStore(input.settings)
  const proofCaptureEnabled = /^[a-f0-9]{40,}$/i.test(
    String(process.env.READY_BROWSER_LIVE_PROOF_NONCE || ''),
  ) && process.env.READY_CODEX_E5_GATEWAY_CAPTURE === '1'
  const proofCapturePath = join(input.userDataPath, 'e5-gateway-capture.ndjson')
  const createGateway = () => new CodexModelGateway({
    spawnBound: true,
    authority: new CodexDatabaseModelGatewayAuthority(gatewayRepository),
    credentials: credentialStore,
    ...(proofCaptureEnabled ? {
      proofSentinels: readE5ProofSentinels(),
      onValidatedRequest(capture) {
        appendFileSync(proofCapturePath, `${JSON.stringify(capture)}\n`, { encoding: 'utf8' })
      },
    } : {}),
  })
  let gateway = createGateway()
  let gatewayAddress: CodexModelGatewayAddress | null = null
  let gatewayNeedsReplacement = false
  const gate = new RuntimeGate()
  const ownerMainBootId = randomUUID()
  const preparedDetails = new Map<string, PreparedDetail>()
  const detailPrepared = new Map<string, PreparedCodexProductRun>()
  const browserTurnLeases = new Map<string, BrowserTurnLease>()
  const currentDocumentExactReadRuns = new Set<string>()
  const artifactMaterializer = new ArtifactMaterializer(join(input.userDataPath, 'codex-artifacts'), {
    readStorageRetention: () => repository.readArtifactStorageRetention(),
  })
  const calendarListedEventIdsByRun = new Map<string, string[]>()
  const calendarNotifyReady = import('../../calendar-engine/ipc-handler')
    .then((module) => module.notifyCalendarEventChanged)
    .catch(() => null)
  const loadedThreads = new Set<string>()
  type PendingEngineTerminalFinalization = {
    identity: { aliasId: string; aliasGeneration: number }
    product: CodexProductTurnRuntimeRead
    terminal: ProductTurnCloseoutEvidence['terminal']
    productTerminalDigest: string
    closeoutAt: string
    recovered: ReadyClosedCodexProductRun
  }
  const pendingEngineTerminalFinalizations = new Map<string, PendingEngineTerminalFinalization>()
  const expectedCodexCloseouts = new CodexProductCloseoutExpectationGuard()
  const commitExpectedCodexCloseout = async <T>(
    readyRunId: string,
    mode: CodexProductCloseoutMode,
    commit: () => Promise<T>,
  ): Promise<T> => {
    const token = expectedCodexCloseouts.acquire(readyRunId, mode)
    try {
      return await commit()
    } finally {
      expectedCodexCloseouts.release(readyRunId, token)
    }
  }
  const commitExpectedCodexRecoveryFailure = async <T>(
    readyRunId: string,
    recoveryFailure: {
      code: string
      evidenceDigest: string
      pendingInteractionRestart?: CodexPendingInteractionRestartPlan | null
    },
    commit: () => Promise<T>,
  ): Promise<T> => {
    const token = expectedCodexCloseouts.acquireRecoveryFailure(readyRunId, recoveryFailure)
    try {
      return await commit()
    } finally {
      expectedCodexCloseouts.release(readyRunId, token)
    }
  }
  const releaseBrowserTurnLease = (readyRunId: string): void => {
    browserTurnLeases.get(readyRunId)?.release()
    browserTurnLeases.delete(readyRunId)
    currentDocumentExactReadRuns.delete(readyRunId)
  }
  let host: CodexRuntimeHostPort | null = null
  let state: PreparedCodexRuntimeState | null = null
  let supervisor: CodexSidecarSupervisor | null = null
  let sidecarSession: CodexSidecarSession | null = null
  let registry: CodexStartIdentityRegistry | null = null
  let productRecovery: CodexProductBootRecovery | null = null
  let bootOnceImplementation: (() => Promise<boolean>) | null = null
  let lifecycle: 'new' | 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped' | 'failed' = 'new'
  let bootGeneration = 0
  const memoryGenerationStore = new ReadyMemoryGenerationStore(rawDb)
  const memoryProvider = new ReadyMemoryProductionProvider({
    profiles: gatewayRepository,
    credentials: credentialStore,
  })
  const memoryCoordinator = new ReadyMemoryGenerationCoordinator({
    repository: readyMemoryRepository,
    store: memoryGenerationStore,
    provider: memoryProvider,
    evidenceLoader: new ReadyMemorySqliteEvidenceLoader(rawDb),
    workerId: `ready-memory-${ownerMainBootId}`,
    resolveProfile(now) {
      const profile = activeProfile(input.settings)
      const frozen = createCodexProductUpstreamProfileSnapshot(profile)
      gatewayRepository.storeSnapshot({ ...frozen, createdAt: now })
      return {
        model: frozen.snapshot.model,
        upstreamProfileSnapshotRef: frozen.snapshotRef,
        upstreamProfileSnapshotDigest: frozen.snapshotDigest,
      }
    },
    isIdle() {
      if (lifecycle !== 'running') return false
      return isReadyMemoryProductionIdle(rawDb)
    },
  })
  let memoryWorker: ReadyMemoryIdleWorker
  const memoryRuntime = new ReadyMemoryRuntimeService({
    db: rawDb,
    repository: readyMemoryRepository,
    coordinator: memoryCoordinator,
    automaticGenerationAvailable: memoryProvider.automaticGenerationAvailable,
    wakeWorker: () => memoryWorker.wake(),
  })
  memoryWorker = new ReadyMemoryIdleWorker({
    coordinator: memoryCoordinator,
    onError(error) {
      logAgentMetric('ready_memory_worker_failed', { error: stableErrorCode(error, 'unknown') })
    },
  })
  let settleLifecycleHostFailureCloseout: ((identity: {
    aliasId: string
    aliasGeneration: number
  }) => Promise<void>) | null = null
  let settleLifecycleEngineTerminalUserStop: ((identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>) | null = null
  let settleLifecycleReadbackTerminalUserStop: ((input: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
    codexThreadId: string
    turn: CodexTurn
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>) | null = null
  let retryLifecycleEngineTerminalUserStopFinalization: ((identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }) => Promise<ProductTurnCloseoutEvidence | null>) | null = null

  const threadArchiveStore = new CodexThreadArchiveIntentStore(rawDb)
  const threadArchiveDispatchPort = new CodexDurableThreadArchiveDispatchPort({
    store: threadArchiveStore,
    now: isoNow,
  })
  const nativeRuntime = new StableNativeRuntime(() => {
    if (!sidecarSession) throw new Error('codex_sidecar_session_unavailable')
    return sidecarSession.getClient()
  })
  const threadArchiveCleanup = new CodexThreadArchiveCleanupOwner({
    store: threadArchiveStore,
    runtime: nativeRuntime,
    getConnectionEpoch: () => {
      if (!sidecarSession) throw new Error('codex_sidecar_session_unavailable')
      return sidecarSession.getActiveConnectionEpoch()
    },
    now: isoNow,
  })
  const scheduleThreadArchiveCleanup = (): void => {
    queueMicrotask(() => {
      void threadArchiveCleanup.drain().catch((error: unknown) => {
        logAgentMetric('codex_thread_archive_cleanup_failed', {
          reason: stableErrorCode(error, 'thread_archive_failed'),
        })
      })
    })
  }
  const collector = new CodexTurnCollector(nativeRuntime)
  const manualCompactionController = new CodexManualCompactionController({
    repository,
    gatewayRepository,
    getSession: () => sidecarSession,
    ownerMainBootId,
    timeoutMs: 300_000,
    now: isoNow,
    nowMs: Date.now,
    onArchiveIntentReady() {
      scheduleThreadArchiveCleanup()
    },
    onRecoveryFailure({ manualCompactionId, reason }) {
      logAgentMetric('codex_manual_compaction_recovery_observer_failed', {
        manualCompactionId,
        reason,
      })
    },
  })
  const lifecycleStore = createLifecycleStore({
    repository,
    nativeRuntime,
    getHost: () => host,
    getRegistry: () => registry,
    scheduleThreadArchiveCleanup,
    sealClosedConversationInOpenTransaction(value) {
      memoryRuntime.sealClosedConversationInOpenTransaction(value)
    },
    getDeveloperInstructions(prepared) {
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || detailPrepared.get(prepared.runId) !== prepared) {
        throw new Error('codex_prepared_instructions_missing')
      }
      return detail.developerInstructions
    },
    getNativeModelSettings(prepared) {
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || detailPrepared.get(prepared.runId) !== prepared) {
        throw new Error('codex_prepared_model_settings_missing')
      }
      return resolveCodexNativeModelSettings(detail.upstream.snapshot)
    },
    settleHostFailureCloseout(identity) {
      if (!settleLifecycleHostFailureCloseout) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return settleLifecycleHostFailureCloseout(identity)
    },
    settleEngineTerminalUserStop(identity, action) {
      if (!settleLifecycleEngineTerminalUserStop) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return settleLifecycleEngineTerminalUserStop(identity, action)
    },
    settleReadbackTerminalUserStop(value, action) {
      if (!settleLifecycleReadbackTerminalUserStop) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return settleLifecycleReadbackTerminalUserStop(value, action)
    },
    retryEngineTerminalUserStopFinalization(identity) {
      if (!retryLifecycleEngineTerminalUserStopFinalization) return Promise.resolve(null)
      return retryLifecycleEngineTerminalUserStopFinalization(identity)
    },
    createAliasAtomic(value) {
      rawDb.exec('BEGIN IMMEDIATE')
      try {
        const scope = input.database.upsertConversationScope({
          id: value.aliasId,
          agent: value.agentId,
          activeAgentId: value.agentId,
          userId: 'default-user',
          title: '新对话',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: value.aliasId,
          meta: { sourceLabel: '应用内', createdBy: 'app' },
        })
        if (scope.mode !== 'inserted' || scope.row.id !== value.aliasId) {
          throw new Error('codex_created_scope_identity_mismatch')
        }
        readyMemoryRepository.setConversationContribution({
          conversationId: scope.row.id,
          contributeToMemories: true,
          updatedAt: value.persistedAt,
        })
        const created = repository.createEmptyAliasGenerationInOpenTransaction({
          threadBindingId: `codex-thread-${sha256(`${value.aliasId}\u00001`).slice(0, 32)}`,
          aliasId: value.aliasId,
          aliasGeneration: 1,
          readyScopeId: scope.row.id,
          runtimeManifestDigest: verified.manifestDigest,
          protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
          createdAt: value.persistedAt,
        })
        const readback = repository.readActiveAliasBinding(value.aliasId)
        if (!readback || readback.threadBindingId !== created.threadBindingId
          || readback.aliasGeneration !== 1 || readback.readyScopeId !== scope.row.id
          || readback.codexThreadId !== null || readback.retiredAt !== null) {
          throw new Error('codex_created_alias_readback_mismatch')
        }
        rawDb.exec('COMMIT')
      } catch (error) {
        if (rawDb.inTransaction) rawDb.exec('ROLLBACK')
        throw error
      }
    },
    loadedThreads,
    getActiveConnectionEpoch() {
      if (!sidecarSession) throw new Error('codex_sidecar_session_unavailable')
      return sidecarSession.getActiveConnectionEpoch()
    },
    manualCompactionController,
  })

  const participant = {
    complete(closeout: { readyRunId: string; productTerminalDigest: string; closeoutAt: string }) {
      const product = repository.readProductTurnRuntime(closeout.readyRunId)
      const snapshot = product.prepared.readyMemorySnapshot
      const readEntryIds = repository.readPublishedToolOutputs(closeout.readyRunId)
        .filter((output) => output.toolName === READY_MEMORY_SEARCH_TOOL_NAME)
        .flatMap((output) => {
          const data = output.output.data
          if (!data || data.snapshotDigest !== snapshot.snapshotDigest
            || !Array.isArray(data.readEntryIds)
            || data.readEntryIds.some((entryId) => typeof entryId !== 'string' || !entryId)) {
            throw new Error('ready_memory_published_read_invalid')
          }
          return data.readEntryIds as string[]
        })
      const readReceipt = readyMemoryRepository.createReadReceipt(
        snapshot,
        readEntryIds,
        closeout.closeoutAt,
      )
      readyMemoryRepository.recordReadReceiptForTurn(
        closeout.readyRunId,
        snapshot,
        readReceipt,
        closeout.closeoutAt,
      )
      scheduleThreadArchiveCleanup()
      const expected = expectedCodexCloseouts.readMode(closeout.readyRunId)
      if (!expected) {
        repository.completeCanonicalProductCloseoutInOpenTransaction(closeout)
        return
      }
      if (expected === 'recovery_failure') {
        const failure = expectedCodexCloseouts.readRecoveryFailure(closeout.readyRunId)
        if (!failure) throw new Error('codex_recovery_failure_expectation_missing')
        const result = repository.completeRecoveryFailureCloseoutInOpenTransaction({
          ...closeout,
          recoveryFailureCode: failure.code,
          recoveryFailureEvidenceDigest: failure.evidenceDigest,
        })
        if (!result.handled) throw new Error('codex_canonical_closeout_binding_missing')
        if (failure.pendingInteractionRestart) {
          completeCodexPendingInteractionRestartInOpenTransaction({
            db: rawDb,
            plan: failure.pendingInteractionRestart,
            readyRunId: closeout.readyRunId,
            closeoutAt: closeout.closeoutAt,
            recoveryEvidenceDigest: failure.evidenceDigest,
          })
        }
        return
      }
      if (expected === 'lifecycle_stop'
        || expected === 'lifecycle_close'
        || expected === 'lifecycle_reset') {
        const action = expected.slice('lifecycle_'.length) as CodexLifecycleAction
        const result = repository.completeLifecycleActionCloseoutInOpenTransaction({
          ...closeout,
          action,
        })
        if (!result.handled) throw new Error('codex_lifecycle_action_closeout_binding_missing')
        if (action === 'close') {
          memoryRuntime.sealClosedConversationInOpenTransaction({
            conversationId: product.prepared.readyToolHostIdentity.scopeId,
            closedAt: closeout.closeoutAt,
          })
        }
        return
      }
      if (expected === 'verifier_rejected') {
        const result = repository.completeVerifierRejectedCloseoutInOpenTransaction(closeout)
        if (!result.handled) throw new Error('codex_verifier_rejected_closeout_binding_missing')
        return
      }
      if (expected === 'verifier_accepted') {
        const result = repository.completeVerifierAcceptedCloseoutInOpenTransaction(closeout)
        if (!result.handled) throw new Error('codex_verifier_accepted_closeout_binding_missing')
        return
      }
      const result = expected === 'publication_diverged'
        ? repository.completePublicationDivergenceCloseoutInOpenTransaction(closeout)
        : repository.completeCanonicalProductCloseoutInOpenTransaction(closeout)
      if (!result.handled) throw new Error('codex_canonical_closeout_binding_missing')
    },
  }

  type HostFailureSettlement = {
    readyRunId: string
    reservationSetId: string
    productTerminalDigest: string
    closeoutAt: string
    result: ReadyClosedCodexProductRun
  }

  const releaseHostFailureReservationIfPresent = (
    activeRegistry: CodexStartIdentityRegistry | null,
    settlement: HostFailureSettlement,
  ): void => {
    if (!activeRegistry?.snapshot().members.some(
      (member) => member.reservationSetId === settlement.reservationSetId,
    )) return
    activeRegistry.releaseAfterHostFailure({
      reservationSetId: settlement.reservationSetId,
      productTerminalDigest: settlement.productTerminalDigest,
    })
  }

  const readProductTaskFacts = (
    boundHost: CodexRuntimeHostPort,
    product: CodexProductTurnRuntimeRead,
  ): Pick<TaskProjectionRecord, 'taskType' | 'module'> => {
    const projection = boundHost.getTaskProjectionStore().get(product.readyTaskId)
    if (!projection || projection.runId !== product.readyRunId) {
      throw new Error('codex_product_task_projection_missing')
    }
    const facts = { taskType: projection.taskType, module: projection.module }
    if (
      facts.taskType !== 'direct_answer'
      || facts.module !== 'system'
      || !product.prepared.outputContract
    ) return facts
    return resolveCodexProductCloseoutTaskFacts(
      { taskType: facts.taskType, module: 'system' },
      readCodexFolderOutputActivation(rawDb, product.readyRunId),
    )
  }

  const closePersistedHostFailure = async (
    failure: CodexHostFailureRecovery,
  ): Promise<HostFailureSettlement> => {
    const fence = repository.readRecoverySnapshot(
      (epoch) => sidecarSession?.isConnectionLive(epoch) || false,
    ).productFences.find((entry) => entry.readyRunId === failure.readyRunId)
    if (fence && fence.ownerMainBootId !== ownerMainBootId) {
      repository.claimProductFenceForBoot({
        threadBindingId: fence.threadBindingId,
        readyRunId: fence.readyRunId,
        expectedOwnerMainBootId: fence.ownerMainBootId,
        newOwnerMainBootId: ownerMainBootId,
        claimedAt: isoNow(),
      })
    }
    const product = repository.readProductTurnRuntime(failure.readyRunId)
    const boundHost = host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new Error('codex_host_failure_scope_missing')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const failureError = 'codex_start_delivery_failed'
    const committed = await boundHost.commitCodexProductTurnCloseout({
      parentTaskId: product.readyTaskId,
      ownerRunId: product.readyRunId,
      conversationId: product.readyScopeId,
      status: 'error',
      terminalReason: 'persistence_failed',
      initiator: 'codex_host_failure_recovery',
      durationMs: 0,
      ...taskFacts,
      finalText: codexTerminalPublicMessage('error'),
      providerDiagnostics: codexFailureDiagnostics({ error: failureError, module: taskFacts.module }),
      now: isoNow(),
    })
    const completed = repository.completeHostFailureCloseout({
      readyRunId: product.readyRunId,
      productTerminalDigest: committed.productTerminalDigest,
      continuationBlockedReason: failure.continuationBlockedReason,
      closeoutAt: committed.closeoutAt,
    })
    if (completed.reservationSetId !== failure.reservationSetId) {
      throw new Error('codex_host_failure_reservation_set_mismatch')
    }
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout
      || productCloseout.productTerminalDigest !== committed.productTerminalDigest
      || productCloseout.productCloseoutAt !== committed.closeoutAt) {
      throw new Error('codex_host_failure_closeout_readback_missing')
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: false,
      usedTools: [],
      error: 'codex_start_delivery_failed',
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: 'persistence_failed',
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    return {
      readyRunId: product.readyRunId,
      reservationSetId: completed.reservationSetId,
      productTerminalDigest: productCloseout.productTerminalDigest,
      closeoutAt: productCloseout.productCloseoutAt,
      result: {
        execution,
        productOutcomeDigest: productCloseout.productTerminalDigest,
        candidateBodyDigest: null,
        committedTerminalEvent: terminalEvent({
          scope,
          product,
          execution,
          terminalAt: productCloseout.productCloseoutAt,
        }),
      },
    }
  }

  const readAlreadyCommittedCloseout = (
    product: CodexProductTurnRuntimeRead,
    candidate: CoreTurnCandidate,
  ): ReadyClosedCodexProductRun | null => {
    const committedCloseout = repository.readProductCloseout(product.readyRunId)
    if (!committedCloseout) return null
    const boundHost = host
    if (!boundHost) throw new Error('codex_runtime_host_unbound')
    const scope = boundHost.getScope(product.readyScopeId)
    if (!scope) throw new Error('codex_scope_missing_during_closeout')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const receipt = repository.readProductTurnPresentation(product.readyRunId)
    const successful = receipt.terminal === 'done'
    const cancelled = receipt.terminal === 'cancelled' || receipt.terminal === 'interrupted'
    const execution: ExecutionHostResult = {
      success: successful,
      finalText: receipt.canonicalMessage.content,
      cancelled,
      usedTools: receipt.tools.map((tool) => tool.toolName),
      ...(successful ? {} : { error: receipt.failure?.kind || 'unknown' }),
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: successful ? 'running' : 'suspended',
      terminalReason: successful ? 'done' : cancelled ? 'cancelled_user' : 'persistence_failed',
      canonicalMessage: receipt.canonicalMessage,
      canonicalMessageDigest: receipt.canonicalMessageDigest,
      productTurnReceipt: receipt,
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    return {
      execution,
      productOutcomeDigest: committedCloseout.productTerminalDigest,
      candidateBodyDigest: candidate.kind === 'native_terminal' ? candidate.candidateDigest : null,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: committedCloseout.productCloseoutAt,
      }),
    }
  }

  const closeCandidateOwned = async (candidate: CoreTurnCandidate): Promise<ReadyClosedCodexProductRun> => {
    let publicationReceiptRefs: string[] = []
    let publicationDiverged = false
    let publicationDivergenceKind: 'diverged' | null = null
    let lifecycleAction: ReturnType<CodexBindingRepository['readProductLifecycleAction']> = null
    const product = repository.readProductTurnRuntime(candidate.readyRunId)
    if (candidate.readyTaskId !== product.readyTaskId
      || candidate.scopeId !== product.readyScopeId
      || (candidate.codexThreadId && candidate.codexThreadId !== product.codexThreadId)
      || (candidate.codexTurnId && candidate.codexTurnId !== product.codexTurnId)) {
      throw new Error('codex_candidate_durable_identity_mismatch')
    }
    const alreadyCommitted = readAlreadyCommittedCloseout(product, candidate)
    if (alreadyCommitted) {
      releaseBrowserTurnLease(product.readyRunId)
      return alreadyCommitted
    }
    releaseBrowserTurnLease(product.readyRunId)
    if (candidate.kind === 'native_terminal') {
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
      if (!lifecycleAction && candidate.engineOutcome === 'completed') {
        try {
          const readback = await nativeRuntime.threadRead({
            threadId: candidate.codexThreadId,
            includeTurns: true,
          })
          const automaticCompactionEvidence = verifyCodexAutomaticCompactionEvidence({
            gatewayRepository,
            readyRunId: product.readyRunId,
            codexThreadId: candidate.codexThreadId,
            codexTurnId: candidate.codexTurnId,
            upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
            productToolSurfaceDigest: product.toolSurfaceDigest,
            thread: readback.thread,
          })
          candidate.contextState = {
            ...candidate.contextState,
            automaticCompactionExchanges: automaticCompactionEvidence
              ? [automaticCompactionEvidence]
              : [],
          }
        } catch (error) {
          lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
          if (!lifecycleAction) throw error
        }
      }
      repository.recordEngineTerminalCandidate({
        readyRunId: candidate.readyRunId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        engineOutcome: candidate.engineOutcome,
        candidate,
        recordedAt: isoNow(),
      })
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
      const publication = repository.readToolPublicationBarrier({
        readyRunId: candidate.readyRunId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        candidateCalls: candidate.usedToolCalls,
        effectSettlementOnly: lifecycleAction !== null,
      })
      if (publication.kind === 'accepted') {
        if (!lifecycleAction) {
          publicationReceiptRefs = repository.recordToolPublicationReceipt({
            readyRunId: candidate.readyRunId,
            recordedAt: isoNow(),
          }).verifiedReceiptRefs
        }
      } else if (publication.kind === 'diverged') {
        publicationDiverged = true
        publicationDivergenceKind = publication.kind
      } else {
        throw new Error(`codex_tool_publication_${publication.kind}:${publication.code}`)
      }
    } else {
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
    }
    const boundHost = host
    if (!boundHost) throw new Error('codex_runtime_host_unbound')
    const scope = boundHost.getScope(product.readyScopeId)
    if (!scope) throw new Error('codex_scope_missing_during_closeout')
    const durationMs = Math.max(1, Date.now() - Date.parse(product.admittedAt))
    const taskFacts = readProductTaskFacts(boundHost, product)
    if (lifecycleAction) {
      if (candidate.kind !== 'native_terminal') {
        throw new Error('codex_lifecycle_action_engine_terminal_missing')
      }
      if (repository.readProductCloseout(product.readyRunId)) {
        throw new Error('codex_product_closeout_already_committed')
      }
      const action = lifecycleAction.lifecycleAction
      const committed = await commitExpectedCodexCloseout(
        product.readyRunId,
        `lifecycle_${action}`,
        () => boundHost.commitCodexProductTurnCloseout({
          parentTaskId: product.readyTaskId,
          ownerRunId: product.readyRunId,
          conversationId: scope.id,
          status: 'interrupted',
          terminalReason: 'cancelled_user',
          initiator: `user_${action}`,
          durationMs,
          ...taskFacts,
          finalText: codexTerminalPublicMessage('interrupted'),
          providerDiagnostics: codexFailureDiagnostics({ error: 'cancelled_user', module: taskFacts.module }),
          now: isoNow(),
        }),
      )
      const closeout = repository.readLifecycleActionCloseout(product.readyRunId)
      if (closeout.closeoutDigest !== committed.productTerminalDigest) {
        throw new Error('codex_lifecycle_action_closeout_readback_mismatch')
      }
      if (product.codexThreadId) loadedThreads.delete(product.codexThreadId)
      const reservationSnapshot = registry?.snapshot()
      if (reservationSnapshot?.members.some(
        (member) => member.reservationSetId === product.reservationSetId,
      )) {
        registry?.releaseAfterHostFailure({
          reservationSetId: product.reservationSetId,
          productTerminalDigest: committed.productTerminalDigest,
        })
      }
      const execution: ExecutionHostResult = {
        success: false,
        finalText: committed.canonicalMessage.content,
        cancelled: true,
        usedTools: candidate.usedToolCalls.map((call) => call.tool),
        error: 'cancelled_user',
        taskId: product.readyTaskId,
        taskProjectionId: product.readyTaskId,
        taskType: taskFacts.taskType,
        interactionState: 'suspended',
        terminalReason: 'cancelled_user',
        canonicalMessage: committed.canonicalMessage,
        canonicalMessageDigest: committed.canonicalMessageDigest,
        productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
      }
      preparedDetails.delete(product.readyRunId)
      detailPrepared.delete(product.readyRunId)
      return {
        execution,
        productOutcomeDigest: closeout.closeoutDigest,
        candidateBodyDigest: null,
        committedTerminalEvent: terminalEvent({
          scope,
          product,
          execution,
          terminalAt: committed.closeoutAt,
        }),
      }
    }
    if (
      candidate.kind === 'native_terminal'
      && !publicationDiverged
      && candidate.engineOutcome === 'completed'
      && candidate.candidateSelection.kind === 'accepted'
      && candidate.candidateText !== null
      && candidate.candidateDigest !== null
    ) {
      const acceptedCandidateText = candidate.candidateText
      const workflowInspection = boundHost.runtime
        .getAgentSessionCheckpointRepository()
        .readWorkflowVerifierBundle(product.readyTaskId)
      const workflowBundle = resolveCodexBrowserWorkflowVerifierBundle(workflowInspection)
      const closeoutTaskFacts = resolveCodexBrowserWorkflowTaskFacts(
        taskFacts,
        Boolean(workflowBundle),
      )
      const projection = workflowBundle
        ? boundHost.getTaskProjectionStore().get(product.readyTaskId)
        : null
      if (workflowBundle && !projection) throw new Error('codex_browser_workflow_projection_missing')
      let verifierAttempt: CodexBrowserVerifierAttemptRead | null = null
      let verifierAbortSignal: AbortSignal | null = null
      if (workflowBundle && projection) {
        if (!product.codexThreadId || !product.codexTurnId) {
          throw new Error('codex_browser_verifier_native_identity_missing')
        }
        const frozenIdentityDigest = codexBrowserVerifierIdentityDigest({
          product,
          workflowBundle,
          projection,
        })
        const workflowCloseoutSealDigest = workflowDigest(workflowBundle.seal)
        const begun = repository.beginBrowserVerifierAttempt({
          readyRunId: product.readyRunId,
          readyTaskId: product.readyTaskId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          aliasGeneration: product.aliasGeneration,
          threadBindingId: product.threadBindingId,
          codexThreadId: product.codexThreadId,
          codexTurnId: product.codexTurnId,
          candidateDigest: candidate.candidateDigest,
          frozenIdentityDigest,
          upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
          upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
          workflowCloseoutSealDigest,
          dispatchedAt: isoNow(),
        })
        verifierAttempt = begun.attempt
        if (!begun.created && begun.attempt.status === 'dispatching') {
          const settledAt = isoNow()
          verifierAttempt = repository.settleBrowserVerifierAttempt({
            readyRunId: product.readyRunId,
            attemptId: begun.attempt.attemptId,
            outcome: 'result_unknown',
            verdict: codexBrowserVerifierBlockingVerdict(
              '上一次独立复核的远端结果未能确认，本次未重复请求。',
              '独立复核结果不可确认，已安全阻止交付。',
            ),
            sealedCandidateDigest: null,
            verificationUsage: null,
            verifiedAt: settledAt,
            settledAt,
          })
        } else if (begun.created) {
          try {
            const snapshot = gatewayRepository.readSnapshot(
              product.upstreamProfileSnapshotRef,
              product.upstreamProfileSnapshotDigest,
            )
            const credential = credentialStore.resolve({
              credentialReferenceId: snapshot.credentialReferenceId,
              snapshot,
            })
            verifierAbortSignal = boundHost.getActiveRunAbortSignal({
              readyRunId: product.readyRunId,
              readyScopeId: product.readyScopeId,
              readyAliasId: product.readyAliasId,
            })
            if (!verifierAbortSignal) throw new Error('codex_browser_verifier_abort_signal_missing')
            if (verifierAbortSignal.aborted) {
              throw verifierAbortSignal.reason ?? new DOMException('aborted', 'AbortError')
            }
            const verification = await verifyCodexBrowserWorkflowCandidate({
              readyRunId: product.readyRunId,
              readyTaskId: product.readyTaskId,
              transportModel: product.codexModel,
              runStartedAtMs: Date.parse(product.admittedAt),
              candidateText: acceptedCandidateText,
              workflowBundle,
              projection,
              requestEnvelope: product.ingress,
              snapshot,
              snapshotDigest: product.upstreamProfileSnapshotDigest,
              credential,
              signal: verifierAbortSignal,
            })
            if (verifierAbortSignal.aborted) {
              throw verifierAbortSignal.reason ?? new DOMException('aborted', 'AbortError')
            }
            const currentVerifierSignal = boundHost.getActiveRunAbortSignal({
              readyRunId: product.readyRunId,
              readyScopeId: product.readyScopeId,
              readyAliasId: product.readyAliasId,
            })
            let identityStable = false
            try {
              const currentProduct = repository.readProductTurnRuntime(product.readyRunId)
              const currentWorkflowBundle = resolveCodexBrowserWorkflowVerifierBundle(
                boundHost.runtime.getAgentSessionCheckpointRepository()
                  .readWorkflowVerifierBundle(product.readyTaskId),
              )
              const currentProjection = boundHost.getTaskProjectionStore().get(product.readyTaskId)
              identityStable = Boolean(
                currentVerifierSignal === verifierAbortSignal
                && currentWorkflowBundle
                && currentProjection
                && codexBrowserVerifierIdentityDigest({
                  product: currentProduct,
                  workflowBundle: currentWorkflowBundle,
                  projection: currentProjection,
                }) === frozenIdentityDigest
              )
            } catch {
              identityStable = false
            }
            const settledAt = isoNow()
            verifierAttempt = repository.settleBrowserVerifierAttempt({
              readyRunId: product.readyRunId,
              attemptId: begun.attempt.attemptId,
              outcome: identityStable
                ? codexBrowserVerifierOutcome(verification)
                : 'identity_drift',
              verdict: identityStable
                ? verification.verdict
                : codexBrowserVerifierBlockingVerdict(
                    '独立复核期间任务身份或浏览器证据已变化。',
                    '复核输入已变化，已安全阻止交付。',
                  ),
              sealedCandidateDigest: workflowDigest(verification.sealed),
              verificationUsage: verification.verificationUsage,
              verifiedAt: settledAt,
              settledAt,
            })
          } catch (error) {
            if (isAbortFailure(error, verifierAbortSignal)) throw error
            logAgentMetric('codex_browser_verifier_failed', { readyRunId: product.readyRunId, reason: codexBrowserVerifierFailureCode(error) })
            const settledAt = isoNow()
            verifierAttempt = repository.settleBrowserVerifierAttempt({
              readyRunId: product.readyRunId,
              attemptId: begun.attempt.attemptId,
              outcome: 'provider_unavailable',
              verdict: codexBrowserVerifierBlockingVerdict(
                '独立复核服务暂时不可用。',
                '独立复核未完成，已安全阻止交付。',
              ),
              sealedCandidateDigest: null,
              verificationUsage: null,
              verifiedAt: settledAt,
              settledAt,
            })
          }
        }
        if (
          verifierAttempt.status !== 'settled'
          || !verifierAttempt.outcome
          || !verifierAttempt.verdict
          || !verifierAttempt.receiptDigest
        ) throw new Error('codex_browser_verifier_settlement_missing')
        if (verifierAttempt.outcome !== 'accept') {
          const verifierReceiptDigest = verifierAttempt.receiptDigest
          const unavailable = verifierAttempt.outcome === 'provider_unavailable'
          const resultUnknown = verifierAttempt.outcome === 'result_unknown'
          const identityDrift = verifierAttempt.outcome === 'identity_drift'
          const invalid = verifierAttempt.outcome === 'invalid'
          const errorCode = resultUnknown
            ? 'codex_browser_verifier_result_unknown'
            : unavailable
              ? 'codex_browser_verifier_unavailable'
              : identityDrift
                ? 'codex_browser_verifier_identity_drift'
                : invalid
                  ? 'codex_browser_verifier_invalid_output'
                  : 'codex_browser_verifier_rejected'
          const publicMessage = resultUnknown
            ? '上一次独立复核的结果无法确认，本轮没有交付候选结果。你可以发送新消息，在新的上下文中重新开始。'
            : unavailable
              ? '独立复核服务暂时不可用，本轮没有交付候选结果。你可以发送新消息，在新的上下文中重新开始。'
              : identityDrift
                ? '独立复核期间任务依据已变化，本轮没有交付候选结果。你可以发送新消息，在新的上下文中重新开始。'
                : invalid
                  ? '独立复核未能得出可信结论，本轮没有交付候选结果。你可以发送新消息，在新的上下文中重新开始。'
                  : '独立复核未通过，本轮没有交付候选结果。你可以发送新消息，在新的上下文中重新开始。'
          const verifierTerminalReason = identityDrift
            ? 'persistence_failed' as const
            : unavailable || resultUnknown || invalid
              ? 'blocked_external' as const
              : 'proof_gap' as const
          if (repository.readProductCloseout(product.readyRunId)) {
            throw new Error('codex_product_closeout_already_committed')
          }
          const committedFailure = await commitExpectedCodexCloseout(
            product.readyRunId,
            'verifier_rejected',
            () => boundHost.commitCodexProductTurnCloseout({
              parentTaskId: product.readyTaskId,
              ownerRunId: product.readyRunId,
              conversationId: scope.id,
              status: 'error',
              terminalReason: verifierTerminalReason,
              initiator: 'codex_browser_verifier',
              durationMs,
              ...closeoutTaskFacts,
              finalText: publicMessage,
              providerDiagnostics: codexFailureDiagnostics({
                error: errorCode,
                module: closeoutTaskFacts.module,
                verifierReceiptDigest,
              }),
              now: isoNow(),
            }),
          )
          const reservationSnapshot = registry?.snapshot()
          if (reservationSnapshot?.members.some(
            (member) => member.reservationSetId === product.reservationSetId,
          )) {
            registry?.releaseAfterHostFailure({
              reservationSetId: product.reservationSetId,
              productTerminalDigest: committedFailure.productTerminalDigest,
            })
          }
          const productCloseout = repository.readProductCloseout(product.readyRunId)
          if (
            !productCloseout
            || productCloseout.productTerminalDigest !== committedFailure.productTerminalDigest
          ) throw new Error('codex_verifier_rejected_closeout_readback_missing')
          const execution: ExecutionHostResult = {
            success: false,
            finalText: publicMessage,
            cancelled: false,
            usedTools: candidate.usedToolCalls.map((call) => call.tool),
            error: errorCode,
            taskId: product.readyTaskId,
            taskProjectionId: product.readyTaskId,
            taskType: closeoutTaskFacts.taskType,
            interactionState: 'suspended',
            terminalReason: verifierTerminalReason,
            canonicalMessage: committedFailure.canonicalMessage,
            canonicalMessageDigest: committedFailure.canonicalMessageDigest,
            productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
          }
          preparedDetails.delete(product.readyRunId)
          detailPrepared.delete(product.readyRunId)
          return {
            execution,
            productOutcomeDigest: productCloseout.productTerminalDigest,
            candidateBodyDigest: null,
            committedTerminalEvent: terminalEvent({
              scope,
              product,
              execution,
              terminalAt: productCloseout.productCloseoutAt,
            }),
          }
        }
      }
      const terminalQualityPatch = workflowBundle && projection
        ? readExistingTerminalQualityPatch(projection)
        : null
      const currentAcceptSignal = workflowBundle
        ? boundHost.getActiveRunAbortSignal({
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            readyAliasId: product.readyAliasId,
          })
        : null
      if (currentAcceptSignal?.aborted || verifierAbortSignal?.aborted) {
        throw currentAcceptSignal?.reason
          ?? verifierAbortSignal?.reason
          ?? new DOMException('aborted', 'AbortError')
      }
      const completionVerifierReceipt = workflowBundle && terminalQualityPatch && verifierAttempt
        ? {
            version: 1 as const,
            verdict: 'accept' as const,
            parentTaskId: product.readyTaskId,
            ownerRunId: product.readyRunId,
            candidateDigest: workflowDigest(candidate.candidateText),
            workflowCloseoutSealDigest: workflowDigest(workflowBundle.seal),
            sealedCandidateDigest: verifierAttempt.sealedCandidateDigest as string,
            terminalQualityPatchDigest: workflowDigest(terminalQualityPatch),
            durableVerifierReceiptDigest: verifierAttempt.receiptDigest as string,
            verifiedAt: verifierAttempt.verifiedAt as string,
          }
        : null
      if (repository.readProductCloseout(product.readyRunId)) {
        throw new Error('codex_product_closeout_already_committed')
      }
      const publishedToolEvidence = repository.readPublishedToolOutputs(product.readyRunId)
        .map((tool) => ({
          itemId: tool.itemId,
          tool: tool.toolName,
          proofs: collectToolOutputProofs(
            tool.toolName,
            normalizeToolExecutionOutput(tool.output),
            new Date(tool.completedAt),
            { runId: product.readyRunId },
          ),
        }))
      const requestedCloseout = {
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        status: 'done' as const,
        terminalReason: 'done',
        initiator: 'done',
        durationMs,
        finalText: acceptedCandidateText,
        conversationId: scope.id,
        ...closeoutTaskFacts,
        providerDiagnostics: {
          provider: 'ready_gateway',
          agentProtocol: 'openai',
          wireApi: 'responses',
          actionReceiptRefs: publicationReceiptRefs,
        },
        workflowCloseoutSeal: workflowBundle?.seal ?? null,
        terminalQualityPatch,
        completionVerifierReceipt,
      }
      const committed = await commitExpectedCodexCloseout(
        product.readyRunId,
        workflowBundle ? 'verifier_accepted' : 'product',
        async () => workflowBundle
          ? {
              ...await boundHost.commitCodexProductTurnCloseout(requestedCloseout),
              status: 'done',
              terminalReason: 'done',
            }
          : finalizeCodexProductCloseout({
              closeout: requestedCloseout,
              toolCalls: candidate.usedToolCalls,
              publishedToolEvidence,
              taskProjectionStore: boundHost.getTaskProjectionStore(),
              commitCanonicalCoreCloseout: (closeout) => (
                boundHost.commitCodexProductTurnCloseout(closeout)
              ),
            }),
      )
      const productCloseout = repository.readProductCloseout(product.readyRunId)
      if (!productCloseout) throw new Error('codex_product_closeout_readback_missing')
      const successful = committed.status === 'done'
      const execution: ExecutionHostResult = {
        success: successful,
        finalText: committed.canonicalMessage.content,
        cancelled: false,
        usedTools: candidate.usedToolCalls.map((call) => call.tool),
        ...(successful ? {} : { error: committed.terminalReason }),
        taskId: product.readyTaskId,
        taskProjectionId: product.readyTaskId,
        taskType: closeoutTaskFacts.taskType,
        interactionState: successful ? 'running' : 'suspended',
        terminalReason: committed.terminalReason as ExecutionHostResult['terminalReason'],
        canonicalMessage: committed.canonicalMessage,
        canonicalMessageDigest: committed.canonicalMessageDigest,
        productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
      }
      preparedDetails.delete(product.readyRunId)
      detailPrepared.delete(product.readyRunId)
      return {
        execution,
        productOutcomeDigest: productCloseout.productTerminalDigest,
        candidateBodyDigest: successful ? candidate.candidateDigest : null,
        committedTerminalEvent: terminalEvent({
          scope, product, execution, terminalAt: productCloseout.productCloseoutAt,
        }),
      }
    }

    if (candidate.kind === 'host_failure') {
      const start = repository.readProductStartState(product.readyRunId)
      if (start.codexTurnId && start.codexThreadId) {
        const requestedAt = isoNow()
        repository.requestProductInterrupt({
          aliasId: product.readyAliasId,
          aliasGeneration: product.aliasGeneration,
          readyRunId: product.readyRunId,
          codexThreadId: start.codexThreadId,
          codexTurnId: start.codexTurnId,
          requestedAt,
        })
        boundHost.abortActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
        })
        const recovered = await recoverCodexTerminalAfterInterrupt({
          runtime: nativeRuntime,
          collector,
          product,
          timedOutCandidate: candidate,
          acknowledgeInterrupt() {
            repository.acknowledgeProductInterrupt({
              readyRunId: product.readyRunId,
              acknowledgedAt: isoNow(),
            })
          },
          markInterruptUnknown() {
            repository.markProductInterruptUnknown({
              readyRunId: product.readyRunId,
              unknownAt: isoNow(),
            })
          },
        })
        return closeCandidate(recovered)
      }
      if (!start.codexTurnId) {
        const deliveryWasNeverAttempted = start.codexThreadId
          ? start.turnStartDispatchIntentAt === null
          : start.threadStartDispatchIntentAt === null
        if (!deliveryWasNeverAttempted && !start.hostFailureKind) {
          throw new Error('codex_start_delivery_unknown')
        }
        if (!start.hostFailureKind) {
          repository.recordHostFailureEvidence({
            readyRunId: product.readyRunId,
            kind: start.codexThreadId
              ? 'turn_start_delivery_proven_absent'
              : 'thread_start_delivery_proven_absent',
            evidenceDigest: candidate.hostFailure.evidenceDigest,
            recordedAt: isoNow(),
          })
        }
        const failure = repository.readRecoverySnapshot(
          (epoch) => sidecarSession?.isConnectionLive(epoch) || false,
        ).hostFailureCloseouts.find((entry) => entry.readyRunId === product.readyRunId)
        if (!failure) throw new Error('codex_host_failure_readback_missing')
        const settlement = await closePersistedHostFailure(failure)
        releaseHostFailureReservationIfPresent(registry, settlement)
        return settlement.result
      }
    }
    const status = candidate.engineOutcome === 'interrupted' ? 'interrupted' : 'error'
    const terminalReason = status === 'interrupted'
      ? 'cancelled_runtime'
      : candidate.kind === 'native_terminal' && candidate.engineOutcome === 'failed'
        ? 'blocked_external'
        : 'persistence_failed'
    const errorCode = candidate.kind === 'host_failure'
      ? `codex_${candidate.hostFailure.stage}_failed`
      : publicationDivergenceKind === 'diverged'
        ? 'codex_tool_publication_diverged'
      : 'codex_native_terminal_rejected'
    const closeoutMode = candidate.kind === 'native_terminal'
      && (publicationDiverged || candidate.engineOutcome !== 'interrupted')
      ? 'publication_diverged' as const
      : 'product' as const
    if (repository.readProductCloseout(product.readyRunId)) {
      throw new Error('codex_product_closeout_already_committed')
    }
    const committed = await commitExpectedCodexCloseout(product.readyRunId, closeoutMode, () => (
      boundHost.commitCodexProductTurnCloseout({
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        conversationId: scope.id,
        status,
        terminalReason,
        initiator: 'codex_native',
        durationMs,
        ...taskFacts,
        finalText: codexTerminalPublicMessage(status),
        providerDiagnostics: codexFailureDiagnostics({ error: errorCode, module: taskFacts.module }),
        now: isoNow(),
      })
    ))
    const reservationSnapshot = registry?.snapshot()
    if (reservationSnapshot?.members.some((member) => member.reservationSetId === product.reservationSetId)) {
      registry?.releaseAfterHostFailure({
        reservationSetId: product.reservationSetId,
        productTerminalDigest: committed.productTerminalDigest,
      })
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: status === 'interrupted',
      usedTools: candidate.usedToolCalls.map((call) => call.tool),
      error: errorCode,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason,
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout || productCloseout.productTerminalDigest !== committed.productTerminalDigest) {
      throw new Error('codex_product_closeout_readback_missing')
    }
    return {
      execution,
      productOutcomeDigest: productCloseout.productTerminalDigest,
      candidateBodyDigest: candidate.candidateDigest,
      committedTerminalEvent: terminalEvent({
        scope, product, execution, terminalAt: productCloseout.productCloseoutAt,
      }),
    }
  }

  const closeCandidateInFlight = new CodexCloseCandidateInFlightOwner<ReadyClosedCodexProductRun>()
  const closeCandidateIdentityDigest = (candidate: CoreTurnCandidate): string => workflowDigest({
    kind: candidate.kind,
    readyRunId: candidate.readyRunId,
    readyTaskId: candidate.readyTaskId,
    scopeId: candidate.scopeId,
    codexThreadId: candidate.codexThreadId,
    codexTurnId: candidate.codexTurnId,
    ...(candidate.kind === 'native_terminal'
      ? {
          engineOutcome: candidate.engineOutcome,
          candidateSelection: candidate.candidateSelection,
          candidateDigest: candidate.candidateDigest,
        }
      : { hostFailure: candidate.hostFailure }),
  })
  const closeCandidate = (candidate: CoreTurnCandidate): Promise<ReadyClosedCodexProductRun> => {
    const candidateIdentityDigest = closeCandidateIdentityDigest(candidate)
    return closeCandidateInFlight.run({
      readyRunId: candidate.readyRunId,
      candidateIdentityDigest,
      close: () => closeCandidateOwned(candidate),
    })
  }

  const closeRunLocalRecoveryFailure = async (
    readyRunId: string,
    errorCode: string,
    pendingInteractionRestart?: CodexPendingInteractionRestartPlan,
  ): Promise<ReadyClosedCodexProductRun> => {
    const product = repository.readProductTurnRuntime(readyRunId)
    const boundHost = host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new Error('codex_recovery_failure_scope_missing')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const evidenceDigest = pendingInteractionRestart?.evidenceDigest || digestCanonicalJson({
      contract: 'codex_product_recovery_failure_v1',
      readyRunId: product.readyRunId,
      readyTaskId: product.readyTaskId,
      readyAliasId: product.readyAliasId,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: product.codexThreadId,
      codexTurnId: product.codexTurnId,
      errorCode,
    })
    const committed = await commitExpectedCodexRecoveryFailure(
      product.readyRunId,
      { code: errorCode, evidenceDigest, pendingInteractionRestart },
      () => boundHost.commitCodexProductTurnCloseout({
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        conversationId: product.readyScopeId,
        status: pendingInteractionRestart ? 'interrupted' : 'error',
        terminalReason: pendingInteractionRestart ? 'cancelled_runtime' : 'persistence_failed',
        initiator: 'codex_recovery',
        durationMs: Math.max(1, Date.now() - Date.parse(product.admittedAt)),
        ...taskFacts,
        finalText: codexTerminalPublicMessage(
          pendingInteractionRestart ? 'interrupted' : 'error',
        ),
        providerDiagnostics: codexFailureDiagnostics({ error: errorCode, module: taskFacts.module }),
        now: pendingInteractionRestart?.cancelledAt || isoNow(),
      }),
    )
    if (pendingInteractionRestart) {
      settleCodexPendingInteractionsInMemoryAfterCommit(pendingInteractionRestart.interactions)
    }
    if (registry?.snapshot().members.some(
      (member) => member.reservationSetId === product.reservationSetId,
    )) {
      registry.releaseAfterHostFailure({
        reservationSetId: product.reservationSetId,
        productTerminalDigest: committed.productTerminalDigest,
      })
    }
    releaseBrowserTurnLease(product.readyRunId)
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout
      || productCloseout.productTerminalDigest !== committed.productTerminalDigest
      || productCloseout.productCloseoutAt !== committed.closeoutAt) {
      throw new Error('codex_recovery_failure_closeout_readback_missing')
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: Boolean(pendingInteractionRestart),
      usedTools: [],
      error: errorCode,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: pendingInteractionRestart ? 'cancelled_runtime' : 'persistence_failed',
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    return {
      execution,
      productOutcomeDigest: productCloseout.productTerminalDigest,
      candidateBodyDigest: null,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: productCloseout.productCloseoutAt,
      }),
    }
  }

  const failRuntimeForProductRecovery = (
    readyRunId: string,
    errorCode: string,
    metric = 'codex_product_recovery_failed',
  ): void => {
    logAgentMetric(metric, { readyRunId, reason: errorCode })
    gate.close('product_recovery_failed')
    if (lifecycle !== 'stopping' && lifecycle !== 'stopped') lifecycle = 'failed'
  }

  const lifecycleAdapter = new ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>({
    nativeRuntime,
    threadResumePort: new CodexThreadResumeAuthority(() => sidecarSession),
    collector,
    inputBuilder: new CodexTurnInputBuilder(),
    lifecycleStore,
    closeout: {
      closeCandidate,
      recoverRejectedCandidate() { throw new Error('codex_closeout_readback_required') },
      observeCandidateReadback(readback, callback) {
        if (!readback.candidate) return () => undefined
        let stopped = false
        let running = false
        let lastCloseoutError: string | null = null
        const timer = setInterval(() => {
          if (stopped || running) return
          const candidate = readback.candidate as CoreTurnCandidate
          if (candidate.kind === 'host_failure') {
            const start = repository.readProductStartState(candidate.readyRunId)
            if (!start.productCloseoutCommitted && !start.hostFailureKind) return
          }
          running = true
          void closeCandidate(candidate)
            .then((result) => {
              if (stopped) return
              stopped = true
              clearInterval(timer)
              callback(result)
            })
            .catch(async (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              const errorCode = /^[a-z0-9_:-]{1,96}$/i.test(message)
                ? message
                : stableErrorCode(error, 'codex_closeout_readback_rejected')
              if (errorCode !== lastCloseoutError) {
                lastCloseoutError = errorCode
                logAgentMetric('codex_closeout_readback_rejected', {
                  readyRunId: candidate.readyRunId,
                  candidateKind: candidate.kind,
                  errorCode,
                })
              }
              const classification = classifyCodexProductRecoveryFailure(error)
              if (classification.kind === 'transient') {
                if (
                  classification.code === 'codex_product_closeout_already_committed'
                  && repository.readProductCloseout(candidate.readyRunId)
                ) {
                  stopped = true
                  clearInterval(timer)
                }
                return
              }
              if (classification.kind === 'global') {
                stopped = true
                clearInterval(timer)
                failRuntimeForProductRecovery(
                  candidate.readyRunId,
                  classification.code,
                  'codex_live_closeout_recovery_failed',
                )
                return
              }
              const browserWorkflowCode = recoverableBrowserWorkflowCode(error)
              try {
                if (browserWorkflowCode && candidate.kind === 'native_terminal') {
                  const product = repository.readProductTurnRuntime(candidate.readyRunId)
                  await settleEngineTerminalFailure({
                    identity: {
                      aliasId: product.readyAliasId,
                      aliasGeneration: product.aliasGeneration,
                    },
                    readyRunId: candidate.readyRunId,
                    status: 'error',
                    terminalReason: 'blocked_external',
                    initiator: 'codex_recovery',
                    error: browserWorkflowCode,
                  })
                  if (!stopped) {
                    const recovered = readAlreadyCommittedCloseout(product, candidate)
                    if (!recovered) throw new Error('codex_recovered_closeout_readback_missing')
                    callback(recovered)
                  }
                } else {
                  const recovered = await closeRunLocalRecoveryFailure(
                    candidate.readyRunId,
                    classification.code,
                  )
                  if (!stopped) callback(recovered)
                }
                stopped = true
                clearInterval(timer)
                logAgentMetric('codex_live_closeout_retired', {
                  readyRunId: candidate.readyRunId,
                  reason: classification.code,
                })
              } catch (settlementError) {
                stopped = true
                clearInterval(timer)
                failRuntimeForProductRecovery(
                  candidate.readyRunId,
                  stableErrorCode(settlementError, 'codex_live_closeout_settlement_failed'),
                  'codex_live_closeout_recovery_failed',
                )
              }
            })
            .finally(() => { running = false })
        }, 1_000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      },
    },
  })

  const deliverRecoveredCloseout = (
    readyRunId: string,
    recovered: ReadyClosedCodexProductRun,
  ): void => {
    if (!recovered.committedTerminalEvent) {
      throw new Error('codex_recovered_closeout_event_missing')
    }
    const disposition = lifecycleAdapter.deliverRecoveredCloseout(readyRunId, recovered)
    if (disposition !== 'publish_only') return
    if (!host) throw new Error('codex_recovered_closeout_event_missing')
    host.publishCommittedTerminalEvent(recovered.committedTerminalEvent)
    lifecycleAdapter.acknowledgePublishedRecoveredCloseout(readyRunId)
  }

  const finalizeEngineTerminalCloseout = (
    finalization: PendingEngineTerminalFinalization,
    onDeliveryFailure?: (error: unknown) => void,
  ): void => {
    const key = buildCodexEngineTerminalFinalizationKey({
      ...finalization.identity,
      readyRunId: finalization.product.readyRunId,
    })
    pendingEngineTerminalFinalizations.set(key, finalization)
    runCodexEngineTerminalFinalization({
      deliver: () => deliverRecoveredCloseout(
        finalization.product.readyRunId,
        finalization.recovered,
      ),
      cleanup: () => {
        try {
          releaseBrowserTurnLease(finalization.product.readyRunId)
        } catch (error) {
          browserTurnLeases.delete(finalization.product.readyRunId)
          logAgentMetric('codex_user_stop_memory_cleanup_failed', {
            readyRunId: finalization.product.readyRunId,
            stage: 'browser_turn_lease',
            errorCode: stableErrorCode(error, 'browser_turn_lease_release_failed'),
          })
        }
        try {
          if (registry?.snapshot().members.some(
            (member) => member.reservationSetId === finalization.product.reservationSetId,
          )) {
            registry.releaseAfterHostFailure({
              reservationSetId: finalization.product.reservationSetId,
              productTerminalDigest: finalization.productTerminalDigest,
            })
          }
        } catch (error) {
          logAgentMetric('codex_user_stop_memory_cleanup_failed', {
            readyRunId: finalization.product.readyRunId,
            stage: 'start_identity_registry',
            errorCode: stableErrorCode(error, 'start_identity_registry_release_failed'),
          })
        }
        preparedDetails.delete(finalization.product.readyRunId)
        detailPrepared.delete(finalization.product.readyRunId)
      },
      onDeliveryFailure,
    })
  }

  const readLifecycleCloseout = (
    identity: { aliasId: string; aliasGeneration: number; readyRunId?: string },
  ): ProductTurnCloseoutEvidence => {
    if (identity.readyRunId && repository.readProductLifecycleAction(identity.readyRunId)) {
      const lifecycle = repository.readLifecycleActionCloseout(identity.readyRunId)
      if (lifecycle.aliasId !== identity.aliasId
        || lifecycle.aliasGeneration !== identity.aliasGeneration) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return {
        aliasId: lifecycle.aliasId,
        aliasGeneration: lifecycle.aliasGeneration,
        codexThreadId: lifecycle.codexThreadId,
        codexTurnId: lifecycle.codexTurnId,
        terminal: lifecycle.terminal,
        closeoutDigest: lifecycle.closeoutDigest,
        fenceReleaseRevision: lifecycle.fenceReleaseRevision,
        lifecycleAction: lifecycle.action,
        lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
        retiredGeneration: lifecycle.retiredGeneration,
        retirementTransactionDigest: lifecycle.retirementTransactionDigest,
        archiveIntentDigest: lifecycle.archiveIntentDigest,
        scopeClosureEvidenceDigest: lifecycle.scopeClosureEvidenceDigest,
        newGeneration: lifecycle.newGeneration,
        newThreadBindingId: lifecycle.newThreadBindingId,
      }
    }
    const read = repository.readLatestLifecycleCloseout(identity)
    return {
      aliasId: read.aliasId,
      aliasGeneration: read.aliasGeneration,
      codexThreadId: read.codexThreadId,
      codexTurnId: read.codexTurnId,
      terminal: read.terminal,
      closeoutDigest: read.closeoutDigest,
      fenceReleaseRevision: read.fenceReleaseRevision,
    }
  }

  const readEngineTerminalFinalization = (
    finalization: PendingEngineTerminalFinalization,
  ): ProductTurnCloseoutEvidence => {
    const productCloseout = repository.readProductCloseout(finalization.product.readyRunId)
    if (
      !productCloseout
      || productCloseout.productTerminalDigest !== finalization.productTerminalDigest
      || productCloseout.productCloseoutAt !== finalization.closeoutAt
    ) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const readback = readLifecycleCloseout({
      ...finalization.identity,
      readyRunId: finalization.product.readyRunId,
    })
    if (
      readback.terminal !== finalization.terminal
      || readback.codexThreadId !== finalization.product.codexThreadId
      || readback.codexTurnId !== finalization.product.codexTurnId
      || readback.closeoutDigest !== finalization.productTerminalDigest
    ) throw new ReadyCodexLifecyclePortError('persistence_failed')
    return readback
  }

  const settleEngineTerminalFailure = async (input: {
    identity: { aliasId: string; aliasGeneration: number }
    readyRunId: string
    status: 'error' | 'interrupted'
    terminalReason: 'blocked_external' | 'cancelled_user'
    initiator: 'codex_recovery' | 'user_stop' | 'user_close' | 'user_reset'
    lifecycleAction?: CodexLifecycleAction
    error: string
  }): Promise<ProductTurnCloseoutEvidence> => {
    const product = repository.readProductTurnRuntime(input.readyRunId)
    const terminal = repository.readEngineTerminalCandidate(product.readyRunId)
    const candidate = terminal?.candidate as CoreTurnCandidate | undefined
    if (
      !terminal
      || candidate?.kind !== 'native_terminal'
      || product.readyAliasId !== input.identity.aliasId
      || product.aliasGeneration !== input.identity.aliasGeneration
      || product.codexThreadId !== terminal.codexThreadId
      || product.codexTurnId !== terminal.codexTurnId
    ) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    const boundHost = host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const taskFacts = readProductTaskFacts(boundHost, product)
    if (repository.readProductCloseout(product.readyRunId)) {
      return readLifecycleCloseout({ ...input.identity, readyRunId: input.readyRunId })
    }
    if (input.lifecycleAction) {
      requestCodexEngineTerminalLifecycleActionBeforeCloseout({
        repository,
        host: boundHost,
        product,
        action: input.lifecycleAction,
        requestedAt: isoNow(),
      })
    }
    const committed = await commitExpectedCodexCloseout(
      product.readyRunId,
      input.lifecycleAction
        ? `lifecycle_${input.lifecycleAction}` as CodexProductCloseoutMode
        : 'publication_diverged',
      () => boundHost.commitCodexProductTurnCloseout({
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        conversationId: product.readyScopeId,
        status: input.status,
        terminalReason: input.terminalReason,
        initiator: input.initiator,
        durationMs: Math.max(1, Date.now() - Date.parse(product.admittedAt)),
        ...taskFacts,
        finalText: codexTerminalPublicMessage(input.status),
        providerDiagnostics: codexFailureDiagnostics({ error: input.error, module: taskFacts.module }),
        now: isoNow(),
      }),
    )
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: input.status === 'interrupted',
      usedTools: candidate.usedToolCalls.map((call) => call.tool),
      error: input.error,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: input.terminalReason,
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    const recovered: ReadyClosedCodexProductRun = {
      execution,
      productOutcomeDigest: committed.productTerminalDigest,
      candidateBodyDigest: candidate.candidateDigest,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: committed.closeoutAt,
      }),
    }
    const finalization: PendingEngineTerminalFinalization = {
      identity: input.identity,
      product,
      terminal: input.status === 'error' ? 'failed' : 'interrupted',
      productTerminalDigest: committed.productTerminalDigest,
      closeoutAt: committed.closeoutAt,
      recovered,
    }
    finalizeEngineTerminalCloseout(
      finalization,
      input.initiator === 'codex_recovery'
        ? (error) => {
            logAgentMetric('codex_product_recovery_terminal_notification_failed', {
              readyRunId: product.readyRunId,
              errorCode: stableErrorCode(error, 'terminal_notification_failed'),
            })
          }
        : undefined,
    )
    const readback = readEngineTerminalFinalization(finalization)
    pendingEngineTerminalFinalizations.delete(buildCodexEngineTerminalFinalizationKey({
      ...input.identity,
      readyRunId: input.readyRunId,
    }))
    return readback
  }

  settleLifecycleReadbackTerminalUserStop = async (input, requestedAction = 'stop') => {
    if (input.turn.status === 'inProgress' || input.turn.id.trim() === '') {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const identity = {
      aliasId: input.aliasId,
      aliasGeneration: input.aliasGeneration,
    }
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (
      lifecycleOperation.activeReadyRunId !== input.readyRunId
      || lifecycleOperation.facts.codexThreadId !== input.codexThreadId
      || lifecycleOperation.facts.codexTurnId !== input.turn.id
      || !lifecycleOperation.facts.productRunNonterminal
      || !lifecycleOperation.facts.interruptStateUnknown
    ) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const product = repository.readProductTurnRuntime(input.readyRunId)
    if (
      product.readyAliasId !== input.aliasId
      || product.aliasGeneration !== input.aliasGeneration
      || product.codexThreadId !== input.codexThreadId
      || product.codexTurnId !== input.turn.id
    ) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const existing = repository.readEngineTerminalCandidate(input.readyRunId)
    if (existing) {
      if (
        existing.codexThreadId !== input.codexThreadId
        || existing.codexTurnId !== input.turn.id
        || existing.engineOutcome !== input.turn.status
      ) throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    } else {
      const candidate = buildCodexProductReadbackCandidate({
        collector,
        product,
        turn: input.turn,
        recovery: 'interrupt_unknown_exact_readback',
      })
      if (candidate.kind !== 'native_terminal') {
        throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
      }
      repository.recordEngineTerminalCandidate({
        readyRunId: product.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.turn.id,
        engineOutcome: input.turn.status,
        candidate,
        recordedAt: isoNow(),
      })
    }
    return settleEngineTerminalFailure({
      identity,
      readyRunId: input.readyRunId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: `user_${requestedAction}`,
      lifecycleAction: requestedAction,
      error: 'cancelled_user',
    })
  }

  settleLifecycleEngineTerminalUserStop = async (identity, requestedAction = 'stop') => {
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (!lifecycleOperation.activeReadyRunId) {
      try {
        return readLifecycleCloseout({ ...identity, readyRunId: identity.readyRunId })
      } catch {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
    }
    if (lifecycleOperation.activeReadyRunId !== identity.readyRunId) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    if (
      !lifecycleOperation.facts.engineTerminalRecorded
      || lifecycleOperation.facts.readyCloseoutCommitted
    ) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    return settleEngineTerminalFailure({
      identity,
      readyRunId: identity.readyRunId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: `user_${requestedAction}`,
      lifecycleAction: requestedAction,
      error: 'cancelled_user',
    })
  }

  retryLifecycleEngineTerminalUserStopFinalization = async (identity) => {
    const key = buildCodexEngineTerminalFinalizationKey(identity)
    const finalization = pendingEngineTerminalFinalizations.get(key)
    if (!finalization || finalization.product.readyRunId !== identity.readyRunId) return null
    finalizeEngineTerminalCloseout(finalization)
    const readback = readEngineTerminalFinalization(finalization)
    pendingEngineTerminalFinalizations.delete(key)
    return readback
  }

  settleLifecycleHostFailureCloseout = async (identity) => {
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (!lifecycleOperation.activeReadyRunId
      || !lifecycleOperation.facts.hostFailureEvidenceComplete) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    const failure = repository.readRecoverySnapshot(
      (epoch) => sidecarSession?.isConnectionLive(epoch) || false,
    ).hostFailureCloseouts.find(
      (entry) => entry.readyRunId === lifecycleOperation.activeReadyRunId,
    )
    if (!failure) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const settlement = await closePersistedHostFailure(failure)
    releaseHostFailureReservationIfPresent(registry, settlement)
    deliverRecoveredCloseout(settlement.readyRunId, settlement.result)
  }

  const aliasBindingPort: CodexAliasBindingPort = {
    readAliasGeneration(aliasId) {
      return repository.readActiveAliasBinding(aliasId)?.aliasGeneration ?? null
    },
    readLatestAliasGeneration(aliasId) {
      return repository.readLatestAliasGeneration(aliasId)
    },
    readActiveProductRunVisibilityIdentity(readyRunId) {
      return repository.readActiveProductRunVisibilityIdentity(readyRunId)
    },
    readCommittedProductRunVisibilityIdentity(readyRunId) {
      return repository.readCommittedProductRunVisibilityIdentity(readyRunId)
    },
    readLifecycleSnapshot(identity) {
      const read = repository.readLifecycleOperation(identity)
      const snapshot = classifyLifecycleOperation(read.facts)
      return {
        identity: read.identity,
        activeReadyRunId: read.activeReadyRunId,
        latestReadyRunId: read.latestReadyRunId,
        snapshot,
        interruptRequested: read.interruptRequested,
        interruptAcknowledged: read.interruptAcknowledged,
        requestedAction: read.requestedAction,
        evidenceDigest: digestCanonicalJson({ ...read, snapshot }),
      }
    },
  }

  const startIdentityPort: CodexStartIdentityPort = {
    resolveMethods(scopeId) {
      gate.assertOpen()
      const binding = repository.resolveUserIngressAliasBinding({
        aliasId: scopeId,
        runtimeManifestDigest: verified.manifestDigest,
        protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
        createdAt: isoNow(),
        currentToolSurfaceDigest: digestCodexRootToolSurface(
          listLiveCodexThreadToolDefinitions(),
        ),
      })
      if (!binding || binding.retiredAt) throw new Error('codex_alias_binding_missing')
      if (binding.continuationBlockedAt) throw new PrePersistenceAdmissionError(
        'conversation_reset_required', false,
        digestCanonicalJson({ scopeId, reason: binding.continuationBlockedReason }),
        'codex_conversation_reset_required',
      )
      if (binding.hasActiveFence) throw new PrePersistenceAdmissionError(
        'thread_busy', true, digestCanonicalJson({ scopeId, state: 'thread_busy' }),
        'codex_thread_busy',
      )
      return binding.codexThreadId ? ['turn/start'] : ['thread/start', 'turn/start']
    },
    async reserve({ scopeId, methods }) {
      gate.assertOpen()
      if (!registry) throw new Error('codex_registry_unavailable')
      const binding = repository.readActiveAliasBinding(scopeId)
      if (!binding) throw new Error('codex_alias_binding_missing')
      const expected = binding.codexThreadId ? ['turn/start'] : ['thread/start', 'turn/start']
      if (methods.join('\u0000') !== expected.join('\u0000')) throw new Error('codex_reservation_method_drift')
      return registry.reserve({ scopeId, existingThread: Boolean(binding.codexThreadId) })
    },
    async reconcileReservationContractFailure({ reservationResult, evidenceDigest }) {
      if (!registry || !reservationResult || typeof reservationResult !== 'object') return
      const reservation = (reservationResult as { reservation?: { reservationSetId?: unknown } }).reservation
      if (typeof reservation?.reservationSetId !== 'string') return
      const present = registry.snapshot().members.some((member) => member.reservationSetId === reservation.reservationSetId)
      if (present) registry.releaseBeforeDispatch({ reservationSetId: reservation.reservationSetId, evidenceDigest })
    },
    async releaseAfterIngressFailure({ reservation, failure }) {
      registry?.releaseBeforeDispatch({ reservationSetId: reservation.reservationSetId, evidenceDigest: failure.evidenceDigest })
      for (const [readyRunId, prepared] of detailPrepared) {
        if (prepared.ingressBinding.reservationSetId !== reservation.reservationSetId) continue
        preparedDetails.delete(readyRunId)
        detailPrepared.delete(readyRunId)
      }
    },
    async releaseAfterPrePersistenceRejection({ reservation, rejection }) {
      registry?.releaseBeforeDispatch({ reservationSetId: reservation.reservationSetId, evidenceDigest: rejection.admissionEvidenceDigest })
    },
  }

  const preparer = new CodexProductRunPreparer()
  const ingressPort: CodexIngressPort = {
    async prepareIngress({ scope, request, reservation }) {
      try {
        gate.assertOpen()
        const boundHost = host
        if (!boundHost) throw new Error('codex_runtime_host_unbound')
        if (request.expectedMessageVisibilityEpoch !== scope.messageVisibilityEpoch) {
          throw new PrePersistenceAdmissionError(
            'conversation_reset_required',
            false,
            digestCanonicalJson({
              scopeId: scope.id,
              expectedMessageVisibilityEpoch: request.expectedMessageVisibilityEpoch,
              actualMessageVisibilityEpoch: scope.messageVisibilityEpoch,
            }),
            'codex_message_visibility_epoch_mismatch',
          )
        }
        const currentInput = toCodexInput(request)
        if (!currentInput) throw new Error('codex_product_ingress_unsupported')
        const profile = activeProfile(input.settings)
        await input.providerReadiness.ensureReady(profile)
        const binding = repository.readActiveAliasBinding(scope.id)
        if (!binding || binding.aliasGeneration !== scope.aliasGeneration) {
          throw new Error('codex_alias_generation_mismatch')
        }
        if (
          typeof request.expectedAliasGeneration === 'number'
          && request.expectedAliasGeneration > binding.aliasGeneration
        ) {
          throw new Error('codex_alias_generation_mismatch')
        }
        if (
          typeof request.expectedAliasGeneration === 'number'
          && request.expectedAliasGeneration < binding.aliasGeneration
        ) {
          const predecessor = rawDb.prepare(`
            SELECT retired_reason
              FROM codex_thread_bindings
             WHERE ready_conversation_alias = ? AND alias_generation = ?
             LIMIT 1
          `).get<{ retired_reason: string | null }>(scope.id, request.expectedAliasGeneration)
          if (!predecessor || !['publication_diverged', 'cleanup'].includes(predecessor.retired_reason || '')) {
            throw new Error('codex_alias_generation_mismatch')
          }
        }
        const externalReadRequest = parseCodexExternalReadSliceRequest(request.userMessage.meta)
        if (request.currentDocumentAnchor && externalReadRequest) {
          throw new Error('codex_external_read_slice_conflicts_with_current_document')
        }
        const externalReadSlice = externalReadRequest
          ? await boundHost.resolveExternalReadSlice(externalReadRequest)
          : null
        const requestedWorkbenchMode = request.userMessage.meta.workbenchMode
        const browserSelections = (request.resources ?? []).filter(
          (selection): selection is Extract<NonNullable<SendScopedRequest['resources']>[number], { kind: 'browser_tab' }> => (
            selection.kind === 'browser_tab'
          ),
        )
        if (browserSelections.length > 1) throw new Error('codex_explicit_browser_reference_ambiguous')
        const browserReference = browserSelections[0]
          ? await (boundHost.browserController
              ? resolveTrustedBrowserReference(boundHost.browserController, browserSelections[0].tabId)
              : Promise.resolve(null))
          : null
        if (browserSelections[0] && !browserReference) {
          throw new Error('codex_explicit_browser_reference_unavailable')
        }
        const hostEnvironment = await boundHost.runtime.resolveTrustedRequestEnvironment(
          requestedWorkbenchMode === 'browser'
            || requestedWorkbenchMode === 'document'
            || requestedWorkbenchMode === 'rss'
            || requestedWorkbenchMode === 'calendar'
            ? { workbenchMode: requestedWorkbenchMode }
            : undefined,
        )
        const activeWorkbenchMode = requestedWorkbenchMode === 'browser'
          || requestedWorkbenchMode === 'document'
          || requestedWorkbenchMode === 'rss'
          || requestedWorkbenchMode === 'calendar'
          ? requestedWorkbenchMode
          : hostEnvironment.workbenchMode
        const executionPageRef = resolveBrowserExecutionPageRef(buildBrowserAdmissionAuthoritySnapshot({
          authorityId: `browser-exec:${request.requestId}`,
          activeWorkbenchMode,
          currentBrowserPageRef: activeWorkbenchMode === 'browser'
            ? hostEnvironment.browserPageRef || null
            : null,
          explicitBrowserReadRefs: browserReference?.environment.browserPageRef
            ? [browserReference.environment.browserPageRef]
            : [],
        }))
        const trustedEnvironment = {
          ...(activeWorkbenchMode ? { workbenchMode: activeWorkbenchMode } : {}),
          ...(executionPageRef ? { browserPageRef: executionPageRef } : {}),
        }
        const resolvedBrowserInput = trustedBrowserReferenceInput(browserReference)
        let retryPredecessor: ReturnType<CodexBindingRepository['readProductTurnRuntime']> | null = null
        let retryPredecessorReceipt: ProductTurnReceipt | null = null
        let retryTaskContext: ReturnType<CodexBindingRepository['readProductTurnRuntime']> | null = null
        let retryArtifactSources: import('./codex-product-run-preparer').CodexRetryArtifactSource[] = []
        if (request.explicitRetry) {
          const lineage = resolveCodexExplicitRetryLineage({
            repository,
            requestedRunId: request.explicitRetry.predecessorRunId,
            requestedPresentationDigest: request.explicitRetry.predecessorPresentationDigest,
            readyScopeId: scope.id,
          })
          retryTaskContext = lineage.taskContext
          retryPredecessor = lineage.predecessor
          retryPredecessorReceipt = lineage.predecessorReceipt
          retryArtifactSources = lineage.artifactSources
        }
        const retryLocalResources = retryTaskContext
          ? recoverCodexRetryLocalResourceSelections({
              explicitInput: retryTaskContext.prepared.ingress.explicitResourceEnvelope.input,
              authorities: retryTaskContext.prepared.resourceAuthorities ?? [],
            })
          : []
        const retrySkillSelection = retryTaskContext
          ? recoverCodexRetrySkillSelection(
              retryTaskContext.prepared.readyTurnToolAuthorization.skillAuthorization,
            )
          : null
        const currentResourceSelections = retrySkillSelection
          ? (request.resources ?? []).filter((selection) => selection.kind !== 'skill')
          : request.resources ?? []
        const explicitResources = await resolveCodexExplicitResources({
          selections: [
            ...currentResourceSelections,
            ...retryLocalResources.map((resource) => resource.selection),
            ...(retrySkillSelection ? [retrySkillSelection.selection] : []),
          ],
          resolveSkill: (selection) => {
            const resolved = boundHost.resolveNativeSkillInput?.({
              skillId: selection.skillId,
              path: selection.path,
            })
            return resolved ? { name: resolved.name, path: resolved.path } : null
          },
          resolveBrowser: async (selection) => (
            browserSelections[0]?.id === selection.id ? resolvedBrowserInput : null
          ),
          resolveCalendar: (selection) => {
            const eventId = persistableCalendarEventId(selection.eventId) || selection.eventId
            const event = input.database.getCalendarEventById(eventId)
            return event ? trustedCalendarReferenceInput(event) : null
          },
          resolveRssItem: (selection) => {
            const item = input.database.getRSSItemsByIds([selection.itemId])[0]
            return item ? trustedRssItemInput(item) : null
          },
          resolveRssSource: (selection) => {
            const source = input.database.getRSSSources().find((candidate) => candidate.id === selection.sourceId)
            return source ? trustedRssSourceInput(source) : null
          },
        })
        const turnResources = retrySkillSelection
          ? {
              ...explicitResources,
              requestResources: explicitResources.requestResources.map((resource) => (
                resource.kind === 'skill_reference'
                  && resource.name === retrySkillSelection.selection.skillId
                  ? {
                      ...resource,
                      applicableToolNames: retrySkillSelection.applicableToolNames,
                    }
                  : resource
              )),
            }
          : explicitResources
        if (request.explicitRetry) {
          for (const retryResource of retryLocalResources) {
            const currentReference = explicitResources.resourceRefs.find(
              (reference) => reference.logicalResourceId === retryResource.logicalResourceId,
            )
            const currentAuthority = explicitResources.authorities.find(
              (authority) => authority.logicalResourceId === retryResource.logicalResourceId,
            )
            if (!currentReference || (retryResource.directoryIdentity && (
              !currentAuthority?.directoryIdentity
              || currentAuthority.directoryIdentity.device !== retryResource.directoryIdentity.device
              || currentAuthority.directoryIdentity.inode !== retryResource.directoryIdentity.inode
              || currentAuthority.directoryIdentity.mode !== retryResource.directoryIdentity.mode
            ))) {
              throw new Error('codex_explicit_retry_resource_identity_drift')
            }
          }
          const predecessorDestination = retryTaskContext!.prepared.outputContract?.destination
          const currentDirectories = turnResources.authorities.filter(
            (authority) => authority.kind === 'local_directory',
          )
          if (predecessorDestination && currentDirectories.length === 1) {
            const current = currentDirectories[0]
            if (!current.directoryIdentity
              || current.logicalResourceId !== predecessorDestination.logicalResourceId
              || current.directoryIdentity.device !== predecessorDestination.directoryIdentity.device
              || current.directoryIdentity.inode !== predecessorDestination.directoryIdentity.inode
              || current.directoryIdentity.mode !== predecessorDestination.directoryIdentity.mode) {
              throw new Error('codex_explicit_retry_destination_identity_drift')
            }
          } else if (predecessorDestination) {
            throw new Error('codex_explicit_retry_destination_identity_drift')
          }
        }
        const currentDocumentAnchor = request.currentDocumentAnchor ?? null
        assertWidgetTargetsMatchAnchor(request.resources ?? [], currentDocumentAnchor)
        const currentDocumentWriteIntent = Boolean(currentDocumentAnchor)
          && hasExplicitCurrentDocumentWriteIntent(request.userMessage.content)
        const hasFolderExportDestination = turnResources.requestResources.some((resource) => (
          resource.kind === 'folder_reference'
        ))
        const { requestEnvelope, authorization } = resolveCodexProductTurnAuthorization({
          host: boundHost,
          request,
          scopeId: scope.id,
          externalReadSlice,
          trustedEnvironment,
          trustedResources: turnResources.requestResources,
          currentDocumentCanWrite: currentDocumentWriteIntent,
        })
        const intentClassification = classifyIntent(requestEnvelope)
        const hasMapRouteIntent = isMapSemanticIntentActive(
          classifyMapSemanticIntentFallback(requestEnvelope.primaryInstruction),
        )
        const readyMemorySnapshot = readyMemoryRepository.buildSnapshot(isoNow())
        const resolvedToolSnapshot = boundHost.resolveToolTurnSnapshot({
          surfaceId: `codex-surface:${scope.id}:${request.requestId}`,
          authorizationId: `codex-auth:${request.requestId}`,
          authorization,
          message: toRunMessage(request),
          sessionId: scope.id,
          scopeId: scope.id,
          config: profile.config,
          requestEnvelope,
          frozenToolSurface: binding.toolSurface || undefined,
        })
        const explicitAllowedToolNames = [...new Set(
          turnResources.authorities.flatMap((authority) => authority.allowedToolNames),
        )]
        const exclusiveAllowSet = authorization.mode === 'selected' && authorization.skillId === 'tag-forge'
          ? TAG_FORGE_EXCLUSIVE_TOOL_NAMES
          : null
        const mapRouteMode = hasMapRouteIntent
          ? resolvedToolSnapshot.readyTurnToolAuthorization.allowedToolNames.includes('map_plan_route')
            ? 'configured_primary' as const
            : 'public_web_fallback' as const
          : null
        const browserAdmission = buildBrowserAdmissionAuthoritySnapshot({
          authorityId: `browser-auth:${request.requestId}`,
          activeWorkbenchMode,
          currentBrowserPageRef: activeWorkbenchMode === 'browser'
            ? hostEnvironment.browserPageRef || null
            : null,
          explicitBrowserReadRefs: browserReference?.environment.browserPageRef
            ? [browserReference.environment.browserPageRef]
            : [],
          selectedSkillToolNames: authorization.mode === 'selected'
            ? [...authorization.allowedTypedActions, ...authorization.allowedPrimitives]
            : [],
          hasExplicitAttachment: turnResources.requestResources.some((resource) => resource.kind === 'attachment'),
          hasWritableRoot: turnResources.requestResources.some((resource) => (
            resource.kind === 'folder_reference' && resource.canWrite
          )),
          tagForgeExclusive: exclusiveAllowSet !== null,
        })
        const surfaceNames = new Set(resolvedToolSnapshot.readyToolSurface.toolNames)
        const capabilityAvailability = resolveReadyCapabilityTurnAvailability({
          publicResearchProviderAvailable: surfaceNames.has('web_search') || surfaceNames.has('web_fetch'),
          calendarHostAvailable: surfaceNames.has('calendar_list_window')
            || surfaceNames.has('calendar_capture_session')
            || surfaceNames.has('calendar_create_event'),
          calendarProductMapped: surfaceNames.has('calendar_create_event'),
          workbenchMode: trustedEnvironment.workbenchMode,
          currentBrowserPageRef: browserAdmission.currentBrowserRoot,
          explicitBrowserReadRefs: browserAdmission.explicitBrowserReadRefs,
          hasCalendarResource: turnResources.requestResources.some((resource) => (
            resource.kind === 'calendar_window' || resource.kind === 'calendar_event'
          )),
          tagForgeExclusive: exclusiveAllowSet !== null,
        })
        const toolSnapshot = composeCodexTurnToolSnapshot({
          resolved: resolvedToolSnapshot,
          authorizationId: `codex-auth:${request.requestId}`,
          authorization,
          currentDocument: currentDocumentAnchor
            ? { present: true, allowWrite: currentDocumentWriteIntent }
            : undefined,
          folderExport: {
            present: hasFolderExportDestination,
            allowWrite: hasFolderExportDestination,
          },
          externalReadAllowedToolNames: externalReadSlice?.allowedToolNames,
          explicitResourceAllowedToolNames: explicitAllowedToolNames,
          workbenchMode: trustedEnvironment.workbenchMode,
          exclusiveAllowSet,
          browserAdmission,
          capabilityAvailability,
          mapRouteMode,
          readyMemory: {
            enabled: readyMemorySnapshot.enabled,
            hasEntries: readyMemorySnapshot.entries.length > 0,
          },
        })
        const selectedSkill = toolSnapshot.readyTurnToolAuthorization.skillAuthorization
        const selectedNativeSkill = selectedSkill.mode === 'selected'
          ? boundHost.resolveNativeSkillInput?.({
              skillId: selectedSkill.skillId,
              authorizedToolNames: [
                ...selectedSkill.allowedTypedActions,
                ...selectedSkill.allowedPrimitives,
              ],
            }) ?? null
          : null
        if (selectedSkill.mode === 'selected' && !selectedNativeSkill) {
          throw new Error('codex_selected_skill_unavailable')
        }
        const productTaskInput = {
          skillAuthorization: selectedSkill.mode === 'selected'
            ? {
                mode: 'selected' as const,
                completionProfile: selectedNativeSkill!.completionProfile,
              }
            : { mode: 'none' as const },
          intentClassification,
          hasFolderExportDestination,
        }
        const productTaskFacts = resolveCodexProductTaskFacts(productTaskInput)
        const selectedSkillResources = selectedNativeSkill
          ? await resolveCodexExplicitResources({
              selections: [],
              resolveSkill: () => null,
              selectedSkill: {
                name: selectedNativeSkill.name,
                path: selectedNativeSkill.path,
              },
            })
          : null
        const instructionContract = resolveCodexThreadInstructionContract({
          assetRoot: verified.assetRoot,
          host: boundHost,
          skillAuthorization: selectedSkill,
        })
        const resourceReferences = [
          ...(currentDocumentAnchor ? [resourceReferenceForAnchor(currentDocumentAnchor)] : []),
          ...(externalReadSlice ? [externalReadResourceReference(externalReadSlice)] : []),
          ...turnResources.resourceRefs,
          ...(selectedSkillResources?.resourceRefs ?? []),
        ].filter((reference, index, all) => all.findIndex(
          (candidate) => candidate.logicalResourceId === reference.logicalResourceId,
        ) === index)
        const explicitResourceInput = [
          ...turnResources.input,
          ...(selectedSkillResources?.input ?? []),
        ].filter((entry, index, all) => all.findIndex((candidate) => (
          digestCanonicalJson(candidate) === digestCanonicalJson(entry)
        )) === index)
        let explicitRetry: {
          predecessorRunId: string
          historyParityEvidenceDigest: string
          currentThreadReadEvidenceDigest: string
          continuationContractDigest: string
          artifactSources: import('./codex-product-run-preparer').CodexRetryArtifactSource[]
        } | undefined
        if (request.explicitRetry) {
          const predecessorReceipt = retryPredecessorReceipt as ProductTurnReceipt
          const predecessor = retryPredecessor as ReturnType<CodexBindingRepository['readProductTurnRuntime']>
          const threadRead = binding.codexThreadId
            ? await nativeRuntime.threadRead({ threadId: binding.codexThreadId, includeTurns: true })
            : null
          const currentThreadReadEvidenceDigest = digestCanonicalJson({
            contract: 'codex_explicit_retry_thread_read_v1',
            aliasId: scope.id,
            aliasGeneration: binding.aliasGeneration,
            codexThreadId: binding.codexThreadId,
            threadRead,
          })
          const predecessorTurnPresent = !binding.codexThreadId
            || predecessor.codexThreadId !== binding.codexThreadId
            || !predecessor.codexTurnId
            || Boolean(threadRead?.thread.turns.some((turn) => turn.id === predecessor.codexTurnId))
          if (!predecessorTurnPresent) throw new Error('codex_explicit_retry_history_parity_failed')
          const historyParityEvidenceDigest = digestCanonicalJson({
            contract: 'codex_explicit_retry_history_parity_v1',
            predecessorPresentationDigest: predecessorReceipt.presentationDigest,
            predecessorProductTerminalDigest: repository.readProductCloseout(
              predecessor.readyRunId,
            )?.productTerminalDigest,
            predecessorTurnPresent,
          })
          const artifactSources = retryArtifactSources
          explicitRetry = {
            predecessorRunId: predecessor.readyRunId,
            historyParityEvidenceDigest,
            currentThreadReadEvidenceDigest,
            artifactSources,
            continuationContractDigest: digestCanonicalJson({
              contract: 'codex_explicit_retry_continuation_v1',
              predecessorRunId: predecessor.readyRunId,
              predecessorPresentationDigest: predecessorReceipt.presentationDigest,
              currentUserMessageId: request.userMessage.id,
              currentInputDigest: digestCanonicalJson(currentInput),
              resourceReferences,
              artifactSources,
            }),
          }
        }
        const preparedResult = preparer.prepare({
          taskId: `codex-task-${sha256(request.requestId).slice(0, 24)}`,
          runId: request.requestId,
          requestId: request.requestId,
          scopeId: scope.id,
          aliasId: scope.id,
          aliasGeneration: binding.aliasGeneration,
          taskOrigin: 'user_root',
          runOrigin: 'initial',
          originUserMessageId: request.userMessage.id,
          reservationSetId: reservation.reservationSetId,
          reservationEvidenceDigest: reservation.reservationEvidenceDigest,
          currentInput,
          explicitResourceEnvelope: { input: explicitResourceInput, resourceRefs: resourceReferences },
          resourceAdditionalContext: resourceReferences,
          currentDocumentAnchor,
          externalReadSlice,
          resourceAuthorities: turnResources.authorities,
          ...(executionPageRef
            ? { browserPageRef: executionPageRef }
            : {}),
          productSurfaceTargets: extractProductSurfaceTargets(request.resources ?? []),
          actionAuthorizationMode: readActionAuthorizationModeFromEnvelope(requestEnvelope),
          readyMemorySnapshot,
          readyToolSurface: toolSnapshot.readyToolSurface,
          readyTurnToolAuthorization: toolSnapshot.readyTurnToolAuthorization,
          authorizationOwnerId: scope.activeAgentId || scope.agent,
          resourceOwnerId: scope.activeAgentId || scope.agent,
          productBudgetSeed: createCodexProductBudgetSeed(productTaskInput),
          ...(explicitRetry ? { explicitRetry } : {}),
        })
        if (!preparedResult.ok) throw new Error(preparedResult.code)
        const upstream = createCodexProductUpstreamProfileSnapshot({
          profileId: profile.profileId,
          config: profile.config,
        })
        const threadBindingId = binding.threadBindingId
        if (!state) throw new Error('codex_runtime_state_unavailable')
        const isolatedThreadCwd = binding.isolatedThreadCwd || join(state.threadCwdRoot, threadBindingId)
        mkdirSync(isolatedThreadCwd, { recursive: true, mode: 0o700 })
        const turnContractDigest = digestCanonicalJson({
          runId: preparedResult.prepared.runId,
          requestId: request.requestId,
          toolSurfaceDigest: toolSnapshot.readyToolSurface.toolSurfaceDigest,
          authorizationDigest: toolSnapshot.readyTurnToolAuthorization.authorizationDigest,
          resourceAnchorDigest: preparedResult.prepared.resourceAnchorDigest,
          readyMemorySnapshotDigest: readyMemorySnapshot.snapshotDigest,
          ...(preparedResult.prepared.outputContract
            ? { outputContract: preparedResult.prepared.outputContract }
            : {}),
          ...(externalReadSlice ? {
            methodConstraintDigest: externalReadSlice.methodConstraintDigest,
            dependencySnapshotDigest: externalReadSlice.dependencySnapshotDigest,
          } : {}),
        })
        preparedDetails.set(preparedResult.prepared.runId, {
          preparedAtMs: Date.now(),
          executionBinding: await boundHost.createInitialExecutionBinding({
            runId: preparedResult.prepared.runId,
            ownerAgentIdAtStart: scope.activeAgentId || scope.agent,
          }),
          threadBindingId,
          isolatedThreadCwd,
          turnRequestId: request.requestId,
          upstream,
          developerInstructions: instructionContract.developerInstructions,
          instructionContractDigest: instructionContract.instructionContractDigest,
          turnContractDigest,
          productTaskFacts,
        })
        detailPrepared.set(preparedResult.prepared.runId, preparedResult.prepared)
        return { ok: true, dispatchContext: preparedResult.prepared }
      } catch (error) {
        const failure = classifyCodexIngressPreparationError(error)
        return {
          ok: false,
          code: failure.code,
          retryableByUser: failure.retryableByUser,
          error: failure.error,
          admissionEvidenceDigest: digestCanonicalJson({ scopeId: scope.id, requestId: request.requestId, stage: 'prepare' }),
        }
      }
    },
    async persistIngressAtomic({ scope, request, reservation, prepared }) {
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || detailPrepared.get(prepared.runId) !== prepared || !host) {
        throw new IngressPersistenceError('ingress_transaction_failed', sha256(`missing:${prepared.runId}`), 'codex_prepared_detail_missing')
      }
      const admittedAt = isoNow()
      const eventBase = {
        type: 'ingress_admitted' as const,
        requestId: request.requestId,
        scopeId: scope.id,
        originUserMessageId: request.userMessage.id,
        aliasGeneration: prepared.conversationAlias.aliasGeneration,
        ingressAdmittedRevision: 1,
        admittedAt,
      }
      try {
        rawDb.exec('BEGIN IMMEDIATE')
        assertCodexProfileRouteCurrent({ settings: input.settings, expected: detail.upstream })
        const scopeEpoch = rawDb.prepare(`
          SELECT message_visibility_epoch
            FROM chat_conversations
           WHERE id = ? AND closed_at IS NULL
           LIMIT 1
        `).get<{ message_visibility_epoch: number }>(scope.id)
        if (!scopeEpoch || !Number.isSafeInteger(scopeEpoch.message_visibility_epoch)) {
          throw new Error('codex_message_visibility_scope_missing')
        }
        const messageVisibilityEpoch = scopeEpoch.message_visibility_epoch
        if (request.expectedMessageVisibilityEpoch !== messageVisibilityEpoch
          || (
            typeof request.expectedAliasGeneration === 'number'
            && request.expectedAliasGeneration > prepared.conversationAlias.aliasGeneration
          )) {
          throw new Error('codex_ingress_expected_identity_mismatch')
        }
        const admissionWithoutDigest = {
          prepared,
          reservation,
          ownerMainBootId,
          admittedAt,
          ingressAdmittedRevision: 1,
          threadBindingId: detail.threadBindingId,
          isolatedThreadCwd: detail.isolatedThreadCwd,
          turnRequestId: detail.turnRequestId,
          runtimeManifestDigest: verified.manifestDigest,
          protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
          instructionContractDigest: detail.instructionContractDigest,
          codexModel: 'ready-e0-model',
          upstreamProfileSnapshotRef: detail.upstream.snapshotRef,
          upstreamProfileSnapshotDigest: detail.upstream.snapshotDigest,
          additionalContextDigest: digestReadyAdditionalContext({
            resourceReferences: prepared.ingress.kind === 'user_ingress'
              ? prepared.ingress.resourceAdditionalContext
              : [],
            explicitRetry: prepared.ingress.kind === 'user_ingress'
              && prepared.ingress.attemptKind === 'explicit_retry'
              ? buildCodexExplicitRetryContext(prepared.ingress)
              : null,
            readyMemory: readyMemoryPromptPayload(prepared.readyMemorySnapshot),
          }),
          turnContractDigest: detail.turnContractDigest,
          messageVisibilityEpoch,
          readyParentReceipt: {
            messageRole: 'user' as const,
            messageContent: request.userMessage.content,
            messageTimestamp: request.userMessage.timestamp,
            messageMetaDigest: digestCanonicalJson(request.userMessage.meta),
            executionBindingDigest: digestCanonicalJson(detail.executionBinding),
          },
        }
        const ingressAdmittedDigest = buildCodexIngressAdmittedDigest(admissionWithoutDigest)
        const existing = rawDb.prepare('SELECT 1 AS present FROM chat_messages WHERE id = ? LIMIT 1').get(request.userMessage.id)
        if (existing) throw new Error('codex_origin_message_already_exists')
        input.database.addChatMessage(
          request.userMessage.id,
          scope.id,
          'user',
          request.userMessage.content,
          request.userMessage.timestamp,
          request.userMessage.meta,
          messageVisibilityEpoch,
        )
        host.getTaskProjectionStore().create({
          taskId: prepared.taskId,
          scopeId: scope.id,
          messageVisibilityEpoch,
          runId: prepared.runId,
          ...detail.productTaskFacts,
          taskTitle: prepared.neutralProjectionSeed.taskTitle,
          taskSummary: prepared.neutralProjectionSeed.taskSummary,
          status: 'running',
          interactionState: 'running',
          waitingFor: 'none',
          steps: [],
          ownerAgentId: scope.activeAgentId || scope.agent,
          taskOrigin: 'user_root',
          executionBinding: detail.executionBinding,
          createdAt: admittedAt,
          updatedAt: admittedAt,
        }, { silent: true, reasonHint: 'create' })
        host.createCodexActiveRunMetaInOpenTransaction({
          runId: prepared.runId,
          taskId: prepared.taskId,
          scopeId: scope.id,
          messageVisibilityEpoch,
          agentId: scope.activeAgentId || scope.agent,
          executionBinding: detail.executionBinding,
          taskType: detail.productTaskFacts.taskType,
        })
        gatewayRepository.storeSnapshot({ ...detail.upstream, createdAt: admittedAt })
        repository.admitProductBindingsInOpenTransaction({
          ...admissionWithoutDigest,
          ingressAdmittedDigest,
        })
        rawDb.exec('COMMIT')
        const attachmentConfirmation = resolveAttachmentConfirmation(
          request.userMessage.attachmentConfirmation,
        )
        return {
          persistence: {
            scope: 'pre-existing',
            message: 'persisted',
            ...attachmentConfirmation,
          },
          event: { ...eventBase, messageVisibilityEpoch, ingressAdmittedDigest },
        }
      } catch (error) {
        if (rawDb.inTransaction) rawDb.exec('ROLLBACK')
        throw new IngressPersistenceError(
          'ingress_transaction_failed',
          digestCanonicalJson({ runId: prepared.runId, stage: 'atomic_ingress' }),
          stableErrorCode(error, 'codex_ingress_transaction_failed'),
        )
      }
    },
  }

  const preparedRunContextPort: CodexPreparedRunContextPort = {
    async resolve({ prepared, scope }) {
      gate.assertOpen()
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || scope.id !== prepared.readyToolHostIdentity.scopeId) throw new Error('codex_prepared_context_mismatch')
      const activityHost = host
      const taskActivityProjector = activityHost
        ? createCodexTaskActivityProjector({
          store: activityHost.getTaskProjectionStore(),
          publish: (patch) => activityHost.publishActivityProjection({
            type: 'updated',
            scopeId: scope.id,
            aliasGeneration: prepared.conversationAlias.aliasGeneration,
            messageVisibilityEpoch: scope.messageVisibilityEpoch,
            visibilityOwnerKind: 'product_alias',
            agent: scope.agent,
            ownerAgentId: scope.activeAgentId || scope.agent,
            taskOrigin: 'user_root',
            handoffGeneration: scope.handoffGeneration,
            runId: prepared.runId,
            taskId: prepared.taskId,
            module: prepared.externalReadSlice?.kind === 'lark_cli_read' ? 'feishu' : 'system',
            taskProjectionId: prepared.taskId,
            ...patch,
          }),
          taskId: prepared.taskId,
          runId: prepared.runId,
          messageVisibilityEpoch: scope.messageVisibilityEpoch,
          larkCliRead: prepared.externalReadSlice?.kind === 'lark_cli_read',
        })
        : null
      return {
        turnBuildContext: {
          turnRequestId: detail.turnRequestId,
          reasoningEffort: resolveCodexNativeModelSettings(
            detail.upstream.snapshot,
          ).reasoningEffort,
          readyRunId: prepared.runId,
          toolSurfaceDigest: prepared.readyToolSurface.toolSurfaceDigest,
          turnContractDigest: detail.turnContractDigest,
          upstreamProfileSnapshotDigest: detail.upstream.snapshotDigest,
          readyMemorySnapshot: prepared.readyMemorySnapshot,
        },
        collection: {
          terminalTimeoutMs: 300_000,
          actionReceiptRefs: [],
          interactionState: null,
          waitingFor: null,
          terminalReasonCandidate: 'done',
          abortInitiator: null,
          budgetState: { ...prepared.productBudgetSeed },
          contextState: {
            resourceAnchorDigest: prepared.resourceAnchorDigest,
            automaticCompactionExchanges: [],
          },
          providerDiagnostics: { provider: 'ready_gateway', agentProtocol: 'openai', wireApi: 'responses' },
          recoveryCheckpointRef: null,
          browserContinuationRef: null,
          browserProofRefs: [],
          otherProofRefs: [],
          projectionPatchRefs: [],
          allowNullPhaseFallback: false,
          allowDirectProvisionalStream: codexAllowsDirectProvisionalStream(prepared),
          onActivity(event) {
            taskActivityProjector?.observe(event)
          },
          onProvisionalDelta(event) {
            if (!codexAllowsDirectProvisionalStream(prepared)) return
            host?.emitProvisionalDelta({
              scopeId: scope.id,
              aliasGeneration: prepared.conversationAlias.aliasGeneration,
              messageVisibilityEpoch: scope.messageVisibilityEpoch,
              agent: scope.agent,
              ownerAgentId: scope.activeAgentId || scope.agent,
              handoffGeneration: scope.handoffGeneration,
              runId: prepared.runId,
              taskId: prepared.taskId,
              delta: event.delta,
            })
          },
        },
      }
    },
  }

  const startRuntime = async (): Promise<boolean> => {
    if (!host) throw new Error('codex_runtime_host_unbound')
    if (gatewayNeedsReplacement) {
      gateway = createGateway()
      gatewayNeedsReplacement = false
    }
    const address = gatewayAddress || await gateway.start()
    gatewayAddress = address
    state = prepareCodexRuntimeState({
      userDataPath: input.userDataPath,
      gatewayUrl: `${address.url}/v1`,
      contracts: verified.contracts,
    })
    const inspector = new MacCodexProcessInspector()
    const mainProcess = (await inspector.list()).find((entry) => entry.pid === process.pid)
    if (!mainProcess) throw new Error('codex_main_process_identity_unavailable')
    supervisor = new CodexSidecarSupervisor({
      runtime: verified,
      state,
      spawnCapability: {
        activate(identities) {
          const capability = gateway.activateSpawn(identities.sidecarSpawnInstanceId)
          const gatewaySpawnConfig = activateCodexGatewaySpawnConfig({
            state: state as PreparedCodexRuntimeState,
            sidecarSpawnInstanceId: identities.sidecarSpawnInstanceId,
            gatewayUrl: `${capability.url}/v1`,
            gatewayToken: capability.bearerToken,
            contracts: verified.contracts,
          })
          return buildCodexChildEnvironment({ state: state as PreparedCodexRuntimeState, ...identities, gatewaySpawnConfig })
        },
        revoke(spawnId) { gateway.revokeSpawn(spawnId) },
      },
      leaseStore: repository,
      inspector,
      spawnPort: new NodeCodexSidecarSpawnPort(),
      ownerMainBootId,
      ownerMainPid: process.pid,
      ownerMainProcessStartIdentity: mainProcess.processStartIdentity,
    })
    const journal = new CodexToolActionJournal(rawDb)
    const larkRequiredResourceReads = new Map<string, Set<string>>()
    const toolBridge = createCodexReadyToolBridge({
      persistence: repository,
      receipts: journal,
      buildToolContext(binding, abortSignal, executionIdentity) {
        const scope = host?.getScope(binding.readyScopeId) || null
        const product = repository.readProductTurnRuntime(binding.readyRunId)
        const anchor = product.ingress.kind === 'user_ingress'
          ? product.ingress.currentDocumentAnchor || null
          : null
        const externalReadSlice = product.prepared.externalReadSlice || null
        const taskProjection = host?.runtime
          .getTaskProjectionStoreForFinalize()
          .get(binding.readyTaskId) || null
        const executionBinding = taskProjection?.executionBinding || null
        const larkReadSet = externalReadSlice?.kind === 'lark_cli_read'
          ? larkRequiredResourceReads.get(binding.readyRunId) || new Set<string>()
          : null
        if (larkReadSet && !larkRequiredResourceReads.has(binding.readyRunId)) {
          larkRequiredResourceReads.set(binding.readyRunId, larkReadSet)
        }
        let browserTurnLease = browserTurnLeases.get(binding.readyRunId) || null
        if (
          host?.browserController
          && binding.authorization.allowedToolNames.some((toolName) => toolName.startsWith('browser_'))
          && !browserTurnLease
        ) {
          browserTurnLease = createBrowserTurnLease({
            taskId: binding.readyTaskId,
            runId: binding.readyRunId,
          })
          browserTurnLeases.set(binding.readyRunId, browserTurnLease)
        }
        return {
          runtime: host?.runtime || null,
          browserController: host?.browserController || null,
          sidecarManager: host?.sidecarManager || null,
          scope,
          agent: scope?.activeAgentId || scope?.agent || null,
          sessionId: binding.readyAliasId,
          scopeId: binding.readyScopeId,
          messageVisibilityEpoch: product.messageVisibilityEpoch,
          runId: binding.readyRunId,
          taskId: binding.readyTaskId,
          sourceMessageId: product.ingress.originUserMessageId,
          readyMemorySnapshot: binding.readyMemorySnapshot,
          executionBinding,
          browserLease: browserTurnLease,
          ensureBrowserWorkflowRoute: executionBinding
            ? async () => host!.runtime.getAgentSessionCheckpointRepository().bindBrowserWorkflowRoute({
                parentTaskId: binding.readyTaskId,
                ownerRunId: binding.readyRunId,
                sourceMessageId: product.ingress.originUserMessageId,
                executionBinding,
                resourceAnchors: [],
              })
            : undefined,
          requestEnvelope: {
            ...readCodexPreparedActionAuthorizationEnvelope(product),
            folderOutputActivation: readCodexFolderOutputActivation(rawDb, binding.readyRunId),
          },
          artifactMaterializer,
          readArtifactWriteHead: (relativePath: string) => (
            repository.readArtifactWriteHead(binding.readyRunId, relativePath)
          ),
          codexExecutionIdentity: {
            readyActionId: executionIdentity.readyActionId,
            actionIdentityDigest: executionIdentity.actionIdentityDigest,
          },
          requestModuleToolAction: createCodexProductActionRequester({
            executingToolName: executionIdentity.executingToolName,
            allowedToolNames: binding.authorization.allowedToolNames,
            readyRunId: binding.readyRunId,
            scopeId: binding.readyScopeId,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            codexThreadId: executionIdentity.codexThreadId,
            codexTurnId: executionIdentity.codexTurnId,
            codexCallId: executionIdentity.codexCallId,
            readyActionId: executionIdentity.readyActionId,
            actionIdentityDigest: executionIdentity.actionIdentityDigest,
            abortSignal,
            journal,
            assertEffectAuthority: () => {
              if (abortSignal.aborted) throw new CodexToolBridgeError('tool_execution_aborted')
              const currentScope = host?.getScope(binding.readyScopeId)
              if (!currentScope || currentScope.messageVisibilityEpoch !== product.messageVisibilityEpoch) {
                throw new CodexToolBridgeError('product_action_authority_drift')
              }
              const current = repository.readProductTurnRuntime(binding.readyRunId)
              if (current.readyRunId !== binding.readyRunId) {
                throw new CodexToolBridgeError('product_action_authority_drift')
              }
            },
            handlers: createProductionProductActionHandlers({
              database: input.database,
              rss: {
                async fetchUpdates() {
                  const { fetchAllRSSFeeds } = await import('../../rss-engine/ipc-handler')
                  return fetchAllRSSFeeds()
                },
                async addSource(payload) {
                  const { addRSSSourceCore } = await import('../../rss-engine/ipc-handler')
                  return addRSSSourceCore(payload)
                },
                async analyzeItem(payload) {
                  const { getRSSItemAnalysisManager } = await import('../../rss-engine/item-analysis-manager')
                  const job = await getRSSItemAnalysisManager().startItemAnalysis({
                    itemId: payload.itemId,
                    action: payload.analysisType,
                    link: payload.link,
                    title: payload.title,
                    targetDir: join(input.userDataPath, 'rss-analysis'),
                    source: payload.source,
                    summary: payload.summary,
                    force: true,
                  })
                  const failed = job.status === 'failed'
                  return {
                    ok: !failed,
                    summary: failed
                      ? `RSS 条目分析失败：${payload.title}`
                      : `RSS 条目分析已启动：${payload.title}`,
                    jobId: job.id,
                    status: job.status,
                    itemId: payload.itemId,
                    outputDir: job.output_dir,
                    reportPath: job.report_path,
                    errorKind: failed ? 'rss_analyze_failed' : undefined,
                  }
                },
              },
              requestRendererToolAction: input.requestRendererToolAction,
              documentRequester: anchor
                ? createCurrentDocumentReadRequester({
                    anchor,
                    agent: scope?.activeAgentId || scope?.agent,
                    sessionId: binding.readyAliasId,
                    scopeId: binding.readyScopeId,
                    readyRunId: binding.readyRunId,
                    codexThreadId: executionIdentity.codexThreadId,
                    codexTurnId: executionIdentity.codexTurnId,
                    codexCallId: executionIdentity.codexCallId,
                    readyActionId: executionIdentity.readyActionId,
                    actionIdentityDigest: executionIdentity.actionIdentityDigest,
                    resourceAnchorDigest: binding.authorization.resourceAnchorDigest,
                    abortSignal,
                    requestRendererToolAction: input.requestRendererToolAction,
                    allowWrite: binding.authorization.allowedToolNames.some((toolName) => (
                      toolName === 'document_insert_widget'
                      || toolName === 'document_update_widget'
                      || toolName === 'document_remove_widget'
                      || toolName === 'document_replace_exact'
                      || toolName === 'document_save_tab'
                    )),
                    hasExactRead: () => currentDocumentExactReadRuns.has(binding.readyRunId),
                    onExactRead: () => { currentDocumentExactReadRuns.add(binding.readyRunId) },
                  })
                : undefined,
              targets: product.prepared.productSurfaceTargets,
              recordListedCalendarEventIds: (eventIds) => {
                calendarListedEventIdsByRun.set(binding.readyRunId, [...eventIds])
              },
              listedCalendarEventIds: () => calendarListedEventIdsByRun.get(binding.readyRunId) || [],
              onCalendarMutated: (eventId) => {
                void calendarNotifyReady.then((notify) => { notify?.(eventId) })
              },
              agent: scope?.activeAgentId || scope?.agent || undefined,
              sessionId: binding.readyAliasId,
              runId: binding.readyRunId,
              codexThreadId: executionIdentity.codexThreadId,
              codexTurnId: executionIdentity.codexTurnId,
              codexCallId: executionIdentity.codexCallId,
              readyActionId: executionIdentity.readyActionId,
              actionIdentityDigest: executionIdentity.actionIdentityDigest,
              abortSignal,
            }),
          }),
          feishuReadAuthority: externalReadSlice?.kind === 'feishu_typed_read'
            ? externalReadSlice.authority
            : null,
          runShellRequiredMethod: externalReadSlice?.kind === 'lark_cli_read'
            ? externalReadSlice.requiredMethod
            : null,
          larkCliExecutableAuthority: externalReadSlice?.kind === 'lark_cli_read'
            ? externalReadSlice.requiredMethod.executableAuthority
            : null,
          runShellRequiredMethodPreflight: externalReadSlice?.kind === 'lark_cli_read'
            ? async () => {
                const current = await readLarkCliAuthReadback({
                  executableAuthority: externalReadSlice.requiredMethod.executableAuthority,
                })
                if (current.authReadbackDigest !== externalReadSlice.authReadback.authReadbackDigest) {
                  throw new Error('codex_external_read_lark_auth_identity_drift')
                }
              }
            : null,
          assertRequiredResourcesRead: externalReadSlice?.kind === 'lark_cli_read'
            ? () => {
                const required = externalReadSlice.requiredResources.map((resource) => resource.logicalPath)
                if (!larkReadSet || required.some((logicalPath) => !larkReadSet.has(logicalPath))) {
                  throw new Error('codex_external_read_lark_required_resources_unread')
                }
              }
            : null,
          readArtifactRequiredResources: externalReadSlice?.kind === 'lark_cli_read'
            ? externalReadSlice.requiredResources.map((resource) => ({
                logicalPath: resource.logicalPath,
                root: resource.rootKind === 'selected_skill'
                  ? externalReadSlice.skillRoot
                  : externalReadSlice.siblingReadRoots[0],
                relativePath: resource.relativePath,
                sha256: resource.sha256,
                fileIdentity: resource.fileIdentity,
              }))
            : null,
          onExactResourceRead: externalReadSlice?.kind === 'lark_cli_read'
            ? (logicalPath: string) => {
                if (externalReadSlice.requiredResources.some((resource) => resource.logicalPath === logicalPath)) {
                  larkReadSet?.add(logicalPath)
                }
              }
            : null,
          activeFrame: externalReadSlice?.kind === 'lark_cli_read'
            ? {
                activeArtifactRoots: [],
                activeReadOnlyRoots: [],
                runContract: null,
                discoveredHandles: [],
                resumableCandidates: [],
              }
            : null,
        }
      },
      getAbortSignal(binding) {
        return host?.getActiveRunAbortSignal({
          readyRunId: binding.readyRunId,
          readyScopeId: binding.readyScopeId,
          readyAliasId: binding.readyAliasId,
        }) || null
      },
      getSensitiveValues() {
        return input.settings.getAIWorkspace().profiles.flatMap((profile) => profile.config.apiKey ? [profile.config.apiKey] : [])
      },
      async awaitInteractionResolution() {
        throw new CodexToolBridgeError('tool_interaction_requires_ready_confirmation')
      },
      isConnectionLive(epoch) { return sidecarSession?.isConnectionLive(epoch) || false },
      getConnectionAbortSignal(epoch) { return sidecarSession?.getConnectionAbortSignal(epoch) || null },
      now: isoNow,
      timeoutMs: 120_000,
    })
    const pendingHostFailureSettlements = new Map<string, HostFailureSettlement>()
    const commitHostFailureTerminal = async (
      failure: CodexHostFailureRecovery,
    ): Promise<{ productTerminalDigest: string; closeoutAt: string }> => {
      const settlement = await closePersistedHostFailure(failure)
      pendingHostFailureSettlements.set(failure.readyRunId, settlement)
      return {
        productTerminalDigest: settlement.productTerminalDigest,
        closeoutAt: settlement.closeoutAt,
      }
    }
    const deliverHostFailureTerminal = async (
      failure: CodexHostFailureRecovery,
    ): Promise<void> => {
      const settlement = pendingHostFailureSettlements.get(failure.readyRunId)
        || await closePersistedHostFailure(failure)
      pendingHostFailureSettlements.delete(failure.readyRunId)
      deliverRecoveredCloseout(settlement.readyRunId, settlement.result)
    }
    const settleHostFailure = async (
      readyRunId: string,
      activeRegistry: CodexStartIdentityRegistry,
    ): Promise<void> => {
      const failure = repository.readRecoverySnapshot(
        (epoch) => sidecarSession?.isConnectionLive(epoch) || false,
      ).hostFailureCloseouts.find((entry) => entry.readyRunId === readyRunId)
      if (!failure) return
      const settlement = await closePersistedHostFailure(failure)
      releaseHostFailureReservationIfPresent(activeRegistry, settlement)
      deliverRecoveredCloseout(settlement.readyRunId, settlement.result)
    }
    productRecovery = new CodexProductBootRecovery({
      repository,
      runtime: () => (sidecarSession as CodexSidecarSession).getClient(),
      collector,
      closeCandidate,
      publishRecoveredCloseout(readyRunId, result) {
        deliverRecoveredCloseout(readyRunId, result as ReadyClosedCodexProductRun)
      },
      async onRecoveryFailure(readyRunId, error) {
        await routeCodexBootRecoveryFailure({
          error,
          async settleRunLocal(code) {
            const browserWorkflowCode = recoverableBrowserWorkflowCode(error)
            if (browserWorkflowCode) {
              const product = repository.readProductTurnRuntime(readyRunId)
              await settleEngineTerminalFailure({
                identity: {
                  aliasId: product.readyAliasId,
                  aliasGeneration: product.aliasGeneration,
                },
                readyRunId,
                status: 'error',
                terminalReason: 'blocked_external',
                initiator: 'codex_recovery',
                error: browserWorkflowCode,
              })
            } else {
              const recovered = await closeRunLocalRecoveryFailure(readyRunId, code)
              deliverRecoveredCloseout(readyRunId, recovered)
            }
            logAgentMetric('codex_product_recovery_retired', { readyRunId, reason: code })
          },
          failGlobal(code) { failRuntimeForProductRecovery(readyRunId, code) },
        })
      },
      settleHostFailure,
      restoreActiveProductRun(product) {
        const boundHost = host
        if (!boundHost) throw new Error('codex_runtime_host_not_bound')
        boundHost.restoreActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          requestId: product.prepared.ingressBinding.requestId,
        })
      },
      abortActiveProductRun(product) {
        return host?.abortActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
        }) || false
      },
      finishActiveProductRun(product) {
        host?.finishActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          requestId: product.prepared.ingressBinding.requestId,
        })
      },
      ownerMainBootId,
      resolveDeveloperInstructions(product) {
        const selectedSkill = product.prepared.readyTurnToolAuthorization.skillAuthorization
        return resolveCodexThreadInstructionContract({
          assetRoot: verified.assetRoot,
          host,
          skillAuthorization: selectedSkill,
          expectedDigest: product.instructionContractDigest,
        }).developerInstructions
      },
      resolveNativeModelSettings(product) {
        return resolveCodexNativeModelSettings(gatewayRepository.readSnapshot(
          product.upstreamProfileSnapshotRef,
          product.upstreamProfileSnapshotDigest,
        ))
      },
      verifyAutomaticCompaction({ product, thread, turn }) {
        if (!product.codexThreadId || !product.codexTurnId || turn.id !== product.codexTurnId) {
          throw new Error('codex_recovered_automatic_compaction_identity_mismatch')
        }
        return verifyCodexAutomaticCompactionEvidence({
          gatewayRepository,
          readyRunId: product.readyRunId,
          codexThreadId: product.codexThreadId,
          codexTurnId: product.codexTurnId,
          upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
          productToolSurfaceDigest: product.toolSurfaceDigest,
          thread,
        })
      },
    })
    const runBoot = async (): Promise<boolean> => {
      if (!await productRecovery?.beginBootGeneration()) return false
      if (!await manualCompactionController.beginBootGeneration()) return false
      const restartSweepAt = isoNow()
      const pendingInteractions = scanCodexPendingInteractionsForRestart({
        db: rawDb,
        repository,
        cancelledAt: restartSweepAt,
      })
      for (const plan of pendingInteractions.closeoutPlans) {
        try {
          const recovered = await closeRunLocalRecoveryFailure(
            plan.readyRunId,
            'codex_pending_interaction_cancelled_app_restart',
            plan,
          )
          collector.deliverRecoveredCandidate(
            buildCodexPendingInteractionRestartCandidate(plan),
          )
          deliverRecoveredCloseout(plan.readyRunId, recovered)
          logAgentMetric('codex_pending_interaction_restart_closed', {
            readyRunId: plan.readyRunId,
            interactionCount: plan.interactions.length,
          })
        } catch (error) {
          logAgentMetric('codex_pending_interaction_restart_closeout_failed', {
            readyRunId: plan.readyRunId,
            reason: stableErrorCode(error, 'pending_interaction_restart_closeout_failed'),
          })
          try {
            cancelCodexPendingInteractionsWithoutRunCloseout({
              db: rawDb,
              interactions: plan.interactions,
              cancelledAt: restartSweepAt,
              disposition: 'run_closeout_failed',
            })
            settleCodexPendingInteractionsInMemoryAfterCommit(plan.interactions)
          } catch (cancelError) {
            logAgentMetric('codex_pending_interaction_restart_cancel_only_failed', {
              readyRunId: plan.readyRunId,
              interactionCount: plan.interactions.length,
              reason: stableErrorCode(cancelError, 'pending_interaction_restart_cancel_only_failed'),
            })
          }
        }
      }
      for (const interaction of pendingInteractions.cancelOnly) {
        try {
          cancelCodexPendingInteractionsWithoutRunCloseout({
            db: rawDb,
            interactions: [interaction],
            cancelledAt: restartSweepAt,
          })
          settleCodexPendingInteractionsInMemoryAfterCommit([interaction])
        } catch (error) {
          logAgentMetric('codex_pending_interaction_restart_cancel_only_failed', {
            readyRunId: interaction.readyRunId,
            interactionId: interaction.interactionId,
            reason: stableErrorCode(error, 'pending_interaction_restart_cancel_only_failed'),
          })
        }
      }
      assertCodexPendingInteractionRestartSweepComplete({
        db: rawDb,
        repository,
        cancelledAt: restartSweepAt,
      })
      const currentBootGeneration = ++bootGeneration
      const canCommitBoot = () => (
        currentBootGeneration === bootGeneration
        && lifecycle !== 'failed'
        && lifecycle !== 'stopping'
        && lifecycle !== 'stopped'
      )
      loadedThreads.clear()
      const currentState = state
      const currentSupervisor = supervisor
      if (!currentState || !currentSupervisor) throw new Error('codex_boot_dependencies_missing')
      const rejectionResolver = new CodexLiveStartRejectionResolver({
        runtime: nativeRuntime,
        repository,
        pinnedThreadSource: verified.contracts.turnClientIdentityExtractionContract
          .thread_start.pinnedAppServerSource,
        threadListLimit: 100,
        stableZeroReadCount: 2,
        waitBetweenZeroReads: () => new Promise((resolve) => setTimeout(resolve, 25)),
        isConnectionLive: (connectionEpoch) => sidecarSession?.isConnectionLive(connectionEpoch) || false,
      })
      sidecarSession = new CodexSidecarSession({
        runtime: verified,
        state: currentState,
        repository,
        supervisor: currentSupervisor,
        evidenceResolver: rejectionResolver,
        serverRequestExecutor: toolBridge,
        requestTimeoutMs: 30_000,
        inboundDeadlineMs: 30_000,
        inboundMaxFrames: 256,
        inboundMaxBytes: 2 * 1024 * 1024,
        threadArchiveDispatchPort,
        now: isoNow,
        nowMs: Date.now,
        onProtocolFailure({ code, method }) {
          logAgentMetric('codex_sidecar_protocol_failure', { code, method })
        },
        onUnexpectedCloseDetected() {
          productRecovery?.cancelBootGeneration()
          manualCompactionController.cancelBootGeneration()
        },
        onUnexpectedClose(settlement) {
          gate.close('sidecar_connection_closed')
          loadedThreads.clear()
          nativeRuntime.detachClient()
          void sidecarRecoveryOwner.recover({
            trigger: 'unexpected_close',
            prerequisite: settlement,
          }).catch((error) => {
            logAgentMetric('codex_sidecar_recovery_exhausted', {
              trigger: 'unexpected_close',
              reason: stableErrorCode(error, 'sidecar_recovery_exhausted'),
            })
          })
        },
      })
      const actions = new CodexDefaultBootRecoveryActions({
        runtime: nativeRuntime,
        repository,
        pinnedThreadSource: verified.contracts.turnClientIdentityExtractionContract.thread_start.pinnedAppServerSource,
        threadListLimit: 100,
        stableZeroReadCount: 2,
        waitBetweenZeroReads: async () => undefined,
        heldStartDispatcher: {
          async dispatch(input) {
            return (productRecovery as CodexProductBootRecovery).dispatchHeldStart(input)
          },
        },
        absenceProof: {
          async prove({ member, stableReadbackEvidenceDigest }) {
            return proveCodexStableStartAbsence({
              repository, ownerMainBootId, member, stableReadbackEvidenceDigest,
            })
          },
        },
        hostFailureTerminal: {
          commit: commitHostFailureTerminal,
          deliver: deliverHostFailureTerminal,
        },
        manualCompaction: {
          async reconcile(manual) {
            await manualCompactionController.reconcileRecovery(manual)
          },
        },
        productFence: {
          async reconcile(fence) {
            await (productRecovery as CodexProductBootRecovery).reconcileProductFence(fence)
          },
        },
      })
      const boot = new CodexRuntimeBootReconciler({
        runtime: verified,
        repository,
        supervisor: currentSupervisor,
        sidecarSession,
        actions,
        threadArchiveCleanup,
        ingressGate: gate,
        canCommitBoot,
        now: isoNow,
      })
      const result = await boot.boot()
      if (!canCommitBoot()) {
        gate.close('boot_reconciliation_cancelled')
        await sidecarSession?.stop()
        nativeRuntime.detachClient()
        return false
      }
      registry = result.registry
      nativeRuntime.attach(sidecarSession.getClient())
      return true
    }
    bootOnceImplementation = runBoot
    return runBoot()
  }

  const sidecarRecoveryOwner = new CodexSidecarRecoveryOwner({
    maxAttempts: CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT,
    bootOnce() {
      return bootOnceImplementation ? bootOnceImplementation() : startRuntime()
    },
    async settleFailedAttempt() {
      loadedThreads.clear()
      nativeRuntime.detachClient()
      const settlementErrors: unknown[] = []
      try { await sidecarSession?.stop() } catch (error) { settlementErrors.push(error) }
      if (!bootOnceImplementation) {
        const failedGateway = gateway
        gatewayAddress = null
        gatewayNeedsReplacement = true
        state = null
        supervisor = null
        sidecarSession = null
        registry = null
        productRecovery = null
        try { await failedGateway.stop() } catch (error) { settlementErrors.push(error) }
      }
      if (settlementErrors.length > 0) {
        throw new AggregateError(settlementErrors, 'sidecar_failed_attempt_settlement_unproven')
      }
    },
    resetAttemptBudget() {
      supervisor?.resetCrashBudgetForExplicitRetry()
    },
    shouldRetryFailure() {
      return lifecycle !== 'failed'
    },
    onSnapshot(snapshot) {
      logAgentMetric('codex_sidecar_recovery_state', snapshot)
      if (lifecycle === 'stopping' || lifecycle === 'stopped') return
      if (snapshot.state === 'recovering') lifecycle = 'recovering'
      if (snapshot.state === 'ready') {
        lifecycle = 'running'
        memoryWorker.start()
      }
      if (snapshot.state === 'exhausted') {
        lifecycle = 'failed'
        gate.close('sidecar_recovery_exhausted')
      }
    },
  })

  return {
    nativeRuntime,
    collector,
    lifecycleAdapter,
    startIdentityPort,
    ingressPort,
    aliasBindingPort,
    preparedRunContextPort,
    memoryRuntime,
    canonicalCloseoutTransactionParticipant: participant,
    readProductTurnPresentation(readyRunId) {
      return repository.readProductTurnPresentation(readyRunId)
    },
    readProductTurnPresentations(readyRunIds) {
      return repository.readProductTurnPresentations(readyRunIds)
    },
    async readRuntimeDiagnostics() {
      const unavailable = {
        status: 'unavailable' as const,
        runtimeVersion: verified.manifest.codexVersion,
        binarySha256: verified.manifest.binarySha256,
        connectionEpoch: null,
        process: null,
        gauges: [],
      }
      const session = sidecarSession
      if (lifecycle !== 'running' || !session) return unavailable
      try {
        const connectionEpoch = session.getActiveConnectionEpoch()
        const diagnostics = await nativeRuntime.serverDiagnostics()
        if (!session.isConnectionLive(connectionEpoch)) return unavailable
        return {
          status: 'available' as const,
          runtimeVersion: verified.manifest.codexVersion,
          binarySha256: verified.manifest.binarySha256,
          connectionEpoch,
          process: diagnostics.process,
          gauges: diagnostics.gauges,
        }
      } catch {
        return unavailable
      }
    },
    bindHost(boundHost) {
      if (host && host !== boundHost) throw new Error('codex_runtime_host_already_bound')
      if (lifecycle !== 'new') throw new Error('codex_runtime_host_bind_too_late')
      host = boundHost
    },
    sealIngress(reason) { gate.close(reason) },
    async ensureReadyForUserIngress() {
      if (lifecycle === 'running') {
        gate.assertOpen()
        return
      }
      if (lifecycle === 'stopping' || lifecycle === 'stopped') {
        throw new Error('codex_runtime_stopped')
      }
      const committed = await sidecarRecoveryOwner.ensureReadyForUserIngress()
      if (!committed) throw new Error('codex_runtime_retry_cancelled')
      gate.assertOpen()
    },
    async start() {
      if (lifecycle !== 'new') throw new Error('codex_runtime_start_state_invalid')
      lifecycle = 'starting'
      gate.close('runtime_starting')
      try {
        const committed = await sidecarRecoveryOwner.recover({ trigger: 'initial_start' })
        if (committed && lifecycle === 'starting') {
          lifecycle = 'running'
          memoryWorker.start()
        }
      } catch (error) {
        if (sidecarRecoveryOwner.readSnapshot().state !== 'blocked') {
          gate.close('sidecar_recovery_exhausted')
        }
        lifecycle = 'failed'
        throw error
      }
    },
    async stop() {
      if (lifecycle === 'stopped') return
      gate.close('runtime_stopping')
      lifecycle = 'stopping'
      bootGeneration += 1
      sidecarRecoveryOwner.stop()
      const stopErrors: unknown[] = []
      try { await memoryWorker.stop() } catch (error) { stopErrors.push(error) }
      try { await productRecovery?.stop() } catch (error) { stopErrors.push(error) }
      try { await manualCompactionController.stop() } catch (error) { stopErrors.push(error) }
      try { await sidecarSession?.stop() } catch (error) { stopErrors.push(error) }
      nativeRuntime.detachClient()
      try { await sidecarRecoveryOwner.drain() } catch (error) { stopErrors.push(error) }
      gate.close('runtime_stopped')
      try { await gateway.stop() } catch (error) { stopErrors.push(error) }
      if (stopErrors.length > 0) {
        throw new AggregateError(stopErrors, 'codex_runtime_stop_unproven')
      }
      lifecycle = 'stopped'
    },
  }
}
