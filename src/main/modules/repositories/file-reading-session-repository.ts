import { randomUUID } from 'crypto'

import type { DatabaseConnection } from '../database'
import type {
  FileEmergenceReadingProgressKind,
  FileReadingSession,
} from '../../../shared/file-emergence'

export interface FileReadingSessionRecordInput {
  path: string
  workspaceRoot?: string | null
  source: 'document_mode'
  startedAt: number
  endedAt: number
  activeMs: number
  progressStart?: number | null
  progressEnd?: number | null
  progressKind?: FileEmergenceReadingProgressKind | null
  meta?: Record<string, unknown>
}

export interface FileReadingSessionListOptions {
  workspaceRoots: string[]
  since: number
  limit: number
}

interface FileReadingSessionRow {
  id: string
  path: string
  workspace_root: string | null
  source: 'document_mode'
  started_at: number
  ended_at: number
  active_ms: number
  progress_start: number | null
  progress_end: number | null
  progress_kind: FileEmergenceReadingProgressKind | null
  meta_json: string | null
}

const MIN_ACTIVE_MS = 30_000

export class FileReadingSessionRepository {
  constructor(private readonly db: DatabaseConnection) {}

  recordSession(input: FileReadingSessionRecordInput): FileReadingSession | null {
    const path = input.path.trim()
    if (!path) throw new Error('path is required')
    if (input.source !== 'document_mode') {
      throw new Error(`source '${input.source}' is not recorded for reading sessions`)
    }
    const startedAt = Math.floor(input.startedAt)
    const endedAt = Math.floor(input.endedAt)
    const activeMs = Math.floor(input.activeMs)
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
      throw new Error('reading session time range is invalid')
    }
    if (!Number.isFinite(activeMs) || activeMs < MIN_ACTIVE_MS) return null

    const id = randomUUID()
    this.db
      .prepare(`
        INSERT INTO document_reading_sessions (
          id, path, workspace_root, source, started_at, ended_at, active_ms,
          progress_start, progress_end, progress_kind, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        path,
        input.workspaceRoot ?? null,
        input.source,
        startedAt,
        endedAt,
        activeMs,
        normalizeProgress(input.progressStart),
        normalizeProgress(input.progressEnd),
        input.progressKind ?? null,
        serializeMeta(input.meta),
      )
    return this.getById(id)
  }

  getById(id: string): FileReadingSession | null {
    const row = this.db
      .prepare('SELECT * FROM document_reading_sessions WHERE id = ?')
      .get<FileReadingSessionRow>(id)
    return row ? rowToSession(row) : null
  }

  listRecent(options: FileReadingSessionListOptions): FileReadingSession[] {
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit || 100)))
    const roots = Array.from(new Set(options.workspaceRoots.map((root) => root.trim()).filter(Boolean)))
    if (roots.length === 0) return []

    const placeholders = roots.map(() => '?').join(', ')
    return this.db
      .prepare(`
        SELECT * FROM document_reading_sessions
        WHERE workspace_root IN (${placeholders}) AND ended_at >= ?
        ORDER BY ended_at DESC
        LIMIT ?
      `)
      .all<FileReadingSessionRow>(...roots, options.since, limit)
      .map(rowToSession)
  }

  prune(cutoff: number, maxRows: number): void {
    this.db.prepare('DELETE FROM document_reading_sessions WHERE ended_at < ?').run(cutoff)
    const cappedRows = Math.max(1, Math.floor(maxRows || 10_000))
    this.db
      .prepare(`
        DELETE FROM document_reading_sessions
        WHERE id NOT IN (
          SELECT id FROM document_reading_sessions
          ORDER BY ended_at DESC
          LIMIT ?
        )
      `)
      .run(cappedRows)
  }
}

function rowToSession(row: FileReadingSessionRow): FileReadingSession {
  return {
    id: row.id,
    path: row.path,
    workspaceRoot: row.workspace_root,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    activeMs: row.active_ms,
    progressStart: row.progress_start,
    progressEnd: row.progress_end,
    progressKind: row.progress_kind,
    meta: parseMeta(row.meta_json),
  }
}

function normalizeProgress(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
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
