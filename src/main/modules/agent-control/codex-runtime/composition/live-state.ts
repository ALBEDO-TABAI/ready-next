import { ReadyMemoryIdleWorker } from '../../ready-memory'
import type { CodexLifecycleAction } from '../codex-binding-repository'
import { CodexModelGateway, type CodexModelGatewayAddress } from '../codex-model-gateway'
import type { CodexTurn } from '../codex-native-runtime'
import { CodexProductBootRecovery } from '../codex-product-boot-recovery'
import type { CodexRuntimeHostPort, ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import type { PreparedCodexRuntimeState } from '../codex-runtime-host'
import type { SameThreadContinuation } from '../codex-same-thread-continuation'
import { CodexSidecarSession } from '../codex-sidecar-session'
import { CodexSidecarSupervisor } from '../codex-sidecar-supervisor'
import type { CodexStartIdentityRegistry } from '../codex-start-identity-registry'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import type { ProductTurnCloseoutEvidence } from '../ready-codex-lifecycle-adapter'

/**
 * The runtime composition's mutable state, shared by every factory. Each field was a `let` of the single composition
 * closure; reading and writing it through this object keeps every closure seeing the current value.
 */
export type CodexCompositionLive = {
  resolveProductHeadContractBlocker: ((input: {
    aliasId: string
    aliasGeneration: number
    scopeEpoch: number
    workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    threadBindingId: string
    codexThreadId: string | null
    materializationKind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  }) => SameThreadContinuation['reason'] | undefined) | null
  gateway: CodexModelGateway
  gatewayAddress: CodexModelGatewayAddress | null
  gatewayNeedsReplacement: boolean
  host: CodexRuntimeHostPort | null
  state: PreparedCodexRuntimeState | null
  supervisor: CodexSidecarSupervisor | null
  sidecarSession: CodexSidecarSession | null
  registry: CodexStartIdentityRegistry | null
  productRecovery: CodexProductBootRecovery | null
  bootOnceImplementation: (() => Promise<boolean>) | null
  lifecycle: 'new' | 'starting' | 'running' | 'recovering' | 'stopping' | 'stopped' | 'failed'
  bootGeneration: number
  memoryWorker: ReadyMemoryIdleWorker
  settleLifecycleHostFailureCloseout: ((identity: {
    aliasId: string
    aliasGeneration: number
  }) => Promise<void>) | null
  settleLifecycleEngineTerminalUserStop: ((identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>) | null
  settleLifecycleReadbackTerminalUserStop: ((input: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
    codexThreadId: string
    turn: CodexTurn
  }, action?: CodexLifecycleAction) => Promise<ProductTurnCloseoutEvidence>) | null
  retryLifecycleEngineTerminalUserStopFinalization: ((identity: {
    aliasId: string
    aliasGeneration: number
    readyRunId: string
  }) => Promise<ProductTurnCloseoutEvidence | null>) | null
  /** Bound by the lifecycle wiring, created after the engine terminal settlement that calls it. */
  deliverRecoveredCloseout: (readyRunId: string, recovered: ReadyClosedCodexProductRun) => void
  /** Bound by the closeout dispatch, which wraps the candidate closeout that re-closes recovered candidates. */
  closeCandidate: (candidate: CoreTurnCandidate) => Promise<ReadyClosedCodexProductRun>
}

/**
 * Starts every field at its plain default. `createCodexCompositionBase` assigns the constructed ones (`gateway`)
 * before anything reads them; each hook is bound by the factory its comment names.
 */
export function createCodexCompositionLive(): CodexCompositionLive {
  return {
    resolveProductHeadContractBlocker: null,
    gatewayAddress: null,
    gatewayNeedsReplacement: false,
    host: null,
    state: null,
    supervisor: null,
    sidecarSession: null,
    registry: null,
    productRecovery: null,
    bootOnceImplementation: null,
    lifecycle: 'new',
    bootGeneration: 0,
    settleLifecycleHostFailureCloseout: null,
    settleLifecycleEngineTerminalUserStop: null,
    settleLifecycleReadbackTerminalUserStop: null,
    retryLifecycleEngineTerminalUserStopFinalization: null,
    deliverRecoveredCloseout: () => {
      throw new Error('codex_composition_unbound:deliverRecoveredCloseout')
    },
    closeCandidate: () => {
      throw new Error('codex_composition_unbound:closeCandidate')
    },
  } as unknown as CodexCompositionLive
}
