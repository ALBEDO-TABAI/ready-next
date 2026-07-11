/**
 * EP2-T1 — run_meta close-out snapshotting (07 §1.3).
 *
 * task_projections is the authoritative source for task_type/budget; the
 * run_meta columns are demoted to CLOSE-OUT SNAPSHOTS copied from the
 * projection when the finalizer writes the terminal row. run_meta never
 * maintains these two facts independently again — whatever mid-run scratch
 * was written, the close-out copy wins (消灭"两处各记各的").
 *
 * Implemented as a wrapper around the finalizer's RunMetaRepositoryLike dep
 * so finalizeRunOutcome() itself stays untouched (the finalizer body belongs
 * to the Q4a serial window).
 */

import type { RunMetaRepositoryLike } from '../runtime-core/run-finalizer'
import type { TaskProjectionRecord } from '../contracts/run-contracts'

export function wrapRunMetaRepositoryWithCloseoutSnapshot(
  repository: RunMetaRepositoryLike,
  getProjection: (taskId: string) => TaskProjectionRecord | null,
): RunMetaRepositoryLike {
  const enrich = (input: Record<string, unknown>): Record<string, unknown> => {
    const taskId = typeof input.taskId === 'string' && input.taskId ? input.taskId : null
    const hasTerminalStatus = typeof input.status === 'string' && input.status.length > 0
    if (!taskId || !hasTerminalStatus) return input
    try {
      const projection = getProjection(taskId)
      if (!projection) return input
      const hasExplicitTaskType = Object.prototype.hasOwnProperty.call(input, 'taskType')
      const hasExplicitBudget = Object.prototype.hasOwnProperty.call(input, 'budget')
      return {
        ...input,
        taskType: hasExplicitTaskType ? input.taskType : projection.taskType,
        budget: hasExplicitBudget ? input.budget : projection.budget ?? null,
        executionBinding: input.executionBinding ?? projection.executionBinding ?? null,
      }
    } catch {
      return input // silent-catch: snapshot failure degrades to the unenriched write — never blocks finalize
    }
  }
  return {
    get: (runId) => repository.get(runId),
    create: (input) => repository.create(enrich(input)),
    update: (runId, patch) => repository.update(runId, enrich(patch)),
  }
}
