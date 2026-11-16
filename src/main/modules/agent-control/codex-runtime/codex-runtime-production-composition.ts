import { join } from 'node:path'
import { createCodexProductBudgetSeed } from './codex-product-task-facts'
import type { CodexRuntimeComposition } from './codex-runtime-composition'
import { buildCodexThreadDeveloperInstructions } from './codex-thread-instructions'
import { createActionSurfaceReader } from './composition/action-surface'
import { createAliasPorts } from './composition/alias-ports'
import { createCodexCompositionBase } from './composition/base'
import { createBeginNewContextIssuer } from './composition/begin-new-context'
import { createCandidateCloseout } from './composition/candidate-closeout'
import { createCloseoutDispatch } from './composition/closeout-dispatch'
import { createCloseoutSupport } from './composition/closeout-support'
import { createEngineTerminal } from './composition/engine-terminal'
import { createHeadContinuation } from './composition/head-continuation'
import { createIngressPort } from './composition/ingress-port'
import { createIngressPrepare } from './composition/ingress-prepare'
import { createIngressImagePreparer } from './composition/ingress-image'
import { resolveIngressMcpResource } from './composition/ingress-mcp-resource'
import { createLifecycleWiring } from './composition/lifecycle'
import { createCodexCompositionLive } from './composition/live-state'
import { createRuntimeStart } from './composition/runtime-start'
import type { FactoryInput } from './composition/support'

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
  hasExplicitCurrentDocumentAccessExclusion,
  hasExplicitCurrentDocumentAccessIntent,
  hasExplicitCurrentDocumentWriteProhibition,
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

/**
 * Assembles Ready's Codex runtime. Each part lives in `composition/` as a factory over its explicit dependencies and
 * the shared mutable state; this function only creates them in dependency order and returns the runtime surface.
 */
export function createCodexRuntimeComposition(input: FactoryInput): CodexRuntimeComposition {
  const live = createCodexCompositionLive()
  const withBase = { ...createCodexCompositionBase(input, live), live }
  const withCloseoutSupport = { ...withBase, ...createCloseoutSupport(withBase) }
  const withEngineTerminal = { ...withCloseoutSupport, ...createEngineTerminal(withCloseoutSupport) }
  const withCandidateCloseout = { ...withEngineTerminal, ...createCandidateCloseout(withEngineTerminal) }
  const withCloseoutDispatch = { ...withCandidateCloseout, ...createCloseoutDispatch(withCandidateCloseout) }
  const withLifecycle = { ...withCloseoutDispatch, ...createLifecycleWiring(withCloseoutDispatch) }
  const withHeadContinuation = { ...withLifecycle, ...createHeadContinuation(withLifecycle) }
  const withBeginNewContext = { ...withHeadContinuation, ...createBeginNewContextIssuer(withHeadContinuation) }
  const withActionSurface = { ...withBeginNewContext, ...createActionSurfaceReader(withBeginNewContext) }
  const withAliasPorts = { ...withActionSurface, ...createAliasPorts(withActionSurface) }
  const withIngressPrepare = { ...withAliasPorts, ...createIngressPrepare({
    ...withAliasPorts,
    resolveIngressMcpResource,
    prepareIngressImage: createIngressImagePreparer(join(input.userDataPath, 'codex-runtime', 'prepared-images')),
  }) }
  const withIngressPort = { ...withIngressPrepare, ...createIngressPort(withIngressPrepare) }
  const withRuntimeStart = { ...withIngressPort, ...createRuntimeStart(withIngressPort) }
  const {
    aliasBindingPort,
    collector,
    gate,
    ingressPort,
    lifecycleAdapter,
    manualCompactionController,
    memoryRuntime,
    nativeRuntime,
    participant,
    preparedRunContextPort,
    repository,
    sidecarRecoveryOwner,
    startIdentityPort,
    verified,
  } = withRuntimeStart
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
    readProductTurnPresentation(readyRunId, currentEnvironment) {
      return repository.readProductTurnPresentation(readyRunId, currentEnvironment)
    },
    readProductTurnPresentations(readyRunIds, currentEnvironment) {
      return repository.readProductTurnPresentations(readyRunIds, currentEnvironment)
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
      const session = live.sidecarSession
      if (live.lifecycle !== 'running' || !session) return unavailable
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
        // silent-catch: a failed connection or server diagnostics probe is reported to the caller as runtime status unavailable
        return unavailable
      }
    },
    bindHost(boundHost) {
      if (live.host && live.host !== boundHost) throw new Error('codex_runtime_host_already_bound')
      if (live.lifecycle !== 'new') throw new Error('codex_runtime_host_bind_too_late')
      live.host = boundHost
    },
    sealIngress(reason) { gate.close(reason) },
    async ensureReadyForUserIngress() {
      if (live.lifecycle === 'running') {
        gate.assertOpen()
        return
      }
      if (live.lifecycle === 'stopping' || live.lifecycle === 'stopped') {
        throw new Error('codex_runtime_stopped')
      }
      const committed = await sidecarRecoveryOwner.ensureReadyForUserIngress()
      if (!committed) throw new Error('codex_runtime_retry_cancelled')
      gate.assertOpen()
    },
    async start() {
      if (live.lifecycle !== 'new') throw new Error('codex_runtime_start_state_invalid')
      live.lifecycle = 'starting'
      gate.close('runtime_starting')
      try {
        const committed = await sidecarRecoveryOwner.recover({ trigger: 'initial_start' })
        if (committed && live.lifecycle === 'starting') {
          live.lifecycle = 'running'
          live.memoryWorker.start()
        }
      } catch (error) {
        if (sidecarRecoveryOwner.readSnapshot().state !== 'blocked') {
          gate.close('sidecar_recovery_exhausted')
        }
        live.lifecycle = 'failed'
        throw error
      }
    },
    async stop() {
      if (live.lifecycle === 'stopped') return
      gate.close('runtime_stopping')
      live.lifecycle = 'stopping'
      live.bootGeneration += 1
      sidecarRecoveryOwner.stop()
      const stopErrors: unknown[] = []
      try { await live.memoryWorker.stop() } catch (error) { stopErrors.push(error) }
      try { await live.productRecovery?.stop() } catch (error) { stopErrors.push(error) }
      try { await manualCompactionController.stop() } catch (error) { stopErrors.push(error) }
      try { await live.sidecarSession?.stop() } catch (error) { stopErrors.push(error) }
      nativeRuntime.detachClient()
      try { await sidecarRecoveryOwner.drain() } catch (error) { stopErrors.push(error) }
      gate.close('runtime_stopped')
      try { await live.gateway.stop() } catch (error) { stopErrors.push(error) }
      if (stopErrors.length > 0) {
        throw new AggregateError(stopErrors, 'codex_runtime_stop_unproven')
      }
      live.lifecycle = 'stopped'
    },
  }
}
