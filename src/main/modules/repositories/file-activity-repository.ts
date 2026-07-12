import { randomUUID } from 'crypto'

import type { DatabaseConnection } from '../database'
import type {
  FileActivityEvent,
  FileActivityEventType,
  FileActivitySource,
} from '../../../shared/file-emergence'

export interface FileActivityRecordInput {
  path: string
  workspaceRoot?: string | null
  eventType: FileActivityEventType
  source: FileActivitySource
  weight?: number
  meta?: Record<string, unknown>
  createdAt?: number
}

export interface FileActivityListOptions {
  workspaceRoots: string[]
  since: number
  limit: number
}

interface FileActivityRow {
  id: string
  path: string
  workspace_root: string | null
  event_type: FileActivityEventType
  source: FileActivitySource
  weight: number
  meta_json: string | null
  created_at: number
}

const DEDUPE_WINDOW_MS = 30_000

export class FileActivityRepository {
  constructor(private readonly db: DatabaseConnection) {}

  recordEvent(input: FileActivityRecordInput): FileActivityEvent {
    const now = input.createdAt ?? Date.now()
    const path = input.path.trim()
    if (!path) throw new Error('path is required')
    if (input.eventType !== 'open' && input.eventType !== 'save') {
      throw new Error(`eventType '${input.eventType}' is not recorded in file emergence v1`)
    }

    const recent = input.eventType === 'open'
      ? this.db
          .prepare(`
            SELECT * FROM file_activity_events
            WHERE path = ? AND event_type = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get<FileActivityRow>(path, input.eventType, now - DEDUPE_WINDOW_MS)
      : this.db
          .prepare(`
            SELECT * FROM file_activity_events
            WHERE path = ? AND event_type = ? AND source = ? AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 1
          `)
          .get<FileActivityRow>(path, input.eventType, input.source, now - DEDUPE_WINDOW_MS)

    if (recent) {
      this.db
        .prepare(`
          UPDATE file_activity_events
          SET workspace_root = ?, weight = ?, meta_json = ?, created_at = ?
          WHERE id = ?
        `)
        .run(
          input.workspaceRoot ?? recent.workspace_root,
          input.weight ?? recent.weight,
          serializeMeta(input.meta),
          now,
          recent.id,
        )
      return this.getById(recent.id)!
    }

    const id = randomUUID()
    this.db
      .prepare(`
        INSERT INTO file_activity_events (
          id, path, workspace_root, event_type, source, weight, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        path,
          input.workspaceRoot ?? null,
          input.eventType,
          input.source,
          input.weight ?? defaultWeight(input.eventType, input.source),
          serializeMeta(input.meta),
          now,
      )
    return this.getById(id)!
  }

  getById(id: string): FileActivityEvent | null {
    const row = this.db
      .prepare('SELECT * FROM file_activity_events WHERE id = ?')
      .get<FileActivityRow>(id)
    return row ? rowToEvent(row) : null
  }

  listRecent(options: FileActivityListOptions): FileActivityEvent[] {
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit || 100)))
    const roots = Array.from(new Set(options.workspaceRoots.map((root) => root.trim()).filter(Boolean)))
    if (roots.length === 0) return []

    const placeholders = roots.map(() => '?').join(', ')
    return this.db
      .prepare(`
        SELECT * FROM file_activity_events
        WHERE workspace_root IN (${placeholders}) AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all<FileActivityRow>(...roots, options.since, limit)
      .map(rowToEvent)
  }

  prune(cutoff: number, maxRows: number): void {
    this.db.prepare('DELETE FROM file_activity_events WHERE created_at < ?').run(cutoff)
    const cappedRows = Math.max(1, Math.floor(maxRows || 10_000))
    this.db
      .prepare(`
        DELETE FROM file_activity_events
        WHERE id NOT IN (
          SELECT id FROM file_activity_events
          ORDER BY created_at DESC
          LIMIT ?
        )
      `)
      .run(cappedRows)
  }
}

function rowToEvent(row: FileActivityRow): FileActivityEvent {
  return {
    id: row.id,
    path: row.path,
    workspaceRoot: row.workspace_root,
    eventType: row.event_type,
    source: row.source,
    weight: row.weight,
    meta: parseMeta(row.meta_json),
    createdAt: row.created_at,
  }
}

function serializeMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta || Object.keys(meta).length === 0) return null
  return JSON.stringify(meta)
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function defaultWeight(eventType: FileActivityEventType, source: FileActivitySource): number {
  if (source === 'emergence') return 0.15
  if (eventType === 'save') return 1.2
  if (source === 'document_mode') return 1.1
  return 1
}
