import type { DatabaseConnection } from '../database/connection'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { basename, dirname, sep } from 'path'
import type {
  DocumentMarkDraft,
  DocumentMarkPatch,
  DocumentMarkRecord,
  DocumentMarkStatus,
} from '../../../shared/document-side-panels'


interface DocumentMarkRow {
  id: string
  kind: 'bookmark' | 'note'
  document_path: string
  title: string
  group_name: string
  note_text: string | null
  excerpt: string | null
  line_start: number | null
  line_end: number | null
  anchor_title: string | null
  anchor_ordinal: number | null
  anchor_progress: number | null
  anchor_status: DocumentMarkStatus
  sort_order: number
  created_at: string
  updated_at: string
}

interface RunResult {
  changes?: number
}

interface DocumentMarkPathRow {
  document_path: string
}

function normalizeText(value: string | null | undefined, fallback = ''): string {
  const next = (value ?? '').trim()
  return next || fallback
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const next = (value ?? '').trim()
  return next || null
}

function normalizeInteger(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(1, Math.floor(value as number))
}

function normalizeOrdinal(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.floor(value as number))
}

function normalizeProgress(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, Number(value)))
}

function getMoveSuffix(documentPath: string): string | null {
  const fileName = basename(documentPath)
  const parentName = basename(dirname(documentPath))
  if (!fileName || !parentName || parentName === sep) return null
  return `${sep}${parentName}${sep}${fileName}`
}

function rowToRecord(row: DocumentMarkRow): DocumentMarkRecord {
  return {
    id: row.id,
    kind: row.kind,
    documentPath: row.document_path,
    title: row.title,
    groupName: row.group_name,
    noteText: row.note_text,
    excerpt: row.excerpt,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    anchorTitle: row.anchor_title,
    anchorOrdinal: row.anchor_ordinal,
    anchorProgress: row.anchor_progress,
    anchorStatus: row.anchor_status,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DocumentMarksRepository {
  constructor(private readonly db: DatabaseConnection) {}

  private findMovedDocumentPaths(documentPath: string): string[] {
    if (!existsSync(documentPath)) return []
    const suffix = getMoveSuffix(documentPath)
    if (!suffix) return []
    const rows = this.db
      .prepare(`
        SELECT DISTINCT document_path
        FROM document_marks
        WHERE document_path != ?
          AND document_path LIKE ?
      `)
      .all<DocumentMarkPathRow>(documentPath, `%${suffix}`)
    return rows
      .map((row) => normalizeText(row.document_path))
      .filter((candidate) => (
        candidate &&
        candidate !== documentPath &&
        candidate.endsWith(suffix) &&
        !existsSync(candidate)
      ))
  }

  list(documentPath: string): DocumentMarkRecord[] {
    const normalizedPath = normalizeText(documentPath)
    if (!normalizedPath) return []
    const paths = [normalizedPath, ...this.findMovedDocumentPaths(normalizedPath)]
    const placeholders = paths.map(() => '?').join(', ')
    return this.db
      .prepare(`
        SELECT *
        FROM document_marks
        WHERE document_path IN (${placeholders})
        ORDER BY kind ASC, group_name ASC, sort_order ASC, updated_at DESC
      `)
      .all<DocumentMarkRow>(...paths)
      .map(rowToRecord)
  }

  create(draft: DocumentMarkDraft): DocumentMarkRecord {
    const documentPath = normalizeText(draft.documentPath)
    if (!documentPath) throw new Error('document_path_required')
    const kind = draft.kind === 'note' ? 'note' : 'bookmark'
    const now = new Date().toISOString()
    const sortOrder = Date.now()
    const fallbackTitle = kind === 'note' ? '新笔记' : '书签'
    const id = `dm-${randomUUID()}`

    this.db.prepare(`
      INSERT INTO document_marks (
        id, kind, document_path, title, group_name, note_text, excerpt,
        line_start, line_end, anchor_title, anchor_ordinal, anchor_progress,
        anchor_status, sort_order, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?)
    `).run(
      id,
      kind,
      documentPath,
      normalizeText(draft.title, fallbackTitle),
      normalizeText(draft.groupName, '默认'),
      normalizeNullableText(draft.noteText),
      normalizeNullableText(draft.excerpt),
      normalizeInteger(draft.lineStart),
      normalizeInteger(draft.lineEnd),
      normalizeNullableText(draft.anchorTitle),
      normalizeOrdinal(draft.anchorOrdinal ?? null),
      normalizeProgress(draft.anchorProgress),
      sortOrder,
      now,
      now,
    )

    const created = this.get(id)
    if (!created) throw new Error('document_mark_create_failed')
    return created
  }

  get(id: string): DocumentMarkRecord | null {
    const row = this.db
      .prepare('SELECT * FROM document_marks WHERE id = ?')
      .get<DocumentMarkRow>(id)
    return row ? rowToRecord(row) : null
  }

  update(id: string, patch: DocumentMarkPatch): DocumentMarkRecord | null {
    const existing = this.get(id)
    if (!existing) return null

    const next = {
      title: patch.title !== undefined ? normalizeText(patch.title, existing.title) : existing.title,
      groupName: patch.groupName !== undefined ? normalizeText(patch.groupName, '默认') : existing.groupName,
      noteText: patch.noteText !== undefined ? normalizeNullableText(patch.noteText) : existing.noteText,
      excerpt: patch.excerpt !== undefined ? normalizeNullableText(patch.excerpt) : existing.excerpt,
      lineStart: patch.lineStart !== undefined ? normalizeInteger(patch.lineStart) : existing.lineStart,
      lineEnd: patch.lineEnd !== undefined ? normalizeInteger(patch.lineEnd) : existing.lineEnd,
      anchorTitle: patch.anchorTitle !== undefined ? normalizeNullableText(patch.anchorTitle) : existing.anchorTitle,
      anchorOrdinal: patch.anchorOrdinal !== undefined ? normalizeOrdinal(patch.anchorOrdinal) : existing.anchorOrdinal,
      anchorProgress: patch.anchorProgress !== undefined ? normalizeProgress(patch.anchorProgress) : existing.anchorProgress,
      anchorStatus: patch.anchorStatus !== undefined ? (patch.anchorStatus === 'stale' ? 'stale' : 'linked') : existing.anchorStatus,
      sortOrder: Number.isFinite(patch.sortOrder) ? Math.max(0, Math.floor(patch.sortOrder as number)) : existing.sortOrder,
    }

    this.db.prepare(`
      UPDATE document_marks
      SET title = ?,
          group_name = ?,
          note_text = ?,
          excerpt = ?,
          line_start = ?,
          line_end = ?,
          anchor_title = ?,
          anchor_ordinal = ?,
          anchor_progress = ?,
          anchor_status = ?,
          sort_order = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.groupName,
      next.noteText,
      next.excerpt,
      next.lineStart,
      next.lineEnd,
      next.anchorTitle,
      next.anchorOrdinal,
      next.anchorProgress,
      next.anchorStatus,
      next.sortOrder,
      new Date().toISOString(),
      id,
    )

    return this.get(id)
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM document_marks WHERE id = ?')
      .run(id) as RunResult
    return (result.changes ?? 0) > 0
  }
}
