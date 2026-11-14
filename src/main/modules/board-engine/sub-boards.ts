import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { applyCanvasOperations, ReadyCanvasSchema, subBoardEffects, subBoardOwners, type CanvasOperation, type CanvasWriteRequest, type CanvasWriteResult, type ReadyCanvas } from '../../../shared/ready-canvas'
import type { PageOperation, PageReceipt, PageTrashEntry } from '../../../shared/document-pages'
import { checkedPath, ensureDirectory, hashBytes } from '../document-drafts/files'
import type { CanvasPlan, CanvasService } from './canvas-service'
import { moveCards, undoCardMove, type CardMoveResult } from './card-moves'
import { WriteSchema } from './schema'

// A sub-board file follows its card (M4 §9.3). The card lives in the parent board's file and its bin; the file goes
// to the library bin through the page service. Restores run before the board is written, recycling after, and the
// recycle list is part of the durable write plan so an interrupted one is finished at startup.

export interface SubBoardPages {
  operate(input: PageOperation): Promise<PageReceipt>
  trash(root: string): PageTrashEntry[]
}
export interface SubBoardSummary { nodeId: string; objectId: string; available: boolean; title: string; count: number; images: string[] }

export class SubBoardCoordinator {
  constructor(private readonly canvas: CanvasService, private readonly pages: SubBoardPages) {}
  private get db() { return this.canvas.registry.db }
  private read(objectId: string): { path: string; original: string; canvas: ReadyCanvas } | null {
    const object = this.canvas.registry.get(objectId)
    if (!object || object.kind !== 'canvas' || object.status !== 'present' || !object.current_path) return null
    const original = readFileSync(checkedPath(this.canvas.root, object.current_path), 'utf8')
    return { path: object.current_path, original, canvas: ReadyCanvasSchema.parse(JSON.parse(original)) }
  }
  /** Page operation ids allow letters, digits, - and _ only; derive a stable one per write and sub-board. */
  private operationId(operationId: string, step: 'restore' | 'trash' | 'delete', childId: string): string {
    return `subboard-${step}-${hashBytes(`${operationId}\n${childId}`).slice(0, 40)}`
  }
  private async restore(childId: string, operationId: string): Promise<void> {
    const object = this.canvas.registry.get(childId)
    if (object?.status !== 'trashed') return
    const entry = this.pages.trash(this.canvas.root).find(item => item.objectId === childId)
    if (!entry) throw new Error('子画板文件已不在回收站，无法恢复这张卡片')
    ensureDirectory(this.canvas.root, dirname(entry.originalPath))
    try { await this.pages.operate({ type: 'restore', root: this.canvas.root, objectId: childId, operationId: this.operationId(operationId, 'restore', childId) }) }
    catch (error) { throw new Error(`子画板文件无法恢复到原位置：${error instanceof Error ? error.message : String(error)}`) }
  }
  /** After a completed write: sub-boards whose card left the board go to the library bin. Safe to repeat. */
  private async settle(operationId: string): Promise<void> {
    const row = this.db.prepare("SELECT plan_json FROM canvas_operations WHERE id=? AND state='completed'").get<{ plan_json: string }>(operationId)
    const plan: CanvasPlan | undefined = row && JSON.parse(row.plan_json)
    if (!plan?.subBoards?.trash.length || plan.root !== this.canvas.root) return
    const owners = subBoardOwners(this.read(plan.objectId)?.canvas ?? { nodes: [], edges: [], ready: { schemaVersion: 1, id: plan.objectId } })
    for (const childId of plan.subBoards.trash) {
      const recycle = this.operationId(operationId, 'trash', childId)
      if (owners.get(childId) !== 'active' && this.canvas.registry.get(childId)?.status === 'present' && !this.db.prepare('SELECT 1 AS n FROM document_page_operations WHERE id=?').get(recycle)) {
        await this.pages.operate({ type: 'trash', root: this.canvas.root, objectId: childId, operationId: recycle })
      }
      if (plan.subBoards.purge && this.canvas.registry.get(childId)?.status === 'trashed' && this.pages.trash(this.canvas.root).some(item => item.objectId === childId && item.operationId === recycle)) {
        await this.pages.operate({ type: 'delete', root: this.canvas.root, objectId: childId, operationId: this.operationId(operationId, 'delete', childId) })
      }
    }
  }
  /** What the write would do to the board's sub-boards, read from disk without changing anything. */
  private peek(request: CanvasWriteRequest): string[] {
    const current = this.read(request.objectId)
    if (!current || hashBytes(current.original) !== request.expectedVersion) return []
    const operations: CanvasOperation[] = request.commands.flatMap(command => command.type === 'batch' ? command.operations
      : command.type === 'importAttachment' || command.type === 'createSubcanvas' ? [{ type: 'addNode' as const, node: command.node }] : [command])
    try { return subBoardEffects(current.canvas, applyCanvasOperations(current.canvas, operations).canvas).restore }
    catch { return [] } // The write itself reports what is wrong with these operations.
  }
  async write(input: CanvasWriteRequest): Promise<CanvasWriteResult> {
    const request = WriteSchema.parse(input)
    if (!this.db.prepare('SELECT 1 AS n FROM canvas_operations WHERE id=?').get(request.operationId)) for (const childId of this.peek(request)) await this.restore(childId, request.operationId)
    const result = await this.canvas.write(request)
    if (result.state === 'completed') await this.settle(request.operationId)
    return result
  }
  async moveCards(input: Parameters<typeof moveCards>[1]): Promise<CardMoveResult> {
    return moveCards(this.canvas, input)
  }
  async undoMove(input: Parameters<typeof undoCardMove>[1]): Promise<CardMoveResult> {
    const result = await undoCardMove(this.canvas, input)
    if (result.state === 'completed') await this.settle(result.operationId)
    return result
  }
  /** Finish recycling that a completed write did not get to (the app stopped in between). */
  async recover(): Promise<void> {
    for (const row of this.db.prepare("SELECT id FROM canvas_operations WHERE state='completed' AND plan_json LIKE '%\"subBoards\"%'").all<{ id: string }>()) {
      try { await this.settle(row.id) } catch (error) { console.error('[canvas] sub-board recovery', row.id, error) }
    }
  }
  /** What each sub-board card shows: the child's title, how many cards it holds and a few of its pictures. */
  summaries(parentObjectId: string): SubBoardSummary[] {
    const parent = this.read(parentObjectId)
    if (!parent) throw new Error('identity_conflict: canvas is unavailable')
    return parent.canvas.nodes.flatMap((node): SubBoardSummary[] => {
      if (node.type !== 'file' || node.ready.kind !== 'subcanvas' || node.ready.ref?.kind !== 'canvas' || node.ready.trash) return []
      const name = node.file.split('/').pop()!.replace(/\.canvas$/i, '')
      let child: ReturnType<SubBoardCoordinator['read']> = null
      try { child = this.read(node.ready.ref.id) } catch (error) { console.warn('[canvas] sub-board summary', node.ready.ref.id, error instanceof Error ? error.message : String(error)) }
      if (!child) return [{ nodeId: node.id, objectId: node.ready.ref.id, available: false, title: name, count: 0, images: [] }]
      const cards = child.canvas.nodes.filter(item => !item.ready.trash && item.type !== 'group')
      const images = cards.flatMap(item => item.type === 'file' && item.ready.kind === 'image' && existsSync(join(this.canvas.root, item.file)) ? [item.file] : []).slice(0, 4)
      return [{ nodeId: node.id, objectId: node.ready.ref.id, available: true, title: child.canvas.ready.title || relative(dirname(child.path), child.path).replace(/\.canvas$/i, ''), count: cards.length, images }]
    })
  }
}
