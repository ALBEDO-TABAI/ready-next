import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Import } from 'lucide-react'
import type { CanvasOpen } from '../../../main/modules/board-engine/canvas-service'
import type { SubBoardSummary } from '../../../main/modules/board-engine/sub-boards'
import type { CanvasNode } from '../../../shared/ready-canvas'
import type { PageNode } from '../../../shared/document-pages'
import { freeSubBoardPath, leaveLastMove, moveCards, moveSummary, registerUndoHost, undoLastMove, undoMove, useLastMove } from '../../modules/canvas/folders'
import { requestCanvasNode } from '../../modules/canvas/navigation'
import { openInCurrentTab } from '../../modules/document/ink/layout-state'
import { showToast, type MenuEntry } from '../ui'
import { SubBoardCard } from './SubBoardCard'
import type { CanvasSurfaceProps } from './surface/types'

// Sub-boards on the open board (M4 §9): what their cards show, moving the selection in and out, the one move ⌘Z
// can still take back, and bringing a Stillroom space in as a sub-board.

export function useSubBoards({ opened, parent, exclusive, report, resolveAsset }: {
  opened: CanvasOpen | null
  /** The board this one is a sub-board of. */
  parent: PageNode | undefined
  /** One Main command on this board while nothing else writes it; the board reloads after (unless told not to). */
  exclusive(work: (board: CanvasOpen) => Promise<void>, reload?: boolean): Promise<void>
  report(cause: unknown): void
  resolveAsset(path: string): string | undefined
}): { actions: NonNullable<CanvasSurfaceProps['subBoards']>; renderCard(node: CanvasNode): ReactNode | undefined; moreItems: MenuEntry[] } {
  const api = window.electronAPI, objectId = opened?.objectId
  const [summaries, setSummaries] = useState(new Map<string, SubBoardSummary>())
  const hasSubBoards = !!opened?.canvas.nodes.some(node => node.ready.kind === 'subcanvas')
  useEffect(() => {
    if (!objectId || !hasSubBoards) { setSummaries(new Map()); return }
    let stale = false
    const load = () => { void api.canvas.subBoards(objectId).then(result => { if (!stale && result.ok) setSummaries(new Map(result.value.map(item => [item.nodeId, item]))) }).catch(report) }
    load()
    // A sub-board edited elsewhere, or sent to and brought back from the library bin, changes what its card says.
    const offCanvas = api.canvas.onChanged(load), offPages = api.documentPages.onChanged(load)
    return () => { stale = true; offCanvas(); offPages() }
  }, [api, objectId, opened?.version, hasSubBoards]) // eslint-disable-line react-hooks/exhaustive-deps -- report is the host's stable error sink
  useEffect(() => { if (objectId) leaveLastMove(objectId) }, [objectId])
  const last = useLastMove(objectId)
  const run = useCallback((work: () => Promise<void>) => { void work().catch(report) }, [report])
  useEffect(() => objectId ? registerUndoHost(objectId, async move => {
    // Undoing 收进子画板 from inside the new sub-board removes that board: go back to its parent instead of reloading it.
    const leaving = move.created && move.targetObjectId === objectId && parent
    await exclusive(async () => { await undoMove(move) }, !leaving)
    if (leaving) openInCurrentTab(parent.path)
  }) : undefined) // No dependency list: re-registered every render, so the host closes over the latest board state.
  const undoNow = () => run(async () => { if (await undoLastMove()) showToast('已撤销移动') })
  const undo = last ? undoNow : undefined
  const moved = (text: string) => showToast(text, { durationMs: 8000, actions: [{ label: '撤销', onClick: undoNow }] })
  const actions: NonNullable<CanvasSurfaceProps['subBoards']> = {
    collect: nodeIds => run(async () => {
      let text = ''
      await exclusive(async board => {
        const target = await freeSubBoardPath(await vaultRoot(), board.path)
        text = moveSummary(await moveCards(board, nodeIds, { kind: 'new', ...target }), `收进「${target.title}」`)
      })
      moved(text)
    }),
    moveInto: (nodeIds, target) => run(async () => {
      const childId = target.ready.ref?.kind === 'canvas' ? target.ready.ref.id : undefined
      if (!childId) return
      let text = ''
      await exclusive(async board => { text = moveSummary(await moveCards(board, nodeIds, { kind: 'existing', objectId: childId }), `移入「${summaries.get(target.id)?.title || '子画板'}」`) })
      moved(text)
    }),
    ...(parent ? {
      moveOut: nodeIds => run(async () => {
        let text = '', first: string | undefined
        await exclusive(async board => { const move = await moveCards(board, nodeIds, { kind: 'existing', objectId: parent.objectId }); text = moveSummary(move, `移出到「${parent.title}」`); first = move.movedNodeIds[0] }, false)
        // Follow the cards to the parent board and show where they landed.
        openInCurrentTab(parent.path); requestCanvasNode(parent.objectId, first)
        moved(text)
      }),
      openParent: () => openInCurrentTab(parent.path),
    } : {}),
    ...(undo ? { undo } : {}),
  }
  const importStillroom = () => run(async () => {
    let placed: { objectId: string; nodeId: string } | undefined
    await exclusive(async board => {
      const cards = board.canvas.nodes.filter(node => !node.ready.trash)
      // Below what the board already holds, so the new card covers nothing.
      const at = cards.length ? { x: Math.min(...cards.map(node => node.x)) + 130, y: Math.max(...cards.map(node => node.y + node.height)) + 146 } : { x: 130, y: 98 }
      const result = await api.canvas.importStillroom({ operationId: crypto.randomUUID(), objectId: board.objectId, handleId: board.handleId, expectedVersion: board.version, at })
      if (!result.ok) throw new Error(result.error.replace(/^Error:\s*/, ''))
      if (!result.value) return
      const { receipt, card, nodeId } = result.value, name = receipt.path.split('/').pop()!.replace(/\.canvas$/i, '')
      if (card.state !== 'completed') throw new Error(`已导入为 ${receipt.path}，但没能在这个画板上放卡片；可以从侧栏打开它。`)
      placed = { objectId: board.objectId, nodeId }
      showToast(receipt.status === 'complete' ? `已导入 Stillroom 空间「${name}」` : `已导入「${name}」，有 ${receipt.incomplete.length} 项内容不完整（自动保存文件不带媒体，完整导入请用空间 ZIP）`, { durationMs: receipt.status === 'complete' ? 4000 : 10000 })
    })
    // The board has reloaded: show the new card, once the surface has taken the reloaded content in.
    if (placed) { await new Promise(resolve => setTimeout(resolve, 60)); requestCanvasNode(placed.objectId, placed.nodeId) }
  })
  return {
    actions, moreItems: [{ id: 'import-stillroom', label: '导入 Stillroom 空间…', icon: <Import />, onSelect: importStillroom }],
    renderCard: node => node.ready.kind === 'subcanvas' ? <SubBoardCard node={node} summary={summaries.get(node.id)} resolveAsset={resolveAsset} /> : undefined,
  }
}

async function vaultRoot(): Promise<string> {
  const state = await window.electronAPI.vault.get()
  if (state.status !== 'ready') throw new Error('请先配置资料库')
  return state.root
}
