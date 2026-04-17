import { randomUUID } from 'node:crypto'
import type { WorkerSessionIdentity } from './run-contracts'

function normalizeSegment(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task'
}

export function createWorkerSessionIdentity(params: {
  scopeId: string
  parentTaskId: string
  parentStepId: string
}): WorkerSessionIdentity {
  const seed = randomUUID()
  const stepKey = normalizeSegment(params.parentStepId)
  const parentKey = normalizeSegment(params.parentTaskId)

  return {
    taskId: `task-${seed}`,
    workerSessionId: `worker-${parentKey}-${stepKey}-${seed}`,
    parentTaskId: params.parentTaskId,
    parentStepId: params.parentStepId,
  }
}
