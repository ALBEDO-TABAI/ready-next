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
  markConsumed: (taskId: string, handoffGeneration: number) => void | Promise<void>
  markRecoveryFailed?: (taskId: string, handoffGeneration: number, attempts: number, error: string) => void | Promise<void>
  markRecoveryTerminal?: (taskId: string, handoffGeneration: number, error: string) => void | Promise<void>
  log: (name: string, payload: Record<string, unknown>) => void
}): Promise<void> {
  for (const pending of deps.listPending()) {
    const ref = pending.continuationRef
    if (!ref || ref.kind !== 'handoff_takeover' || ref.consumed === true) continue
    const targetAgentId = typeof ref.targetAgentId === 'string' ? ref.targetAgentId : ''
    const userRequestVerbatim = typeof ref.userRequestVerbatim === 'string' ? ref.userRequestVerbatim : ''
    const handoffGeneration = Number(ref.handoffGeneration || 0)
    const recoveryAttempts = Math.max(0, Number(ref.startupRecoveryAttempts || 0))
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

    if (recoveryAttempts >= 3) {
      try {
        await deps.markRecoveryTerminal?.(
          pending.taskId,
          handoffGeneration,
          String(ref.startupRecoveryError || 'startup_recovery_exhausted'),
        )
      } catch (error) {
        deps.log('handoff_takeover_startup_recovery_settlement_failed', {
          taskId: pending.taskId,
          scopeId: pending.scopeId,
          outcome: 'recovery_terminal',
          error: error instanceof Error ? error.message : String(error),
        })
      }
      deps.log('handoff_takeover_startup_recovery_terminal', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        targetAgentId,
        handoffGeneration,
        recoveryAttempts,
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
      try {
        await deps.markConsumed(pending.taskId, handoffGeneration)
      } catch (error) {
        deps.log('handoff_takeover_startup_recovery_settlement_failed', {
          taskId: pending.taskId,
          scopeId: pending.scopeId,
          outcome: 'consumed',
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      deps.log('handoff_takeover_startup_recovered', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        targetAgentId,
        handoffGeneration,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const attempts = recoveryAttempts + 1
      if (attempts >= 3) {
        try {
          await deps.markRecoveryTerminal?.(pending.taskId, handoffGeneration, message)
        } catch (settlementError) {
          deps.log('handoff_takeover_startup_recovery_settlement_failed', {
            taskId: pending.taskId,
            scopeId: pending.scopeId,
            outcome: 'recovery_terminal',
            error: settlementError instanceof Error ? settlementError.message : String(settlementError),
          })
        }
      } else {
        try {
          await deps.markRecoveryFailed?.(pending.taskId, handoffGeneration, attempts, message)
        } catch (settlementError) {
          deps.log('handoff_takeover_startup_recovery_settlement_failed', {
            taskId: pending.taskId,
            scopeId: pending.scopeId,
            outcome: 'recovery_failed',
            error: settlementError instanceof Error ? settlementError.message : String(settlementError),
          })
        }
      }
      deps.log('handoff_takeover_startup_recovery_failed', {
        taskId: pending.taskId,
        scopeId: pending.scopeId,
        targetAgentId,
        handoffGeneration,
        error: message,
        recoveryAttempts: attempts,
      })
    }
  }
}
