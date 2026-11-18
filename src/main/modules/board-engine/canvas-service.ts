import { relativeFileReference } from '../../utils/platform'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { applyCanvasOperations, subBoardEffects, CanvasIdSchema, CanvasPathSchema, graphicSvg, readCanvas, ReadyCanvasSchema, serializeCanvas, stableJson, validateCanvasCollection, type CanvasWriteRequest, type CanvasWriteResult, type CanvasReceipt, type CanvasOperation, type ReadyCanvas, type CanvasBufferConfirmation, type CardMoveDetail, type SubBoardEffects } from '../../../shared/ready-canvas'
import { checkedPath, ensureDirectory, hashBytes, publishNewFile, stageFile, vaultRoot } from '../document-drafts/files'
import { publishFileAtomically } from '../document-engine/atomic-file-publish'
import { withDocumentPathLock } from '../document-engine/document-write-service'
import { isInside, ObjectRegistry, objectTransaction } from '../object-service/registry'
import { ObjectLinkRepository } from '../search-engine/object-links'
import { extractCanvasLinks } from '../search-engine/canvas-links'
import { BufferSchema, CreateSchema, WriteSchema, type CanvasBuffer } from './schema'
import { rewriteMarkdownMediaRefs } from '../../../shared/markdown-asset-refs'
import { mergeCanvas } from './merge'
import { STAGING_TOTAL_BYTES, STAGING_TTL_MS } from './attachment-staging'

export interface CanvasOpen { objectId: string; handleId: string; path: string; version: string; canvas: ReadyCanvas }
export interface CanvasSyncRequest {
  operationId: string; objectId: string; phase: 'prepare' | 'commit' | 'rollback' | 'release'; deadline: number
  confirmation?: CanvasBufferConfirmation; canvas?: ReadyCanvas; dirty?: boolean
}
export interface CanvasDependencies {
  changed?(objectId: string): void
  stage?: typeof stageFile
  publish?: typeof publishFileAtomically
  readback?(path: string): Promise<Buffer>
  sync?(request: CanvasSyncRequest): Promise<{ confirmation?: CanvasBufferConfirmation; canvas?: ReadyCanvas }>
  checkpoint?(phase: 'staged' | 'published' | 'readback' | 'indexed'): void | Promise<void>
}
export interface CanvasFile { original?: string; path: string; content: string; sha256: string }
export interface CanvasPlan {
  root: string; path: string; objectId: string; operationId: string; original: string | null; content: string
  expectedBuffer?: CanvasBufferConfirmation; savingBuffer?: boolean; files: CanvasFile[]; affectedNodeIds: string[]; incomplete?: Array<{ sourceId: string; reason: string }>
  /** M4 §9: a two-board move never merges into an unsaved buffer; sub-board files that follow their cards. */
  strict?: boolean; move?: CardMoveDetail & { kind: 'move' | 'undo' }; subBoards?: SubBoardEffects & { purge?: boolean }
}
interface Row { id: string; object_id: string; state: string; input_hash: string; plan_json: string; result_json: string | null }
const queues = new Map<string, Promise<unknown>>()
const bufferLocks = new Set<string>()
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(work)
  const tail = result.catch(() => undefined); queues.set(key, tail)
  try { return await result } finally { if (queues.get(key) === tail) queues.delete(key) }
}
const confirmation = (buffer: CanvasBuffer): CanvasBufferConfirmation => ({ tabId: buffer.tabId, bufferVersion: buffer.bufferVersion, openGeneration: buffer.openGeneration })

/** One service per library. Handles are transient; operation plans and buffers are durable. */
export class CanvasService {
  readonly root: string
  private readonly handles = new Map<string, string>()
  private readonly assets = new Map<string, { bytes: Buffer; name: string; stagedAt?: number }>()
  constructor(readonly registry: ObjectRegistry, root: string, private readonly dependencies: CanvasDependencies = {}) { this.root = vaultRoot(root) }
  private location(path: string): string { CanvasPathSchema.parse(path); return checkedPath(this.root, join(this.root, path)) }
  private row(id: string): Row | undefined { return this.registry.db.prepare('SELECT * FROM canvas_operations WHERE id=?').get<Row>(id) }
  private saveResult(id: string, state: string, result: CanvasWriteResult): CanvasWriteResult {
    this.registry.db.prepare('UPDATE canvas_operations SET state=?,result_json=?,error=NULL WHERE id=?').run(state, JSON.stringify(result), id)
    if (result.state === 'completed') this.dependencies.changed?.(result.objectId)
    return result
  }
  private objectPath(id: string): string {
    const object = this.registry.get(CanvasIdSchema.parse(id))
    if (!object || object.kind !== 'canvas' || object.status !== 'present' || !object.current_path || object.identity_state === 'conflict') throw new Error('identity_conflict: canvas is unavailable')
    checkedPath(this.root, object.current_path)
    return object.current_path
  }
  async open(objectId: string): Promise<CanvasOpen> {
    const path = this.objectPath(objectId), content = await readFile(path, 'utf8'), parsed = readCanvas(JSON.parse(content))
    if (parsed.mode !== 'editable') throw new Error('Readonly canvas version')
    if (parsed.canvas.ready.id !== objectId) throw new Error('identity_conflict: embedded identity changed')
    const handleId = randomUUID(); this.handles.set(handleId, objectId)
    return { objectId, handleId, path: relativeFileReference(this.root, path), version: hashBytes(content), canvas: parsed.canvas }
  }
  async read(handleId: string): Promise<CanvasOpen> {
    const objectId = this.handles.get(handleId)
    if (!objectId) throw new Error('Canvas handle expired')
    const opened = await this.open(objectId); this.release(opened.handleId)
    return { ...opened, handleId }
  }
  /** The object a live handle was opened for. */
  holds(handleId: string): string | undefined { return this.handles.get(handleId) }
  release(handleId: string): void { this.handles.delete(CanvasIdSchema.parse(handleId)) }
  buffer(objectId: string): CanvasBuffer | null {
    const row = this.registry.db.prepare('SELECT snapshot_json FROM canvas_buffers WHERE object_id=?').get<{ snapshot_json: string }>(objectId)
    return row ? BufferSchema.parse(JSON.parse(row.snapshot_json)) : null
  }
  updateBuffer(input: CanvasBuffer): void {
    const buffer = BufferSchema.parse(input)
    this.objectPath(buffer.objectId)
    if (buffer.canvas.ready.id !== buffer.objectId) throw new Error('identity_conflict: buffer identity')
    if (bufferLocks.has(buffer.objectId)) throw new Error('buffer_confirmation_expired: buffer is prepared')
    const prior = this.buffer(buffer.objectId)
    if (prior && (buffer.openGeneration < prior.openGeneration || buffer.openGeneration === prior.openGeneration && (buffer.tabId !== prior.tabId || buffer.bufferVersion <= prior.bufferVersion))) throw new Error('buffer_confirmation_expired: stale buffer')
    if (prior && buffer.openGeneration > prior.openGeneration && serializeCanvas(buffer.canvas) !== serializeCanvas(prior.canvas)) {
      const disk = ReadyCanvasSchema.parse(JSON.parse(readFileSync(this.objectPath(buffer.objectId), 'utf8')))
      if (serializeCanvas(prior.canvas) !== serializeCanvas(disk)) throw new Error('buffer_confirmation_expired: recover or save the existing dirty buffer first')
    }
    this.putBuffer(buffer)
  }
  private putBuffer(buffer: CanvasBuffer): void {
    this.registry.db.prepare('INSERT INTO canvas_buffers VALUES (?,?) ON CONFLICT(object_id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(buffer.objectId, JSON.stringify(buffer))
  }
  /** Main caller must obtain the source through its existing file/resource authorization. */
  async prepareAttachment(path: string): Promise<string> {
    const token = randomUUID(), bytes = await readFile(path)
    this.assets.set(token, { bytes, name: path.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._-]/gu, '_') })
    return token
  }
  // [cv-media] Bytes the person dropped, pasted, picked or recorded; attachment-staging.ts validated them first.
  // They wait here for their `importAttachment` write, bounded in time and in total size.
  stageAttachment(bytes: Buffer, name: string): string {
    const now = Date.now()
    for (const [key, asset] of this.assets) if (asset.stagedAt !== undefined && now - asset.stagedAt > STAGING_TTL_MS) this.assets.delete(key)
    let waiting = bytes.length
    for (const asset of this.assets.values()) if (asset.stagedAt !== undefined) waiting += asset.bytes.length
    if (waiting > STAGING_TOTAL_BYTES) throw new Error('等待写入画板的文件过多，请稍后再试')
    const token = randomUUID(); this.assets.set(token, { bytes, name, stagedAt: now })
    return token
  }
  // [/cv-media]
  async create(input: z.input<typeof CreateSchema>): Promise<CanvasOpen> {
    const request = CreateSchema.parse(input), fingerprint = hashBytes(stableJson(request)), prior = this.row(request.operationId)
    if (prior && prior.input_hash !== fingerprint) throw new Error('operation_id_reused')
    const canvas = prior ? ReadyCanvasSchema.parse(JSON.parse(JSON.parse(prior.plan_json).content)) : request.canvas ?? { nodes: [], edges: [], ready: { schemaVersion: 1, id: randomUUID() } }
    const result = await this.publishBundle({ root: this.root, path: request.path, operationId: request.operationId, objectId: canvas.ready.id, original: null, content: serializeCanvas(canvas), files: [], affectedNodeIds: canvas.nodes.map(n => n.id) }, fingerprint)
    if (result.state !== 'completed') throw new Error(JSON.stringify(result))
    return this.open(canvas.ready.id)
  }
  async write(input: CanvasWriteRequest): Promise<CanvasWriteResult> {
    const request = WriteSchema.parse(input), { handleId: _handle, ...durable } = request
    const fingerprint = hashBytes(stableJson(durable))
    return serial(this.root + request.objectId, async () => {
      const prior = this.row(request.operationId)
      if (prior) {
        if (prior.input_hash !== fingerprint) throw new Error('operation_id_reused')
        if (prior.result_json && prior.state !== 'recovery-required') {
          const result: CanvasWriteResult = JSON.parse(prior.result_json)
          if (result.state === 'merged_dirty') await this.finishMerged(JSON.parse(prior.plan_json), result)
          return result
        }
        return this.execute(JSON.parse(prior.plan_json))
      }
      if (bufferLocks.has(request.objectId)) throw new Error('buffer_confirmation_expired: object is moving')
      if (this.handles.get(request.handleId) !== request.objectId) throw new Error('Canvas handle expired or belongs to another object')
      const path = this.objectPath(request.objectId), original = await readFile(path, 'utf8')
      if (hashBytes(original) !== request.expectedVersion) {
        this.record({ root: this.root, path: relativeFileReference(this.root, path), objectId: request.objectId, operationId: request.operationId, original, content: original, files: [], affectedNodeIds: [] }, fingerprint)
        return this.saveResult(request.operationId, 'conflict', { state: 'conflict', operationId: request.operationId, conflict: { code: 'version_conflict', message: 'Canvas changed on disk', nodeIds: [], actualVersion: hashBytes(original) } })
      }
      const before = ReadyCanvasSchema.parse(JSON.parse(original)), files: CanvasFile[] = [], operations: CanvasOperation[] = []
      for (const command of request.commands) {
        if (command.type === 'batch') operations.push(...command.operations)
        else if (command.type === 'importAttachment') {
          const asset = this.assets.get(command.sourceToken)
          if (!asset || command.node.type !== 'file') throw new Error('Attachment token unavailable or invalid file node')
          const hash = hashBytes(asset.bytes), target = `${relativeFileReference(this.root, path).slice(0, -7)}.assets/${hash}-${asset.name}`
          files.push({ path: target, content: asset.bytes.toString('base64'), sha256: hash })
          operations.push({ type: 'addNode', node: { ...command.node, file: target } })
          if (asset.stagedAt !== undefined) this.assets.delete(command.sourceToken) // [cv-media] staged bytes are used once
        } else if (command.type === 'createSubcanvas') {
          const content = serializeCanvas(command.canvas)
          files.push({ path: command.path, content: Buffer.from(content).toString('base64'), sha256: hashBytes(content) })
          operations.push({ type: 'addNode', node: command.node })
        } else operations.push(command)
      }
      let canvas: ReadyCanvas
      try { canvas = applyCanvasOperations(before, operations).canvas } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('text_conflict:')) throw error
        this.record({ root: this.root, path: relativeFileReference(this.root, path), objectId: request.objectId, operationId: request.operationId, original, content: original, files: [], affectedNodeIds: [] }, fingerprint)
        return this.saveResult(request.operationId, 'conflict', { state: 'conflict', operationId: request.operationId, conflict: { code: 'text_conflict', message: error.message, nodeIds: operations.flatMap(op => op.type === 'textRanges' ? [op.id] : []) } })
      }
      for (const node of canvas.nodes) if (node.type === 'file' && node.ready.graphic) {
        const svg = graphicSvg(node.ready.graphic, node.width, node.height), bytes = Buffer.from(svg)
        const target = `${relativeFileReference(this.root, path).slice(0, -7)}.assets/${hashBytes(bytes)}.svg`
        node.file = target
        if (!existsSync(this.location(target))) files.push({ path: target, content: bytes.toString('base64'), sha256: hashBytes(bytes) })
      }
      const affected = new Set([...before.nodes, ...canvas.nodes].filter(node => JSON.stringify(before.nodes.find(n => n.id === node.id)) !== JSON.stringify(canvas.nodes.find(n => n.id === node.id))).map(n => n.id))
      const subBoards = subBoardEffects(before, canvas)
      const plan: CanvasPlan = { root: this.root, path: relativeFileReference(this.root, path), objectId: request.objectId, operationId: request.operationId, original, content: serializeCanvas(canvas), files, affectedNodeIds: [...affected], ...(subBoards.restore.length || subBoards.trash.length ? { subBoards } : {}) }
      this.record(plan, fingerprint)
      return this.execute(plan)
    })
  }
  async saveBuffer(input: { handleId: string; objectId: string; expectedVersion: string; operationId: string }): Promise<CanvasWriteResult> {
    const fingerprint = hashBytes(stableJson({ objectId: input.objectId, expectedVersion: input.expectedVersion, operationId: input.operationId, kind: 'save-buffer' }))
    const prior = this.row(input.operationId)
    if (prior) return this.publishBundle(JSON.parse(prior.plan_json), fingerprint, true)
    const buffer = this.buffer(input.objectId)
    if (!buffer) throw new Error('No recoverable canvas buffer')
    const h = await this.read(input.handleId)
    if (h.objectId !== input.objectId || h.version !== input.expectedVersion || buffer.baseVersion !== h.version) throw new Error('version_conflict')
    const original = await readFile(this.objectPath(input.objectId), 'utf8')
    return this.publishBundle({ root: this.root, path: h.path, objectId: h.objectId, operationId: input.operationId, original, content: serializeCanvas(buffer.canvas), expectedBuffer: confirmation(buffer), files: [], affectedNodeIds: buffer.canvas.nodes.map(n => n.id) }, fingerprint, true)
  }
  async resumeOperation(operationId: string, fingerprint: string): Promise<CanvasWriteResult | undefined> {
    const prior = this.row(operationId)
    if (!prior) return undefined
    return this.publishBundle(JSON.parse(prior.plan_json), fingerprint)
  }
  private record(plan: CanvasPlan, fingerprint: string): void {
    this.registry.db.prepare("INSERT INTO canvas_operations VALUES (?,?,?,'prepared',?,NULL,NULL)").run(plan.operationId, plan.objectId, fingerprint, JSON.stringify(plan))
  }
  async publishBundle(plan: CanvasPlan, fingerprint: string, savingBuffer = false): Promise<CanvasWriteResult> {
    if (plan.root !== this.root) throw new Error('Invalid library')
    const ids = [...new Set([plan.objectId, ...plan.files.filter(file => file.path.endsWith('.canvas')).map(file => ReadyCanvasSchema.parse(JSON.parse(Buffer.from(file.content, 'base64').toString())).ready.id)])].sort()
    const locked = (index: number): Promise<CanvasWriteResult> => index < ids.length ? serial(this.root + ids[index], () => locked(index + 1)) : run()
    const run = async (): Promise<CanvasWriteResult> => {
      const prior = this.row(plan.operationId)
      if (prior && prior.input_hash !== fingerprint) throw new Error('operation_id_reused')
      if (prior?.result_json && prior.state !== 'recovery-required') return JSON.parse(prior.result_json)
      if (!prior) this.record({ ...plan, savingBuffer }, fingerprint)
      return this.execute(prior ? JSON.parse(prior.plan_json) : { ...plan, savingBuffer }, savingBuffer)
    }
    return locked(0)
  }
  private async sync(plan: CanvasPlan, phase: CanvasSyncRequest['phase'], buffer: CanvasBuffer | null, canvas?: ReadyCanvas, dirty?: boolean): Promise<void> {
    if (!this.dependencies.sync) return
    const request: CanvasSyncRequest = { operationId: plan.operationId, objectId: plan.objectId, phase, deadline: Date.now() + 10000, ...(buffer ? { confirmation: confirmation(buffer) } : {}), ...(canvas ? { canvas, dirty } : {}) }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reply = await Promise.race([this.dependencies.sync(request), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('buffer_confirmation_expired: timeout')), 10000) })])
      if (!buffer && reply.confirmation) throw new Error('buffer_confirmation_expired: unregistered buffer')
      if (buffer && stableJson(reply.confirmation ?? null) !== stableJson(confirmation(buffer))) throw new Error('buffer_confirmation_expired')
      if (phase === 'commit' && canvas && (!reply.canvas || serializeCanvas(reply.canvas) !== serializeCanvas(canvas))) throw new Error('buffer_confirmation_expired: content readback mismatch')
    } finally { clearTimeout(timer) }
  }
  /** Objects in the library bin: a sub-board card whose file is there waits for it instead of failing the board. */
  recycled(): Set<string> { return new Set(this.registry.list().filter(o => o.status === 'trashed').map(o => o.id)) }
  private validate(plan: CanvasPlan): void {
    const entries = this.registry.list().filter(o => o.kind === 'canvas' && o.status === 'present' && o.current_path && isInside(this.root, o.current_path) && o.id !== plan.objectId).map(o => ({ path: relativeFileReference(this.root, checkedPath(this.root, o.current_path!)), canvas: ReadyCanvasSchema.parse(JSON.parse(readFileSync(o.current_path!, 'utf8'))) }))
    const next = { path: plan.path, canvas: ReadyCanvasSchema.parse(JSON.parse(plan.content)) }
    for (const file of plan.files.filter(f => f.path.endsWith('.canvas'))) {
      const child = { path: file.path, canvas: ReadyCanvasSchema.parse(JSON.parse(Buffer.from(file.content, 'base64').toString())) }
      const existing = entries.findIndex(e => e.path === child.path)
      if (existing >= 0) entries.splice(existing, 1)
      entries.push(child)
    }
    const objects = new Map(this.registry.list().filter(o => o.status === 'present' && o.current_path).map(o => [o.id, relativeFileReference(this.root, o.current_path!)]))
    validateCanvasCollection([...entries, next], objects, this.recycled())
    if (next.canvas.ready.id !== plan.objectId) throw new Error('identity_conflict')
  }
  private async execute(plan: CanvasPlan, savingBuffer = plan.savingBuffer ?? false): Promise<CanvasWriteResult> {
    const path = this.location(plan.path)
    return withDocumentPathLock(path, async () => {
      let prepared = false, committed = false, buffer = this.buffer(plan.objectId)
      const secondary: Array<{ plan: CanvasPlan; buffer: CanvasBuffer | null; committed: boolean }> = []
      bufferLocks.add(plan.objectId)
      try {
        const current = existsSync(path) ? await readFile(path, 'utf8') : null
        if (plan.original === null && current !== null && current !== plan.content) throw new Error('name_collision: target already exists')
        if (current !== plan.original && current !== plan.content) throw new Error('version_conflict: later disk edit preserved')
        this.validate(plan)
        this.registry.db.prepare("UPDATE canvas_operations SET state='awaiting-buffer' WHERE id=?").run(plan.operationId)
        prepared = true; await this.sync(plan, 'prepare', buffer)
        if (savingBuffer && (!buffer || stableJson(plan.expectedBuffer ?? null) !== stableJson(confirmation(buffer))) && !(buffer && current === plan.content && serializeCanvas(buffer.canvas) === plan.content)) throw new Error('buffer_confirmation_expired: save snapshot changed')
        if (current === plan.content && plan.original !== null && plan.original !== plan.content && buffer && serializeCanvas(buffer.canvas) !== plan.content && serializeCanvas(buffer.canvas) !== serializeCanvas(ReadyCanvasSchema.parse(JSON.parse(plan.original)))) throw new Error('version_conflict: recovery preserves newer buffer')
        for (const file of plan.files.filter(f => f.original !== undefined && f.path.endsWith('.canvas'))) {
          const content = Buffer.from(file.content, 'base64').toString(), canvas = ReadyCanvasSchema.parse(JSON.parse(content))
          const other = { ...plan, objectId: canvas.ready.id, path: file.path, original: file.original!, content, files: [], operationId: `${plan.operationId}:${canvas.ready.id}` }
          const snapshot = this.buffer(other.objectId)
          bufferLocks.add(other.objectId)
          secondary.push({ plan: other, buffer: snapshot, committed: false })
          await this.sync(other, 'prepare', snapshot)
          if (snapshot && serializeCanvas(snapshot.canvas) !== serializeCanvas(ReadyCanvasSchema.parse(JSON.parse(file.original!))) && serializeCanvas(snapshot.canvas) !== content) throw new Error('version_conflict: related canvas has unsaved changes')
        }
        let next = ReadyCanvasSchema.parse(JSON.parse(plan.content))
        if (!savingBuffer && current !== plan.content && buffer && plan.original !== null && serializeCanvas(buffer.canvas) !== serializeCanvas(ReadyCanvasSchema.parse(JSON.parse(plan.original)))) {
          if (buffer.baseVersion !== hashBytes(plan.original)) throw new Error('version_conflict: buffer disk base changed')
          if (plan.strict) throw new Error('version_conflict: the board has unsaved changes')
          next = mergeCanvas(ReadyCanvasSchema.parse(JSON.parse(plan.original)), buffer.canvas, next)
          const merged = { ...plan, content: serializeCanvas(next) }
          this.validate(merged)
          await this.stageFiles(merged); await this.publishFiles(merged); await this.verifyResources(merged, true)
          for (const file of plan.files.filter(f => f.path.endsWith('.canvas'))) {
            const child = this.registry.register(this.location(file.path)); this.refreshRelations(child.id)
          }
          await this.sync(plan, 'commit', buffer, next, true); committed = true
          buffer = { ...buffer, canvas: next, bufferVersion: buffer.bufferVersion + 1 }
          objectTransaction(this.registry.db, () => {
            this.putBuffer(buffer!)
            this.saveResult(plan.operationId, 'awaiting-buffer', { state: 'merged_dirty', operationId: plan.operationId, objectId: plan.objectId, confirmation: confirmation(buffer!) })
          })
          await this.sync(plan, 'release', { ...buffer, bufferVersion: buffer.bufferVersion - 1 })
          await this.cleanup(plan)
          return JSON.parse(this.row(plan.operationId)!.result_json!)
        }
        const stage = await this.stageFiles(plan)
        await this.publishFiles(plan)
        ensureDirectory(this.root, dirname(path))
        if (plan.original === null) {
          await stageFile(this.root, join(stage, 'canvas'), plan.content, hashBytes(plan.content))
          await publishNewFile(this.root, join(stage, 'canvas'), path, hashBytes(plan.content))
        } else if (current !== plan.content) {
          if (await readFile(path, 'utf8') !== plan.original) throw new Error('version_conflict: changed before publish')
          await (this.dependencies.publish ?? publishFileAtomically)(this.location(plan.path), plan.content)
        }
        this.registry.db.prepare("UPDATE canvas_operations SET state='published' WHERE id=?").run(plan.operationId)
        await this.dependencies.checkpoint?.('published')
        await this.verifyFiles(plan)
        await this.dependencies.checkpoint?.('readback')
        objectTransaction(this.registry.db, () => {
          for (const location of [...plan.files.filter(f => f.path.endsWith('.canvas')).map(f => f.path), plan.path]) {
            const target = this.location(location), object = this.registry.register(target)
            if (object.identity_state === 'conflict') throw new Error('identity_conflict: registration')
            const links = new ObjectLinkRepository(this.registry.db), extracted = extractCanvasLinks(readFileSync(target, 'utf8'))
            links.replace({ objectId: object.id }, extracted, object.content_hash)
            const count = this.registry.db.prepare('SELECT count(*) AS n FROM object_links WHERE source_id=?').get<{ n: number }>(object.id)!.n
            if (count !== new Set(extracted.map(l => JSON.stringify([l.kind, l.rawTarget, l.sourceNodeId, l.sourceOffset ?? 0]))).size) throw new Error('Relation readback mismatch')
          }
          this.registry.db.prepare("UPDATE canvas_operations SET state='indexed' WHERE id=?").run(plan.operationId)
        })
        await this.dependencies.checkpoint?.('indexed')
        await this.verifyFiles(plan)
        await this.sync(plan, 'commit', buffer, next, false); committed = true
        if (buffer) this.putBuffer({ ...buffer, canvas: next, baseVersion: hashBytes(plan.content), bufferVersion: buffer.bufferVersion + 1 })
        await this.sync(plan, 'release', buffer)
        for (const item of secondary) {
          const canvas = ReadyCanvasSchema.parse(JSON.parse(item.plan.content))
          await this.sync(item.plan, 'commit', item.buffer, canvas, false); item.committed = true
          if (item.buffer) this.putBuffer({ ...item.buffer, canvas, baseVersion: hashBytes(item.plan.content), bufferVersion: item.buffer.bufferVersion + 1 })
          await this.sync(item.plan, 'release', item.buffer)
        }
        const receipt: CanvasReceipt = { state: 'completed', operationId: plan.operationId, objectId: plan.objectId, beforeVersion: hashBytes(plan.original ?? ''), afterVersion: hashBytes(plan.content), affectedNodeIds: plan.affectedNodeIds, attachments: plan.files.map(f => ({ path: f.path, sha256: f.sha256, verified: true })) }
        this.saveResult(plan.operationId, 'completed', receipt)
        // Completed receipts own cleanup. An interrupted cleanup is resumed before future writes.
        await this.cleanup(plan)
        return receipt
      } catch (error) {
        let message = String(error)
        const recorded = this.row(plan.operationId)
        if (recorded?.state === 'completed') throw error
        if (recorded?.state === 'awaiting-buffer' && recorded.result_json) return { state: 'recovery-required', operationId: plan.operationId, phase: 'prepared', message }
        if (prepared && !committed) try { await this.sync(plan, 'rollback', buffer) } catch (rollback) { message += `; rollback: ${String(rollback)}` }
        for (const item of secondary) if (!item.committed) try { await this.sync(item.plan, 'rollback', item.buffer) } catch (rollback) { message += `; rollback: ${String(rollback)}` }
        const code = /text_conflict|delete_edit_conflict|group_conflict|identity_conflict|version_conflict|buffer_confirmation_expired/.exec(message)?.[0]
        const conflict = z.enum(['text_conflict', 'delete_edit_conflict', 'group_conflict', 'identity_conflict', 'version_conflict', 'buffer_confirmation_expired']).safeParse(code)
        if (conflict.success) return this.saveResult(plan.operationId, 'conflict', { state: 'conflict', operationId: plan.operationId, conflict: { code: conflict.data, message, nodeIds: plan.affectedNodeIds } })
        const result: CanvasWriteResult = { state: 'recovery-required', operationId: plan.operationId, phase: existsSync(path) && readFileSync(path, 'utf8') === plan.content ? 'published' : 'prepared', message }
        return this.saveResult(plan.operationId, 'recovery-required', result)
      } finally { bufferLocks.delete(plan.objectId); for (const item of secondary) bufferLocks.delete(item.plan.objectId) }
    })
  }
  private async stageFiles(plan: CanvasPlan): Promise<string> {
    const stage = join(this.root, '.ready', 'canvas-operations', hashBytes(plan.operationId))
    ensureDirectory(this.root, stage)
    for (const [i, file] of plan.files.entries()) {
      this.location(file.path)
      if (hashBytes(Buffer.from(file.content, 'base64')) !== file.sha256) throw new Error('readback_mismatch: attachment plan')
      await (this.dependencies.stage ?? stageFile)(this.root, join(stage, String(i)), Buffer.from(file.content, 'base64'), file.sha256)
    }
    await this.verifyResources(plan, false)
    await this.dependencies.checkpoint?.('staged')
    return stage
  }
  private async publishFiles(plan: CanvasPlan): Promise<void> {
    const stage = join(this.root, '.ready', 'canvas-operations', hashBytes(plan.operationId))
    for (const [i, file] of plan.files.entries()) {
      const target = this.location(file.path); ensureDirectory(this.root, dirname(target))
      if (file.original !== undefined) {
        const current = await readFile(target, 'utf8'), next = Buffer.from(file.content, 'base64').toString('utf8')
        if (current !== next && current !== file.original) throw new Error('version_conflict: moved canvas changed')
        if (current !== next) await publishFileAtomically(target, next)
      } else if (!file.path.endsWith('.canvas') && existsSync(target)) {
        if (hashBytes(await readFile(target)) !== file.sha256) throw new Error('name_collision: attachment contents differ')
      } else await publishNewFile(this.root, join(stage, String(i)), target, file.sha256)
    }
  }
  private async finishMerged(plan: CanvasPlan, result: Extract<CanvasWriteResult, { state: 'merged_dirty' }>): Promise<void> {
    const buffer = this.buffer(plan.objectId)
    if (!buffer) throw new Error('buffer_confirmation_expired: recoverable buffer is missing')
    await this.sync(plan, 'release', { ...buffer, ...result.confirmation, bufferVersion: result.confirmation.bufferVersion - 1 })
    await this.cleanup(plan)
  }
  private async cleanup(plan: CanvasPlan): Promise<void> {
    const stage = join(this.root, '.ready', 'canvas-operations', hashBytes(plan.operationId))
    for (const name of [...plan.files.map((_, i) => String(i)), ...(plan.original === null ? ['canvas'] : [])]) {
      const path = checkedPath(this.root, join(stage, name))
      try { await unlink(path) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
  }
  refreshRelations(objectId: string): void {
    const object = this.registry.get(objectId)
    if (!object || object.kind !== 'canvas') throw new Error('Canvas object unavailable')
    const extracted = object.status === 'present' && object.current_path ? extractCanvasLinks(readFileSync(checkedPath(this.root, object.current_path), 'utf8')) : []
    new ObjectLinkRepository(this.registry.db).replace({ objectId }, extracted, object.content_hash)
  }
  private async verifyFiles(plan: CanvasPlan): Promise<void> {
    const read = this.dependencies.readback ?? readFile
    if ((await read(this.location(plan.path))).toString('utf8') !== plan.content) throw new Error('readback_mismatch: canvas')
    for (const file of plan.files) if (hashBytes(await read(this.location(file.path))) !== file.sha256) throw new Error('readback_mismatch: attachment')
    await this.verifyResources(plan, true)
  }
  private async verifyResources(plan: CanvasPlan, published: boolean): Promise<void> {
    const canvases = [plan.content, ...plan.files.filter(f => f.path.endsWith('.canvas')).map(f => Buffer.from(f.content, 'base64').toString('utf8'))], recycled = this.recycled()
    for (const content of canvases) for (const node of ReadyCanvasSchema.parse(JSON.parse(content)).nodes) {
      const resources = new Map<string, string | undefined>()
      if (node.type === 'file' && !(node.ready.kind === 'subcanvas' && (node.ready.trash || (node.ready.ref?.kind === 'canvas' && recycled.has(node.ready.ref.id))))) resources.set(node.file, node.ready.media?.sha256)
      if (node.type === 'group' && node.background) resources.set(node.background, undefined)
      if (node.ready.preview?.image) resources.set(node.ready.preview.image, undefined)
      if (node.ready.media?.poster) resources.set(node.ready.media.poster, undefined)
      if (node.type === 'text') rewriteMarkdownMediaRefs(node.text, ref => { if (ref.localCandidate) resources.set(ref.rawDest, undefined); return null })
      for (const [resource, expectedHash] of resources) {
        const location = this.location(resource), planned = plan.files.find(f => f.path === resource)
        if (!planned && !existsSync(location) && plan.incomplete?.some(item => item.sourceId === node.id)) continue
        const bytes = !published && planned ? Buffer.from(planned.content, 'base64') : await readFile(location)
        if (expectedHash && hashBytes(bytes) !== expectedHash) throw new Error('readback_mismatch: media')
      }
    }
  }
  async withPageMove<T>(objectIds: string[], operationId: string, work: () => Promise<T>): Promise<T> {
    const ids = [...new Set(objectIds)].sort()
    const lock = (index: number): Promise<T> => index < ids.length ? serial(this.root + ids[index], () => lock(index + 1)) : execute()
    const execute = async (): Promise<T> => {
      const prepared: Array<{ plan: CanvasPlan; buffer: CanvasBuffer | null }> = []
      try {
        for (const id of ids) {
          bufferLocks.add(id)
          const buffer = this.buffer(id), object = this.registry.get(id)!
          const original = readFileSync(object.current_path ?? object.last_known_path, 'utf8')
          const plan: CanvasPlan = { root: this.root, objectId: id, operationId, path: '', original, content: original, files: [], affectedNodeIds: [] }
          prepared.push({ plan, buffer }); await this.sync(plan, 'prepare', buffer)
          if (buffer && serializeCanvas(buffer.canvas) !== serializeCanvas(ReadyCanvasSchema.parse(JSON.parse(original)))) throw new Error('dirty_conflict: save canvas before moving')
        }
        return await work()
      } finally {
        try { for (const entry of prepared) await this.sync(entry.plan, 'rollback', entry.buffer) }
        finally { for (const id of ids) bufferLocks.delete(id) }
      }
    }
    return lock(0)
  }
  async recover(): Promise<CanvasWriteResult[]> {
    const results: CanvasWriteResult[] = []
    for (const row of this.registry.db.prepare("SELECT * FROM canvas_operations WHERE state='completed'").all<Row>()) {
      const plan: CanvasPlan = JSON.parse(row.plan_json)
      if (plan.root === this.root) await this.cleanup(plan)
    }
    const rows = this.registry.db.prepare("SELECT * FROM canvas_operations WHERE state IN ('prepared','awaiting-buffer','published','indexed','recovery-required')").all<Row>()
    for (const row of rows) {
      const plan: CanvasPlan = JSON.parse(row.plan_json)
      if (plan.root !== this.root) continue
      if (row.state === 'awaiting-buffer' && row.result_json) {
        const result: CanvasWriteResult = JSON.parse(row.result_json)
        if (result.state === 'merged_dirty') await this.finishMerged(plan, result)
        results.push(result)
        continue
      }
      results.push(await this.publishBundle(plan, row.input_hash, plan.savingBuffer ?? false))
    }
    return results
  }
}
