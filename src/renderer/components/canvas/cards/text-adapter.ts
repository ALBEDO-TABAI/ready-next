import type { CanvasNode, CanvasOperation } from '../../../../shared/ready-canvas'
import { fragmentHash } from '../../../../shared/document-blocks/positions'
import { replaceRanges, type BlockEdit, type DocumentSelection } from '../../../../shared/document-blocks'

/** M3's public range command, translated to B's node-scoped operation without copying editor/history code. */
export function cardTextEdit(node: CanvasNode, bodyVersion: number, edit: BlockEdit): {
  operation: CanvasOperation; selection: DocumentSelection
} {
  if (node.type !== 'text' || node.ready.kind === 'draft') throw new Error('此卡片不是可编辑正文')
  replaceRanges(node.text, edit.operation, bodyVersion)
  return { operation: { type: 'textRanges', id: node.id, expectedTextVersion: fragmentHash(node.text), ranges: edit.operation.ranges }, selection: edit.selectionAfter }
}
