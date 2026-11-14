import { FolderInput, FolderOutput } from 'lucide-react'
import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { MenuEntry } from '../../ui'
import type { CanvasSurfaceProps } from './types'

// 收进子画板 / 移出到上一级 for the selection (M4 §9): the right-click menu's entries and the selection bar's actions.
// Sub-board cards and draft cards do not change boards, so they do not count.

type Actions = CanvasSurfaceProps['subBoards']
const movable = (chosen: CanvasNode[]) => chosen.filter(node => node.ready.kind !== 'subcanvas' && node.ready.kind !== 'draft').map(node => node.id)

export function subBoardBarActions(actions: Actions, chosen: CanvasNode[]): { collect?(): void; moveOut?(): void } {
  const ids = movable(chosen)
  if (!ids.length) return {}
  return { ...(actions?.collect ? { collect: () => actions.collect!(ids) } : {}), ...(actions?.moveOut ? { moveOut: () => actions.moveOut!(ids) } : {}) }
}
export function subBoardItems(actions: Actions, chosen: CanvasNode[], disabled: boolean): MenuEntry[] {
  const bar = subBoardBarActions(actions, chosen)
  return [
    ...(actions?.collect ? [{ id: 'collect', label: '收进子画板', icon: <FolderInput />, disabled: disabled || !bar.collect, onSelect: () => bar.collect?.() }] : []),
    ...(actions?.moveOut ? [{ id: 'move-out', label: '移出到上一级', icon: <FolderOutput />, disabled: disabled || !bar.moveOut, onSelect: () => bar.moveOut?.() }] : []),
  ]
}
