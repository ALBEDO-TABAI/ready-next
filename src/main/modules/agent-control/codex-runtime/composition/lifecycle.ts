import { logAgentMetric } from '../../metrics'
import { CodexManualCompactionController } from '../codex-manual-compaction-controller'
import { resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { classifyCodexProductRecoveryFailure, undeliveredCodexTurnCode } from '../codex-product-boot-recovery'
import { createLifecycleStore } from '../codex-product-lifecycle-store'
import { sha256 } from '../codex-product-surface-ingress'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import { CodexThreadResumeAuthority } from '../codex-thread-resume-authority'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import { CodexTurnInputBuilder } from '../codex-turn-input-builder'
import { ReadyCodexLifecyclePortError, ReadyCodexLifecycleAdapter } from '../ready-codex-lifecycle-adapter'
import type { CodexCompositionBase } from './base'
import type { CloseoutDispatch } from './closeout-dispatch'
import type { CloseoutSupport } from './closeout-support'
import type { EngineTerminal } from './engine-terminal'
import type { CodexCompositionLive } from './live-state'
import { isoNow, stableErrorCode, recoverableBrowserWorkflowCode } from './support'

export type LifecycleWiringDeps = Pick<CloseoutDispatch, 'closeCandidate' | 'closeRunLocalRecoveryFailure'>
  & Pick<CodexCompositionBase, 'collector' | 'detailPrepared' | 'gate' | 'gatewayRepository' | 'input' | 'loadedThreads' | 'memoryRuntime' | 'nativeRuntime' | 'ownerMainBootId' | 'preparedDetails' | 'rawDb' | 'readyMemoryRepository' | 'repository' | 'scheduleThreadArchiveCleanup' | 'threadDeveloperInstructions' | 'verified'>
  & Pick<CloseoutSupport, 'readAlreadyCommittedCloseout'>
  & Pick<EngineTerminal, 'settleEngineTerminalFailure'>
  & { readonly live: CodexCompositionLive }

/** Lifecycle store, adapter, manual compaction controller and recovered closeout delivery. */
export function createLifecycleWiring(deps: LifecycleWiringDeps) {
  const { live, closeCandidate, closeRunLocalRecoveryFailure, collector, detailPrepared, gate, gatewayRepository, input, loadedThreads, memoryRuntime, nativeRuntime, ownerMainBootId, preparedDetails, rawDb, readAlreadyCommittedCloseout, readyMemoryRepository, repository, scheduleThreadArchiveCleanup, settleEngineTerminalFailure, threadDeveloperInstructions, verified } = deps
  const manualCompactionController = new CodexManualCompactionController({
    repository,
    gatewayRepository,
    getSession: () => live.sidecarSession,
    ensureThreadLoaded: async (identity) => {
      await lifecycleAdapter.ensureNativeThreadLoaded(identity)
    },
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
    getHost: () => live.host,
    getRegistry: () => live.registry,
    currentRuntimeManifestDigest: verified.manifestDigest,
    currentProtocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
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
    getThreadDeveloperInstructions: threadDeveloperInstructions,
    getNativeModelSettings(prepared) {
      const detail = preparedDetails.get(prepared.runId)
      if (!detail || detailPrepared.get(prepared.runId) !== prepared) {
        throw new Error('codex_prepared_model_settings_missing')
      }
      return resolveCodexNativeModelSettings(detail.upstream.snapshot)
    },
    settleHostFailureCloseout(identity) {
      if (!live.settleLifecycleHostFailureCloseout) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return live.settleLifecycleHostFailureCloseout(identity)
    },
    settleEngineTerminalUserStop(identity, action) {
      if (!live.settleLifecycleEngineTerminalUserStop) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return live.settleLifecycleEngineTerminalUserStop(identity, action)
    },
    settleReadbackTerminalUserStop(value, action) {
      if (!live.settleLifecycleReadbackTerminalUserStop) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return live.settleLifecycleReadbackTerminalUserStop(value, action)
    },
    retryEngineTerminalUserStopFinalization(identity) {
      if (!live.retryLifecycleEngineTerminalUserStopFinalization) return Promise.resolve(null)
      return live.retryLifecycleEngineTerminalUserStopFinalization(identity)
    },
    createAliasAtomic(value) {
      rawDb.exec('BEGIN IMMEDIATE')
      try {
        const scope = input.database.chat.upsertConversationScope({
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
      if (!live.sidecarSession) throw new Error('codex_sidecar_session_unavailable')
      return live.sidecarSession.getActiveConnectionEpoch()
    },
    manualCompactionController,
  })

  const failRuntimeForProductRecovery = (
    readyRunId: string,
    errorCode: string,
    metric = 'codex_product_recovery_failed',
  ): void => {
    logAgentMetric(metric, { readyRunId, reason: errorCode })
    gate.close('product_recovery_failed')
    if (live.lifecycle !== 'stopping' && live.lifecycle !== 'stopped') live.lifecycle = 'failed'
  }

  const lifecycleAdapter = new ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>({
    nativeRuntime,
    threadResumePort: new CodexThreadResumeAuthority(() => live.sidecarSession),
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
          // A stopped runtime cannot close anything; the next boot's recovery owns the run, so stop retrying.
          if (live.lifecycle === 'stopping' || live.lifecycle === 'stopped') {
            stopped = true
            clearInterval(timer)
            return
          }
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
              const undelivered = undeliveredCodexTurnCode(error)
              const browserWorkflowCode = recoverableBrowserWorkflowCode(error) ?? undelivered
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
                    forcePublicationDiverged: !undelivered,
                    error: browserWorkflowCode,
                    undelivered,
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
    if (!live.host) throw new Error('codex_recovered_closeout_event_missing')
    live.host.publishCommittedTerminalEvent(recovered.committedTerminalEvent)
    lifecycleAdapter.acknowledgePublishedRecoveredCloseout(readyRunId)
  }
  live.deliverRecoveredCloseout = deliverRecoveredCloseout

  return {
    manualCompactionController,
    lifecycleStore,
    failRuntimeForProductRecovery,
    lifecycleAdapter,
    deliverRecoveredCloseout,
  }
}

export type LifecycleWiring = ReturnType<typeof createLifecycleWiring>
