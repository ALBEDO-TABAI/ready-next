export interface ScheduleDispatchQueueItem {
  occurrenceId: string
  scheduleId: string
  scopeId: string
  scheduledFor: string
}

export interface ScheduleDispatchQueueDeps {
  isScopeBusy: (scopeId: string) => boolean
  dispatch: (item: ScheduleDispatchQueueItem) => Promise<void>
  markSkippedCoalesced: (item: ScheduleDispatchQueueItem) => void
  onDispatchError: (item: ScheduleDispatchQueueItem, error: unknown) => void
}

function compareOccurrences(left: ScheduleDispatchQueueItem, right: ScheduleDispatchQueueItem): number {
  const leftTime = Date.parse(left.scheduledFor)
  const rightTime = Date.parse(right.scheduledFor)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  const scheduledComparison = left.scheduledFor.localeCompare(right.scheduledFor)
  return scheduledComparison || left.occurrenceId.localeCompare(right.occurrenceId)
}

export class ScheduleDispatchQueue {
  private readonly pendingBySchedule = new Map<string, ScheduleDispatchQueueItem>()
  private readonly activeBySchedule = new Map<string, ScheduleDispatchQueueItem>()
  private readonly activeScopes = new Set<string>()
  private readonly drains = new Map<string, Promise<void>>()

  constructor(private readonly deps: ScheduleDispatchQueueDeps) {}

  enqueue(item: ScheduleDispatchQueueItem): Promise<void> {
    if (this.activeBySchedule.get(item.scheduleId)?.occurrenceId === item.occurrenceId) {
      return this.startDrain(item.scopeId)
    }
    const existing = this.pendingBySchedule.get(item.scheduleId)
    if (existing?.occurrenceId === item.occurrenceId) return this.startDrain(item.scopeId)
    if (existing) {
      const keep = compareOccurrences(existing, item) <= 0 ? item : existing
      const skip = keep === item ? existing : item
      this.deps.markSkippedCoalesced(skip)
      this.pendingBySchedule.set(item.scheduleId, keep)
      if (existing.scopeId !== keep.scopeId) this.startDrain(existing.scopeId)
    } else {
      this.pendingBySchedule.set(item.scheduleId, item)
    }
    return this.startDrain(item.scopeId)
  }

  drain(scopeId: string): Promise<void> {
    return this.startDrain(scopeId)
  }

  hasPending(scopeId?: string): boolean {
    if (!scopeId) return this.pendingBySchedule.size > 0
    return [...this.pendingBySchedule.values()].some((item) => item.scopeId === scopeId)
  }

  private startDrain(scopeId: string): Promise<void> {
    const existing = this.drains.get(scopeId)
    if (existing) return existing
    const drain = this.drainScope(scopeId).finally(() => {
      if (this.drains.get(scopeId) === drain) this.drains.delete(scopeId)
    })
    this.drains.set(scopeId, drain)
    return drain
  }

  private async drainScope(scopeId: string): Promise<void> {
    while (!this.activeScopes.has(scopeId) && !this.deps.isScopeBusy(scopeId)) {
      const next = [...this.pendingBySchedule.values()]
        .filter((item) => item.scopeId === scopeId && !this.activeBySchedule.has(item.scheduleId))
        .sort(compareOccurrences)[0]
      if (!next) return

      this.pendingBySchedule.delete(next.scheduleId)
      this.activeScopes.add(scopeId)
      this.activeBySchedule.set(next.scheduleId, next)
      try {
        await this.deps.dispatch(next)
      } catch (error) {
        this.deps.onDispatchError(next, error)
      } finally {
        this.activeBySchedule.delete(next.scheduleId)
        this.activeScopes.delete(scopeId)
      }
    }
  }
}
