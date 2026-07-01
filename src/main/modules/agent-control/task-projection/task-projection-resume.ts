import { canResumeAsUserPoint, type ResumePointHandle } from '../contracts/resume-handle'
import type { TaskProjectionRecord } from '../contracts/run-contracts'

function hasResumeAction(record: TaskProjectionRecord): boolean {
  const actions = record.resumableActions || []
  if (actions.length === 0) {
    return record.status === 'running' || record.status === 'blocked' || record.status === 'failed'
  }
  return actions.includes('continue') || actions.includes('retry')
}

function projectionAllowsResume(record: TaskProjectionRecord): boolean {
  if (record.status === 'completed' || record.status === 'killed') return false
  return hasResumeAction(record)
}

function hasBrowserResumeHandle(record: TaskProjectionRecord): boolean {
  const ref = record.continuationRef || null
  const detachedTaskId = ref?.detachedTaskId
  return typeof detachedTaskId === 'string' && detachedTaskId.trim().startsWith('browser-task-')
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
  if (record.module === 'browser') {
    return {
      ...record,
      canResume: projectionAllowsResume(record) && (record.canResume === true || hasBrowserResumeHandle(record)),
    }
  }
  const ref = record.continuationRef || null
  const handle: ResumePointHandle = {
    childRunId:
      (ref as { childRunId?: string | null } | null)?.childRunId
      || null,
    detachedTaskId: ref?.detachedTaskId || null,
    outputDir: ref?.outputDir || null,
    runStatePath: ref?.runStatePath || null,
    resumeKind: ref?.resumeKind || null,
  }
  return { ...record, canResume: projectionAllowsResume(record) && canResumeAsUserPoint(handle) }
}
