import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasNode, ReadyCanvas } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { stableJson } from '../../../../shared/ready-canvas/serialization'
import { CanvasHistory, type PreparedEdit } from '../../../modules/canvas/interaction/operations'
import type { CanvasSurfaceProps, GraphicDraft } from './types'

/** The input is authoritative; a local accepted buffer is not a disk-save receipt. */
export function useCanvasBuffer(props: CanvasSurfaceProps) {
  const [canvas, setCanvas] = useState(props.canvas), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const current = useRef(canvas), owner = useRef(props), history = useRef(new CanvasHistory())
  const pending = useRef<PreparedEdit | null>(null), locked = useRef(false), generation = useRef(0)
  owner.current = props
  useLayoutEffect(() => {
    if (stableJson(props.canvas) === stableJson(current.current)) return
    if (pending.current && stableJson(props.canvas) === stableJson(pending.current.after)) return
    generation.current++; history.current.clear(); current.current = props.canvas; setCanvas(props.canvas)
    setError(locked.current ? '画板已被更新，本次操作已停止；请核对最新内容后重试。' : ''); pending.current = null; locked.current = false; setBusy(false)
  }, [props.canvas])
  useLayoutEffect(() => () => { generation.current++ }, [])
  const report = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), [])
  const publish = useCallback(async (change: PreparedEdit | undefined, version: number): Promise<boolean> => {
    if (!change) return false
    pending.current = change
    await owner.current.onOperations(change.operations, { objectId: change.before.ready.id, before: change.before, after: change.after, inverse: change.inverse, direction: change.direction })
    if (generation.current !== version) return false
    history.current.accept(change); current.current = change.after; setCanvas(change.after)
    return true
  }, [])
  const run = useCallback(async (prepare: (canvas: ReadyCanvas) => PreparedEdit | undefined | Promise<PreparedEdit | undefined>): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true; setBusy(true); setError('')
    const version = generation.current, before = current.current
    try {
      const change = await prepare(before)
      if (generation.current !== version) return false
      return await publish(change, version)
    } catch (e) { if (generation.current === version) report(e); return false }
    finally { if (generation.current === version) { pending.current = null; locked.current = false; setBusy(false) } }
  }, [publish, report])
  const commit = useCallback((ops: CanvasOperation[]) => ops.length ? run(before => history.current.prepare(before, ops)) : Promise.resolve(false), [run])
  const graphic = useCallback((draft: GraphicDraft, existing?: CanvasNode) => run(async before => {
    const prepare = owner.current.prepareGraphic
    if (!prepare) throw new Error('尚未连接图形附件服务')
    const file = await prepare(draft)
    const ops: CanvasOperation[] = existing
      ? [{ type: 'geometry', id: existing.id, geometry: { x: draft.x, y: draft.y, width: draft.width, height: draft.height } }, { type: 'graphic', id: existing.id, graphic: draft.graphic, file }]
      : [{ type: 'addNode', node: { id: draft.id, type: 'file', file, x: draft.x, y: draft.y, width: draft.width, height: draft.height, ready: { kind: 'graphic', graphic: draft.graphic } } }]
    return history.current.prepare(before, ops)
  }), [run])
  return { canvas, busy, error, commit, graphic,
    undo: () => run(before => history.current.prepareUndo(before)), redo: () => run(before => history.current.prepareRedo(before)),
    canUndo: history.current.canUndo, canRedo: history.current.canRedo }
}
