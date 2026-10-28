import { join } from 'node:path'
import { createBrowserTurnLease } from '../../../browser-engine/agent-browser-turn-lease'
import { getActivePetWindowManager } from '../../../pet/active-pet-window-manager'
import { logAgentMetric } from '../../metrics'
import { verifyCodexAutomaticCompactionEvidence } from '../codex-automatic-compaction-evidence'
import type { CodexHostFailureRecovery } from '../codex-binding-repository'
import { CodexDefaultBootRecoveryActions } from '../codex-boot-recovery-actions'
import { readLarkCliAuthReadback } from '../codex-external-read-slice'
import { readCodexFolderOutputActivation } from '../codex-folder-output-activation'
import { CodexLiveStartRejectionResolver } from '../codex-live-start-rejection-resolver'
import { resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { scanCodexPendingInteractionsForRestart, buildCodexPendingInteractionRestartCandidate, cancelCodexPendingInteractionsWithoutRunCloseout, settleCodexPendingInteractionsInMemoryAfterCommit, assertCodexPendingInteractionRestartSweepComplete } from '../codex-pending-interaction-restart'
import { createProductionProductActionHandlers } from '../codex-product-action-handlers'
import { createCodexProductActionRequester, CodexProductActionError } from '../codex-product-action-requester'
import { CodexProductBootRecovery, routeCodexBootRecoveryFailure, undeliveredCodexTurnCode, proveCodexStableStartAbsence } from '../codex-product-boot-recovery'
import { readCodexPreparedActionAuthorizationEnvelope, createCurrentDocumentReadRequester, resolveCodexThreadInstructionContract } from '../codex-product-turn-authorization'
import { CodexRuntimeBootReconciler } from '../codex-runtime-boot-reconciler'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import { prepareCodexRuntimeState, activateCodexGatewaySpawnConfig, buildCodexChildEnvironment, type PreparedCodexRuntimeState } from '../codex-runtime-host'
import { CodexSidecarRecoveryOwner } from '../codex-sidecar-recovery-owner'
import { CodexSidecarSession } from '../codex-sidecar-session'
import { MacCodexProcessInspector, CodexSidecarSupervisor, NodeCodexSidecarSpawnPort, CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT } from '../codex-sidecar-supervisor'
import type { CodexStartIdentityRegistry } from '../codex-start-identity-registry'
import { createCodexReadyToolBridge, CodexToolBridgeError } from '../codex-tool-bridge'
import type { CodexCompositionBase } from './base'
import type { CloseoutDispatch } from './closeout-dispatch'
import type { HostFailureSettlement, CloseoutSupport } from './closeout-support'
import type { EngineTerminal } from './engine-terminal'
import type { LifecycleWiring } from './lifecycle'
import type { CodexCompositionLive } from './live-state'
import { isoNow, recoverableBrowserWorkflowCode, stableErrorCode } from './support'

/** At boot, moves each pristine fresh-start head that drifted from the current runtime contract onto it. */
export function refreshDriftedPristineFreshStartHeads(input: {
  repository: Pick<CodexCompositionBase['repository'], 'readDriftedFreshStartAliases' | 'refreshPristineFreshStartHeadAtomic'>
  verified: { manifestDigest: string; manifest: { stableV2SchemaSha256: string } }
  createdAt: string
  publishCodexActionSurfaceInvalidation: CodexCompositionBase['publishCodexActionSurfaceInvalidation']
}): void {
  const { repository, verified, createdAt: restartSweepAt, publishCodexActionSurfaceInvalidation } = input
  for (const aliasId of repository.readDriftedFreshStartAliases({
    runtimeManifestDigest: verified.manifestDigest,
    protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
  })) {
    const refreshed = repository.refreshPristineFreshStartHeadAtomic({
      aliasId,
      runtimeManifestDigest: verified.manifestDigest,
      protocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
      createdAt: restartSweepAt,
    })
    if (refreshed.kind === 'refreshed') {
      publishCodexActionSurfaceInvalidation(aliasId, refreshed.invalidation)
    }
  }
}

export type RuntimeStartDeps = Pick<CodexCompositionBase, 'actionJournal' | 'artifactMaterializer' | 'browserTurnLeases' | 'calendarListedEventIdsByRun' | 'calendarNotifyReady' | 'collector' | 'createGateway' | 'currentDocumentExactReadRuns' | 'gate' | 'gatewayRepository' | 'input' | 'loadedThreads' | 'nativeRuntime' | 'ownerMainBootId' | 'publishCodexActionSurfaceInvalidation' | 'rawDb' | 'repository' | 'threadArchiveCleanup' | 'threadArchiveDispatchPort' | 'threadDeveloperInstructions' | 'verified'>
  & Pick<CloseoutDispatch, 'closeCandidate' | 'closeRunLocalRecoveryFailure'>
  & Pick<CloseoutSupport, 'closePersistedHostFailure' | 'releaseHostFailureReservationIfPresent'>
  & Pick<LifecycleWiring, 'deliverRecoveredCloseout' | 'failRuntimeForProductRecovery' | 'manualCompactionController'>
  & Pick<EngineTerminal, 'settleEngineTerminalFailure'>
  & { readonly live: CodexCompositionLive }

/** Starting the runtime and owning sidecar recovery. */
export function createRuntimeStart(deps: RuntimeStartDeps) {
  const { live, actionJournal, artifactMaterializer, browserTurnLeases, calendarListedEventIdsByRun, calendarNotifyReady, closeCandidate, closePersistedHostFailure, closeRunLocalRecoveryFailure, collector, createGateway, currentDocumentExactReadRuns, deliverRecoveredCloseout, failRuntimeForProductRecovery, gate, gatewayRepository, input, loadedThreads, manualCompactionController, nativeRuntime, ownerMainBootId, publishCodexActionSurfaceInvalidation, rawDb, releaseHostFailureReservationIfPresent, repository, settleEngineTerminalFailure, threadArchiveCleanup, threadArchiveDispatchPort, threadDeveloperInstructions, verified } = deps
  const startRuntime = async (): Promise<boolean> => {
    if (!live.host) throw new Error('codex_runtime_host_unbound')
    if (live.gatewayNeedsReplacement) {
      live.gateway = createGateway()
      live.gatewayNeedsReplacement = false
    }
    const address = live.gatewayAddress || await live.gateway.start()
    live.gatewayAddress = address
    live.state = prepareCodexRuntimeState({
      userDataPath: input.userDataPath,
      gatewayUrl: `${address.url}/v1`,
      contracts: verified.contracts,
    })
    const inspector = new MacCodexProcessInspector()
    const mainProcess = (await inspector.list()).find((entry) => entry.pid === process.pid)
    if (!mainProcess) throw new Error('codex_main_process_identity_unavailable')
    live.supervisor = new CodexSidecarSupervisor({
      runtime: verified,
      state: live.state,
      spawnCapability: {
        activate(identities) {
          const capability = live.gateway.activateSpawn(identities.sidecarSpawnInstanceId)
          const gatewaySpawnConfig = activateCodexGatewaySpawnConfig({
            state: live.state as PreparedCodexRuntimeState,
            sidecarSpawnInstanceId: identities.sidecarSpawnInstanceId,
            gatewayUrl: `${capability.url}/v1`,
            gatewayToken: capability.bearerToken,
            contracts: verified.contracts,
          })
          return buildCodexChildEnvironment({ state: live.state as PreparedCodexRuntimeState, ...identities, gatewaySpawnConfig })
        },
        revoke(spawnId) { live.gateway.revokeSpawn(spawnId) },
      },
      leaseStore: repository,
      inspector,
      spawnPort: new NodeCodexSidecarSpawnPort(),
      ownerMainBootId,
      ownerMainPid: process.pid,
      ownerMainProcessStartIdentity: mainProcess.processStartIdentity,
    })
    const larkRequiredResourceReads = new Map<string, Set<string>>()
    const toolBridge = createCodexReadyToolBridge({
      persistence: repository,
      receipts: actionJournal,
      buildToolContext(binding, abortSignal, executionIdentity) {
        const scope = live.host?.getScope(binding.readyScopeId) || null
        const product = repository.readProductTurnRuntime(binding.readyRunId)
        const anchor = product.ingress.kind === 'user_ingress'
          ? product.ingress.currentDocumentAnchor || null
          : null
        const externalReadSlice = product.prepared.externalReadSlice || null
        const taskProjection = live.host?.runtime
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
          live.host?.browserController
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
          runtime: live.host?.runtime || null,
          browserController: live.host?.browserController || null,
          sidecarManager: live.host?.sidecarManager || null,
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
            ? async () => live.host!.runtime.getAgentSessionCheckpointRepository().bindBrowserWorkflowRoute({
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
            journal: actionJournal,
            assertEffectAuthority: () => {
              if (abortSignal.aborted) throw new CodexToolBridgeError('tool_execution_aborted')
              const currentScope = live.host?.getScope(binding.readyScopeId)
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
                  const { fetchAllRSSFeeds } = await import('../../../rss-engine/ipc-handler')
                  return fetchAllRSSFeeds()
                },
                async addSource(payload) {
                  const { addRSSSourceCore } = await import('../../../rss-engine/ipc-handler')
                  return addRSSSourceCore(payload)
                },
                async analyzeItem(payload) {
                  const { getRSSItemAnalysisManager } = await import('../../../rss-engine/item-analysis-manager')
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
                async getAnalysisResult(payload) {
                  const { getRSSItemAnalysisManager } = await import('../../../rss-engine/item-analysis-manager')
                  const manager = getRSSItemAnalysisManager()
                  const initial = payload.jobId
                    ? manager.getJob(payload.jobId)
                    : manager.listJobs(payload.itemId, 50).find((job) => (
                        !payload.analysisType || job.action === payload.analysisType
                      )) || null
                  if (!initial
                    || (payload.itemId && initial.item_id !== payload.itemId)
                    || (payload.analysisType && initial.action !== payload.analysisType)) {
                    return { ok: false, errorKind: 'rss_analysis_job_missing', summary: '未找到匹配的 RSS 分析任务。' }
                  }
                  const job = await manager.waitForTerminal(initial.id, abortSignal)
                  if (['queued', 'paused', 'running_script', 'running_subagent'].includes(job.status)) {
                    return {
                      ok: false,
                      errorKind: job.status === 'paused'
                        ? 'rss_analysis_paused'
                        : 'rss_analysis_still_running',
                      summary: job.status === 'paused'
                        ? 'RSS 条目分析已暂停，尚未生成最终报告。'
                        : 'RSS 条目分析仍在运行，尚未生成最终报告。',
                      jobId: job.id,
                      itemId: job.item_id,
                      status: job.status,
                    }
                  }
                  if (job.status !== 'success' || !job.report_path) {
                    return {
                      ok: false,
                      errorKind: 'rss_analyze_failed',
                      summary: job.error || 'RSS 条目分析失败。',
                      jobId: job.id,
                      itemId: job.item_id,
                      status: job.status,
                    }
                  }
                  const report = manager.readReport({ jobId: job.id, offset: 0, length: 2 })
                  const reportDigest = report.revision
                  return {
                    ok: true,
                    summary: 'RSS 条目分析报告已生成。',
                    jobId: job.id,
                    itemId: job.item_id,
                    status: job.status,
                    reportPath: job.report_path,
                    reportDigest,
                    sourceWarning: report.sourceWarning,
                    outputDir: job.output_dir,
                  }
                },
              },
              pet: {
                async showStickyNote(payload) {
                  const manager = getActivePetWindowManager()
                  if (!manager) throw new CodexProductActionError('product_action_pet_window_unavailable')
                  const result = await manager.showStickyNoteAndWait(payload as {
                    id?: string
                    title?: string
                    body: string
                    tone?: import('../../../../../shared/pet').PetStickyNoteTone
                    enablePet?: boolean
                  }).catch((error) => {
                    if (error instanceof Error && error.name === 'PetWindowLoadError') {
                      throw new CodexProductActionError('product_action_pet_window_unavailable')
                    }
                    throw error
                  })
                  return {
                    ok: true,
                    summary: '已贴到宠物便利贴。',
                    noteId: result.note.id,
                    applied: result.applied,
                    snapshotRevision: result.snapshotRevision,
                    contentDigest: result.contentDigest,
                  }
                },
                async dismissStickyNote(id) {
                  const manager = getActivePetWindowManager()
                  if (!manager) throw new CodexProductActionError('product_action_pet_window_unavailable')
                  const result = await manager.dismissStickyNoteAndWait(id)
                  return {
                    ok: result.dismissed,
                    summary: result.dismissed ? '便利贴已移除。' : '未找到要移除的便利贴。',
                    noteId: id,
                    ...result,
                  }
                },
                async clearStickyNotes() {
                  const manager = getActivePetWindowManager()
                  if (!manager) throw new CodexProductActionError('product_action_pet_window_unavailable')
                  const result = await manager.clearStickyNotesAndWait()
                  return {
                    ok: result.clearedCount > 0,
                    summary: result.clearedCount > 0 ? `已清空 ${result.clearedCount} 条便利贴。` : '当前没有便利贴。',
                    ...result,
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
              rssReferences: product.prepared.rssReferences,
              waitForRssAnalysisResult: product.prepared.actionObligations?.requirements.some((requirement) => (
                requirement.domain === 'rss' && requirement.outcome === 'job_terminal_artifact'
              )),
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
        return live.host?.getActiveRunAbortSignal({
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
      isConnectionLive(epoch) { return live.sidecarSession?.isConnectionLive(epoch) || false },
      getConnectionAbortSignal(epoch) { return live.sidecarSession?.getConnectionAbortSignal(epoch) || null },
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
        (epoch) => live.sidecarSession?.isConnectionLive(epoch) || false,
      ).hostFailureCloseouts.find((entry) => entry.readyRunId === readyRunId)
      if (!failure) return
      const settlement = await closePersistedHostFailure(failure)
      releaseHostFailureReservationIfPresent(activeRegistry, settlement)
      deliverRecoveredCloseout(settlement.readyRunId, settlement.result)
    }
    live.productRecovery = new CodexProductBootRecovery({
      repository,
      runtime: () => (live.sidecarSession as CodexSidecarSession).getClient(),
      collector,
      closeCandidate,
      publishRecoveredCloseout(readyRunId, result) {
        deliverRecoveredCloseout(readyRunId, result as ReadyClosedCodexProductRun)
      },
      async onRecoveryFailure(readyRunId, error) {
        await routeCodexBootRecoveryFailure({
          error,
          async settleRunLocal(code) {
            const undelivered = undeliveredCodexTurnCode(error)
            const browserWorkflowCode = recoverableBrowserWorkflowCode(error) ?? undelivered
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
                forcePublicationDiverged: !undelivered,
                error: browserWorkflowCode,
                undelivered,
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
        const boundHost = live.host
        if (!boundHost) throw new Error('codex_runtime_host_not_bound')
        boundHost.restoreActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          requestId: product.prepared.ingressBinding.requestId,
        })
      },
      abortActiveProductRun(product) {
        return live.host?.abortActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
        }) || false
      },
      finishActiveProductRun(product) {
        live.host?.finishActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          requestId: product.prepared.ingressBinding.requestId,
        })
      },
      ownerMainBootId,
      resolveThreadDeveloperInstructions: threadDeveloperInstructions,
      resolveDeveloperInstructions(product) {
        const selectedSkill = product.prepared.readyTurnToolAuthorization.skillAuthorization
        return resolveCodexThreadInstructionContract({
          assetRoot: verified.assetRoot,
          host: live.host,
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
          productRequestToolsDigest: product.requestToolsDigest,
          thread,
        })
      },
    })
    const runBoot = async (): Promise<boolean> => {
      if (!await live.productRecovery?.beginBootGeneration()) return false
      if (!await manualCompactionController.beginBootGeneration()) return false
      const restartSweepAt = isoNow()
      refreshDriftedPristineFreshStartHeads({
        repository,
        verified,
        createdAt: restartSweepAt,
        publishCodexActionSurfaceInvalidation,
      })
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
      const currentBootGeneration = ++live.bootGeneration
      const canCommitBoot = () => (
        currentBootGeneration === live.bootGeneration
        && live.lifecycle !== 'failed'
        && live.lifecycle !== 'stopping'
        && live.lifecycle !== 'stopped'
      )
      loadedThreads.clear()
      const currentState = live.state
      const currentSupervisor = live.supervisor
      if (!currentState || !currentSupervisor) throw new Error('codex_boot_dependencies_missing')
      const rejectionResolver = new CodexLiveStartRejectionResolver({
        runtime: nativeRuntime,
        repository,
        threadListLimit: 100,
        stableZeroReadCount: 2,
        waitBetweenZeroReads: () => new Promise((resolve) => setTimeout(resolve, 25)),
        isConnectionLive: (connectionEpoch) => live.sidecarSession?.isConnectionLive(connectionEpoch) || false,
      })
      live.sidecarSession = new CodexSidecarSession({
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
          live.productRecovery?.cancelBootGeneration()
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
        forkDeveloperInstructions(threadBindingId) {
          const fork = repository.readNativeForkMaterialization(threadBindingId)
          if (!fork) throw new Error('codex_native_fork_not_found')
          return threadDeveloperInstructions(fork.instructionContractDigest)
        },
        pinnedThreadSource: verified.contracts.turnClientIdentityExtractionContract.thread_start.pinnedAppServerSource,
        threadListLimit: 100,
        stableZeroReadCount: 2,
        waitBetweenZeroReads: async () => undefined,
        heldStartDispatcher: {
          async dispatch(input) {
            return (live.productRecovery as CodexProductBootRecovery).dispatchHeldStart(input)
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
            await (live.productRecovery as CodexProductBootRecovery).reconcileProductFence(fence)
          },
        },
      })
      const boot = new CodexRuntimeBootReconciler({
        runtime: verified,
        repository,
        supervisor: currentSupervisor,
        sidecarSession: live.sidecarSession,
        actions,
        threadArchiveCleanup,
        ingressGate: gate,
        canCommitBoot,
        now: isoNow,
      })
      const result = await boot.boot()
      if (!canCommitBoot()) {
        gate.close('boot_reconciliation_cancelled')
        await live.sidecarSession?.stop()
        nativeRuntime.detachClient()
        return false
      }
      live.registry = result.registry
      nativeRuntime.attach(live.sidecarSession.getClient())
      return true
    }
    live.bootOnceImplementation = runBoot
    return runBoot()
  }

  const sidecarRecoveryOwner = new CodexSidecarRecoveryOwner({
    maxAttempts: CODEX_SIDECAR_CRASH_ATTEMPT_LIMIT,
    bootOnce() {
      return live.bootOnceImplementation ? live.bootOnceImplementation() : startRuntime()
    },
    async settleFailedAttempt() {
      loadedThreads.clear()
      nativeRuntime.detachClient()
      const settlementErrors: unknown[] = []
      try { await live.sidecarSession?.stop() } catch (error) { settlementErrors.push(error) }
      if (!live.bootOnceImplementation) {
        const failedGateway = live.gateway
        live.gatewayAddress = null
        live.gatewayNeedsReplacement = true
        live.state = null
        live.supervisor = null
        live.sidecarSession = null
        live.registry = null
        live.productRecovery = null
        try { await failedGateway.stop() } catch (error) { settlementErrors.push(error) }
      }
      if (settlementErrors.length > 0) {
        throw new AggregateError(settlementErrors, 'sidecar_failed_attempt_settlement_unproven')
      }
    },
    resetAttemptBudget() {
      live.supervisor?.resetCrashBudgetForExplicitRetry()
    },
    shouldRetryFailure() {
      return live.lifecycle !== 'failed'
    },
    onSnapshot(snapshot) {
      logAgentMetric('codex_sidecar_recovery_state', snapshot)
      if (live.lifecycle === 'stopping' || live.lifecycle === 'stopped') return
      if (snapshot.state === 'recovering') live.lifecycle = 'recovering'
      if (snapshot.state === 'ready') {
        live.lifecycle = 'running'
        live.memoryWorker.start()
      }
      if (snapshot.state === 'exhausted') {
        live.lifecycle = 'failed'
        gate.close('sidecar_recovery_exhausted')
      }
    },
  })

  return {
    startRuntime,
    sidecarRecoveryOwner,
  }
}

export type RuntimeStart = ReturnType<typeof createRuntimeStart>
