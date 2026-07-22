/**
 * EP2-I1 — state-first follow-up routing: select task-ref FACTS for a scope
 * so the follow-up classifier consults projection truth before any
 * continuation semantics (05 §2.1). Degrades to "no facts" (empty array via
 * a null store) — never throws into the turn path.
 */

import type { FollowupTaskRef } from '../../../shared/agent-followup-intent'
import type { TaskProjectionStore } from './contracts/run-contracts'

export function selectFollowupTaskRefs(
  store: Pick<TaskProjectionStore, 'listByScope'> | null | undefined,
  scopeId: string,
): FollowupTaskRef[] {
  if (!store || !scopeId) return []
  try {
    const rows = store.listByScope(scopeId)
    if (!Array.isArray(rows)) return [] // async store: facts unavailable synchronously
    return rows.map((record) => ({
      taskId: record.taskId,
      status: String(record.status),
      interactionState: record.interactionState ?? null,
      summary: record.taskSummary ?? null,
      blockerCategory: record.blockedReason ?? null,
      ownerAgentId: record.ownerAgentId ?? null,
      continuationCheckpointId: record.checkpointRefs?.suspensionCheckpointId ?? null,
      browserTaskId: record.humanTakeoverRef?.browserTaskId ?? null,
      canResume: record.canResume === true,
    }))
  } catch {
    return []
  }
}
