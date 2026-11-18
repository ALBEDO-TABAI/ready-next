import { relativeFileReference } from '../../utils/platform'
import { basename, extname, join } from 'node:path'
import type { CanvasWriteResult } from '../../../shared/ready-canvas'
import type { CanvasImportReceipt, CanvasImportService } from '../canvas-import/service'
import { checkedPath, existsIgnoringCase, filename } from '../document-drafts/files'
import type { CanvasService } from './canvas-service'
import type { SubBoardCoordinator } from './sub-boards'

// 导入 Stillroom 空间 (M4 §9.4): the existing import writes the space under this board's folder; this board then
// gets a sub-board card for it. The import has its own durable receipt; the card is an ordinary board write.

export interface StillroomImportResult { receipt: CanvasImportReceipt; nodeId: string; card: CanvasWriteResult }

export async function importStillroomSpace(services: { canvas: CanvasService; imports: CanvasImportService; subBoards: SubBoardCoordinator }, input: {
  operationId: string; objectId: string; handleId: string; expectedVersion: string; at: { x: number; y: number }; sourcePath: string
}): Promise<StillroomImportResult> {
  const { canvas, imports, subBoards } = services
  if (canvas.holds(input.handleId) !== input.objectId) throw new Error('Canvas handle expired or belongs to another object')
  const parent = canvas.registry.get(input.objectId)
  if (!parent?.current_path || parent.status !== 'present') throw new Error('identity_conflict: canvas is unavailable')
  const folder = relativeFileReference(canvas.root, checkedPath(canvas.root, parent.current_path)).replace(/\.canvas$/i, '')
  const kind = extname(input.sourcePath).toLowerCase() === '.zip' ? 'stillroom-zip' as const : 'stillroom-json' as const
  const stem = filename(basename(input.sourcePath, extname(input.sourcePath)))
  let name = stem
  for (let n = 2; ['.canvas', '', '.assets'].some(ext => existsIgnoringCase(join(canvas.root, folder, name + ext))); n++) name = `${stem} ${n}`
  const receipt = await imports.import({ operationId: input.operationId, kind, sourcePath: input.sourcePath, targetPath: `${folder}/${name}.canvas` })
  const nodeId = `${input.operationId}-card`
  const card = await subBoards.write({ objectId: input.objectId, handleId: input.handleId, expectedVersion: input.expectedVersion, operationId: `${input.operationId}-place`, commands: [{ type: 'addNode',
    node: { id: nodeId, type: 'file', file: receipt.path, x: Math.round(input.at.x - 130), y: Math.round(input.at.y - 98), width: 260, height: 195, ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: receipt.objectId } } } }] })
  return { receipt, nodeId, card }
}
