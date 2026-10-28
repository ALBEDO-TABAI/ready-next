import type { LifecycleResult } from '../../../../shared/ipc-contracts/agent-runtime'
import type { ConversationScope } from '../contracts/types'

type SuccessfulReset = Extract<LifecycleResult, { ok: true; action: 'reset' }>
type SuccessfulClose = Extract<LifecycleResult, { ok: true; action: 'close' }>

type ScopeContextCleanupIdentity = {
  scopeId: string
  agents: readonly string[]
}

export interface ScopeContextResetCommitDeps {
  resetExecutionContext: (scopeId: string, agents: readonly string[]) => void
  discardPendingRemoteInbound: (scopeId: string) => void
  closeBrowserTargetClaims: (scopeId: string) => void
  clearActiveSkillContext: (scopeId: string) => void
  forgetContinuity: (scopeId: string) => void
  clearAuthorizationFacts: (scopeId: string) => void
  clearNegations: (scopeId: string) => void
  clearLarkAuthFlows: (scopeId: string) => void
  clearReferenceHint: (scopeId: string) => void
  clearSkillProjection: (scopeId: string) => void
  cancelInteractionLifecycle: (scopeId: string) => void
  rejectEphemeralInteractions: (scopeId: string, error: Error) => void
  rejectAskUserInteractions: (scopeId: string, error: Error) => void
  sweepPendingAskUserCards: (scopeId: string) => void
  clearSessionSnapshot: (internalSessionName: string) => void
  clearRunSummary: (scopeId: string) => void
  reportCleanupFailure: (step: string, error: unknown) => void
}

export function settleScopeContextResetLifecycleResult(input: {
  requestAliasId: string
  result: LifecycleResult
  readScope: (aliasId: string) => ConversationScope | null
  deps: ScopeContextResetCommitDeps
}): LifecycleResult {
  if (!input.result.ok || input.result.action !== 'reset') return input.result
  return commitSuccessfulScopeContextReset({
    requestAliasId: input.requestAliasId,
    result: input.result,
    scope: input.readScope(input.result.aliasId),
    deps: input.deps,
  })
}

export function settleScopeContextCloseLifecycleResult(input: {
  requestAliasId: string
  result: LifecycleResult
  readClosedScopeIdentity: (aliasId: string) => ScopeContextCleanupIdentity | null
  deps: ScopeContextResetCommitDeps
}): LifecycleResult {
  if (!input.result.ok || input.result.action !== 'close') return input.result
  return commitSuccessfulScopeContextClose({
    requestAliasId: input.requestAliasId,
    result: input.result,
    identity: input.readClosedScopeIdentity(input.result.aliasId),
    deps: input.deps,
  })
}

/**
 * Synchronous post-commit half of a durable conversation reset. The caller
 * must invoke this immediately after the lifecycle adapter resolves and must
 * not insert an await before returning the lifecycle result to Renderer.
 */
export function commitSuccessfulScopeContextReset(input: {
  requestAliasId: string
  result: SuccessfulReset
  scope: ConversationScope | null
  deps: ScopeContextResetCommitDeps
}): SuccessfulReset {
  const aliasId = String(input.requestAliasId || '').trim()
  const scope = input.scope
  if (
    !aliasId
    || input.result.aliasId !== aliasId
    || !scope
    || scope.id !== aliasId
    || scope.aliasGeneration !== input.result.newGeneration
    || !Number.isSafeInteger(scope.messageVisibilityEpoch)
    || scope.messageVisibilityEpoch < 0
  ) {
    throw new Error('scope_context_reset_commit_identity_mismatch')
  }

  const agents = Array.from(new Set(
    [scope.agent, scope.activeAgentId]
      .map((agent) => String(agent || '').trim())
      .filter(Boolean),
  ))
  runScopeContextCleanup({
    identity: { scopeId: aliasId, agents },
    reason: 'Conversation reset',
    deps: input.deps,
  })
  return input.result
}

export function commitSuccessfulScopeContextClose(input: {
  requestAliasId: string
  result: SuccessfulClose
  identity: ScopeContextCleanupIdentity | null
  deps: ScopeContextResetCommitDeps
}): SuccessfulClose {
  const aliasId = String(input.requestAliasId || '').trim()
  if (
    !aliasId
    || input.result.aliasId !== aliasId
    || !input.identity
    || input.identity.scopeId !== aliasId
  ) {
    throw new Error('scope_context_close_commit_identity_mismatch')
  }
  runScopeContextCleanup({
    identity: input.identity,
    reason: 'Conversation closed',
    deps: input.deps,
  })
  return input.result
}

function runScopeContextCleanup(input: {
  identity: ScopeContextCleanupIdentity
  reason: string
  deps: ScopeContextResetCommitDeps
}): void {
  const scopeId = input.identity.scopeId
  const agents = Array.from(new Set(input.identity.agents.map((agent) => String(agent || '').trim()).filter(Boolean)))
  const cleanupError = new Error(input.reason)

  const cleanupSteps: Array<{ name: string; run: () => void }> = [
    { name: 'execution_context', run: () => input.deps.resetExecutionContext(scopeId, agents) },
    { name: 'remote_inbound', run: () => input.deps.discardPendingRemoteInbound(scopeId) },
    { name: 'browser_target_claims', run: () => input.deps.closeBrowserTargetClaims(scopeId) },
    { name: 'active_skill', run: () => input.deps.clearActiveSkillContext(scopeId) },
    { name: 'continuity', run: () => input.deps.forgetContinuity(scopeId) },
    { name: 'authorization_facts', run: () => input.deps.clearAuthorizationFacts(scopeId) },
    { name: 'negations', run: () => input.deps.clearNegations(scopeId) },
    { name: 'lark_auth', run: () => input.deps.clearLarkAuthFlows(scopeId) },
    { name: 'reference_hint', run: () => input.deps.clearReferenceHint(scopeId) },
    { name: 'skill_projection', run: () => input.deps.clearSkillProjection(scopeId) },
    { name: 'interaction_lifecycle', run: () => input.deps.cancelInteractionLifecycle(scopeId) },
    { name: 'ephemeral_interactions', run: () => input.deps.rejectEphemeralInteractions(scopeId, cleanupError) },
    { name: 'ask_user_interactions', run: () => input.deps.rejectAskUserInteractions(scopeId, cleanupError) },
    { name: 'ask_user_cards', run: () => input.deps.sweepPendingAskUserCards(scopeId) },
    ...agents.map((agent) => ({
      name: `session_snapshot:${agent}`,
      run: () => input.deps.clearSessionSnapshot(`${agent}::${scopeId}`),
    })),
    { name: 'run_summary', run: () => input.deps.clearRunSummary(scopeId) },
  ]
  for (const cleanup of cleanupSteps) {
    let failure: unknown = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        cleanup.run()
        failure = null
        break
      } catch (error) {
        // silent-catch: the step is retried once and a persistent failure goes to reportCleanupFailure below
        failure = error
      }
    }
    if (failure !== null) {
      try {
        input.deps.reportCleanupFailure(cleanup.name, failure)
      } catch {
        // silent-catch: the durable reset is already committed; a failing failure reporter cannot change its result
      }
    }
  }
}
