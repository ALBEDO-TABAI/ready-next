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
  // perf-rescue B8: per-document wikilink resolution. Avoids the full-workspace
  // re-scan on every single-file save. See resolveWikilinkTargetsForDocument().
  private readonly resolveOutgoingLinksStmt: DatabaseStatement
  private readonly markOutgoingResolvedFlagStmt: DatabaseStatement
  private readonly selectDocumentByIdStmt: DatabaseStatement
  private readonly resolveIncomingLinksByNameStmt: DatabaseStatement
  private readonly markIncomingResolvedByNameStmt: DatabaseStatement

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
    // perf-rescue B8: narrow per-document resolvers. Used on the single-file
    // save path so we don't re-scan every wikilink in the workspace just
    // because one file changed.
    //
    // (A) Outgoing — re-resolve only links emitted by this document. The
    //     target lookup stays the same as the workspace-wide variant; only
    //     the WHERE on src_doc_id is narrowed.
    this.resolveOutgoingLinksStmt = db.prepare(`
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
      WHERE kind = 'wikilink' AND src_doc_id = ?
    `)
    this.markOutgoingResolvedFlagStmt = db.prepare(`
      UPDATE doc_links
      SET resolved = CASE WHEN target_doc_id IS NULL THEN 0 ELSE 1 END
      WHERE src_doc_id = ?
    `)
    this.selectDocumentByIdStmt = db.prepare(
      'SELECT id, workspace_id, name FROM documents WHERE id = ?'
    )
    // (B) Incoming — when this doc is newly created/renamed, ghost-links from
    //     other docs in the same workspace whose target_text matches this
    //     doc's name should bind to this doc's id. We restrict to wikilinks
    //     that are still unresolved (target_doc_id IS NULL) so we don't
    //     overwrite an already-bound resolution.
    //
    //     The match logic is symmetric with the workspace resolver:
    //     given the *workspace* resolver matches a target_text against
    //     d.name across (=, =||.md, lower=, lower=||.md), the incoming
    //     resolver tries every spelling of d.name a target_text could have
    //     used. Concretely we accept target_text in {name, basename(name),
    //     name without .md, name + .md} compared case-(in)sensitively.
    //
    //     Bind params (fed by resolveWikilinkTargetsForDocument):
    //       1. documentId      (the new target_doc_id)
    //       2. workspaceId     (scope filter)
    //       3. name            (exact)
    //       4. nameNoMd        (name with trailing .md stripped, or = name)
    //       5. name            (lower-compare)
    //       6. nameNoMd        (lower-compare)
    this.resolveIncomingLinksByNameStmt = db.prepare(`
      UPDATE doc_links
      SET target_doc_id = ?
      WHERE kind = 'wikilink'
        AND target_doc_id IS NULL
        AND src_doc_id IN (SELECT id FROM documents WHERE workspace_id = ?)
        AND (
          target_text = ?
          OR target_text = ?
          OR lower(target_text) = lower(?)
          OR lower(target_text) = lower(?)
        )
    `)
    this.markIncomingResolvedByNameStmt = db.prepare(`
      UPDATE doc_links
      SET resolved = 1
      WHERE kind = 'wikilink'
        AND target_doc_id = ?
        AND resolved = 0
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

  /**
   * perf-rescue B8: resolve wikilinks for a single document.
   *
   * Two narrow updates instead of the workspace-wide resolver:
   *  (A) outgoing — links from this doc may now bind to existing targets;
   *  (B) incoming — ghost-links in OTHER docs that point at this doc's name
   *      now bind to this doc's id.
   *
   * Edge cases the per-doc path can't catch (so the caller should still
   * schedule a debounced workspace resolve as backup):
   *  - A doc was renamed and its old name was the target of ghost-links: the
   *    incoming pass binds them to the *new* name, but ghost-links targeting
   *    the *old* name in some unrelated rename history won't unbind here.
   *  - A doc was deleted and an ON DELETE SET NULL fired: the resolved flag
   *    was not flipped back to 0 by SQLite trigger (we don't have one).
   *  - Ambiguous names where multiple documents share `name` — the workspace
   *    resolver's `LIMIT 1` is non-deterministic; per-doc agrees on a single
   *    binding direction but cross-doc ties aren't reconciled.
   */
  resolveWikilinkTargetsForDocument(documentId: number): void {
    const doc = this.selectDocumentByIdStmt.get<{ id: number; workspace_id: number; name: string }>(documentId)
    if (!doc) return
    // (A) outgoing — bind/refresh this doc's own wikilinks
    this.resolveOutgoingLinksStmt.run(doc.workspace_id, documentId)
    this.markOutgoingResolvedFlagStmt.run(documentId)
    // (B) incoming — bind ghost-links in same workspace targeting this doc's name
    if (doc.name && doc.name.length > 0) {
      // Try both spellings the link author might have written:
      //   - the doc's name verbatim (e.g. [[Foo.md]] when name="Foo.md")
      //   - the basename without .md (e.g. [[Foo]] when name="Foo.md")
      // Both compared case-(in)sensitively. See SQL above for the param order.
      const nameNoMd = doc.name.toLowerCase().endsWith('.md')
        ? doc.name.slice(0, -3)
        : doc.name
      this.resolveIncomingLinksByNameStmt.run(
        documentId,
        doc.workspace_id,
        doc.name,
        nameNoMd,
        doc.name,
        nameNoMd,
      )
      this.markIncomingResolvedByNameStmt.run(documentId)
    }
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
