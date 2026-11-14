import { useSyncExternalStore } from 'react'
import type { CanvasOpen } from '../../../main/modules/board-engine/canvas-service'
import type { CardMoveResult } from '../../../main/modules/board-engine/card-moves'
import type { CardMoveDetail } from '../../../shared/ready-canvas/card-move'

// Sub-boards as folders (M4 §9): the renderer's side of the two-board moves. Main moves the cards in one durable
// command; here are the calls, what the person is told, and the one move that ⌘Z can still take back.

type Completed = Extract<CardMoveResult, { state: 'completed' }>
export interface LastMove { operationId: string; sourceObjectId: string; targetObjectId: string; created: boolean }

let last: LastMove | null = null
const listeners = new Set<() => void>()
function setLast(next: LastMove | null) { last = next; listeners.forEach(listener => listener()) }
/** The cross-board move this board can still undo: only the two boards it touched offer it. */
export function useLastMove(objectId: string | undefined): LastMove | null {
  const move = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => last)
  return move && objectId && (move.sourceObjectId === objectId || move.targetObjectId === objectId) ? move : null
}
/** Opening a board that the last move did not touch ends the offer (M4 §9.2). */
export function leaveLastMove(objectId: string): void {
  if (last && last.sourceObjectId !== objectId && last.targetObjectId !== objectId) setLast(null)
}

function completed(result: { ok: true; value: CardMoveResult } | { ok: false; error: string }): Completed {
  if (!result.ok) throw new Error(moveError(result.error))
  const value = result.value
  if (value.state === 'completed') return value
  throw new Error(value.state === 'conflict' ? '画板刚刚有别的改动，卡片没有移动；请再试一次。' : value.state === 'recovery-required' ? `移动没有完成：${value.message}` : '画板还有未保存的修改，卡片没有移动。')
}
function moveError(message: string): string {
  if (message.includes('nothing_to_move')) return '选中的卡片不能换画板（子画板卡和草稿卡留在原处）。'
  if (message.includes('nothing_to_undo')) return '这次移动已经没有可撤销的卡片。'
  if (message.includes('name_collision')) return '同名的子画板已经存在，请再试一次。'
  return message.replace(/^Error:\s*/, '')
}

export async function moveCards(board: CanvasOpen, nodeIds: string[], target: { kind: 'existing'; objectId: string } | { kind: 'new'; path: string; title: string }): Promise<CardMoveDetail> {
  const result = completed(await window.electronAPI.canvas.moveCards({ operationId: crypto.randomUUID(), objectId: board.objectId, handleId: board.handleId, expectedVersion: board.version, nodeIds,
    target: target.kind === 'new' ? { ...target, cardId: crypto.randomUUID() } : target }))
  setLast({ operationId: result.operationId, sourceObjectId: board.objectId, targetObjectId: result.move.targetObjectId, created: target.kind === 'new' })
  return result.move
}
export async function undoMove(move: LastMove): Promise<CardMoveDetail> {
  const result = completed(await window.electronAPI.canvas.undoMove({ operationId: crypto.randomUUID(), moveOperationId: move.operationId }))
  if (last?.operationId === move.operationId) setLast(null)
  return result.move
}
/** A free name for a new sub-board in the board's own folder: 子画板, 子画板 2, … */
export async function freeSubBoardPath(root: string, boardPath: string): Promise<{ path: string; title: string }> {
  const folder = boardPath.replace(/\\/g, '/').replace(/\.canvas$/i, '')
  let title = '子画板'
  for (let n = 2; (await window.electronAPI.document.stat(`${root}/${folder}/${title}.canvas`))?.success; n++) title = `子画板 ${n}`
  return { path: `${folder}/${title}.canvas`, title }
}
/** What the toast says after a move: how many went, and what could not come along. */
export function moveSummary(move: CardMoveDetail, where: string): string {
  const left = move.skipped.filter(item => item.reason === 'subcanvas' || item.reason === 'draft').length
  return [`已把 ${move.movedNodeIds.length} 张卡片${where}`, move.droppedEdgeIds.length ? `${move.droppedEdgeIds.length} 条连到别处的连线已移除` : '', left ? `${left} 张子画板卡或草稿卡留在原处` : ''].filter(Boolean).join('，')
}

type UndoHost = (move: LastMove) => Promise<void>
const mounted = new Map<string, UndoHost>()
/** An open board takes part in undoing a move that touched it (it must not write meanwhile, and reloads after). */
export function registerUndoHost(objectId: string, host: UndoHost): () => void {
  mounted.set(objectId, host)
  return () => { if (mounted.get(objectId) === host) mounted.delete(objectId) }
}
/** Take the last cross-board move back (M4 §9.2), through an open board when one of the two is open. */
export async function undoLastMove(): Promise<boolean> {
  const move = last
  if (!move) return false
  const host = mounted.get(move.targetObjectId) ?? mounted.get(move.sourceObjectId)
  if (host) await host(move); else await undoMove(move)
  return true
}
