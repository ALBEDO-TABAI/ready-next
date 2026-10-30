import type { ObjectMovedEvent } from '../../../shared/object-identity'
import type { DatabaseConnection } from '../database/connection'
import type { ObjectRecord, ObjectRegistry } from './registry'

const listeners = new Map<DatabaseConnection, Set<(event: ObjectMovedEvent) => void>>()
export function subscribeObjectMoves(db: DatabaseConnection, listener: (event: ObjectMovedEvent) => void): () => void {
  const subscribers = listeners.get(db) ?? new Set()
  subscribers.add(listener); listeners.set(db, subscribers)
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(db) }
}
/** Called only after the move owner has committed, never from a nested reconciliation. */
export function publishObjectMoves(registry: ObjectRegistry, before: readonly ObjectRecord[]): void {
  for (const old of before) {
    const next = registry.get(old.id)
    if (!old.current_path || next?.status !== 'present' || !next.current_path || old.current_path === next.current_path) continue
    const event = { objectId: old.id, from: old.current_path, to: next.current_path, revision: next.revision }
    for (const listener of listeners.get(registry.db) ?? []) {
      try { listener(event) } catch (error) { console.error('[objects] completed move notification failed', error) }
    }
  }
}
