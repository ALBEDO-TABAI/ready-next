import type { BrowserCapabilityTaskHandle } from './capability-types'

const CANCELLABLE_COLLECTION_STATUSES = new Set(['queued', 'running', 'paused'])

export function isCancellableCollectionTask(task: BrowserCapabilityTaskHandle): boolean {
  return CANCELLABLE_COLLECTION_STATUSES.has(task.status)
}

/** Prefer the live linked execution even when a newer terminal retry exists. */
export function selectLinkedCollectionExecution(
  tasks: BrowserCapabilityTaskHandle[],
): BrowserCapabilityTaskHandle | null {
  return [...tasks].sort((a, b) => {
    const activeDelta = Number(isCancellableCollectionTask(b)) - Number(isCancellableCollectionTask(a))
    if (activeDelta !== 0) return activeDelta
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))
  })[0] || null
}

/** Resolve a visible discovery card to the linked write task it represents. */
export function collectionTaskIdToCancel(
  requestedTask: BrowserCapabilityTaskHandle,
  linkedExecution: BrowserCapabilityTaskHandle | null,
): string {
  if (
    requestedTask.kind === 'visible_collect'
    && linkedExecution
    && isCancellableCollectionTask(linkedExecution)
  ) {
    return linkedExecution.taskId
  }
  return requestedTask.taskId
}
