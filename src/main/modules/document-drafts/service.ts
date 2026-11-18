import { relativeFileReference } from '../../utils/platform'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import {
  DocumentDraftSchema, DraftCreateSchema, DraftFinalizeInputSchema, DraftIdSchema, DraftRevisionSchema,
  LegacyDraftItemSchema, DraftReceiptSchema,
  type DocumentDraft, type DraftCreate, type DraftFinalizeInput, type DraftFinalizeIntent,
  type DraftFinalizeReceipt, type DraftReceipt, type LegacyDraftItem, type LegacyDraftReceipt,
} from '../../../shared/document-drafts'
import { readDocumentSource, setFrontmatterFields } from '../../../shared/document-operations'
import { rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'
import { CanvasPathSchema } from '../../../shared/ready-canvas/schema'
import type { DatabaseConnection } from '../database/connection'
import { ObjectRegistry, objectTransaction } from '../object-service/registry'
import { checkedPath, collision, draftError, ensureDirectory, existsIgnoringCase, filename, hashBytes, publishNewFile, realParent, stageFile, vaultRoot } from './files'

export interface DraftDependencies {
  registry: ObjectRegistry
  index(vaultRoot: string, path: string): Promise<void>
  beforePublish?(): void | Promise<void>
  completeCanvas?(draft: DocumentDraft, receipt: DraftFinalizeReceipt, keep: boolean): Promise<void>
}
const select = `SELECT draft_id AS draftId, tab_id AS tabId, vault_root AS vaultRoot, revision, content, content_hash AS contentHash,
  origin, object_id AS objectId, base_version AS baseVersion, suggested_parent AS suggestedParent,
  source_canvas_json AS sourceCanvas, attachments_json AS attachments, title, state, finalize_json AS finalize,
  created_at AS createdAt, updated_at AS updatedAt FROM document_drafts`
function decode(row: Record<string, unknown>): DocumentDraft {
  const json = (key: string) => typeof row[key] === 'string' ? JSON.parse(row[key]) : row[key]
  return DocumentDraftSchema.parse({ ...row, sourceCanvas: json('sourceCanvas'), attachments: json('attachments'), finalize: json('finalize') })
}
function receipt(draft: DocumentDraft): DraftReceipt {
  return { draftId: draft.draftId, revision: draft.revision, contentHash: draft.contentHash }
}

export class DocumentDraftService {
  private readonly pending = new Map<string, { input: string; promise: Promise<DraftFinalizeReceipt> }>()
  constructor(private readonly db: DatabaseConnection, private readonly dependencies: DraftDependencies) {
    // One service is created at Main startup. Interrupted intents remain attached and retryable.
    db.prepare("UPDATE document_drafts SET state='editing' WHERE state='finalizing'").run()
  }

  read(draftId: string): DocumentDraft | null {
    const row = this.db.prepare(`${select} WHERE draft_id=?`).get<Record<string, unknown>>(DraftIdSchema.parse(draftId))
    return row ? decode(row) : null
  }
  list(root: string, tabId?: string): DocumentDraft[] {
    if (tabId !== undefined) DraftIdSchema.parse(tabId)
    return this.db.prepare(`${select} WHERE vault_root=?
      ${tabId === undefined ? "AND state IN ('editing','conflict')" : 'AND tab_id=?'}
      ORDER BY revision DESC,CASE WHEN state IN ('editing','conflict') THEN 0 ELSE 1 END,updated_at DESC,draft_id`)
      .all<Record<string, unknown>>(...[vaultRoot(root), ...(tabId === undefined ? [] : [tabId])]).map(decode)
  }
  private require(draftId: string, expectedRevision?: number): DocumentDraft {
    const draft = this.read(draftId)
    if (!draft) throw draftError('not_found', 'draft not found')
    if (expectedRevision !== undefined && draft.revision !== DraftRevisionSchema.parse(expectedRevision)) throw draftError('revision_conflict', 'draft revision changed')
    return draft
  }
  private write(draft: DocumentDraft, previousRevision: number): DocumentDraft {
    draft = DocumentDraftSchema.parse(draft)
    this.db.prepare(`UPDATE document_drafts SET tab_id=?,revision=?,content=?,content_hash=?,state=?,finalize_json=?,updated_at=?
      WHERE draft_id=? AND revision=?`).run(draft.tabId, draft.revision, draft.content, draft.contentHash, draft.state,
      draft.finalize ? JSON.stringify(draft.finalize) : null, Date.now(), draft.draftId, previousRevision)
    const readback = this.require(draft.draftId)
    if (readback.tabId !== draft.tabId || readback.revision !== draft.revision || readback.contentHash !== draft.contentHash || readback.content !== draft.content ||
      readback.state !== draft.state || JSON.stringify(readback.finalize) !== JSON.stringify(draft.finalize)) {
      throw draftError('readback_mismatch', 'draft database readback mismatch')
    }
    return readback
  }
  private baseChanged(draft: DocumentDraft): boolean {
    if (draft.origin !== 'document') return false
    const object = this.dependencies.registry.get(draft.objectId!)
    if (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict') return true
    const path = checkedPath(draft.vaultRoot, object.current_path)
    try { return hashBytes(readFileSync(path)) !== draft.baseVersion }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error }
  }
  private conflict(draft: DocumentDraft): never {
    const saved = this.write({ ...draft, state: 'conflict' }, draft.revision)
    throw Object.assign(draftError('base_conflict', 'document base version changed'), { receipt: receipt(saved) })
  }

  private nextRevision(root: string, tabId: string | null): number {
    const row = this.db.prepare('SELECT MAX(revision) AS revision FROM document_drafts WHERE vault_root=? AND tab_id=?')
      .get<{ revision: number | null }>(root, tabId)
    return (row?.revision ?? 0) + 1
  }
  create(input: DraftCreate): DraftReceipt {
    const parsed = DraftCreateSchema.parse(input)
    const root = vaultRoot(parsed.vaultRoot)
    for (const attachment of parsed.attachments) {
      checkedPath(root, attachment.sourcePath)
      if (filename(attachment.name) !== attachment.name) throw draftError('invalid_attachment', 'attachment name must be a safe filename')
    }
    if (new Set(parsed.attachments.map(item => item.name.toLowerCase())).size !== parsed.attachments.length) throw draftError('invalid_attachment', 'duplicate attachment name')
    const now = Date.now()
    const draft: DocumentDraft = {
      ...parsed, vaultRoot: root, draftId: randomUUID(), revision: this.nextRevision(root, parsed.tabId), contentHash: hashBytes(parsed.content),
      objectId: parsed.origin === 'document' ? parsed.objectId : null,
      baseVersion: parsed.origin === 'document' ? parsed.baseVersion : null,
      sourceCanvas: parsed.origin === 'canvas' ? parsed.sourceCanvas : null,
      state: 'editing', finalize: null, createdAt: now, updatedAt: now,
    }
    if (this.baseChanged(draft)) draft.state = 'conflict'
    this.db.prepare(`INSERT INTO document_drafts
      (draft_id,tab_id,vault_root,revision,content,content_hash,origin,object_id,base_version,suggested_parent,source_canvas_json,attachments_json,title,state,finalize_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`).run(draft.draftId, draft.tabId, root, draft.revision, draft.content, draft.contentHash,
      draft.origin, draft.objectId, draft.baseVersion, draft.suggestedParent, draft.sourceCanvas ? JSON.stringify(draft.sourceCanvas) : null,
      JSON.stringify(draft.attachments), draft.title, draft.state, now, now)
    const saved = this.require(draft.draftId)
    if (saved.content !== draft.content || saved.contentHash !== draft.contentHash) throw draftError('readback_mismatch', 'created draft readback mismatch')
    return receipt(saved)
  }
  save(draftId: string, expectedRevision: number, content: string, tabId: string): DraftReceipt {
    const draft = this.require(draftId, expectedRevision)
    z.string().parse(content)
    DraftIdSchema.parse(tabId)
    if (!['editing', 'conflict'].includes(draft.state) || (draft.finalize && content !== draft.content)) throw draftError('invalid_state', 'draft is not editable; resume its pending finalization')
    // Recovering a pending finalization may rebind its tab, but cannot revise its frozen intent.
    if (draft.finalize) return receipt(this.write({ ...draft, tabId }, draft.revision))
    const changed = this.baseChanged(draft)
    const saved = this.write({ ...draft, tabId, content, contentHash: hashBytes(content), revision: Math.max(draft.revision + 1, this.nextRevision(draft.vaultRoot, tabId)),
      state: changed || draft.state === 'conflict' ? 'conflict' : 'editing' }, draft.revision)
    if (saved.state === 'conflict') throw Object.assign(draftError('base_conflict', 'document base version changed'), { receipt: receipt(saved) })
    return receipt(saved)
  }
  discard(draftId: string, expectedRevision: number): DraftReceipt {
    const draft = this.require(draftId, expectedRevision)
    if (draft.finalize || !['editing', 'conflict'].includes(draft.state)) throw draftError('invalid_state', 'pending or completed finalization cannot be discarded')
    return receipt(this.write({ ...draft, revision: draft.revision + 1, state: 'discarded' }, draft.revision))
  }

  async finalize(draftId: string, expectedRevision: number, input: DraftFinalizeInput): Promise<DraftFinalizeReceipt> {
    const request = DraftFinalizeInputSchema.parse(input)
    const key = JSON.stringify({ expectedRevision, request })
    const pending = this.pending.get(draftId)
    if (pending) {
      if (pending.input !== key) throw draftError('operation_conflict', 'another operation is finalizing this draft')
      return pending.promise
    }
    const promise = this.finalizeOnce(draftId, expectedRevision, request)
    this.pending.set(draftId, { input: key, promise })
    try { return await promise } finally { this.pending.delete(draftId) }
  }
  private prepare(draft: DocumentDraft, request: DraftFinalizeInput): DraftFinalizeIntent {
    const name = filename(request.title)
    const registry = this.dependencies.registry
    const parent = request.parentObjectId ? registry.get(request.parentObjectId) : null
    if (request.parentObjectId && (!parent?.current_path || parent.status !== 'present')) throw draftError('invalid_parent', 'parent object is unavailable')
    // A picked folder may arrive through a system alias (/var vs /private/var); the parent exists, so check its real location.
    const parentPath = checkedPath(draft.vaultRoot, realParent(parent?.current_path ?? request.parentPath!))
    const info = statSync(parentPath)
    registry.reconcile([parentPath], false)
    const parentObject = registry.find(parentPath)
    if (!parentObject || (request.parentObjectId && parentObject.id !== request.parentObjectId)) throw draftError('invalid_parent', 'parent identity changed')
    if (parentObject.identity_state === 'conflict') throw draftError('invalid_parent', 'parent identity is ambiguous')
    if (!info.isDirectory() && !['.md', '.canvas'].includes(extname(parentPath).toLowerCase())) throw draftError('invalid_parent', 'parent must be a page or directory')
    const directory = info.isDirectory() ? parentPath : join(dirname(parentPath), basename(parentPath, extname(parentPath)))
    checkedPath(draft.vaultRoot, directory)
    const path = join(directory, `${name}.md`)
    if (draft.origin === 'canvas' && request.keepDocumentCard !== false && !CanvasPathSchema.safeParse(relativeFileReference(draft.vaultRoot, path)).success) {
      throw draftError('invalid_canvas_path', '画板无法引用此路径，请使用不含 #、% 等特殊字符的名称或位置')
    }
    if (existsIgnoringCase(path)) throw collision(path)
    // Only drafts still on their way to disk claim a path; a finalized page may since have been renamed away.
    const claimed = this.db.prepare("SELECT draft_id FROM document_drafts WHERE json_extract(finalize_json,'$.path')=? AND state NOT IN ('discarded','finalized')").get(path)
    if (claimed) throw collision(path)
    const operation = this.db.prepare("SELECT draft_id FROM document_drafts WHERE json_extract(finalize_json,'$.request.operationId')=?").get(request.operationId)
    if (operation) throw draftError('operation_conflict', 'operation id already belongs to a draft')
    let content = draft.content
    const fields = readDocumentSource(content).frontmatter
    if (name !== request.title || 'ready_id' in fields) content = setFrontmatterFields(content, {
      set: name !== request.title ? { title: request.title } : {}, remove: ['ready_id'],
    })
    if (draft.origin === 'canvas' && request.keepDocumentCard !== false) {
      content = setFrontmatterFields(content, { set: { ready_id: registry.reserve(path).id } })
    }
    const media = new Map(draft.attachments.filter(item => item.markdownPath).map(item => [item.markdownPath!, `${name}.assets/${item.name}`]))
    content = rewriteMarkdownMediaRefs(content, ref => ref.localCandidate && media.has(ref.localCandidate) ? encodeURI(media.get(ref.localCandidate)!) : null)
    const stagingDirectory = join(draft.vaultRoot, '.ready', 'draft-finalize', draft.draftId)
    const files: DraftFinalizeIntent['files'] = draft.attachments.map((attachment, i) => ({
      path: join(directory, `${name}.assets`, attachment.name), stagePath: join(stagingDirectory, String(i)),
      contentHash: attachment.contentHash, sourcePath: attachment.sourcePath,
    }))
    for (const file of files) { checkedPath(draft.vaultRoot, file.path); if (existsIgnoringCase(file.path)) throw collision(file.path) }
    files.push({ path, stagePath: join(stagingDirectory, 'document'), contentHash: hashBytes(content), sourcePath: null })
    return { request, path, directory, parentObjectId: parentObject.id, stagingDirectory, content, contentHash: hashBytes(content), files, receipt: null }
  }
  private async finalizeOnce(draftId: string, expectedRevision: number, request: DraftFinalizeInput): Promise<DraftFinalizeReceipt> {
    let draft = this.require(draftId, expectedRevision)
    if (draft.finalize && JSON.stringify(draft.finalize.request) !== JSON.stringify(request)) throw draftError('operation_conflict', 'operation intent cannot change')
    if (this.baseChanged(draft)) this.conflict(draft)
    if (draft.finalize?.receipt) return draft.finalize.receipt
    if (draft.state !== 'editing') throw draftError('invalid_state', 'draft cannot be finalized in its current state')
    if (draft.origin === 'canvas' && !this.dependencies.completeCanvas) throw draftError('canvas_unavailable', '画板保存服务尚未接通')
    const intent = draft.finalize ?? this.prepare(draft, request)
    try {
      draft = this.write({ ...draft, state: 'finalizing', finalize: intent }, draft.revision)
      if (intent.publishedReceipt) return await this.completeFinalization(draft, intent.publishedReceipt)
      ensureDirectory(draft.vaultRoot, intent.directory)
      ensureDirectory(draft.vaultRoot, intent.stagingDirectory)
      for (const file of intent.files) {
        let data: string | Uint8Array
        // Prefer an existing stage on retry, so moved source attachments do not break recovery.
        try { data = await readFile(checkedPath(draft.vaultRoot, file.stagePath)) }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          data = file.sourcePath ? await readFile(checkedPath(draft.vaultRoot, file.sourcePath)) : intent.content
        }
        if (hashBytes(data) !== file.contentHash) throw draftError('attachment_conflict', 'attachment content hash changed')
        await stageFile(draft.vaultRoot, file.stagePath, data, file.contentHash)
      }
      await this.dependencies.beforePublish?.()
      if (this.baseChanged(draft)) this.conflict(draft)
      for (const file of intent.files) {
        ensureDirectory(draft.vaultRoot, dirname(file.path))
        await publishNewFile(draft.vaultRoot, file.stagePath, file.path, file.contentHash)
      }
      const object = this.dependencies.registry.register(intent.path)
      if (object.identity_state === 'conflict' || object.content_hash !== intent.contentHash) throw draftError('identity_conflict', 'published object identity readback mismatch')
      await this.dependencies.index(draft.vaultRoot, intent.path)
      if (this.baseChanged(draft)) this.conflict(draft)
      const result: DraftFinalizeReceipt = { operationId: request.operationId, draftId, revision: draft.revision,
        objectId: object.id, path: intent.path, contentHash: intent.contentHash, parentObjectId: intent.parentObjectId }
      return await this.completeFinalization(draft, result)
    } catch (error) {
      const current = this.require(draftId)
      if (current.state === 'finalizing') this.write({ ...current, state: 'editing' }, current.revision)
      throw error
    }
  }

  private async verifyFinalFiles(draft: DocumentDraft): Promise<void> {
    for (const file of draft.finalize!.files) {
      if (hashBytes(await readFile(checkedPath(draft.vaultRoot, file.path))) !== file.contentHash) throw draftError('readback_mismatch', '已保存文件发生变化，未覆盖文件')
    }
  }
  private async completeFinalization(draft: DocumentDraft, result: DraftFinalizeReceipt): Promise<DraftFinalizeReceipt> {
    await this.verifyFinalFiles(draft)
    if (!draft.finalize!.publishedReceipt) draft = this.write({ ...draft, finalize: { ...draft.finalize!, publishedReceipt: result } }, draft.revision)
    const intent = draft.finalize!
    if (draft.origin === 'canvas') {
      try { await this.dependencies.completeCanvas!(draft, result, intent.request.keepDocumentCard !== false) }
      catch (error) { throw draftError('canvas_pending', `文档已保存，画板待完成：${error instanceof Error ? error.message : String(error)}`) }
      await this.verifyFinalFiles(draft)
    }
    const saved = this.write({ ...draft, state: 'finalized', finalize: { ...intent, receipt: result } }, draft.revision)
    await rm(checkedPath(draft.vaultRoot, intent.stagingDirectory), { recursive: true, force: true })
    return saved.finalize!.receipt!
  }

  importLegacy(rootPath: string, items: LegacyDraftItem[]): LegacyDraftReceipt[] {
    const root = vaultRoot(rootPath)
    const parsed = z.array(LegacyDraftItemSchema).parse(items)
    const receipts = objectTransaction(this.db, () => parsed.map(item => {
      if (hashBytes(item.content) !== item.contentHash) throw draftError('invalid_hash', 'legacy content hash mismatch')
      const prior = this.db.prepare('SELECT content_hash,receipt_json FROM document_draft_imports WHERE vault_root=? AND migration_key=?')
        .get<{ content_hash: string; receipt_json: string }>(root, item.migrationKey)
      if (prior) {
        if (prior.content_hash !== item.contentHash) throw draftError('migration_conflict', 'migration key was already imported with different content')
        return { ...DraftReceiptSchema.parse(JSON.parse(prior.receipt_json)), migrationKey: item.migrationKey }
      }
      const created = this.create({ tabId: item.tabId, vaultRoot: root, origin: 'new', content: item.content, title: item.title ?? '' })
      if (item.path) {
        // Legacy storage has no base version. Do not claim today's disk bytes were its base.
        const path = checkedPath(root, item.path)
        const object = this.dependencies.registry.reserve(path)
        this.db.prepare("UPDATE document_drafts SET origin='document',object_id=?,base_version=?,state='conflict' WHERE draft_id=?")
          .run(object.id, item.contentHash, created.draftId)
      }
      const imported = this.require(created.draftId)
      if (imported.content !== item.content || imported.contentHash !== item.contentHash) throw draftError('readback_mismatch', 'legacy import readback mismatch')
      this.db.prepare('INSERT INTO document_draft_imports(vault_root,migration_key,content_hash,draft_id,receipt_json) VALUES (?,?,?,?,?)')
        .run(root, item.migrationKey, item.contentHash, created.draftId, JSON.stringify(created))
      return { ...created, migrationKey: item.migrationKey }
    }))
    // Return only after the entire transaction has committed and the receipt rows read back.
    for (const result of receipts) {
      const saved = this.db.prepare('SELECT receipt_json FROM document_draft_imports WHERE vault_root=? AND migration_key=?')
        .get<{ receipt_json: string }>(root, result.migrationKey)
      if (!saved || saved.receipt_json !== JSON.stringify({ draftId: result.draftId, revision: result.revision, contentHash: result.contentHash })) throw draftError('readback_mismatch', 'legacy receipt readback mismatch')
    }
    return receipts
  }
}
