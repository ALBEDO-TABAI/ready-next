import { getRepositoryDatabase } from '../../repositories/database-accessor'
import type { DatabaseManager } from '../../database'

export type ScopeContextEpochRead =
  | { kind: 'open'; messageVisibilityEpoch: number }
  | { kind: 'closed' }
  | { kind: 'unavailable' }
  | { kind: 'untracked' }

let testDatabase: Pick<DatabaseManager, 'getRawDb'> | null = null

export function __setScopeContextEpochDatabaseForTests(
  database: Pick<DatabaseManager, 'getRawDb'> | null,
): void {
  testDatabase = database
}

/**
 * Read the durable context identity for a real conversation scope. Opaque
 * test/product session keys deliberately remain `untracked`; callers may keep
 * their legacy behaviour for those keys, but real scopes must match exactly.
 */
export function readScopeContextEpoch(scopeId: string | null | undefined): ScopeContextEpochRead {
  const normalizedScopeId = String(scopeId || '').trim()
  if (!normalizedScopeId) return { kind: 'untracked' }
  try {
    const raw = (testDatabase ?? getRepositoryDatabase()).getRawDb()
    if (!raw) return { kind: 'unavailable' }
    const row = raw.prepare(`
      SELECT message_visibility_epoch, closed_at
        FROM chat_conversations
       WHERE id = ?
       LIMIT 1
    `).get<{ message_visibility_epoch: number; closed_at: string | null }>(normalizedScopeId)
    if (!row) return { kind: 'untracked' }
    if (row.closed_at !== null) return { kind: 'closed' }
    if (!Number.isSafeInteger(row.message_visibility_epoch) || row.message_visibility_epoch < 0) {
      return { kind: 'closed' }
    }
    return { kind: 'open', messageVisibilityEpoch: row.message_visibility_epoch }
  } catch {
    // silent-catch: a database that cannot be opened or queried is reported to the caller as epoch state unavailable
    return { kind: 'unavailable' }
  }
}

export function isSafeMessageVisibilityEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
