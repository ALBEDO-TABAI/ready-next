import type { ConversationScope } from '../contracts/types'

export interface PendingHandoffTakeover {
  taskId: string
  scopeId: string
  continuationRef: Record<string, unknown> | null
}

export async function recoverPendingHandoffTakeovers(deps: {
  listPending: () => PendingHandoffTakeover[]
  getScope: (scopeId: string) => ConversationScope | null
  runTakeover: (input: {
    taskId: string
    scope: ConversationScope
    userRequestVerbatim: string
    contextRefIds: string[]
  }) => Promise<{ success: boolean; error?: string }>
  markConsumed: (taskId: string, handoffGeneration: number) => void
  log: (name: string, payload: Record<string, unknown>) => void
}): Promise<void> {
  for (const pending of deps.listPending()) {
    const ref = pending.continuationRef
    if (!ref || ref.kind !== 'handoff_takeover' || ref.consumed === true) continue
    const targetAgentId = typeof ref.targetAgentId === 'string' ? ref.targetAgentId : ''
    const userRequestVerbatim = typeof ref.userRequestVerbatim === 'string' ? ref.userRequestVerbatim : ''
    const handoffGeneration = Number(ref.handoffGeneration || 0)
    const scope = deps.getScope(pending.scopeId)
    if (
      !targetAgentId
      || !userRequestVerbatim
      || !Number.isInteger(handoffGeneration)
      || handoffGeneration < 1
      || !scope
      || scope.activeAgentId !== targetAgentId
      || scope.handoffGeneration !== handoffGeneration
    ) {
      deps.log('handoff_takeover_startup_recovery_rejected', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        reason: 'identity_or_generation_mismatch',
      })
      continue
    }

    try {
      const result = await deps.runTakeover({
        taskId: pending.taskId,
        scope,
        userRequestVerbatim,
        contextRefIds: Array.isArray(ref.contextRefIds) ? ref.contextRefIds.map(String) : [],
      })
      if (!result.success) throw new Error(result.error || 'handoff takeover failed')
      deps.markConsumed(pending.taskId, handoffGeneration)
      deps.log('handoff_takeover_startup_recovered', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        targetAgentId,
        handoffGeneration,
      })
    } catch (error) {
      deps.log('handoff_takeover_startup_recovery_failed', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        targetAgentId,
        handoffGeneration,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
