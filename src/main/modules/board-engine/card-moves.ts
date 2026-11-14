import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import { CanvasIdSchema, CanvasPathSchema, ReadyCanvasSchema, Sha256Schema, planCardMove, planCardMoveUndo, serializeCanvas, stableJson,
  type CanvasNode, type CanvasReceipt, type CanvasWriteResult, type CardMoveDetail, type CardMovePlacement, type ReadyCanvas } from '../../../shared/ready-canvas'
import { checkedPath, hashBytes } from '../document-drafts/files'
import type { CanvasFile, CanvasPlan, CanvasService } from './canvas-service'

// Cards change boards (M4 §9.1, §9.2): one durable two-file publish, target first, replayed after an interruption.

const id = CanvasIdSchema
export const MoveCardsSchema = z.strictObject({
  operationId: id, objectId: id, handleId: id, expectedVersion: Sha256Schema, nodeIds: z.array(id).min(1),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), objectId: id }),
    z.strictObject({ kind: z.literal('new'), path: CanvasPathSchema.refine(path => path.endsWith('.canvas')), title: z.string().min(1).max(200), cardId: id }),
  ]),
})
export const UndoMoveSchema = z.strictObject({ operationId: id, moveOperationId: id })
export type CardMoveResult = (CanvasReceipt & { move: CardMoveDetail }) | Exclude<CanvasWriteResult, CanvasReceipt>

interface Board { path: string; original: string; canvas: ReadyCanvas }
function board(service: CanvasService, objectId: string): Board {
  const object = service.registry.get(objectId)
  if (!object || object.kind !== 'canvas' || object.status !== 'present' || !object.current_path || object.identity_state === 'conflict') throw new Error('identity_conflict: canvas is unavailable')
  const absolute = checkedPath(service.root, object.current_path), original = readFileSync(absolute, 'utf8')
  return { path: relative(service.root, absolute), original, canvas: ReadyCanvasSchema.parse(JSON.parse(original)) }
}
const owner = (canvas: ReadyCanvas, childId: string): CanvasNode | undefined =>
  canvas.nodes.find(node => !node.ready.trash && node.ready.kind === 'subcanvas' && node.ready.ref?.kind === 'canvas' && node.ready.ref.id === childId)
const conflict = (operationId: string, message: string): CardMoveResult => ({ state: 'conflict', operationId, conflict: { code: 'version_conflict', message, nodeIds: [] } })
function unsaved(service: CanvasService, objectId: string, item: Board): boolean {
  const buffer = service.buffer(objectId)
  return !!buffer && serializeCanvas(buffer.canvas) !== serializeCanvas(item.canvas)
}
const canvasFile = (path: string, canvas: ReadyCanvas, original?: string): CanvasFile => {
  const content = serializeCanvas(canvas)
  return { path, content: Buffer.from(content).toString('base64'), sha256: hashBytes(content), ...(original === undefined ? {} : { original }) }
}
/** Attachments follow their cards: copy what lives in the board the cards leave into the board they join. */
function attachments(service: CanvasService, fromPath: string, toPath: string, files: CanvasFile[]): (path: string) => string {
  const from = `${fromPath.replace(/\.canvas$/i, '')}.assets/`, to = `${toPath.replace(/\.canvas$/i, '')}.assets/`, done = new Map<string, string>()
  return path => {
    if (!path.startsWith(from)) return path
    const known = done.get(path)
    if (known) return known
    const absolute = checkedPath(service.root, join(service.root, path))
    if (!existsSync(absolute)) return path
    const bytes = readFileSync(absolute), sha = hashBytes(bytes), rest = path.slice(from.length)
    const free = (candidate: string) => {
      const planned = files.find(file => file.path === candidate), location = join(service.root, candidate)
      return planned ? planned.sha256 === sha : !existsSync(location) || hashBytes(readFileSync(location)) === sha
    }
    let next = to + rest
    if (!free(next)) { const cut = rest.lastIndexOf('/') + 1; next = `${to}${rest.slice(0, cut)}${sha.slice(0, 12)}-${rest.slice(cut)}` }
    if (!files.some(file => file.path === next) && !existsSync(join(service.root, next))) files.push({ path: next, content: bytes.toString('base64'), sha256: sha })
    done.set(path, next)
    return next
  }
}
function detailed(service: CanvasService, result: CanvasWriteResult): CardMoveResult {
  if (result.state !== 'completed') return result
  const row = service.registry.db.prepare('SELECT plan_json FROM canvas_operations WHERE id=?').get<{ plan_json: string }>(result.operationId)
  const plan: CanvasPlan = JSON.parse(row!.plan_json)
  if (!plan.move) throw new Error('operation_id_reused')
  const { kind: _kind, ...move } = plan.move
  return { ...result, move }
}

export async function moveCards(service: CanvasService, input: z.input<typeof MoveCardsSchema>): Promise<CardMoveResult> {
  const request = MoveCardsSchema.parse(input), { handleId: _handle, ...durable } = request
  const fingerprint = hashBytes(stableJson({ kind: 'move-cards', ...durable }))
  const replay = await service.resumeOperation(request.operationId, fingerprint)
  if (replay) return detailed(service, replay)
  if (service.holds(request.handleId) !== request.objectId) throw new Error('Canvas handle expired or belongs to another object')
  const source = board(service, request.objectId)
  if (hashBytes(source.original) !== request.expectedVersion) return conflict(request.operationId, 'Canvas changed on disk')
  if (unsaved(service, request.objectId, source)) return conflict(request.operationId, 'The board has unsaved changes')
  let target: Omit<Board, 'original'> & { original?: string }, placement: CardMovePlacement, targetId: string
  if (request.target.kind === 'existing') {
    targetId = request.target.objectId
    const existing = board(service, targetId), up = owner(existing.canvas, request.objectId)
    if (!owner(source.canvas, targetId) && !up) throw new Error('identity_conflict: cards move only between a board and its own sub-board')
    if (unsaved(service, targetId, existing)) return conflict(request.operationId, 'The other board has unsaved changes')
    target = existing; placement = up ? { kind: 'beside-node', nodeId: up.id } : { kind: 'beside-content' }
  } else {
    const folder = `${source.path.replace(/\.canvas$/i, '')}/`, path = request.target.path
    if (!path.startsWith(folder) || path.slice(folder.length).includes('/')) throw new Error('Subcanvas outside parent directory')
    if (existsSync(checkedPath(service.root, join(service.root, path)))) throw new Error('name_collision: target already exists')
    targetId = randomUUID()
    target = { path, canvas: { nodes: [], edges: [], ready: { schemaVersion: 1, id: targetId, title: request.target.title } } }
    placement = { kind: 'origin' }
  }
  const files: CanvasFile[] = []
  const plan = planCardMove({ source: source.canvas, target: target.canvas, nodeIds: request.nodeIds, placement, rehome: attachments(service, source.path, target.path, files) })
  let next = plan.source, createdNodeId: string | undefined
  if (request.target.kind === 'new') {
    createdNodeId = request.target.cardId
    if ([...next.nodes, ...next.edges].some(item => item.id === createdNodeId)) throw new Error(`identity_conflict: ${createdNodeId} already exists on the board`)
    // The sub-board card sits where the selection was.
    const card: CanvasNode = { id: createdNodeId, type: 'file', file: target.path, x: Math.round(plan.box.x + plan.box.width / 2 - 130), y: Math.round(plan.box.y + plan.box.height / 2 - 98), width: 260, height: 195,
      ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: targetId } } }
    next = ReadyCanvasSchema.parse({ ...next, nodes: [...next.nodes, card] })
  }
  const move: CardMoveDetail = { targetObjectId: targetId, movedNodeIds: plan.movedNodeIds, movedEdgeIds: plan.movedEdgeIds, droppedEdgeIds: plan.droppedEdgeIds, skipped: plan.skipped, ...(createdNodeId ? { createdNodeId } : {}) }
  return detailed(service, await service.publishBundle({ root: service.root, path: source.path, objectId: request.objectId, operationId: request.operationId, original: source.original, content: serializeCanvas(next),
    files: [...files, canvasFile(target.path, plan.target, target.original)], affectedNodeIds: [...plan.movedNodeIds, ...(createdNodeId ? [createdNodeId] : [])], strict: true, move: { ...move, kind: 'move' } }, fingerprint))
}

export async function undoCardMove(service: CanvasService, input: z.input<typeof UndoMoveSchema>): Promise<CardMoveResult> {
  const request = UndoMoveSchema.parse(input), fingerprint = hashBytes(stableJson({ kind: 'undo-move', ...request }))
  const replay = await service.resumeOperation(request.operationId, fingerprint)
  if (replay) return detailed(service, replay)
  const row = service.registry.db.prepare('SELECT state,plan_json FROM canvas_operations WHERE id=?').get<{ state: string; plan_json: string }>(request.moveOperationId)
  const done: CanvasPlan | undefined = row?.state === 'completed' ? JSON.parse(row.plan_json) : undefined
  if (!done || done.root !== service.root || done.move?.kind !== 'move' || done.original === null) throw new Error('nothing_to_undo: no completed move with this id')
  const { kind: _kind, ...detail } = done.move
  const source = board(service, done.objectId), target = board(service, detail.targetObjectId)
  if (unsaved(service, done.objectId, source) || unsaved(service, detail.targetObjectId, target)) return conflict(request.operationId, 'A board has unsaved changes')
  const files: CanvasFile[] = []
  const undo = planCardMoveUndo({ source: source.canvas, target: target.canvas, original: ReadyCanvasSchema.parse(JSON.parse(done.original)), detail, rehome: attachments(service, target.path, source.path, files) })
  return detailed(service, await service.publishBundle({ root: service.root, path: source.path, objectId: done.objectId, operationId: request.operationId, original: source.original, content: serializeCanvas(undo.source),
    files: [...files, canvasFile(target.path, undo.target, target.original)], affectedNodeIds: undo.returnedNodeIds, strict: true, move: { ...detail, movedNodeIds: undo.returnedNodeIds, kind: 'undo' },
    // A sub-board the move created and that is empty again leaves with its card, for good.
    ...(undo.removedCard ? { subBoards: { restore: [], trash: [detail.targetObjectId], purge: true } } : {}) }, fingerprint))
}
