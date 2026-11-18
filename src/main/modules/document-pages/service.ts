import { CanvasService } from '../board-engine/canvas-service'
import { canvasPageMoveIds, repairCanvasPageMoves } from '../board-engine/page-moves'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { PageOperationSchema, PagePropertiesSchema, type PageOperation, type PageReceipt, type PageChange, type PageRoot, type PageUserState, type PageProperties, type PageOperationRecord, type PageTrashEntry } from '../../../shared/document-pages'
import { readDocumentSource, setFrontmatterFields } from '../../../shared/document-operations'
import { readDatabase, writeDatabase } from '../../../shared/document-database/format'
import { DocumentDraftService } from '../document-drafts/service'
import { checkedPath, collision, draftError, ensureDirectory, existsIgnoringCase, filename, vaultRoot } from '../document-drafts/files'
import { commitDocumentOperation, documentVersion, documentWriteError, getDocumentWriteDependencies, publishDocumentContent, saveUserDocument } from '../document-engine/document-write-service'
import { ObjectRegistry, canonicalObjectPath, isInside, objectTransaction } from '../object-service/registry'
import { ObjectMutations, type ObjectMoveGroup } from '../object-service/mutations'
import { publishObjectMoves } from '../object-service/events'
import { repairObjectLinks } from '../object-service/link-repair'
import { readPageTree } from './tree'

interface Dependencies { vaultRoot?(): string | null; canvases?: CanvasService; index(path: string): Promise<void>; afterMove?(index: number): void | Promise<void> }
type Intent = { kind: 'create'; draftId: string; revision: number; database?: { name: string } } | { kind: 'group'; title: string; group: ObjectMoveGroup; parentObjectId: string | null; originalPath: string; trashId?: string; canvasPathMoves?: ObjectMoveGroup['moves'] }
  | { kind: 'delete'; trashId: string; directory: string; objectIds: string[] }
type VersionedPageOperation = z.output<typeof PageOperationSchema> & { expectedVersion?: string }
interface RecordRow { id: string; request_json: string; intent_json: string; state: PageOperationRecord['state']; receipt_json: string | null; error: string | null }

export class DocumentPageService {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(change: PageChange) => void>()
  private readonly mutations: ObjectMutations
  private readonly drafts: DocumentDraftService
  constructor(readonly registry: ObjectRegistry, private readonly dependencies: Dependencies) {
    this.mutations = new ObjectMutations(registry)
    this.drafts = new DocumentDraftService(registry.db, { registry, index: (_root, path) => dependencies.index(path) })
  }
  subscribe(listener: (change: PageChange) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify(change: PageChange): void { for (const listener of this.listeners) { try { listener(change) } catch (error) { console.error('[pages] notification failed', error) } } }
  tree(input: PageRoot) {
    const root = vaultRoot(input.path)
    if (root.split(/[\\/]/).includes('.ready')) throw new Error('Internal metadata is not a page root')
    this.registry.db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(root)
    return readPageTree(input, path => {
      this.registry.reconcile([path], false)
      const row = this.registry.find(path)
      if (!row) throw new Error('Page is unavailable during an operation')
      return { objectId: row.id, revision: row.revision }
    }, parent => this.registry.db.prepare('SELECT object_id FROM document_page_order WHERE parent_id=? ORDER BY position').all<{object_id:string}>(parent).map(row => row.object_id))
  }
  async save(input: { path: string; content: string; expectedVersion: string }) {
    if (extname(input.path).toLowerCase() === '.canvas') throw new Error('Canvas writes require a canvas handle')
    const receipt = await saveUserDocument(input)
    const row = this.registry.register(receipt.path)
    this.notify({ operationId: 'save', objectId: row.id, revision: row.revision })
    return receipt
  }
  private object(id: string) {
    const row = this.registry.get(z.string().min(1).parse(id))
    if (!row || row.identity_state === 'conflict') throw new Error('Object unavailable or ambiguous')
    return row
  }
  properties(id: string): { properties: PageProperties; version: string } {
    const row = this.object(id)
    if (row.kind !== 'markdown' || !row.current_path) throw new Error('Page is not present')
    const content = readFileSync(row.current_path, 'utf8'), fields = readDocumentSource(content).frontmatter
    const properties: PageProperties = {}
    for (const key of ['title', 'icon', 'cover', 'ready_page'] as const) {
      if (fields[key] !== undefined) Object.assign(properties, { [key]: fields[key] })
    }
    return { properties: PagePropertiesSchema.extend({ ready_page: PagePropertiesSchema.shape.ready_page.unwrap().passthrough().optional() }).parse(properties), version: documentVersion(content) }
  }
  async patchProperties(id: string, expectedVersion: string, set: PageProperties, remove: (keyof PageProperties)[] = []) {
    const fields = PagePropertiesSchema.parse(set)
    z.array(z.enum(['title', 'icon', 'cover', 'ready_page'])).parse(remove)
    // Title changes own a persistent rename operation; the property endpoint cannot bypass it.
    if ('title' in fields || remove.includes('title')) throw new Error('Use the rename operation to change the title')
    const row = this.object(id), dependencies = getDocumentWriteDependencies()
    if (row.kind !== 'markdown') throw new Error('Properties require a Markdown page')
    if (!row.current_path || !dependencies) throw new Error('Document writer unavailable')
    if (fields.ready_page) {
      const original = readDocumentSource(readFileSync(row.current_path,'utf8')).frontmatter.ready_page
      if (original !== undefined) {
        if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('ready_page must be a mapping')
        fields.ready_page = { ...original, ...fields.ready_page }
      }
    }
    const receipt = await commitDocumentOperation({ path: row.current_path, expectedVersion: z.string().min(1).parse(expectedVersion), operation: { type: 'setFrontmatterFields', set: fields, remove }, origin: 'page_properties' }, dependencies, { published: async () => {} })
    const current = this.registry.register(row.current_path)
    this.notify({ operationId: 'properties', objectId: id, revision: current.revision })
    return { version: receipt.afterVersion }
  }
  order(parentId: string, ids: string[]): void {
    this.object(parentId); z.array(z.string().min(1)).parse(ids)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate ordering entry')
    const parent = this.object(parentId)
    if (!parent.current_path) throw new Error('Parent is unavailable')
    const directory = ['markdown', 'canvas'].includes(parent.kind) ? parent.current_path.slice(0, -extname(parent.current_path).length) : parent.current_path
    for (const id of ids) { const row = this.object(id); if (!row.current_path || dirname(row.current_path) !== directory) throw new Error('Ordering entry is not a child') }
    objectTransaction(this.registry.db, () => {
      this.registry.db.prepare('DELETE FROM document_page_order WHERE parent_id=?').run(parentId)
      ids.forEach((id, i) => this.registry.db.prepare('INSERT INTO document_page_order VALUES (?,?,?)').run(parentId,id,i))
    })
    this.notify({ operationId: 'order', objectId: parentId, revision: parent.revision })
  }
  favorite(id: string, value: boolean): void {
    const row = this.object(id); z.boolean().parse(value)
    this.registry.db.prepare('INSERT INTO document_page_state(object_id,favorite) VALUES (?,?) ON CONFLICT(object_id) DO UPDATE SET favorite=excluded.favorite').run(id, value ? 1 : 0)
    this.notify({ operationId: 'favorite', objectId: id, revision: row.revision })
  }
  visit(id: string): void {
    const row = this.object(id)
    this.registry.db.prepare('INSERT INTO document_page_state(object_id,last_visited_at) VALUES (?,?) ON CONFLICT(object_id) DO UPDATE SET last_visited_at=excluded.last_visited_at').run(id,Date.now())
    this.notify({ operationId: 'visit', objectId: id, revision: row.revision })
  }
  recentEdited(root: string | null): Array<{ ref: import('../../../shared/ready-ref').ReadyRef; title: string; editedAt: number }> {
    if (!root) return []
    // The person's own pages: 书房's database page and book entries (阅读.md, 阅读/) and 模板 are not “recent work”.
    const ownPage = (path: string) => { const [first, ...rest] = relative(vaultRoot(root), path).split(sep); return !(first === '阅读.md' || first === '模板' || (first === '阅读' && rest.length)) }
    return this.registry.list().filter(row => row.kind === 'markdown' && row.status === 'present' && row.current_path && isInside(root, row.current_path) && ownPage(row.current_path))
      .sort((a, b) => Number(b.mtime_ns ?? 0) - Number(a.mtime_ns ?? 0)).slice(0, 3)
      .map(row => ({ ref: { kind: 'page', id: row.id }, title: basename(row.current_path!, '.md'), editedAt: Number(row.mtime_ns ?? 0) / 1e6 }))
  }
  states(): PageUserState[] {
    return this.registry.db.prepare('SELECT object_id,favorite,last_visited_at FROM document_page_state').all<{object_id:string;favorite:number;last_visited_at:number|null}>()
      .map(row => ({ objectId: row.object_id, favorite: !!row.favorite, lastVisitedAt: row.last_visited_at }))
  }
  private record(id: string): RecordRow | undefined { return this.registry.db.prepare('SELECT * FROM document_page_operations WHERE id=?').get<RecordRow>(id) }
  operation(id: string): PageOperationRecord | null {
    const row = this.record(z.string().min(1).parse(id))
    return row ? { operationId: row.id, state: row.state, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, error: row.error } : null
  }
  trash(root: string): PageTrashEntry[] {
    return this.registry.db.prepare("SELECT * FROM document_page_operations WHERE state='committed' AND json_extract(request_json,'$.type')='trash' AND json_extract(request_json,'$.root')=?").all<RecordRow>(vaultRoot(root))
      .filter(row => { const receipt: PageReceipt = JSON.parse(row.receipt_json!); const object = this.registry.get(receipt.objectId); return object?.status === 'trashed' && isInside(join(root, '.ready', 'trash', row.id), object.last_known_path) })
      .map(row => {
        const receipt: PageReceipt = JSON.parse(row.receipt_json!), intent: Intent = JSON.parse(row.intent_json)
        if (intent.kind !== 'group') throw new Error('Invalid trash manifest')
        return { ...receipt, originalPath: intent.originalPath, trashedPath: this.object(receipt.objectId).last_known_path, title: intent.title, parentObjectId: intent.parentObjectId }
      })
  }
  private parent(root: string, input: { parentObjectId?: string; parentPath?: string }): { path: string; id: string } {
    if (!!input.parentObjectId === !!input.parentPath) throw new Error('Specify exactly one parent')
    const parent = input.parentObjectId ? this.object(input.parentObjectId) : this.registry.register(checkedPath(root,input.parentPath!))
    if (!parent.current_path || !['markdown','canvas','directory'].includes(parent.kind)) throw new Error('Parent is unavailable')
    checkedPath(root,parent.current_path)
    if (parent.current_path.split(/[\\/]/).includes('.ready')) throw new Error('Cannot create pages inside internal metadata')
    return { path: ['markdown', 'canvas'].includes(parent.kind) ? parent.current_path.slice(0,-extname(parent.current_path).length) : parent.current_path, id: parent.id }
  }
  private prepare(request: VersionedPageOperation): Intent {
    const root = vaultRoot(request.root)
    if (root !== request.root) throw new Error('Use the canonical root')
    this.registry.db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(root)
    if (request.type === 'create') {
      const parent = this.parent(root,request)
      const stem = filename(request.title)
      let name = stem
      if (request.database) {
        let suffix = 2
        while (['.md', '', '.canvas', '.assets'].some(ext => existsIgnoringCase(join(parent.path, name + ext)))) name = filename(`${stem} (${suffix++})`)
      }
      const path = join(parent.path, name + '.md')
      if (existsIgnoringCase(path)) throw collision(path)
      const content = request.database ? writeDatabase(request.content, {
        version: 1, source: name,
        fields: {
          状态: { id: 'status', name: '状态', type: 'select', options: ['未开始', '进行中', '完成'] },
          日期: { id: 'date', name: '日期', type: 'date' },
          标签: { id: 'tags', name: '标签', type: 'multi_select', options: [] },
        },
        views: [{ id: 'table', name: '表格', type: 'table', visibleFields: ['$title', 'status', 'date', 'tags'] }],
      }) : request.content
      const draft = this.drafts.create({ vaultRoot: root, origin: 'new', content })
      return { kind: 'create', draftId: draft.draftId, revision: draft.revision, ...(request.database ? { database: { name } } : {}) }
    }
    let sourceRoot = root
    if (request.type === 'adopt') {
      if (this.dependencies.vaultRoot?.() !== root) throw draftError('invalid_path', '收进的目标必须是当前资料库')
      const source = canonicalObjectPath(resolve(request.source))
      if (!isAbsolute(request.source) || isInside(root, source) || isInside(source, root) || source.split(/[\\/]/).includes('.ready')) {
        throw draftError('invalid_path', '源必须位于资料库之外，且不能包含资料库')
      }
      const workspace = this.registry.db.prepare('SELECT root FROM workspaces ORDER BY length(root) DESC').all<{ root: string }>()
        .find(row => isAbsolute(row.root) && isInside(row.root, source))
      if (!workspace) throw draftError('invalid_path', '源不在已登记的挂载文件夹内')
      checkedPath(workspace.root, request.source)
      if (!existsSync(source)) throw draftError('source_unavailable', '要收进的文件或文件夹已不存在')
      // A mounted root itself disappears during a move; recovery must anchor at its surviving parent.
      sourceRoot = source === workspace.root ? dirname(workspace.root) : workspace.root
    }
    const object = request.type === 'adopt' ? this.registry.register(request.source) : this.object(request.objectId)
    if (request.type === 'restore' || request.type === 'delete') {
      const trash = this.trash(root).find(item => item.objectId === object.id)
      if (!trash) throw new Error('Object is not in this trash')
      const previous: Intent = JSON.parse(this.record(trash.operationId)!.intent_json)
      if (previous.kind !== 'group') throw new Error('Invalid trash manifest')
      const directory = checkedPath(root,join(root,'.ready','trash',trash.operationId))
      if (request.type === 'delete') return { kind: 'delete', trashId: trash.operationId, directory, objectIds: previous.group.objects.map(row => row.id) }
      const destination = request.parentObjectId || request.parentPath ? this.parent(root,request) : { path: dirname(previous.originalPath), id: previous.parentObjectId }
      if (!existsSync(destination.path) || !statSync(destination.path).isDirectory()) throw new Error('parent_conflict: original parent no longer exists')
      const moves = previous.group.moves.map(move => ({ source: move.target, target: checkedPath(root,join(destination.path,basename(move.source))) }))
      for (const move of moves) if (existsIgnoringCase(move.target)) throw collision(move.target)
      const objects = previous.group.objects.map(row => {
        const current = this.object(row.id)
        if (current.status !== 'trashed') throw new Error('Trash member changed')
        return { ...current, current_path: current.last_known_path }
      })
      return { kind: 'group', title: previous.title, group: { id: request.operationId, root, moves, objects, status: 'present' }, originalPath: moves[0].target, parentObjectId: destination.id, trashId: trash.operationId, canvasPathMoves: previous.group.moves.map((move, index) => ({ source: move.source, target: moves[index].target })) }
    }
    const page = ['markdown', 'canvas'].includes(object.kind)
    if ((!page && request.type !== 'adopt') || !object.current_path) throw new Error('Page is not present')
    const path = checkedPath(sourceRoot,object.current_path), base = page ? path.slice(0,-extname(path).length) : path, name = basename(base)
    // Reuse the read model's ambiguity decision, so operations never guess a partner.
    if (page) {
      const tree = this.tree({ path: dirname(path), kind: 'external' })
      if (tree.children.find(node => node.path === path)?.ambiguity) throw new Error('ambiguous page: use file view')
    }
    const sources = page ? [path, base, base+'.assets'].filter(existsSync) : [path]
    for (const source of sources) checkedPath(sourceRoot,source)
    const originalParent = this.registry.find(dirname(path))!
    const destination = request.type === 'move' || request.type === 'adopt' ? this.parent(root,request) : { path: dirname(path), id: originalParent.id }
    const nextName = request.type === 'rename' ? filename(request.title) : name
    const trashDir = join(root,'.ready','trash',request.operationId)
    const targetBase = join(request.type === 'trash' ? trashDir : destination.path,nextName)
    const moves = sources.map(source => ({ source, target: checkedPath(root,targetBase+source.slice(base.length)) })).filter(move => move.source !== move.target)
    if (request.type === 'move' && isInside(base,destination.path)) throw new Error('Cannot move page inside its own children')
    for (const move of moves) if (existsIgnoringCase(move.target)) throw collision(move.target)
    for (const source of sources) this.registry.reconcile([source])
    const objects = this.registry.list().filter(row => row.current_path && sources.some(source => isInside(source,row.current_path!)))
    if (objects.some(row => row.identity_state === 'conflict')) throw new Error('ambiguous object identity')
    // Persisted unsaved drafts also count when their window is closed.
    if (request.type === 'trash' || request.type === 'adopt') for (const row of objects) {
      const drafts = this.registry.db.prepare("SELECT content_hash FROM document_drafts WHERE object_id=? AND state IN ('editing','conflict','finalizing')").all<{content_hash:string}>(row.id)
      if (drafts.some(d => d.content_hash !== row.content_hash)) throw new Error('dirty_conflict: save draft before moving or recycling page')
    }
    const original = page ? readFileSync(path,'utf8') : ''
    if (request.expectedVersion !== undefined && documentVersion(original) !== request.expectedVersion) throw documentWriteError('version_conflict', 'version_conflict: page changed before rename or move')
    let renamed = original
    if (request.type === 'rename' && object.kind === 'markdown') {
      renamed = setFrontmatterFields(original, { set: { title: request.title } })
      if (readDocumentSource(original).frontmatter.ready_database !== undefined) {
        const definition = readDatabase(original)
        if (definition.source === name) renamed = writeDatabase(renamed, { ...definition, source: nextName })
      }
    }
    const title = object.kind === 'canvas' ? JSON.parse(original).ready?.title : readDocumentSource(original).frontmatter.title
    return { kind: 'group', title: request.type === 'rename' ? request.title : typeof title === 'string' ? title : name, group: { id: request.operationId, root, ...(request.type === 'adopt' ? { sourceRoot } : {}), moves, objects, status: request.type === 'trash' ? 'trashed' : 'present',
      ...(request.type === 'rename' && object.kind === 'markdown' ? { patch: { path: targetBase+'.md', original, content: renamed } } : {}) },
      parentObjectId: destination.id, originalPath: path }
  }
  operate(input: PageOperation, expectedVersion?: string): Promise<PageReceipt> {
    const request: VersionedPageOperation = PageOperationSchema.parse(input)
    if (expectedVersion !== undefined) {
      if (request.type !== 'rename' && request.type !== 'move') throw new Error('Expected version requires rename or move')
      request.expectedVersion = z.string().min(1).parse(expectedVersion)
    }
    const result = this.tail.then(() => this.execute(request))
    this.tail = result.catch(() => undefined)
    return result
  }
  private async execute(request: VersionedPageOperation): Promise<PageReceipt> {
    const db = this.registry.db, prior = this.record(request.operationId)
    if (prior && prior.request_json !== JSON.stringify(request)) throw new Error('operation_conflict: operation id reused')
    if (prior?.receipt_json) return JSON.parse(prior.receipt_json)
    if (prior?.state === 'rolled_back') throw new Error('Operation was rolled back; use a new operation id')
    const intent: Intent = prior ? JSON.parse(prior.intent_json) : objectTransaction(db, () => {
      const prepared = this.prepare(request)
      db.prepare("INSERT INTO document_page_operations VALUES (?,?,?,'prepared',NULL,NULL)").run(request.operationId,JSON.stringify(request),JSON.stringify(prepared))
      return prepared
    })
    try {
      let objectId: string
      if (intent.kind === 'create') {
        if (request.type !== 'create') throw new Error('Invalid create intent')
        const result = await this.drafts.finalize(intent.draftId,intent.revision,{ operationId: request.operationId, title: intent.database?.name ?? request.title, parentObjectId: request.parentObjectId, parentPath: request.parentPath })
        if (intent.database) ensureDirectory(request.root, join(dirname(result.path), intent.database.name))
        objectId = result.objectId
      } else if (intent.kind === 'delete') {
        if (request.type !== 'delete') throw new Error('Invalid delete intent')
        checkedPath(request.root,intent.directory)
        await rm(intent.directory,{recursive:true,force:true})
        objectTransaction(db, () => {
          for (const id of intent.objectIds) db.prepare("UPDATE objects SET status='deleted',revision=revision+1 WHERE id=? AND status='trashed'").run(id)
          this.registry.syncProjection()
        })
        objectId = request.objectId
      } else {
        if (request.type === 'create') throw new Error('Invalid move intent')
        const canvases = this.dependencies.canvases ?? new CanvasService(this.registry, request.root)
        const pathGroup = { ...intent.group, moves: intent.canvasPathMoves ?? intent.group.moves }
        const canvasIds = canvasPageMoveIds(canvases, pathGroup)
        await canvases.withPageMove(canvasIds, request.operationId, () => this.mutations.moveGroup(intent.group,this.dependencies.afterMove,async () => {
          if (request.type === 'trash') {
            const directory = join(request.root,'.ready','trash',request.operationId)
            ensureDirectory(request.root,directory)
            await publishDocumentContent(join(directory,'manifest.json'),JSON.stringify({ operationId: request.operationId, objectId: request.objectId, parentObjectId: intent.parentObjectId, originalPath: intent.originalPath, ...intent.group },null,2))
          } else for (const move of intent.group.moves) ensureDirectory(request.root,dirname(move.target))
        }))
        await repairCanvasPageMoves(canvases, pathGroup, request.type === 'rename' ? { objectId: request.objectId, value: request.title } : undefined)
        for (const id of canvasIds) canvases.refreshRelations(id)
        objectId = request.type === 'adopt' ? intent.group.objects.find(row => row.current_path === intent.originalPath)!.id : request.objectId
        if (intent.group.status === 'present') {
          for (const row of intent.group.objects) { const current = this.registry.get(row.id); if (current?.kind === 'markdown' && current.current_path) await this.dependencies.index(current.current_path) }
        }
        publishObjectMoves(this.registry,intent.group.objects)
      }
      const object = this.object(objectId)
      const receipt: PageReceipt = { operationId: request.operationId, state:'committed', objectId, revision:object.revision, path:object.current_path }
      db.prepare("UPDATE document_page_operations SET state='committed',receipt_json=?,error=NULL WHERE id=?").run(JSON.stringify(receipt),request.operationId)
      this.notify(receipt)
      await repairObjectLinks(this.registry)
      return JSON.parse(this.record(request.operationId)!.receipt_json!)
    } catch (error) {
      const group = db.prepare('SELECT state FROM object_move_groups WHERE id=?').get<{state:string}>(request.operationId)
      db.prepare('UPDATE document_page_operations SET state=?,error=? WHERE id=?').run(group?.state === 'rolled_back' || intent.kind === 'group' && !group || intent.kind === 'create' && !this.drafts.read(intent.draftId)?.finalize ? 'rolled_back' : 'recovery_required',String(error),request.operationId)
      throw error
    }
  }
  async recover(): Promise<void> {
    await this.mutations.recoverGroups()
    for (const row of this.registry.db.prepare("SELECT * FROM document_page_operations WHERE state IN ('prepared','recovery_required')").all<RecordRow>()) {
      const group = this.registry.db.prepare('SELECT state FROM object_move_groups WHERE id=?').get<{state:string}>(row.id)
      if (group?.state === 'rolled_back') this.registry.db.prepare("UPDATE document_page_operations SET state='rolled_back' WHERE id=?").run(row.id)
      else {
        const { expectedVersion, ...request } = JSON.parse(row.request_json)
        await this.operate(request, expectedVersion)
      }
    }
  }
}
