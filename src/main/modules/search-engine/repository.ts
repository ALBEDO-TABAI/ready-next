import type { DatabaseConnection, DatabaseStatement } from '../database'
import type { WikilinkRef, MdlinkRef, AttachmentRef } from '../../../shared/document-graph-parse'

export interface DocumentRow {
  id: number
  workspace_id: number
  path: string
  name: string
  ext: string | null
  size: number | null
  mtime: number | null
  content_hash: string | null
  frontmatter_json: string | null
  indexed_at: number | null
}

export interface UpsertDocumentInput {
  workspaceId: number
  path: string
  name: string
  ext: string | null
  size: number | null
  mtime: number | null
  contentHash: string | null
  frontmatterJson: string | null
  body: string
  sourceType?: string
  sourceId?: string | null
  sourceMetaJson?: string | null
}

export interface UpsertDocumentResult {
  documentId: number
  skipped: boolean
}

export class SearchRepository {
  private readonly ensureWorkspaceStmt: DatabaseStatement
  private readonly findWorkspaceStmt: DatabaseStatement
  private readonly touchWorkspaceStmt: DatabaseStatement
  private readonly selectDocumentByPathStmt: DatabaseStatement
  private readonly insertDocumentStmt: DatabaseStatement
  private readonly updateDocumentStmt: DatabaseStatement
  private readonly deletePathStmt: DatabaseStatement
  private readonly listPathsForWorkspaceStmt: DatabaseStatement
  private readonly countDocumentsStmt: DatabaseStatement
  private readonly insertFtsStmt: DatabaseStatement | null
  private readonly deleteFtsStmt: DatabaseStatement | null
  private readonly deleteTagsStmt: DatabaseStatement
  private readonly insertTagStmt: DatabaseStatement
  private readonly deleteLinksStmt: DatabaseStatement
  private readonly insertLinkStmt: DatabaseStatement
  private readonly deleteAttachmentsStmt: DatabaseStatement
  private readonly insertAttachmentStmt: DatabaseStatement
  private readonly resolveLinkTargetsStmt: DatabaseStatement
  private readonly markResolvedFlagStmt: DatabaseStatement

  constructor(private readonly db: DatabaseConnection, private readonly ftsAvailable: boolean) {
    this.ensureWorkspaceStmt = db.prepare(
      'INSERT INTO workspaces (root) VALUES (?) ON CONFLICT(root) DO NOTHING'
    )
    this.findWorkspaceStmt = db.prepare('SELECT id FROM workspaces WHERE root = ?')
    this.touchWorkspaceStmt = db.prepare('UPDATE workspaces SET last_indexed_at = ? WHERE id = ?')
    this.selectDocumentByPathStmt = db.prepare(
      'SELECT id, content_hash FROM documents WHERE workspace_id = ? AND path = ?'
    )
    this.insertDocumentStmt = db.prepare(`
      INSERT INTO documents
        (workspace_id, path, name, ext, size, mtime, content_hash, frontmatter_json, indexed_at,
         source_type, source_id, source_meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.updateDocumentStmt = db.prepare(`
      UPDATE documents
      SET name = ?, ext = ?, size = ?, mtime = ?, content_hash = ?, frontmatter_json = ?, indexed_at = ?,
          source_type = ?, source_id = ?, source_meta_json = ?
      WHERE id = ?
    `)
    this.deletePathStmt = db.prepare(
      'DELETE FROM documents WHERE workspace_id = ? AND path = ?'
    )
    this.listPathsForWorkspaceStmt = db.prepare(
      'SELECT id, path FROM documents WHERE workspace_id = ?'
    )
    this.countDocumentsStmt = db.prepare(
      'SELECT COUNT(*) AS total FROM documents WHERE workspace_id = ?'
    )
    if (ftsAvailable) {
      this.insertFtsStmt = db.prepare('INSERT INTO documents_fts(rowid, name, body) VALUES (?, ?, ?)')
      this.deleteFtsStmt = db.prepare('DELETE FROM documents_fts WHERE rowid = ?')
    } else {
      this.insertFtsStmt = null
      this.deleteFtsStmt = null
    }
    this.deleteTagsStmt = db.prepare('DELETE FROM tags WHERE doc_id = ?')
    this.insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags (doc_id, tag) VALUES (?, ?)')
    this.deleteLinksStmt = db.prepare('DELETE FROM doc_links WHERE src_doc_id = ?')
    this.insertLinkStmt = db.prepare(
      'INSERT OR IGNORE INTO doc_links (src_doc_id, kind, target_text, target_doc_id, resolved) VALUES (?, ?, ?, NULL, 0)'
    )
    this.deleteAttachmentsStmt = db.prepare('DELETE FROM doc_attachments WHERE doc_id = ?')
    this.insertAttachmentStmt = db.prepare(
      'INSERT OR IGNORE INTO doc_attachments (doc_id, kind, ref) VALUES (?, ?, ?)'
    )
    this.resolveLinkTargetsStmt = db.prepare(`
      UPDATE doc_links
      SET target_doc_id = (
        SELECT d.id FROM documents d
        WHERE d.workspace_id = ?
          AND (d.name = doc_links.target_text
               OR d.name = doc_links.target_text || '.md'
               OR lower(d.name) = lower(doc_links.target_text)
               OR lower(d.name) = lower(doc_links.target_text) || '.md')
        LIMIT 1
      )
      WHERE kind = 'wikilink'
        AND src_doc_id IN (SELECT id FROM documents WHERE workspace_id = ?)
    `)
    this.markResolvedFlagStmt = db.prepare(`
      UPDATE doc_links
      SET resolved = CASE WHEN target_doc_id IS NULL THEN 0 ELSE 1 END
      WHERE src_doc_id IN (SELECT id FROM documents WHERE workspace_id = ?)
    `)
  }

  ensureWorkspace(root: string): number {
    this.ensureWorkspaceStmt.run(root)
    const row = this.findWorkspaceStmt.get<{ id: number }>(root)
    if (!row) {
      throw new Error(`[search-engine] failed to resolve workspace id for root=${root}`)
    }
    return row.id
  }

  touchWorkspace(workspaceId: number, at: number): void {
    this.touchWorkspaceStmt.run(at, workspaceId)
  }

  upsertDocument(input: UpsertDocumentInput): UpsertDocumentResult {
    const existing = this.selectDocumentByPathStmt.get<{ id: number; content_hash: string | null }>(
      input.workspaceId,
      input.path,
    )

    if (existing && existing.content_hash === input.contentHash && input.contentHash !== null) {
      return { documentId: existing.id, skipped: true }
    }

    const indexedAt = Math.floor(Date.now() / 1000)
    const sourceType = input.sourceType ?? 'document'
    const sourceId = input.sourceId ?? null
    const sourceMetaJson = input.sourceMetaJson ?? null

    if (!existing) {
      const insertResult = this.insertDocumentStmt.run(
        input.workspaceId,
        input.path,
        input.name,
        input.ext,
        input.size,
        input.mtime,
        input.contentHash,
        input.frontmatterJson,
        indexedAt,
        sourceType,
        sourceId,
        sourceMetaJson,
      ) as { lastInsertRowid: number | bigint }
      const documentId = Number(insertResult.lastInsertRowid)
      this.writeFtsRow(documentId, input.name, input.body)
      return { documentId, skipped: false }
    }

    this.updateDocumentStmt.run(
      input.name,
      input.ext,
      input.size,
      input.mtime,
      input.contentHash,
      input.frontmatterJson,
      indexedAt,
      sourceType,
      sourceId,
      sourceMetaJson,
      existing.id,
    )
    this.writeFtsRow(existing.id, input.name, input.body)
    return { documentId: existing.id, skipped: false }
  }

  replaceTags(documentId: number, tags: string[]): void {
    this.deleteTagsStmt.run(documentId)
    for (const tag of tags) {
      const trimmed = tag.trim()
      if (!trimmed) continue
      this.insertTagStmt.run(documentId, trimmed)
    }
  }

  replaceLinks(documentId: number, wikilinks: WikilinkRef[], mdlinks: MdlinkRef[]): void {
    this.deleteLinksStmt.run(documentId)
    for (const link of wikilinks) {
      const target = link.target.trim()
      if (!target) continue
      this.insertLinkStmt.run(documentId, 'wikilink', target)
    }
    for (const link of mdlinks) {
      const target = link.url.trim()
      if (!target) continue
      this.insertLinkStmt.run(documentId, 'mdlink', target)
    }
  }

  replaceAttachments(documentId: number, attachments: AttachmentRef[]): void {
    this.deleteAttachmentsStmt.run(documentId)
    for (const attachment of attachments) {
      const ref = attachment.ref.trim()
      if (!ref) continue
      this.insertAttachmentStmt.run(documentId, attachment.kind, ref)
    }
  }

  resolveWikilinkTargets(workspaceId: number): void {
    this.resolveLinkTargetsStmt.run(workspaceId, workspaceId)
    this.markResolvedFlagStmt.run(workspaceId)
  }

  deletePath(workspaceId: number, path: string): void {
    this.deletePathStmt.run(workspaceId, path)
  }

  listPathsForWorkspace(workspaceId: number, sourceType?: string): Array<{ id: number; path: string }> {
    if (sourceType) {
      return this.db
        .prepare('SELECT id, path FROM documents WHERE workspace_id = ? AND source_type = ?')
        .all<{ id: number; path: string }>(workspaceId, sourceType)
    }
    return this.listPathsForWorkspaceStmt.all<{ id: number; path: string }>(workspaceId)
  }

  countDocuments(workspaceId: number): number {
    const row = this.countDocumentsStmt.get<{ total: number }>(workspaceId)
    return row?.total ?? 0
  }

  listWorkspaceRoots(): Array<{ id: number; root: string }> {
    return this.db
      .prepare('SELECT id, root FROM workspaces ORDER BY LENGTH(root) DESC')
      .all<{ id: number; root: string }>()
  }

  /** Escape hatch for adapters that need ad-hoc SELECTs from their source tables. */
  getConnection(): DatabaseConnection {
    return this.db
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private writeFtsRow(documentId: number, name: string, body: string): void {
    if (!this.insertFtsStmt || !this.deleteFtsStmt) return
    this.deleteFtsStmt.run(documentId)
    this.insertFtsStmt.run(documentId, name, body)
  }
}
