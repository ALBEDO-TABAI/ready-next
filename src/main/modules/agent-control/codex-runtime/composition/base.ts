import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserTurnLease } from '../../../browser-engine/agent-browser-turn-lease'
import { ArtifactMaterializer } from '../../../tools/artifact-materializer'
import { logAgentMetric } from '../../metrics'
import { ReadyMemoryRepository, ReadyMemoryGenerationStore, ReadyMemoryProductionProvider, ReadyMemoryGenerationCoordinator, ReadyMemorySqliteEvidenceLoader, isReadyMemoryProductionIdle, ReadyMemoryRuntimeService, ReadyMemoryIdleWorker } from '../../ready-memory'
import { clearLastReferenceSkill } from '../../skills/skill-reference-hints'
import { CodexBindingRepository } from '../codex-binding-repository'
import { CodexModelGateway } from '../codex-model-gateway'
import { CodexModelGatewayRepository, ReadySettingsModelGatewayCredentialStore, CodexDatabaseModelGatewayAuthority } from '../codex-model-gateway-authority'
import type { CodexPendingInteractionRestartPlan } from '../codex-pending-interaction-restart'
import { CodexProductCloseoutExpectationGuard, type CodexProductCloseoutMode } from '../codex-product-closeout-support'
import { CodexProductRunPreparer, type PreparedCodexProductRun } from '../codex-product-run-preparer'
import { resolveCodexThreadInstructionContract, RuntimeGate, createCodexProductUpstreamProfileSnapshot } from '../codex-product-turn-authorization'
import { loadRuntimeContinuityAssets } from '../codex-runtime-continuity-assets'
import { resolveCodexRuntimePaths, loadVerifiedCodexRuntime } from '../codex-runtime-host'
import { StableNativeRuntime } from '../codex-stable-native-runtime'
import { CodexThreadArchiveIntentStore, CodexDurableThreadArchiveDispatchPort } from '../codex-thread-archive-cleanup'
import { CodexThreadArchiveCleanupOwner } from '../codex-thread-archive-owner'
import { CodexToolActionJournal } from '../codex-tool-action-journal'
import { CodexTurnCollector } from '../codex-turn-collector'
import { appendCodexGatewayRefusalLog, appendCodexUpstreamFailureLog } from '../codex-upstream-failure-log'
import type { CodexCompositionLive } from './live-state'
import { readE5ProofSentinels, activeProfile, stableErrorCode, isoNow, type PreparedDetail, type FactoryInput } from './support'
import type { PendingEngineTerminalFinalization } from './types'

/** Releases a start reservation before dispatch, forgetting the runs prepared under it. */
export function createPreparedReservationRelease(deps: {
  live: Pick<CodexCompositionLive, 'registry'>
  preparedDetails: Map<string, PreparedDetail>
  detailPrepared: Map<string, PreparedCodexProductRun>
}) {
  const { live, preparedDetails, detailPrepared } = deps

  const releasePreparedReservation = (reservationSetId: string, evidenceDigest: string) => {
    for (const [readyRunId, prepared] of detailPrepared) {
      if (prepared.ingressBinding.reservationSetId !== reservationSetId) continue
      preparedDetails.delete(readyRunId)
      detailPrepared.delete(readyRunId)
    }
    live.registry?.releaseBeforeDispatch({ reservationSetId, evidenceDigest })
  }
  return { releasePreparedReservation }
}

/** Tells the renderer that a conversation's action surface changed, from the committed facts or a fresh read. */
export function createActionSurfaceInvalidationPublisher(deps: {
  repository: CodexBindingRepository
  input: Pick<FactoryInput, 'onCodexActionSurfaceInvalidated'>
}) {
  const { repository, input } = deps

  const publishCodexActionSurfaceInvalidation = (aliasId: string,
    committedFacts?: NonNullable<ReturnType<CodexBindingRepository['readActionSurfaceInvalidation']>>,
  ): void => {
    if (!input.onCodexActionSurfaceInvalidated) return
    try {
      const facts = committedFacts ?? repository.readActionSurfaceInvalidation(aliasId)
      if (!facts) return
      input.onCodexActionSurfaceInvalidated({
        contract: 'codex_action_surface_invalidation_v1',
        scopeId: facts.scopeId,
        scopeEpoch: facts.scopeEpoch,
        aliasGeneration: facts.aliasGeneration,
        actionProjectionSequence: facts.actionProjectionSequence,
      })
    } catch (error) {
      logAgentMetric('codex_action_surface_invalidation_failed', {
        aliasId,
        reason: stableErrorCode(error, 'unknown'),
      })
    }
  }
  return { publishCodexActionSurfaceInvalidation }
}

/** Everything the runtime shares before any closeout or port exists: stores, maps, the gateway and the native runtime. */
export function createCodexCompositionBase(input: FactoryInput, live: CodexCompositionLive) {
  const rawDb = input.database.getRawDb()

  if (!rawDb) throw new Error('codex_database_unavailable')

  const paths = resolveCodexRuntimePaths(input)

  const verified = loadVerifiedCodexRuntime(paths)

  const runtimeContinuity = loadRuntimeContinuityAssets({
    assetRoot: join(paths.assetRoot, '..', 'runtime-continuity'),
    targetManifestDigest: verified.manifestDigest,
  })

  const repository = new CodexBindingRepository(rawDb, {
    runtimeManifestDigest: verified.manifestDigest,
    protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
    instructionContractDigest: resolveCodexThreadInstructionContract({
      assetRoot: verified.assetRoot,
      host: null,
      skillAuthorization: { mode: 'none' },
    }).instructionContractDigest,
    runtimeContinuityCatalog: runtimeContinuity.catalog,
    resolveHeadContractBlocker(request) {
      if (!live.resolveProductHeadContractBlocker) {
        throw new Error('codex_head_continuation_resolver_unbound')
      }
      return live.resolveProductHeadContractBlocker(request)
    },
  })

  const actionJournal = new CodexToolActionJournal(rawDb)

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
    onUpstreamFailure: appendCodexUpstreamFailureLog,
    onRequestRefused: appendCodexGatewayRefusalLog,
    ...(proofCaptureEnabled ? {
      proofSentinels: readE5ProofSentinels(),
      onValidatedRequest(capture) {
        appendFileSync(proofCapturePath, `${JSON.stringify(capture)}\n`, { encoding: 'utf8' })
      },
    } : {}),
  })

  live.gateway = createGateway()

  const gate = new RuntimeGate()

  const ownerMainBootId = randomUUID()

  const preparedDetails = new Map<string, PreparedDetail>()

  const detailPrepared = new Map<string, PreparedCodexProductRun>()

  const { releasePreparedReservation } = createPreparedReservationRelease({ live, preparedDetails, detailPrepared })

  const browserTurnLeases = new Map<string, BrowserTurnLease>()

  const currentDocumentExactReadRuns = new Set<string>()

  const artifactMaterializer = new ArtifactMaterializer(join(input.userDataPath, 'codex-artifacts'), {
    readStorageRetention: () => repository.readArtifactStorageRetention(),
  })

  const calendarListedEventIdsByRun = new Map<string, { ids: string[]; versions: Record<string, number> }>()

  const loadedThreads = new Set<string>()

  const pendingEngineTerminalFinalizations = new Map<string, PendingEngineTerminalFinalization>()

  const expectedCodexCloseouts = new CodexProductCloseoutExpectationGuard()

  const pendingNativeForkSeeds = new Map<string, {
    targetCwd: string
    reservationSetId: string
    reservationId: string
    reservationEvidenceDigest: string
  }>()

  const materializedForkTargets = new Map<string, string>()

  const commitExpectedCodexCloseout = async <T>(
    readyRunId: string,
    mode: CodexProductCloseoutMode,
    commit: () => Promise<T>,
    terminalEvidence?: import('../codex-binding-repository').CodexTerminalCloseoutEvidence,
  ): Promise<T> => {
    const token = expectedCodexCloseouts.acquire(readyRunId, mode)
    if (terminalEvidence) expectedCodexCloseouts.setTerminalEvidence(readyRunId, terminalEvidence)
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
      if (live.lifecycle !== 'running') return false
      return isReadyMemoryProductionIdle(rawDb)
    },
    onStateChanged: input.onReadyMemoryStateChanged,
    onStateChangePublishError(error) {
      logAgentMetric('ready_memory_state_change_publish_failed', {
        error: stableErrorCode(error, 'unknown'),
      })
    },
  })

  const memoryRuntime = new ReadyMemoryRuntimeService({
    db: rawDb,
    repository: readyMemoryRepository,
    coordinator: memoryCoordinator,
    automaticGenerationAvailable: memoryProvider.automaticGenerationAvailable,
    wakeWorker: () => live.memoryWorker.wake(),
    onStateChanged: input.onReadyMemoryStateChanged,
    onStateChangePublishError(error) {
      logAgentMetric('ready_memory_state_change_publish_failed', {
        error: stableErrorCode(error, 'unknown'),
      })
    },
  })

  live.memoryWorker = new ReadyMemoryIdleWorker({
    coordinator: memoryCoordinator,
    onError(error) {
      logAgentMetric('ready_memory_worker_failed', { error: stableErrorCode(error, 'unknown') })
    },
  })

  const threadArchiveStore = new CodexThreadArchiveIntentStore(rawDb)

  const threadArchiveDispatchPort = new CodexDurableThreadArchiveDispatchPort({
    store: threadArchiveStore,
    now: isoNow,
  })

  const nativeRuntime = new StableNativeRuntime(() => {
    if (!live.sidecarSession) throw new Error('codex_sidecar_session_unavailable')
    return live.sidecarSession.getClient()
  })

  const threadArchiveCleanup = new CodexThreadArchiveCleanupOwner({
    store: threadArchiveStore,
    runtime: nativeRuntime,
    getConnectionEpoch: () => {
      if (!live.sidecarSession) throw new Error('codex_sidecar_session_unavailable')
      return live.sidecarSession.getActiveConnectionEpoch()
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
  const { publishCodexActionSurfaceInvalidation } = createActionSurfaceInvalidationPublisher({ repository, input })

  // Codex drops a thread's developer instructions when it rebuilds a compacted history on resume or fork; Ready
  // re-declares the ones the thread was created with, rebuilt from its frozen digest.
  const threadDeveloperInstructions = (instructionContractDigest: string): string => (
    resolveCodexThreadInstructionContract({
      assetRoot: verified.assetRoot,
      host: null,
      skillAuthorization: { mode: 'none' },
      expectedDigest: instructionContractDigest,
    }).developerInstructions
  )

  const materializeNativeFork = async (targetThreadBindingId: string): Promise<void> => {
    const seed = repository.readNativeForkMaterialization(targetThreadBindingId)
    if (!seed || seed.materializationState !== 'pending') {
      throw new Error('codex_native_fork_not_pending')
    }
    mkdirSync(seed.targetCwd, { recursive: true })
    const materialized = await nativeRuntime.threadFork({
      threadId: seed.sourceCodexThreadId,
      lastTurnId: seed.acceptedThroughCodexTurnId,
      cwd: seed.targetCwd,
      model: seed.model,
      modelProvider: 'ready_gateway',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: threadDeveloperInstructions(seed.instructionContractDigest),
    }, targetThreadBindingId)
    const readback = repository.readNativeForkMaterialization(targetThreadBindingId)
    if (!readback || readback.materializationState !== 'confirmed'
      || materialized.thread.id === seed.sourceCodexThreadId) {
      throw new Error('codex_native_fork_materialization_readback_missing')
    }
    loadedThreads.add(materialized.thread.id)
    publishCodexActionSurfaceInvalidation(seed.aliasId)
    scheduleThreadArchiveCleanup()
  }

  const collector = new CodexTurnCollector(nativeRuntime)

  const preparer = new CodexProductRunPreparer()

  return {
    input,
    rawDb,
    paths,
    verified,
    runtimeContinuity,
    repository,
    actionJournal,
    readyMemoryRepository,
    gatewayRepository,
    credentialStore,
    proofCaptureEnabled,
    proofCapturePath,
    createGateway,
    gate,
    ownerMainBootId,
    preparedDetails,
    detailPrepared,
    releasePreparedReservation,
    browserTurnLeases,
    currentDocumentExactReadRuns,
    artifactMaterializer,
    calendarListedEventIdsByRun,
    loadedThreads,
    pendingEngineTerminalFinalizations,
    expectedCodexCloseouts,
    pendingNativeForkSeeds,
    materializedForkTargets,
    commitExpectedCodexCloseout,
    commitExpectedCodexRecoveryFailure,
    releaseBrowserTurnLease,
    memoryGenerationStore,
    memoryProvider,
    memoryCoordinator,
    memoryRuntime,
    threadArchiveStore,
    threadArchiveDispatchPort,
    nativeRuntime,
    threadArchiveCleanup,
    scheduleThreadArchiveCleanup,
    publishCodexActionSurfaceInvalidation,
    threadDeveloperInstructions,
    materializeNativeFork,
    collector,
    preparer,
    clearLastReferenceSkill,
  }
}

export type CodexCompositionBase = ReturnType<typeof createCodexCompositionBase>
