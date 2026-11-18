import { relativeFileReference } from '../../utils/platform'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CanvasComposeInputSchema, CanvasComposeReceiptSchema, CanvasPreviewInputSchema, DraftReceiptSchema,
  type CanvasComposeInput, type CanvasComposeReceipt, type CanvasPreviewInput, type DocumentDraft, type DraftFinalizeReceipt } from '../../../shared/document-drafts'
import { CanvasNodeSchema, serializeCanvas, stableJson, type CanvasNode, type CanvasWriteRequest } from '../../../shared/ready-canvas'
import { CanvasService } from '../board-engine/canvas-service'
import { WriteSchema } from '../board-engine/schema'
import { DocumentDraftService } from '../document-drafts/service'
import { checkedPath, draftError, ensureDirectory, hashBytes, stageFile } from '../document-drafts/files'
import { objectTransaction } from '../object-service/registry'
import { convertSelection } from './convert'
import { readCanvasDocumentPreview } from './preview'

const PlanSchema = z.object({
  request: CanvasComposeInputSchema, draft: DraftReceiptSchema, card: CanvasNodeSchema, orderedNodeIds: z.array(z.string()).min(1),
  files: z.array(z.object({ path: z.string(), content: z.string(), hash: z.string() })),
  cardWrite: WriteSchema.omit({ handleId: true }),
  finalization: z.object({ state: z.enum(['prepared', 'completed']),
    write: WriteSchema.omit({ handleId: true }), card: CanvasNodeSchema.nullable(),
  }).optional(),
})
type Plan = z.infer<typeof PlanSchema>
interface Row { input_hash: string; plan_json: string; receipt_json: string | null }
interface Dependencies { checkpoint?(phase: 'prepared' | 'attachments' | 'card' | 'completed' | 'final-prepared' | 'final-card'): void | Promise<void> }

/** One instance per vault; F must share B's CanvasService (including buffer synchronization). */
export class CanvasCompositionService {
  private readonly pending = new Map<string, { hash: string; promise: Promise<CanvasComposeReceipt> }>()
  constructor(private readonly canvas: CanvasService, private readonly drafts: DocumentDraftService, private readonly dependencies: Dependencies = {}) {}
  private get db() { return this.canvas.registry.db }
  async preview(input: CanvasPreviewInput) {
    const parsed = CanvasPreviewInputSchema.parse(input)
    if ('kind' in parsed) return readCanvasDocumentPreview(this.canvas.registry, this.canvas.root, parsed)
    const opened = await this.canvas.open(parsed.objectId)
    try {
      const node = opened.canvas.nodes.find(n => n.id === parsed.nodeId && !n.ready.trash)
      if (!node || node.type !== 'file' || node.ready.kind !== 'document') throw new Error('文档卡已改变或不存在')
      const object = this.canvas.registry.register(checkedPath(this.canvas.root, join(this.canvas.root, node.file)))
      if (object.identity_state === 'conflict' || (node.ready.ref && 'id' in node.ready.ref && node.ready.ref.id !== object.id)) throw new Error('文档卡引用身份冲突')
      const ref = node.ready.ref ?? { kind: 'page' as const, id: object.id }
      return readCanvasDocumentPreview(this.canvas.registry, this.canvas.root, ref)
    } finally { this.canvas.release(opened.handleId) }
  }
  private row(operationId: string): Row | undefined {
    return this.db.prepare('SELECT input_hash,plan_json,receipt_json FROM canvas_compositions WHERE operation_id=? AND vault_root=?')
      .get<Row>(operationId, this.canvas.root)
  }
  private save(plan: Plan): void {
    const serialized = JSON.stringify(PlanSchema.parse(plan))
    this.db.prepare('UPDATE canvas_compositions SET plan_json=? WHERE operation_id=? AND vault_root=?')
      .run(serialized, plan.request.operationId, this.canvas.root)
    if (this.row(plan.request.operationId)?.plan_json !== serialized) throw new Error('Composition plan readback mismatch')
  }
  async compose(input: CanvasComposeInput): Promise<CanvasComposeReceipt> {
    const request = CanvasComposeInputSchema.parse(input), hash = hashBytes(stableJson(request))
    const prior = this.pending.get(request.operationId)
    if (prior) {
      if (prior.hash !== hash) throw draftError('operation_conflict', 'operation input changed')
      return prior.promise
    }
    const promise = this.composeOnce(request, hash)
    this.pending.set(request.operationId, { hash, promise })
    try { return await promise } finally { this.pending.delete(request.operationId) }
  }
  private async composeOnce(request: CanvasComposeInput, hash: string): Promise<CanvasComposeReceipt> {
    const prior = this.row(request.operationId)
    if (prior && prior.input_hash !== hash) throw draftError('operation_conflict', 'operation input changed')
    if (prior?.receipt_json) return CanvasComposeReceiptSchema.parse(JSON.parse(prior.receipt_json))
    const opened = await this.canvas.open(request.objectId)
    try {
      let plan: Plan
      if (prior) plan = PlanSchema.parse(JSON.parse(prior.plan_json))
      else {
        if (opened.version !== request.expectedVersion) throw draftError('unconfirmed_selection', '画板已改变，请重新确认选区')
        const buffer = this.canvas.buffer(request.objectId)
        if (buffer && serializeCanvas(buffer.canvas) !== serializeCanvas(opened.canvas)) throw draftError('unsaved_canvas', '请先保存画板，再添加到文档')
        const selected = new Set(request.nodeIds)
        const active = opened.canvas.nodes.filter(n => !n.ready.trash)
        if (active.filter(n => selected.has(n.id)).length !== selected.size) throw draftError('invalid_selection', '选区包含已移除的卡片')
        // Selecting a group includes its descendants; preserve original drawing order.
        let size = 0
        while (size !== selected.size) {
          size = selected.size
          for (const node of active) if (node.ready.groupId && selected.has(node.ready.groupId)) selected.add(node.id)
        }
        const nodes = active.filter(n => selected.has(n.id))
        if (nodes.every(n => n.type === 'group')) throw draftError('invalid_selection', '选区没有正文')
        const converted = convertSelection(this.canvas.root, request.objectId, request.operationId, nodes, this.canvas.registry)
        const cardId = randomUUID()
        plan = objectTransaction(this.db, () => {
          const draft = this.drafts.create({ origin: 'canvas', vaultRoot: this.canvas.root, tabId: request.tabId, title: request.title,
            content: converted.content, attachments: converted.attachments, suggestedParent: request.objectId,
            sourceCanvas: { objectId: request.objectId, nodeId: cardId } })
          const card: CanvasNode = { id: cardId, type: 'text', text: request.title || '未命名草稿',
            x: Math.max(...nodes.map(n => n.x + n.width)) + 48, y: Math.min(...nodes.map(n => n.y)), width: 280, height: 140,
            ready: { kind: 'draft', draftId: draft.draftId, draftLibraryId: hashBytes(this.canvas.root) } }
          const prepared: Plan = { request, draft, card, files: converted.files, orderedNodeIds: converted.orderedNodeIds,
            cardWrite: { operationId: `${request.operationId}:draft-card`, objectId: request.objectId, expectedVersion: opened.version, commands: [{ type: 'addNode', node: card }] } }
          PlanSchema.parse(prepared)
          this.db.prepare("INSERT INTO canvas_compositions(operation_id,vault_root,input_hash,draft_id,state,plan_json) VALUES (?,?,?,?,'prepared',?)")
            .run(request.operationId, this.canvas.root, hash, draft.draftId, JSON.stringify(prepared))
          if (this.row(request.operationId)?.plan_json !== JSON.stringify(prepared)) throw new Error('Composition plan readback mismatch')
          return prepared
        })
      }
      await this.dependencies.checkpoint?.('prepared')
      if (this.drafts.read(plan.draft.draftId)?.state === 'discarded') throw draftError('discarded_draft', '草稿已丢弃，不再创建草稿卡')
      for (const file of plan.files) {
        const path = checkedPath(this.canvas.root, file.path)
        ensureDirectory(this.canvas.root, dirname(path))
        await stageFile(this.canvas.root, path, Buffer.from(file.content, 'base64'), file.hash)
      }
      await this.dependencies.checkpoint?.('attachments')
      const version = await this.writeCard({ ...plan.cardWrite, handleId: opened.handleId }, plan.card)
      await this.dependencies.checkpoint?.('card')
      const receipt: CanvasComposeReceipt = { ...plan.draft, operationId: request.operationId, objectId: request.objectId, cardId: plan.card.id, canvasVersion: version }
      this.db.prepare("UPDATE canvas_compositions SET state='completed',receipt_json=? WHERE operation_id=? AND vault_root=?")
        .run(JSON.stringify(receipt), request.operationId, this.canvas.root)
      const readback = this.row(request.operationId)
      if (readback?.receipt_json !== JSON.stringify(receipt)) throw new Error('Composition receipt readback mismatch')
      await this.dependencies.checkpoint?.('completed')
      return receipt
    } finally { this.canvas.release(opened.handleId) }
  }
  private async writeCard(request: CanvasWriteRequest, expected: CanvasNode | null, cardId = expected?.id): Promise<string> {
    const result = await this.canvas.write(request)
    if (result.state === 'conflict') throw draftError(result.conflict.code, result.conflict.message)
    if (result.state === 'recovery-required') throw draftError('canvas_recovery_required', result.message)
    // merged_dirty is not success. A later explicit save may have completed it.
    const read = await this.canvas.read(request.handleId), actual = read.canvas.nodes.find(n => n.id === cardId) ?? null
    if (stableJson(actual) !== stableJson(expected)) throw draftError('canvas_pending', '画板尚未保存或卡片已变化，请保存画板后重试')
    const object = this.canvas.registry.get(request.objectId)
    if (object?.content_hash !== read.version) throw draftError('canvas_pending', '画板索引尚未确认')
    return read.version
  }
  async complete(draft: DocumentDraft, receipt: DraftFinalizeReceipt, keep: boolean): Promise<void> {
    if (draft.vaultRoot !== this.canvas.root || !draft.sourceCanvas) throw draftError('wrong_vault', '草稿不属于此画板资料库')
    const row = this.db.prepare('SELECT plan_json FROM canvas_compositions WHERE draft_id=? AND vault_root=?')
      .get<{ plan_json: string }>(draft.draftId, this.canvas.root)
    if (!row) throw draftError('missing_composition', '找不到草稿与画板的联动记录')
    const plan = PlanSchema.parse(JSON.parse(row.plan_json))
    if (plan.finalization?.state === 'completed') return
    const opened = await this.canvas.open(draft.sourceCanvas.objectId)
    try {
      if (!plan.finalization) {
        const current = opened.canvas.nodes.find(n => n.id === plan.card.id)
        if (!current || current.type !== 'text' || current.ready.kind !== 'draft' || current.ready.draftId !== draft.draftId || current.ready.trash) {
          throw draftError('canvas_conflict', '草稿卡已被移除或改变，文档保持已保存')
        }
        const { draftId: _draft, draftLibraryId: _library, ...ready } = current.ready
        const { text: _text, ...geometry } = current
        const card: CanvasNode | null = keep ? { ...geometry, type: 'file', file: relativeFileReference(this.canvas.root, checkedPath(this.canvas.root, receipt.path)),
          ready: { ...ready, kind: 'document', ref: { kind: 'page', id: receipt.objectId }, preview: { title: draft.finalize!.request.title } } } : null
        plan.finalization = { state: 'prepared', card, write: { operationId: `${receipt.operationId}:document-card`, objectId: opened.objectId, expectedVersion: opened.version,
          commands: card ? [{ type: 'replaceNode', node: card }] : [
            ...opened.canvas.edges.filter(e => e.fromNode === current.id || e.toNode === current.id).map(e => ({ type: 'deleteEdge' as const, id: e.id })),
            { type: 'deleteNode', id: current.id },
          ] } }
        this.save(plan)
      }
      await this.dependencies.checkpoint?.('final-prepared')
      await this.writeCard({ ...plan.finalization.write, handleId: opened.handleId }, plan.finalization.card, plan.card.id)
      await this.dependencies.checkpoint?.('final-card')
      plan.finalization.state = 'completed'; this.save(plan)
    } finally { this.canvas.release(opened.handleId) }
  }
  async recover(): Promise<CanvasComposeReceipt[]> {
    const rows = this.db.prepare("SELECT plan_json FROM canvas_compositions WHERE vault_root=? AND state='prepared'")
      .all<{ plan_json: string }>(this.canvas.root)
    const receipts: CanvasComposeReceipt[] = []
    for (const row of rows) receipts.push(await this.compose(PlanSchema.parse(JSON.parse(row.plan_json)).request))
    return receipts
  }
}
