import { ObjectRegistry, canonicalObjectPath } from '../object-service/registry'
import type { DatabaseConnection, DatabaseStatement } from '../database/connection'

import type { AttachmentRef } from '../../../shared/document-graph-parse'
import { ObjectLinkRepository } from './object-links'
import { extractCanvasLinks } from './canvas-links'
import { extractObjectLinks } from './object-link-extract'
import { parseReadyUri } from '../../../shared/ready-ref'
import { createHash } from 'node:crypto'
import { buildFtsSearchText } from './query'

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

export interface IndexedPathMetadata {
  id: number
  path: string
  size: number | null
  mtime: number | null
  contentHash: string | null
}

export class SearchRepository {
  private readonly ensureWorkspaceStmt: DatabaseStatement
  private readonly findWorkspaceStmt: DatabaseStatement
  private readonly touchWorkspaceStmt: DatabaseStatement
  private readonly selectDocumentByPathStmt: DatabaseStatement
  private readonly insertDocumentStmt: DatabaseStatement
  private readonly updateDocumentStmt: DatabaseStatement
  private readonly updateDocumentMetadataStmt: DatabaseStatement
  private readonly deletePathStmt: DatabaseStatement
  private readonly listPathsForWorkspaceStmt: DatabaseStatement
  private readonly countDocumentsStmt: DatabaseStatement
  private readonly insertFtsStmt: DatabaseStatement | null
  private readonly deleteFtsStmt: DatabaseStatement | null
  private readonly deleteTagsStmt: DatabaseStatement
  private readonly insertTagStmt: DatabaseStatement
  private readonly deleteAttachmentsStmt: DatabaseStatement
  private readonly insertAttachmentStmt: DatabaseStatement

  constructor(private readonly db: DatabaseConnection, private readonly ftsAvailable: boolean) {
    this.ensureWorkspaceStmt = db.prepare(
      'INSERT INTO workspaces (root) VALUES (?) ON CONFLICT(root) DO NOTHING'
    )
    this.findWorkspaceStmt = db.prepare('SELECT id FROM workspaces WHERE root = ?')
    this.touchWorkspaceStmt = db.prepare('UPDATE workspaces SET last_indexed_at = ? WHERE id = ?')
    this.selectDocumentByPathStmt = db.prepare(
      'SELECT id, path, size, mtime, content_hash AS contentHash FROM documents WHERE workspace_id = ? AND path = ?'
    )
    this.insertDocumentStmt = db.prepare(`
      INSERT INTO documents
        (workspace_id, path, name, ext, size, mtime, content_hash, frontmatter_json, indexed_at,
         source_type, source_id, source_meta_json, object_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.updateDocumentStmt = db.prepare(`
      UPDATE documents
      SET name = ?, ext = ?, size = ?, mtime = ?, content_hash = ?, frontmatter_json = ?, indexed_at = ?,
          source_type = ?, source_id = ?, source_meta_json = ?
      WHERE id = ?
    `)
    this.updateDocumentMetadataStmt = db.prepare(`
      UPDATE documents
      SET name = ?, ext = ?, size = ?, mtime = ?, frontmatter_json = ?, indexed_at = ?,
          source_type = ?, source_id = ?, source_meta_json = ?
      WHERE id = ?
    `)
    this.deletePathStmt = db.prepare(
      'DELETE FROM documents WHERE workspace_id = ? AND path = ?'
    )
    this.listPathsForWorkspaceStmt = db.prepare(
      'SELECT id, path, size, mtime, content_hash AS contentHash FROM documents WHERE workspace_id = ?'
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
    this.deleteAttachmentsStmt = db.prepare('DELETE FROM doc_attachments WHERE doc_id = ?')
    this.insertAttachmentStmt = db.prepare('INSERT OR IGNORE INTO doc_attachments (doc_id, kind, ref) VALUES (?, ?, ?)')
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
    const registry = new ObjectRegistry(this.db)
    const object = (input.sourceType ?? 'document') === 'document' ? registry.find(input.path) : null
    if ((input.sourceType ?? 'document') === 'document' && (!object || object.identity_state === 'conflict')) throw new Error('Search requires a verified object')
    if (object) input = {...input,path:object.current_path!,workspaceId:object.workspace_id??input.workspaceId}
    const existing = object
      ? this.db.prepare('SELECT id,path,size,mtime,content_hash AS contentHash FROM documents WHERE object_id=?').get<IndexedPathMetadata>(object.id)
      : this.selectDocumentByPathStmt.get<IndexedPathMetadata>(input.workspaceId,input.path)

    const indexedAt = Math.floor(Date.now() / 1000)
    const sourceType = input.sourceType ?? 'document'
    const sourceId = input.sourceId ?? null
    const sourceMetaJson = input.sourceMetaJson ?? null

    if (existing && existing.contentHash === input.contentHash && input.contentHash !== null) {
      this.updateDocumentMetadataStmt.run(
        input.name,
        input.ext,
        input.size,
        input.mtime,
        input.frontmatterJson,
        indexedAt,
        sourceType,
        sourceId,
        sourceMetaJson,
        existing.id,
      )
      return { documentId: existing.id, skipped: true }
    }

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
        object?.id ?? null,
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

  replaceLinks(documentId: number, raw: string): void {
    const doc = this.db.prepare('SELECT object_id,path FROM documents WHERE id=?').get<{object_id:string|null;path:string}>(documentId)
    if (!doc) throw new Error('Link source missing')
    const parsed = parseReadyUri(doc.path)
    const source = doc.object_id ? {objectId:doc.object_id} : parsed.ok ? {ref:parsed.ref} : null
    if (!source) throw new Error('Link source requires an object or ReadyRef')
    new ObjectLinkRepository(this.db).replace(source, (doc.path.endsWith('.canvas') ? extractCanvasLinks(raw) : extractObjectLinks(raw)), createHash('sha256').update(raw).digest('hex'))
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
    new ObjectLinkRepository(this.db).resolveWorkspace(workspaceId)
  }

  resolveWikilinkTargetsForDocument(documentId: number): void {
    new ObjectLinkRepository(this.db).resolveDocument(documentId)
  }

  deletePath(workspaceId: number, path: string): number {
    const result = this.deletePathStmt.run(workspaceId, path.startsWith('/') ? canonicalObjectPath(path) : path) as { changes?: number }
    return Number(result.changes ?? 0)
  }

  getPathMetadata(workspaceId: number, path: string): IndexedPathMetadata | undefined {
    return this.selectDocumentByPathStmt.get<IndexedPathMetadata>(workspaceId, path.startsWith('/') ? canonicalObjectPath(path) : path)
  }

  listPathsForWorkspace(workspaceId: number, sourceType?: string): IndexedPathMetadata[] {
    if (sourceType) {
      return this.db
        .prepare(`
          SELECT id, path, size, mtime, content_hash AS contentHash
          FROM documents
          WHERE workspace_id = ? AND source_type = ?
        `)
        .all<IndexedPathMetadata>(workspaceId, sourceType)
    }
    return this.listPathsForWorkspaceStmt.all<IndexedPathMetadata>(workspaceId)
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
    this.insertFtsStmt.run(documentId, buildFtsSearchText(name), buildFtsSearchText(body))
  }
}
