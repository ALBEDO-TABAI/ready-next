import { existsSync } from 'node:fs'
import { buildContinuationProbeInput } from '../codex-continuation-probe'
import { resolveCodexNativeModelSettings, CodexModelGatewayContractError } from '../codex-model-gateway-contract'
import { createCodexProductUpstreamProfileSnapshot, resolveCodexThreadInstructionContract } from '../codex-product-turn-authorization'
import type { SameThreadContinuation, SameThreadContinuationCandidate } from '../codex-same-thread-continuation'
import { CodexToolSurfaceError } from '../codex-tool-surface'
import type { CodexCompositionBase } from './base'
import type { CodexCompositionLive } from './live-state'
import { activeProfile } from './support'

export type HeadContinuationDeps = Pick<CodexCompositionBase, 'input' | 'repository' | 'verified'>
  & { readonly live: CodexCompositionLive }

/** Whether a head may continue on its thread under the current runtime and Ready contract. */
export function createHeadContinuation(deps: HeadContinuationDeps) {
  const { live, input, repository, verified } = deps
  const resolveDefaultContinuation = (request: {
    aliasId: string
    aliasGeneration: number
    scopeEpoch: number
    workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    threadBindingId?: string
    materializationKind?: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  }): { decision: SameThreadContinuation; candidate: SameThreadContinuationCandidate } => {
    const boundHost = live.host
    if (!boundHost) throw new Error('codex_runtime_host_unbound')
    // Materialization kind is immutable; successful closeout covers the tail.
    // Read the current coverage obligation, not the creation kind, so settled
    // fresh roots use the ordinary continuation contract on readback/restart.
    const freshRoot = request.materializationKind === 'fresh_root_with_tail'
      && request.threadBindingId !== undefined
      && repository.freshRootRequiresReseed(request.threadBindingId)
    const stored = freshRoot && request.threadBindingId
      ? repository.readFreshRootSourceContinuationContract(request.threadBindingId)
      : repository.readStoredContinuationContract(request)
    const profile = activeProfile(input.settings)
    const profileSnapshot = createCodexProductUpstreamProfileSnapshot(profile)
    const probe = buildContinuationProbeInput(request.workbenchMode)
    const authorization = boundHost.resolveSkillAuthorizationForTurn({
      mode: 'observe',
      message: probe.message,
      sessionId: request.aliasId,
      messageVisibilityEpoch: request.scopeEpoch,
      requestEnvelope: probe.requestEnvelope,
    })
    let currentToolSurface = stored.stored.readyToolSurface
    let toolCompatibility: SameThreadContinuationCandidate['toolCompatibility']
    try {
      currentToolSurface = boundHost.resolveToolTurnSnapshot({
        surfaceId: `continuation-probe:${request.aliasId}`,
        authorizationId: `continuation-probe:${request.aliasId}:${request.aliasGeneration}`,
        authorization,
        message: probe.message,
        sessionId: request.aliasId,
        scopeId: request.aliasId,
        config: profile.config,
        requestEnvelope: probe.requestEnvelope,
        frozenToolSurface: stored.stored.readyToolSurface,
      }).readyToolSurface
    } catch (error) {
      if (!(error instanceof CodexToolSurfaceError) || !error.compatibility) throw error
      toolCompatibility = error.compatibility
    }
    const instruction = resolveCodexThreadInstructionContract({
      assetRoot: verified.assetRoot,
      host: boundHost,
      skillAuthorization: authorization,
    })
    const candidate: SameThreadContinuationCandidate = {
      model: 'ready-e0-model',
      threadConfig: resolveCodexNativeModelSettings(profileSnapshot.snapshot).threadConfig,
      isolatedThreadCwd: stored.stored.isolatedThreadCwd,
      cwdAvailable: existsSync(stored.stored.isolatedThreadCwd),
      instructionContractDigest: instruction.instructionContractDigest,
      currentToolSurface,
      ...(toolCompatibility ? { toolCompatibility } : {}),
    }
    return {
      candidate,
      decision: freshRoot && request.threadBindingId
        ? repository.resolveFreshRootInheritance({
            threadBindingId: request.threadBindingId,
            candidate,
          })
        : repository.resolveSameThreadContinuation({ ...request, candidate }),
    }
  }

  const resolveHeadContinuation = (request: {
    aliasId: string
    aliasGeneration: number
    scopeEpoch: number
    workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    threadBindingId: string
    codexThreadId: string | null
    materializationKind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  }): Pick<SameThreadContinuation, 'kind' | 'reason' | 'evidenceDigest'> | null => {
    if (!request.codexThreadId
      && request.materializationKind !== 'fresh_root_with_tail') return null
    if (!request.codexThreadId
      && !repository.freshRootRequiresReseed(request.threadBindingId)) return null
    return resolveDefaultContinuation(request).decision
  }

  live.resolveProductHeadContractBlocker = (request) => {
    try {
      const decision = resolveHeadContinuation(request)
      return decision ? decision.reason : undefined
    } catch (error) {
      // The live provider configuration cannot form a valid route. That blocks
      // this turn with a named reason, but it is not a history verdict and must
      // never escape as an exception into the read paths that call this
      // (action surface, product presentation, closeout readback). Integrity
      // errors keep propagating.
      if (error instanceof CodexModelGatewayContractError) return 'current_contract_read_failed'
      throw error
    }
  }

  return {
    resolveDefaultContinuation,
    resolveHeadContinuation,
  }
}

export type HeadContinuation = ReturnType<typeof createHeadContinuation>
