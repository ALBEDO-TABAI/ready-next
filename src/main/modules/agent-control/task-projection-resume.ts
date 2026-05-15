import { canResumeWithFs, type ResumeHandle } from './resume-handle'
import type { TaskProjectionRecord } from './run-contracts'

function hasResumeAction(record: TaskProjectionRecord): boolean {
  const actions = record.resumableActions || []
  if (actions.length === 0) {
    return record.status === 'running' || record.status === 'blocked' || record.status === 'failed'
  }
  return actions.includes('continue') || actions.includes('retry')
}

function projectionAllowsResume(record: TaskProjectionRecord): boolean {
  if (record.status === 'done' || record.status === 'cancelled') return false
  return hasResumeAction(record)
}

/**
 * Stage Q (Stage 11) — derive `canResume` for a TaskProjectionRecord.
 *
 * Pure helper used by `runtime.listTaskProjections` /
 * `runtime.getTaskProjection`. Reads `continuationRef`, the terminal
 * projection state, and explicit resumable actions so renderer can consume
 * one boolean instead of recomputing across several fields.
 */
export function deriveTaskProjectionCanResume(record: TaskProjectionRecord): TaskProjectionRecord {
  const ref = record.continuationRef || null
  const handle: ResumeHandle = {
    childRunId:
      (ref as { childRunId?: string | null } | null)?.childRunId
      || null,
    detachedTaskId: ref?.detachedTaskId || null,
    outputDir: ref?.outputDir || null,
    runStatePath: ref?.runStatePath || null,
  }
  return { ...record, canResume: projectionAllowsResume(record) && canResumeWithFs(handle) }
}
