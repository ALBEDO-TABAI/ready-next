import { join, posix } from 'node:path'
import { z } from 'zod'
import { toReadyUri } from '../../../shared/ready-ref'
import type { FastCardItem, FastCardTransferReceipt } from '../../../shared/fastcard'
import { CanvasNodeSchema, CanvasPathSchema, ReadyCanvasSchema, stableJson, type CanvasWriteRequest, type CanvasWriteResult, type ReadyCanvas, type CanvasNode, type CanvasReceipt } from '../../../shared/ready-canvas'
import { fastCardItemSchema, type FastCardRepository } from '../repositories/fastcard-repository'
import { digest, publishBytes, safeDirectory, verifiedRead, type FastCardMediaCache } from './media-cache'

export class FastCardTargetUnavailableError extends Error { readonly code = 'target_unavailable' }

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
export const transferRequestSchema = z.strictObject({
  operationId: id, itemIds: z.array(z.string().min(1)).min(1).max(500).refine(ids => new Set(ids).size === ids.length),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), objectId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('new'), title: z.string().trim().min(1), parentObjectId: z.string().optional(), parentPath: z.string().optional() }),
  ]).optional(),
  position: z.strictObject({ x: z.number().int().safe(), y: z.number().int().safe() }).optional(),
})
export interface BoardTarget { objectId: string; title: string }
export interface FastCardBoardHandle extends BoardTarget {
  handleId: string; libraryRoot: string; relativePath: string; version: string; canvas: ReadyCanvas
}
/** B adapter is scoped to one verified library. create must be idempotent by object/operation ID.
 * apply uses M4's CanvasWriteRequest; it must recover receipts before checking stale expectedVersion.
 * open must read the final file and verify object identity; completed implies index confirmation.
 */
export interface FastCardBoardPort {
  list(): Promise<BoardTarget[]>
  create(input: BoardTarget & { operationId: string; parentObjectId?: string; parentPath?: string }): Promise<BoardTarget>
  open(objectId: string): Promise<FastCardBoardHandle>
  apply(request: CanvasWriteRequest): Promise<CanvasWriteResult>
}
const receiptSchema = z.strictObject({ state: z.literal('completed'), operationId: z.string(), objectId: z.string(),
  title: z.string(), nodeIds: z.array(z.string()) })
const jobSchema = z.strictObject({
  libraryId: z.string(), request: transferRequestSchema, items: z.array(fastCardItemSchema), positions: z.record(z.string(), z.number().int()),
  target: z.strictObject({ objectId: z.string(), title: z.string(), create: z.boolean(), parentObjectId: z.string().optional(), parentPath: z.string().optional() }),
  state: z.enum(['prepared', 'completed', 'undo-prepared', 'undone']),
  plan: z.strictObject({ version: z.string(), relativePath: CanvasPathSchema, nodes: z.array(CanvasNodeSchema) }).optional(),
  undoVersion: z.string().optional(), receipt: receiptSchema.optional(),
  boardReceipt: z.strictObject({ state: z.literal('completed'), operationId: z.string(), objectId: z.string(), beforeVersion: z.string(), afterVersion: z.string(), affectedNodeIds: z.array(z.string()),
    attachments: z.array(z.strictObject({ path: z.string(), sha256: z.string(), verified: z.literal(true) })) }).optional(),
})
type Job = z.infer<typeof jobSchema>

export class FastCardTransferService {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly libraryId: string, private readonly repository: FastCardRepository,
    private readonly cache: FastCardMediaCache, private readonly boards: FastCardBoardPort) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => undefined); return result
  }
  private boardOperationId(operationId: string, phase: 'create' | 'save' | 'undo'): string {
    return `fc-${digest(`${this.libraryId}:${operationId}`)}-${phase}`
  }
  private store(job: Job): void {
    this.repository.saveTransfer(job.request.operationId, job.libraryId, job.state, JSON.stringify(jobSchema.parse(job)))
  }
  private load(operationId: string): Job | undefined {
    const raw = this.repository.loadTransfer(operationId)
    const job = raw ? jobSchema.parse(JSON.parse(raw)) : undefined
    if (job && job.libraryId !== this.libraryId) throw new Error('operation belongs to another library')
    return job
  }
  targets(): Promise<BoardTarget[]> { return this.boards.list() }
  pending(): z.infer<typeof transferRequestSchema>[] {
    return this.repository.pendingTransfers().map(raw => jobSchema.parse(JSON.parse(raw)))
      .filter(job => job.libraryId === this.libraryId).map(job => job.request)
  }
  async recover(): Promise<Array<{ operationId: string; error?: string }>> {
    const results: Array<{ operationId: string; error?: string }> = []
    for (const request of this.pending()) {
      try {
        if (this.load(request.operationId)?.state === 'undo-prepared') await this.undo(request.operationId)
        else await this.transfer(request)
        results.push({ operationId: request.operationId })
      } catch (error) { results.push({ operationId: request.operationId, error: String(error) }) }
    }
    return results
  }
  transfer(input: unknown): Promise<FastCardTransferReceipt> {
    const request = transferRequestSchema.parse(input)
    return this.serial(async () => {
      let job = this.load(request.operationId)
      if (job && JSON.stringify(job.request) !== JSON.stringify(request)) throw new Error('operation_id_reused')
      if (job?.state === 'completed' && job.receipt) return job.receipt
      if (job && job.state !== 'prepared') throw new Error('operation already undone or undo pending')
      if (!job) {
        const all = this.repository.list()
        const items = request.itemIds.map(itemId => {
          const item = all.find(item => item.id === itemId)
          if (!item) throw new Error(`FastCard missing: ${itemId}`)
          if (item.transcription?.status === 'running') throw new Error('转写正在进行，请完成后再转存')
          if ((item.kind === 'image' || item.kind === 'image-description' || item.kind === 'audio') && item.media?.status !== 'cached') throw new Error('媒体缺失，请先补齐；尚未保存到画板')
          return item
        })
        const explicit = request.target
        const remembered = this.repository.lastTarget(this.libraryId)
        const existingId = explicit?.kind === 'existing' ? explicit.objectId : remembered
        let target: Job['target']
        if (explicit?.kind === 'new') {
          target = { objectId: `fc-${digest(`${this.libraryId}:${request.operationId}`).slice(0, 32)}`, title: explicit.title, create: true,
            parentObjectId: explicit.parentObjectId, parentPath: explicit.parentPath }
        } else if (existingId) {
          const objectId = existingId
          try { const opened = await this.boards.open(objectId); target = { objectId, title: opened.title, create: false } }
          catch { throw new FastCardTargetUnavailableError('目标画板不可用，请明确选择其他画板') }
        } else {
          const matches = (await this.boards.list()).filter(board => board.title === '灵感')
          if (matches.length > 1) throw new FastCardTargetUnavailableError('存在多个《灵感》，请明确选择目标画板')
          target = matches[0] ? { ...matches[0], create: false }
            : { objectId: `fc-${digest(`${this.libraryId}:inspiration`).slice(0, 32)}`, title: '灵感', create: true }
        }
        job = { libraryId: this.libraryId, request, items, positions: this.repository.positions(request.itemIds), target, state: 'prepared' }
        // Validate content/provenance before reserving items or creating a target file.
        for (const [index, item] of items.entries()) this.node(item, job, 'validation.canvas', index)
        const prepared = job
        this.repository.transaction(() => { this.store(prepared); this.repository.reserve(request.operationId, items) })
      }
      if (job.target.create) await this.boards.create({ ...job.target, operationId: this.boardOperationId(request.operationId, 'create') })
      const handle = await this.boards.open(job.target.objectId)
      this.validateHandle(handle, job.target.objectId)
      if (!job.plan) {
        const nodes: CanvasNode[] = []
        for (const [index, item] of job.items.entries()) nodes.push(this.node(item, job, handle.relativePath, index))
        job.plan = { version: handle.version, relativePath: handle.relativePath, nodes }
        this.store(job)
      }
      if (handle.relativePath !== job.plan.relativePath) throw new Error('目标画板位置已变化，请恢复原位置后重试')
      this.copyMedia(job, handle)
      const result = await this.boards.apply({ operationId: this.boardOperationId(request.operationId, 'save'), objectId: handle.objectId,
        handleId: handle.handleId, expectedVersion: job.plan.version, commands: job.plan.nodes.map(node => ({ type: 'addNode', node })) })
      this.checkReceipt(result, this.boardOperationId(request.operationId, 'save'), handle.objectId, job.plan.nodes.map(node => node.id))
      const readback = await this.boards.open(handle.objectId)
      this.validateHandle(readback, handle.objectId)
      for (const node of job.plan.nodes) {
        if (!readback.canvas.nodes.some(n => n.id === node.id && stableJson(n) === stableJson(node))) throw new Error('Canvas readback conflict')
      }
      this.copyMedia(job, readback) // Includes final location/hash readback.
      const receipt: FastCardTransferReceipt = { state: 'completed', operationId: request.operationId, objectId: handle.objectId,
        title: readback.title, nodeIds: job.plan.nodes.map(node => node.id) }
      job.state = 'completed'; job.receipt = receipt; job.boardReceipt = result
      const completed = job
      this.repository.transaction(() => {
        this.store(completed)
        this.repository.removeTransferred(request.operationId, completed.items)
        this.repository.rememberTarget(this.libraryId, handle.objectId)
      })
      return receipt
    })
  }
  undo(operationId: string): Promise<{ state: 'undone' }> {
    id.parse(operationId)
    return this.serial(async () => {
      const job = this.load(operationId)
      if (!job) throw new Error('operation not found')
      if (job.state === 'undone') return { state: 'undone' }
      if (!job.plan || !['completed', 'undo-prepared'].includes(job.state)) throw new Error('请先完成转存恢复')
      const handle = await this.boards.open(job.target.objectId)
      this.validateHandle(handle, job.target.objectId)
      const nodeIds = job.plan.nodes.map(node => node.id)
      if (job.state === 'completed') {
        for (const node of job.plan.nodes) {
          if (!handle.canvas.nodes.some(n => n.id === node.id && stableJson(n) === stableJson(node))) throw new Error('undo conflict: 节点已修改或删除')
        }
        if (handle.canvas.edges.some(edge => nodeIds.includes(edge.fromNode) || nodeIds.includes(edge.toNode))) throw new Error('undo conflict: 节点已有连线')
        if (handle.canvas.nodes.some(node => !nodeIds.includes(node.id) && [node.ready.groupId, node.ready.dock?.left, node.ready.dock?.top].some(ref => ref && nodeIds.includes(ref)))) throw new Error('undo conflict: 节点已被引用')
        for (const item of job.items) {
          const existing = this.repository.list().find(value => value.id === item.id)
          if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error('undo conflict: 暂存身份已被使用')
        }
        job.undoVersion = handle.version; job.state = 'undo-prepared'; this.store(job)
      }
      // Undo restores a usable tray, even when the old cache was evicted after transfer.
      for (const [index, item] of job.items.entries()) {
        if (item.media?.status !== 'cached') continue
        const node = job.plan.nodes[index]
        if (node.type !== 'file') throw new Error('Missing undo media node')
        const directory = safeDirectory(handle.libraryRoot, posix.dirname(node.file))
        this.cache.save(verifiedRead(join(directory, posix.basename(node.file)), item.media.sha256), item.media.mime)
      }
      if (!job.undoVersion) throw new Error('Missing undo version')
      const result = await this.boards.apply({ operationId: this.boardOperationId(operationId, 'undo'), objectId: handle.objectId,
        handleId: handle.handleId, expectedVersion: job.undoVersion, commands: nodeIds.map(nodeId => ({ type: 'deleteNode', id: nodeId })) })
      this.checkReceipt(result, this.boardOperationId(operationId, 'undo'), handle.objectId, nodeIds)
      const readback = await this.boards.open(handle.objectId)
      if (readback.canvas.nodes.some(node => nodeIds.includes(node.id))) throw new Error('Undo readback conflict')
      this.repository.transaction(() => {
        this.repository.restoreItems(job.items, job.positions)
        job.state = 'undone'; this.store(job)
      })
      return { state: 'undone' }
    })
  }
  private validateHandle(handle: FastCardBoardHandle, objectId: string): void {
    CanvasPathSchema.parse(handle.relativePath); ReadyCanvasSchema.parse(handle.canvas)
    if (handle.objectId !== objectId || handle.canvas.ready.id !== objectId || !handle.relativePath.endsWith('.canvas')) throw new Error('Canvas identity conflict')
  }
  private checkReceipt(result: CanvasWriteResult, operationId: string, objectId: string, nodeIds: string[]): asserts result is CanvasReceipt {
    if (result.state !== 'completed') throw new Error(`Canvas ${result.state}: 转存尚未完成`)
    if (result.operationId !== operationId || result.objectId !== objectId || JSON.stringify([...result.affectedNodeIds].sort()) !== JSON.stringify([...nodeIds].sort())) throw new Error('Canvas receipt mismatch')
  }
  private node(item: FastCardItem, job: Job, relativePath: string, index: number): CanvasNode {
    const base = { id: `fc-${digest(`${job.request.operationId}:${item.id}`).slice(0, 32)}`,
      x: (job.request.position?.x ?? 0) + index % 3 * 360, y: (job.request.position?.y ?? 0) + Math.floor(index / 3) * 280, width: 320, height: 240 }
    const sources = [{ uri: item.source?.pageUrl || toReadyUri({ kind: 'fastcard', id: item.id }), ...(item.source?.pageTitle ? { title: item.source.pageTitle } : {}),
      capturedAt: new Date(item.source?.capturedAt ?? item.createdAt).toISOString(), method: 'fastcard', fastCardId: item.id }]
    // A's frozen fastCard enum has no audio yet; audio identity is retained in sources, not falsified as text.
    const fastCard = item.kind === 'audio' ? undefined : { id: item.id, kind: item.kind, createdAt: new Date(item.createdAt).toISOString(), ...(item.originalText !== undefined ? { originalText: item.originalText } : {}), ...(item.targetLanguage ? { targetLanguage: item.targetLanguage } : {}) }
    if (item.media?.status === 'cached') {
      return CanvasNodeSchema.parse({ ...base, type: 'file', file: `${relativePath.slice(0, -7)}.assets/${item.media.key}`,
        ready: { kind: item.kind === 'audio' ? 'audio' : 'image', ...(sources ? { sources } : {}), ...(fastCard ? { fastCard } : {}),
          preview: { ...(item.title ? { title: item.title } : {}), ...(item.description || item.caption ? { description: item.description || item.caption } : {}) },
          media: { mime: item.media.mime, sha256: item.media.sha256, ...(item.transcription?.status === 'ready' ? { transcript: item.transcription.text } : {}) } } })
    }
    if (item.kind === 'video') {
      const url = item.video?.originalUrl || item.source?.pageUrl
      if (!url || !/^https?:\/\//.test(url)) throw new Error('视频来源网址缺失')
      return CanvasNodeSchema.parse({ ...base, type: 'link', url, ready: { kind: 'link', ...(sources ? { sources } : {}), ...(fastCard ? { fastCard } : {}) } })
    }
    return CanvasNodeSchema.parse({ ...base, type: 'text', text: item.kind === 'translation'
      ? `${item.originalText || ''}\n\n${item.translatedText || ''}` : item.text || item.description || '', ready: { kind: 'text', ...(sources ? { sources } : {}), ...(fastCard ? { fastCard } : {}) } })
  }
  private copyMedia(job: Job, handle: FastCardBoardHandle): void {
    for (const [index, item] of job.items.entries()) {
      if (item.media?.status !== 'cached') continue
      const node = job.plan?.nodes[index]
      if (node?.type !== 'file') throw new Error('Missing media node')
      const directory = safeDirectory(handle.libraryRoot, posix.dirname(node.file))
      const target = join(directory, posix.basename(node.file))
      // Reuse a verified copy even if the cache was lost after publication.
      try { verifiedRead(target, item.media.sha256) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        publishBytes(target, this.cache.read(item.media))
      }
      verifiedRead(target, item.media.sha256)
    }
  }
}
