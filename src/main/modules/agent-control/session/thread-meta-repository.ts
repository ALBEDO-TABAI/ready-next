/**
 * Stage S (PR-S11 / W10.2) — ThreadMetaRepository.
 *
 * Backs the `thread_meta` table (migration 035). Owner identity
 * (`ownerKind` + `ownerId`) is set at create time and is **immutable**:
 * `update()` rejects any attempt to mutate either field. CI gate
 * `check-thread-meta-strict-mutate.cjs` pins this contract.
 *
 * Constructor takes a `better-sqlite3` `Database` directly so the
 * repository can be unit-tested against an in-memory DB.
 */
import type Database from 'better-sqlite3'

export type ThreadOwnerKind = 'user' | 'agent' | 'system'

export interface ThreadMetaRecord {
  threadId: string
  scopeId: string
  ownerKind: ThreadOwnerKind
  ownerId: string
  displayTitle: string | null
  pinned: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface ThreadMetaCreateInput {
  threadId: string
  scopeId: string
  ownerKind: ThreadOwnerKind
  ownerId: string
  displayTitle?: string | null
  pinned?: boolean
  archived?: boolean
}

/**
 * Strict-mutate update patch. `threadId`, `scopeId`, `ownerKind`, `ownerId`,
 * and `createdAt` are explicitly excluded at the type level. Attempting to
 * pass `ownerKind` or `ownerId` will fail typecheck; the runtime guard in
 * `update()` is a defence-in-depth layer for callers that bypass types
 * (e.g. JSON deserialization). Forbidden fields are listed in
 * `THREAD_META_IMMUTABLE_FIELDS` for the gate to grep.
 */
export type ThreadMetaUpdatePatch = Partial<{
  displayTitle: string | null
  pinned: boolean
  archived: boolean
}>

export const THREAD_META_IMMUTABLE_FIELDS = [
  'threadId',
  'scopeId',
  'ownerKind',
  'ownerId',
  'createdAt',
] as const

export interface ThreadMetaListOptions {
  scopeId?: string
  ownerKind?: ThreadOwnerKind
  ownerId?: string
  archived?: boolean
  pinned?: boolean
  limit?: number
}

interface ThreadMetaRow {
  thread_id: string
  scope_id: string
  owner_kind: ThreadOwnerKind
  owner_id: string
  display_title: string | null
  pinned: number | null
  archived: number | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: ThreadMetaRow): ThreadMetaRecord {
  return {
    threadId: row.thread_id,
    scopeId: row.scope_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    displayTitle: row.display_title,
    pinned: !!row.pinned,
    archived: !!row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ThreadMetaRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: ThreadMetaCreateInput, now: number = Date.now()): ThreadMetaRecord {
    const record: ThreadMetaRecord = {
      threadId: input.threadId,
      scopeId: input.scopeId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      displayTitle: input.displayTitle ?? null,
      pinned: !!input.pinned,
      archived: !!input.archived,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO thread_meta (
          thread_id, scope_id, owner_kind, owner_id,
          display_title, pinned, archived,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.threadId,
        record.scopeId,
        record.ownerKind,
        record.ownerId,
        record.displayTitle,
        record.pinned ? 1 : 0,
        record.archived ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      )
    return record
  }

  get(threadId: string): ThreadMetaRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_meta WHERE thread_id = ?`)
      .get(threadId) as ThreadMetaRow | undefined
    return row ? rowToRecord(row) : null
  }

  /**
   * Strict mutate: `ownerKind`, `ownerId`, and `scopeId` are immutable.
   * Runtime guard rejects any patch object that carries those keys (even
   * with `undefined` values, since callers may type-cast around the
   * `ThreadMetaUpdatePatch` type).
   */
  update(
    threadId: string,
    patch: ThreadMetaUpdatePatch,
    now: number = Date.now(),
  ): ThreadMetaRecord | null {
    const patchKeys = Object.keys(patch as Record<string, unknown>)
    for (const forbidden of THREAD_META_IMMUTABLE_FIELDS) {
      if (patchKeys.includes(forbidden)) {
        throw new Error(
          `[thread-meta-repository] update: field '${forbidden}' is immutable; create a new thread instead`,
        )
      }
    }

    const existing = this.get(threadId)
    if (!existing) return null

    const merged: ThreadMetaRecord = {
      ...existing,
      ...patch,
      threadId: existing.threadId,
      scopeId: existing.scopeId,
      ownerKind: existing.ownerKind,
      ownerId: existing.ownerId,
      createdAt: existing.createdAt,
      updatedAt: now,
    }

    this.db
      .prepare(
        `UPDATE thread_meta SET
          display_title = ?, pinned = ?, archived = ?, updated_at = ?
         WHERE thread_id = ?`
      )
      .run(
        merged.displayTitle,
        merged.pinned ? 1 : 0,
        merged.archived ? 1 : 0,
        merged.updatedAt,
        merged.threadId,
      )

    return merged
  }

  delete(threadId: string): boolean {
    const result = this.db.prepare(`DELETE FROM thread_meta WHERE thread_id = ?`).run(threadId) as {
      changes: number
    }
    return result.changes > 0
  }

  list(options: ThreadMetaListOptions = {}): ThreadMetaRecord[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (options.scopeId !== undefined) {
      conditions.push('scope_id = ?')
      params.push(options.scopeId)
    }
    if (options.ownerKind !== undefined) {
      conditions.push('owner_kind = ?')
      params.push(options.ownerKind)
    }
    if (options.ownerId !== undefined) {
      conditions.push('owner_id = ?')
      params.push(options.ownerId)
    }
    if (options.archived !== undefined) {
      conditions.push('archived = ?')
      params.push(options.archived ? 1 : 0)
    }
    if (options.pinned !== undefined) {
      conditions.push('pinned = ?')
      params.push(options.pinned ? 1 : 0)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : ''
    const sql = `SELECT * FROM thread_meta ${where} ORDER BY updated_at DESC ${limit}`.trim()

    const rows = this.db.prepare(sql).all(...params) as ThreadMetaRow[]
    return rows.map(rowToRecord)
  }
}
