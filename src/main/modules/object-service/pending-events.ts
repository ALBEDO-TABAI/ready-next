import type { DatabaseConnection } from '../database/connection'

/** Watcher batches whose file events have not settled into object identity yet, per database. */
const queued = new Map<DatabaseConnection, Set<{ flush(): void }>>()

export function queueObjectEvents(db: DatabaseConnection, batch: { flush(): void }): void {
  const batches = queued.get(db) ?? new Set()
  batches.add(batch); queued.set(db, batches)
}
export function releaseObjectEvents(db: DatabaseConnection, batch: { flush(): void }): void {
  const batches = queued.get(db)
  if (batches?.delete(batch) && !batches.size) queued.delete(db)
}
/**
 * A single-path registration settles queued watcher events first, so both halves of an external move are reconciled
 * together instead of the new path being registered as a new object. Inside an enclosing transaction the batches wait
 * for their own flush: moves are published only after their owner commits.
 */
export function settleQueuedObjectEvents(db: DatabaseConnection): void {
  if (db.inTransaction) return
  for (const batch of [...(queued.get(db) ?? [])]) batch.flush()
}
