import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { DatabaseDefinitionSchema, DatabaseRequestSchema, UserStateSchema, fieldEntry, fieldValue, readDatabase, writeDatabase, rowPatch, projectView, type DatabaseDefinition, type DatabaseRow, type DatabaseRequest, type Relations } from '../../../shared/document-database'
import { readDocumentSource, setFrontmatterFields, type DocumentOperation } from '../../../shared/document-operations'
import { checkedPath, ensureDirectory, vaultRoot } from '../document-drafts/files'
import { ObjectRegistry, isInside, type ObjectRecord } from '../object-service/registry'
import { DocumentPageService } from '../document-pages/service'
import { commitDocumentOperation, documentVersion, type DocumentWriteDependencies } from '../document-engine/document-write-service'
import { ObjectLinkRepository } from '../search-engine/object-links'
import { extractObjectLinks } from '../search-engine/object-link-extract'
import { ensurePortableIdentity } from '../object-service/portable'

interface Cached { signature: string; revision: number; content: string; values: Record<string, unknown>; version: string }
interface Step { objectId: string; path: string; before: string; after: string; operation: DocumentOperation }
interface Journal { id: string; database_id: string; request_json: string; plan_json: string; state: 'prepared' | 'committed' | 'recovery_required'; receipt_json: string | null; error: string | null }
export class DocumentDatabaseService {
  readonly root: string
  private readonly cache = new Map<string, Cached>()
  private readonly queryCache = new Map<string, { signature: string; result: ReturnType<typeof projectView> }>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(root: string, readonly registry: ObjectRegistry, private readonly pages: DocumentPageService,
    private readonly dependencies: DocumentWriteDependencies & { afterMigrationWrite?(index: number): void | Promise<void> }) { this.root = vaultRoot(root) }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.tail.then(work); this.tail = result.then(() => undefined, () => undefined); return result }
  private object(id: string): ObjectRecord & { current_path: string } {
    return this.availableObject(this.registry.get(z.string().min(1).parse(id)), id)
  }
  private availableObject(object: ObjectRecord | null, id: string): ObjectRecord & { current_path: string } {
    if (!object || !object.current_path || object.status !== 'present' || object.kind !== 'markdown' || object.identity_state === 'conflict') throw new Error(`Object unavailable: ${id}`)
    checkedPath(this.root, object.current_path)
    return { ...object, current_path: object.current_path }
  }
  private load(id: string): Cached {
    const object = this.object(id)
    const result = this.loadPaths([object.current_path], new Map([[object.current_path, object]]))[0]
    if (result.id !== id) throw new Error('Object identity changed')
    return result.loaded
  }
  private loadPaths(paths: string[], objects: ReadonlyMap<string | null, ObjectRecord>) {
    const pending = paths.map(path => {
      const found = objects.get(path), object = found ? this.availableObject(found, found.id) : null
      if (!object) checkedPath(this.root, path)
      const stat = statSync(path, { bigint: true }), signature = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      const previous = object ? this.cache.get(object.id) : undefined
      const cached = previous && previous.revision === object?.revision && previous.signature === signature ? previous : undefined
      const content = cached?.content ?? readFileSync(path, 'utf8'), version = cached?.version ?? documentVersion(content)
      // A cold cache is not an unverified object. Reconcile only changed observations,
      // together, so registration does not traverse the entire registry for every row.
      const changed = !object || object.content_hash !== version || object.device !== String(stat.dev)
        || object.inode !== String(stat.ino) || object.birthtime_ns !== String(stat.birthtimeNs)
        || object.size !== Number(stat.size) || object.mtime_ns !== String(stat.mtimeNs)
      return { path, object, signature, cached, content, version, changed }
    })
    const changed = pending.filter(item => item.changed).map(item => item.path)
    if (changed.length) {
      this.registry.reconcile(changed, false)
      objects = new Map(this.registry.list().map(object => [object.current_path, object]))
    }
    return pending.map(item => {
      const current = objects.get(item.path)
      if (!current || item.object && current.id !== item.object.id) throw new Error('Object identity changed')
      const object = changed.length ? this.availableObject(current, current.id) : current
      if (item.cached && item.cached.revision === object.revision) return { id: object.id, loaded: item.cached }
      const content = item.changed ? readFileSync(item.path, 'utf8') : item.content
      const version = item.changed ? documentVersion(content) : item.version
      if (version !== object.content_hash) throw new Error('Document changed while reading')
      const loaded = { signature: item.signature, revision: object.revision, content, version, values: readDocumentSource(content).frontmatter }
      this.cache.set(object.id, loaded)
      return { id: object.id, loaded }
    })
  }
  private assertIdle(id: string): void {
    if (this.registry.db.prepare("SELECT id FROM document_database_operations WHERE database_id=? AND state<>'committed'").get(id)) throw new Error('migration_in_progress: resume the recorded operation')
  }
  private definition(id: string) {
    const loaded = this.load(id), definition = readDatabase(loaded.content)
    const source = checkedPath(this.root, join(dirname(this.object(id).current_path), definition.source))
    return { definition, version: loaded.version, source, content: loaded.content }
  }
  private rows(id: string, definition: DatabaseDefinition, source: string): DatabaseRow[] {
    const paths: string[] = []
    if (!existsSync(source)) return []
    const scan = (path: string) => {
      checkedPath(this.root, path)
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.assets')) continue
        const child = checkedPath(this.root, join(path, entry.name))
        if (entry.isDirectory()) { if (definition.recursive) scan(child); continue }
        if (!entry.name.toLowerCase().endsWith('.md')) continue
        paths.push(child)
      }
    }
    scan(source)
    return this.loadPaths(paths, new Map(this.registry.list().map(object => [object.current_path, object]))).map(({ id: rowId, loaded }, index) => {
      if (rowId === id) throw new Error('Database cannot include itself')
      return { id: rowId, title: typeof loaded.values.title === 'string' ? loaded.values.title : basename(paths[index]).replace(/\.md$/i, ''), version: loaded.version, values: structuredClone(loaded.values) }
    })
  }
  read(id: string) {
    this.assertIdle(id)
    const database = this.definition(id)
    const referenceRepairs = this.registry.db.prepare("SELECT view_id,old_name,new_name,state FROM document_database_view_repairs WHERE database_id=? AND state<>'completed'").all<{view_id:string;old_name:string;new_name:string;state:string}>(id).filter(repair => database.definition.views.some(view => view.id === repair.view_id && view.name === repair.new_name))
    for (const repair of referenceRepairs) if (repair.state === 'prepared') this.registry.db.prepare("UPDATE document_database_view_repairs SET state='pending_reference_repair' WHERE database_id=? AND view_id=? AND old_name=?").run(id, repair.view_id, repair.old_name)
    // sourcePath: the row folder, which an open view watches so it follows the disk (W3 §4.4).
    return { databaseId: id, definition: database.definition, version: database.version, sourcePath: database.source, rows: this.rows(id, database.definition, database.source), referenceRepairs: referenceRepairs.map(repair => ({ viewId: repair.view_id, oldName: repair.old_name, newName: repair.new_name, state: 'pending_reference_repair' as const })) }
  }
  preview(id: string): import('../../../shared/object-preview').DatabasePreview {
    const snapshot = this.read(id), view = snapshot.definition.views[0]
    const { rows, total } = projectView(snapshot.definition, snapshot.rows, view, this.relations(snapshot.definition, snapshot.rows), { offset: 0, limit: 5 })
    return { kind: 'database', definition: snapshot.definition, view, rows, total }
  }
  private member(databaseId: string, rowId: string) {
    const database = this.definition(databaseId), object = this.object(rowId)
    if (!isInside(database.source, object.current_path) || (!database.definition.recursive && dirname(object.current_path) !== database.source)) throw new Error('Row is outside database')
    return { database, object }
  }
  private relations(def: DatabaseDefinition, rows: DatabaseRow[]): Relations {
    const result: Relations = Object.create(null), links = new ObjectLinkRepository(this.registry.db), targetValues = new Map<string, Record<string, unknown>>()
    const fields = Object.entries(def.fields).filter(([, field]) => field.type === 'relation')
    if (!fields.length) return result
    for (const row of rows) {
      const outgoing = links.outgoing({ objectId: row.id }), byField: Relations[string] = Object.create(null)
      for (const [key, field] of fields) {
        let value: unknown
        try { value = fieldValue(field, row.values[key]) } catch { continue }
        const targets = Array.isArray(value) ? value : [], reasons: string[] = [], related: Record<string, unknown>[] = []
        if (outgoing.length === 1000) reasons.push('Relation query reached its 1000-result limit')
        const seen = new Set<string>()
        for (const reference of targets) {
          const raw = String(reference).slice(2, -2), candidates = outgoing.filter(link => link.kind === 'frontmatter' && link.rawTarget === raw)
          const targetIds = new Set(candidates.flatMap(link => link.resolved && link.target && 'objectId' in link.target ? [link.target.objectId] : []))
          if (targetIds.size !== 1 || candidates.some(link => !link.resolved)) { reasons.push(`Unresolved relation ${raw}: ${candidates.map(link => link.unresolvedReason ?? 'ambiguous').join(', ') || 'not indexed'}`); continue }
          const targetId = [...targetIds][0]
          if (!seen.has(targetId)) {
            try { const values = targetValues.get(targetId) ?? this.load(targetId).values; targetValues.set(targetId, values); related.push(values); seen.add(targetId) } catch (error) { reasons.push(String(error)) }
          }
        }
        byField[field.id] = { rows: related, complete: !reasons.length, reasons }
      }
      result[row.id] = byField
    }
    return result
  }
  query(id: string, viewId: string, offset = 0, limit = 1000) {
    const snapshot = this.read(id), view = snapshot.definition.views.find(v => v.id === viewId)
    if (!view) throw new Error(`View missing: ${viewId}`)
    const relations = this.relations(snapshot.definition, snapshot.rows)
    const signature = JSON.stringify([snapshot.version, snapshot.rows.map(row => [row.id, row.version, this.registry.get(row.id)?.revision]), relations, offset, limit])
    const key = `${id}:${viewId}`, cached = this.queryCache.get(key)
    const result = cached?.signature === signature ? cached.result : projectView(snapshot.definition, snapshot.rows, view, relations, { offset, limit })
    this.queryCache.set(key, { signature, result })
    return { databaseId: id, version: snapshot.version, ...structuredClone(result) }
  }
  private async write(id: string, expectedVersion: string, operation: DocumentOperation, savedOnly = false) {
    const object = this.object(id)
    const receipt = await commitDocumentOperation({ path: object.current_path, expectedVersion, operation, origin: 'document_database' }, this.dependencies, savedOnly ? { published: async () => {} } : {})
    this.cache.delete(id)
    if (receipt.tab !== 'merged_dirty') this.registry.register(object.current_path)
    return { ...receipt, state: receipt.tab === 'merged_dirty' ? 'unsaved' as const : 'saved' as const }
  }
  private async pinRelations(id: string, def: DatabaseDefinition, content: string): Promise<void> {
    const repository = new ObjectLinkRepository(this.registry.db)
    repository.replace({ objectId: id }, extractObjectLinks(content), documentVersion(content))
    const row: DatabaseRow = { id, title: '', version: documentVersion(content), values: readDocumentSource(content).frontmatter }
    const resolved = this.relations(def, [row])[id]
    for (const relation of Object.values(resolved ?? {})) if (!relation.complete) throw new Error(`Relation is incomplete: ${relation.reasons.join('; ')}`)
    const targets = repository.outgoing({ objectId: id }).filter(link => link.kind === 'frontmatter' && link.resolved && link.target && 'objectId' in link.target)
    for (const link of targets) if (link.target && 'objectId' in link.target) {
      const result = await ensurePortableIdentity(this.registry, link.target.objectId, this.dependencies)
      if (!result.ok) throw new Error(result.message)
    }
  }
  private async setFields(request: Extract<z.output<typeof DatabaseRequestSchema>, { type: 'setFields' }>) {
    this.assertIdle(request.databaseId)
    const { database } = this.member(request.databaseId, request.rowId), patch = rowPatch(database.definition, request.set, request.remove)
    const before = this.load(request.rowId)
    if (before.version !== request.expectedVersion) throw new Error('version_conflict: Document version has changed')
    // Validate references before publishing; the index is restored to disk on any failed validation/write.
    const changesRelation = Object.keys(request.set).some(id => fieldEntry(database.definition, id)[1].type === 'relation')
    try {
      if (changesRelation) await this.pinRelations(request.rowId, database.definition, setFrontmatterFields(before.content, patch))
      const current = readFileSync(this.object(request.rowId).current_path, 'utf8')
      if (current !== before.content && current !== setFrontmatterFields(before.content, { set: { ready_id: request.rowId } })) throw new Error('version_conflict: row changed during relation setup')
      return await this.write(request.rowId, documentVersion(current), { type: 'setFrontmatterFields', ...patch }, changesRelation)
    } finally {
      if (changesRelation) {
        const actual = readFileSync(this.object(request.rowId).current_path, 'utf8')
        new ObjectLinkRepository(this.registry.db).replace({ objectId: request.rowId }, extractObjectLinks(actual), documentVersion(actual))
      }
    }
  }
  private async setDefinition(request: Extract<z.output<typeof DatabaseRequestSchema>, { type: 'setDefinition' }>) {
    const snapshot = this.read(request.databaseId), next = DatabaseDefinitionSchema.parse(request.definition)
    if (snapshot.version !== request.expectedVersion) throw new Error('version_conflict: database changed')
    for (const [key, field] of Object.entries(snapshot.definition.fields)) {
      if (next.fields[key] && next.fields[key].id !== field.id) throw new Error('Field identity cannot change when editing its definition')
      const moved = Object.entries(next.fields).find(([, f]) => f.id === field.id)
      if (moved && moved[0] !== key) throw new Error('Use renameKey for storage key migration')
    }
    for (const row of snapshot.rows) for (const [key, field] of Object.entries(next.fields)) {
      if (['formula', 'rollup'].includes(field.type)) { if (Object.hasOwn(row.values, key)) throw new Error(`computed field ${key} has stored values`) }
      else fieldValue(field, row.values[key])
    }
    const before = this.load(request.databaseId).content, after = writeDatabase(before, next)
    const renamed = next.views.flatMap(view => { const old = snapshot.definition.views.find(v => v.id === view.id); return old && old.name !== view.name ? [{ viewId: view.id, oldName: old.name, newName: view.name }] : [] })
    // The durable pending receipt precedes publication so a crash cannot forget a rename.
    for (const rename of renamed) this.registry.db.prepare("INSERT INTO document_database_view_repairs VALUES (?,?,?,?,'prepared') ON CONFLICT(database_id,view_id,old_name) DO UPDATE SET new_name=excluded.new_name,state='prepared'").run(request.databaseId, rename.viewId, rename.oldName, rename.newName)
    const receipt = await this.write(request.databaseId, request.expectedVersion, { type: 'replaceRange', start: 0, end: before.length, expectedText: before, replacement: after }, true)
    for (const rename of renamed) this.registry.db.prepare("UPDATE document_database_view_repairs SET state='pending_reference_repair' WHERE database_id=? AND view_id=? AND old_name=?").run(request.databaseId, rename.viewId, rename.oldName)
    return { ...receipt, references: renamed.length ? 'pending_reference_repair' : 'unchanged' }
  }
  operation(databaseId: string, operationId: string): Journal | null {
    this.object(databaseId)
    return this.registry.db.prepare('SELECT * FROM document_database_operations WHERE id=? AND database_id=?').get<Journal>(operationId, databaseId) ?? null
  }
  private async renameKey(request: Extract<z.output<typeof DatabaseRequestSchema>, { type: 'renameKey' }>) {
    const prior = this.operation(request.databaseId, request.operationId)
    if (prior && prior.request_json !== JSON.stringify(request)) throw new Error('operation_conflict: operation id reused')
    if (prior?.receipt_json) return JSON.parse(prior.receipt_json)
    let steps: Step[], rowIds: string[]
    if (prior) { const plan: { steps: Step[]; rowIds: string[] } = JSON.parse(prior.plan_json); steps = plan.steps; rowIds = plan.rowIds }
    else {
      const snapshot = this.read(request.databaseId)
      if (snapshot.version !== request.expectedVersion) throw new Error('version_conflict: database changed')
      const [oldKey, field] = fieldEntry(snapshot.definition, request.fieldId)
      if (Object.hasOwn(snapshot.definition.fields, request.key)) throw new Error('Storage key already exists')
      rowIds = snapshot.rows.map(row => row.id).sort()
      steps = snapshot.rows.map(row => {
        if (Object.hasOwn(row.values, request.key)) throw new Error(`Storage key collision in ${row.id}`)
        const before = this.load(row.id).content, operation: DocumentOperation = { type: 'setFrontmatterFields', set: Object.hasOwn(row.values, oldKey) ? { [request.key]: row.values[oldKey] } : {}, remove: Object.hasOwn(row.values, oldKey) ? [oldKey] : [] }
        return { objectId: row.id, path: this.object(row.id).current_path, before, after: setFrontmatterFields(before, operation), operation }
      })
      const next = structuredClone(snapshot.definition); delete next.fields[oldKey]; next.fields[request.key] = field
      const before = this.load(request.databaseId).content, after = writeDatabase(before, next)
      steps.push({ objectId: request.databaseId, path: this.object(request.databaseId).current_path, before, after, operation: { type: 'replaceRange', start: 0, end: before.length, expectedText: before, replacement: after } })
      this.registry.db.prepare("INSERT INTO document_database_operations VALUES (?,?,?,?, 'prepared',NULL,NULL)").run(request.operationId, request.databaseId, JSON.stringify(request), JSON.stringify({ steps, rowIds }))
    }
    try {
      const currentDatabase = this.definition(request.databaseId)
      const currentIds = this.rows(request.databaseId, currentDatabase.definition, currentDatabase.source).map(row => row.id).sort()
      if (JSON.stringify(currentIds) !== JSON.stringify(rowIds)) throw new Error('migration_conflict: row membership changed')
      for (const [index, step] of steps.entries()) {
        const object = this.object(step.objectId)
        if (object.current_path !== step.path) throw new Error('migration_conflict: object moved')
        const current = readFileSync(object.current_path, 'utf8')
        if (current === step.after) { await this.dependencies.index(object.current_path, current); this.registry.register(object.current_path); this.cache.delete(step.objectId); continue }
        if (current !== step.before) throw new Error(`version_conflict: migration encountered newer content in ${step.objectId}`)
        await this.write(step.objectId, documentVersion(step.before), step.operation, true)
        await this.dependencies.afterMigrationWrite?.(index)
      }
      for (const step of steps) if (readFileSync(this.object(step.objectId).current_path, 'utf8') !== step.after) throw new Error('migration readback mismatch')
      const receipt = { state: 'committed', operationId: request.operationId, databaseId: request.databaseId, version: documentVersion(steps.at(-1)!.after) }
      this.registry.db.prepare("UPDATE document_database_operations SET state='committed',receipt_json=?,error=NULL WHERE id=?").run(JSON.stringify(receipt), request.operationId)
      return receipt
    } catch (error) {
      this.registry.db.prepare("UPDATE document_database_operations SET state='recovery_required',error=? WHERE id=?").run(String(error), request.operationId)
      throw error
    }
  }
  async recover(): Promise<void> {
    for (const row of this.registry.db.prepare("SELECT request_json FROM document_database_operations WHERE state<>'committed'").all<{ request_json: string }>()) {
      const request = DatabaseRequestSchema.parse(JSON.parse(row.request_json))
      if (request.type !== 'renameKey') throw new Error('Invalid migration request')
      const object = this.registry.get(request.databaseId)
      if (object?.current_path && !isInside(this.root, object.current_path)) continue
      await this.serial(() => this.renameKey(request))
    }
  }
  request(input: DatabaseRequest): Promise<unknown> {
    const request = DatabaseRequestSchema.parse(input)
    return this.serial(async () => {
      switch (request.type) {
        case 'read': return this.read(request.databaseId)
        case 'query': return this.query(request.databaseId, request.viewId, request.offset, request.limit)
        case 'setFields': return this.setFields(request)
        case 'setDefinition': return this.setDefinition(request)
        case 'renameKey': return this.renameKey(request)
        case 'operation': return this.operation(request.databaseId, request.operationId)
        case 'getState': this.object(request.databaseId); return JSON.parse(this.registry.db.prepare('SELECT state_json FROM document_database_state WHERE database_id=?').get<{state_json:string}>(request.databaseId)?.state_json ?? '{}')
        case 'setState': {
          const snapshot = this.read(request.databaseId), state = UserStateSchema.parse(request.state)
          if (state.currentViewId && !snapshot.definition.views.some(v => v.id === state.currentViewId)) throw new Error('View missing')
          this.registry.db.prepare('INSERT INTO document_database_state VALUES (?,?) ON CONFLICT(database_id) DO UPDATE SET state_json=excluded.state_json').run(request.databaseId, JSON.stringify(state)); return state
        }
        case 'createRow': {
          this.assertIdle(request.databaseId)
          const database = this.definition(request.databaseId), patch = rowPatch(database.definition, request.values)
          const content = setFrontmatterFields(request.body, patch)
          for (const [key, field] of Object.entries(database.definition.fields)) {
            if (['formula', 'rollup'].includes(field.type) && Object.hasOwn(readDocumentSource(content).frontmatter, key)) throw new Error('computed values cannot be stored')
            if (!['formula', 'rollup'].includes(field.type)) fieldValue(field, readDocumentSource(content).frontmatter[key])
            if (field.type === 'relation' && Object.hasOwn(readDocumentSource(content).frontmatter, key)) throw new Error('Create the row before assigning relations')
          }
          ensureDirectory(this.root, database.source)
          return this.pages.operate({ type: 'create', root: this.root, operationId: request.operationId, parentPath: database.source, title: request.title, content })
        }
        case 'deleteRow': {
          this.assertIdle(request.databaseId)
          const previous = this.pages.operation(request.operationId)
          if (previous?.receipt?.objectId !== request.rowId || previous.state !== 'committed') this.member(request.databaseId, request.rowId)
          return this.pages.operate({ type: 'trash', root: this.root, operationId: request.operationId, objectId: request.rowId })
        }
      }
    })
  }
}
