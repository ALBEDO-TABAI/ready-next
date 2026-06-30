import type { TaskInteractionState, TaskProjectionRecord } from '../contracts/run-contracts'
import type { TurnTerminalReason } from '../runtime-core/turn-frame'

export function resolveTerminalProjectionInteractionState(
  reason?: TurnTerminalReason | null,
): TaskInteractionState | null {
  if (reason === 'blocked_config') return 'suspended'
  if (reason === 'blocked_external' || reason === 'checkpoint_user_input') {
    return 'awaiting_clarification'
  }
  if (
    reason === 'blocked_tool_error'
    || reason === 'browser_transaction_unconfirmed'
    || reason === 'checkpoint_budget'
    || reason === 'checkpoint_background'
    || reason === 'manual_suspend'
  ) {
    return 'suspended'
  }
  return null
}

export function resolveTerminalProjectionWaitingFor(
  reason?: TurnTerminalReason | null,
): TaskProjectionRecord['waitingFor'] | null {
  if (reason === 'blocked_config') return 'none'
  if (reason === 'blocked_external' || reason === 'checkpoint_user_input') {
    return 'input'
  }
  if (reason === 'checkpoint_background') return 'background'
  return null
}

export function resolveTerminalProjectionStatus(
  reason?: TurnTerminalReason | null,
  phase?: string | null,
): TaskProjectionRecord['status'] | null {
  if (!reason) return null
  if (reason === 'done') return 'completed'
  if (reason === 'adjudication_degraded') {
    if (phase === 'done') return 'completed'
    if (phase === 'error') return 'failed'
    return null
  }
  if (reason === 'cancelled_user' || reason === 'cancelled_runtime' || reason === 'main_no_progress_timeout') {
    return 'killed'
  }
  if (
    reason === 'failed_skill'
    || reason === 'resume_launch_failed'
    || reason === 'persistence_failed'
    || reason === 'context_overflow'
    || reason === 'blocked_tool_error'
    || reason === 'delivery_failed'
    || reason === 'tool_unavailable'
    || reason === 'no_artifact'
    || reason === 'proof_gap'
    || reason === 'blocked_config'
  ) {
    return 'failed'
  }
  return 'blocked'
}
