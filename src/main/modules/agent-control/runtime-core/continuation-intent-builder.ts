import type { ContinuationIntent } from '../contracts/continuation-state'
import { normalizeContinuationIntent } from '../contracts/continuation-state'
import type { ScopeRunSummary } from '../contracts/types'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { canResumeAsUserPoint, type ResumePointHandle } from '../contracts/resume-handle'
import { deriveTaskProjectionCanResume } from '../task-projection/task-projection-resume'

export function buildContinuationIntent(params: {
  projection: TaskProjectionRecord | null
  scopeRunSummary: ScopeRunSummary | null
  incoming?: ContinuationIntent | null
  responseText?: string
}): ContinuationIntent | null {
  const incoming = normalizeContinuationIntent(params.incoming || null)
  const taskId = params.projection?.taskId
    || params.scopeRunSummary?.taskId
    || params.scopeRunSummary?.taskContinuation?.taskId
    || incoming?.taskId
    || null
  if (!taskId) return null

  const continuationRef = params.projection?.continuationRef || params.scopeRunSummary?.taskContinuation || null
  if (params.projection && deriveTaskProjectionCanResume(params.projection).canResume !== true) return null
  const mergedChildRunId = incoming?.childRunId
    || (continuationRef as { childRunId?: string | null } | null)?.childRunId
    || null
  const mergedResumeKind = incoming?.resumeKind || continuationRef?.resumeKind || null
  const intentHandle: ResumePointHandle = {
    childRunId: mergedChildRunId,
    detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || null,
    outputDir: incoming?.outputDir || continuationRef?.outputDir || null,
    runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || null,
    resumeKind: mergedResumeKind,
  }
  if (!canResumeAsUserPoint(intentHandle)) return null

  return normalizeContinuationIntent({
    taskId,
    childRunId: mergedChildRunId || undefined,
    resumeKind: mergedResumeKind || undefined,
    executionId: incoming?.executionId || continuationRef?.executionId || undefined,
    stepId: incoming?.stepId || continuationRef?.stepId || params.projection?.currentStepId
      || params.scopeRunSummary?.currentStepId || undefined,
    blockedReason: incoming?.blockedReason || params.projection?.blockedReason
      || params.scopeRunSummary?.blockedReason || undefined,
    responseText: params.responseText || incoming?.responseText,
    todoId: incoming?.todoId || continuationRef?.todoId || undefined,
    todoTitle: incoming?.todoTitle || continuationRef?.todoTitle || undefined,
    pauseReason: incoming?.pauseReason || continuationRef?.pauseReason || undefined,
    detachedTaskId: incoming?.detachedTaskId || continuationRef?.detachedTaskId || undefined,
    taskRunId: incoming?.taskRunId || continuationRef?.taskRunId || undefined,
    jobId: incoming?.jobId || continuationRef?.jobId || undefined,
    skillId: incoming?.skillId || continuationRef?.skillId || undefined,
    action: incoming?.action || continuationRef?.action || undefined,
    runStatePath: incoming?.runStatePath || continuationRef?.runStatePath || undefined,
    outputDir: incoming?.outputDir || continuationRef?.outputDir || undefined,
    progressFingerprint: incoming?.progressFingerprint || continuationRef?.progressFingerprint || undefined,
  })
}
