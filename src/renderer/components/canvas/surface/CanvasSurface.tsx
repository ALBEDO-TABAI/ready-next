import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import { activeCanvasContent } from '../../../../shared/ready-canvas/operations'
import { CanvasGestures, edgePath, type GestureScene } from '../../../modules/canvas/interaction/gestures'
import { SpatialIndex, clusters, expand, layout, screenToWorld, zoomAt, type Camera } from '../../../modules/canvas/interaction/geometry'
import { groupOperations, layerOperations, ungroupOperations } from '../../../modules/canvas/interaction/operations'
import { visualBounds } from '../../../modules/canvas/interaction/graphics'
import { silhouettePath } from '../../../modules/canvas/interaction/outline'
import { CanvasCard } from './CanvasCard'
import { useCanvasBuffer } from './useCanvasBuffer'
import type { CanvasSurfaceProps, Tool } from './types'
import { CanvasEditorLifecycle } from './editor-lifecycle'

export function CanvasSurface(props: CanvasSurfaceProps) {
  const buffer = useCanvasBuffer(props), { canvas, busy, commit } = buffer
  const [selected, setSelected] = useState<string[]>([]), [tool, setTool] = useState<Tool>('select'), [trash, setTrash] = useState(false)
  const finishEditor = useRef<(() => Promise<void>) | null>(null), exiting = useRef(false)
  const [editorError, setEditorError] = useState(''), [closing, setClosing] = useState(false)
  const registerFinish = useCallback((finish: () => Promise<void>) => {
    finishEditor.current = finish
    return () => { if (finishEditor.current === finish) finishEditor.current = null }
  }, [])
  const [editing, setEditing] = useState<string | null>(null), [camera, setCamera] = useState<Camera>(props.initialCamera ?? { x: 40, y: 80, zoom: 1 })
  const [size, setSize] = useState({ width: 1000, height: 700 })
  useEffect(() => {
    const node = canvas.nodes.find(node => node.id === props.revealNode?.nodeId && !node.ready.trash)
    if (!node) return
    setSelected([node.id]); setCamera({ x: size.width / 2 - node.x - node.width / 2, y: size.height / 2 - node.y - node.height / 2, zoom: 1 })
  }, [props.revealNode?.requestId, size.width, size.height]) // eslint-disable-line react-hooks/exhaustive-deps -- a navigation request runs once; editing must not recenter

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [composing, setComposing] = useState(false), [compositionError, setCompositionError] = useState('')
  const root = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), overlay = useRef<SVGSVGElement>(null)
  const elements = useRef(new Map<string, HTMLElement>()), edgeElements = useRef<GestureScene['edgeElements']>(new Map())
  const latest = useRef({ buffer, props }), scene = useRef<GestureScene | null>(null)
  latest.current = { buffer, props }
  const gestures = useMemo(() => new CanvasGestures({ scene: () => scene.current, select: setSelected, camera: setCamera,
    commit: ops => latest.current.buffer.commit(ops), graphic: (draft, node) => latest.current.buffer.graphic(draft, node), measure: work => latest.current.props.onFrameWork?.(work) }), [])
  const active = useMemo(() => activeCanvasContent(canvas), [canvas])
  const byId = useMemo(() => new Map(active.nodes.map(n => [n.id, n])), [active])
  const index = useMemo(() => new SpatialIndex(active.nodes.map(n => ({ ...n, ...visualBounds(n) }))), [active])
  const children = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const n of active.nodes) if (n.ready.groupId) { const ids = result.get(n.ready.groupId) ?? []; ids.push(n.id); result.set(n.ready.groupId, ids) }
    return result
  }, [active])
  const viewport = useMemo(() => ({ ...screenToWorld({ x: 0, y: 0 }, camera), width: size.width / camera.zoom, height: size.height / camera.zoom }), [camera, size])
  const visible = useMemo(() => index.query(expand(viewport, 80 / camera.zoom)), [index, viewport, camera.zoom])
  const visibleIds = useMemo(() => new Set(visible.map(n => n.id)), [visible])
  const outlines = useMemo(() => clusters(visible.filter(n => n.type !== 'group')).filter(c => c.length > 1).map(c => ({ id: c[0].id, d: silhouettePath(c) })), [visible])
  const chosen = selected.flatMap(id => { const n = byId.get(id); return n ? [n] : [] })
  const marker = `canvas-arrow-${useId().replace(/:/g, '')}`
  const bindElement = useCallback((id: string, el: HTMLDivElement | null) => { if (el) elements.current.set(id, el); else elements.current.delete(id) }, [])
  const open = useCallback((node: CanvasNode) => {
    if (scene.current?.busy) return
    setEditorError('')
    if (node.ready.kind === 'subcanvas') latest.current.props.onNavigateSubcanvas?.(node)
    else if (node.type === 'text' && node.ready.kind !== 'draft' && latest.current.props.renderTextEditor) setEditing(node.id)
    else latest.current.props.onOpenNode?.(node)
  }, [])
  useLayoutEffect(() => {
    if (root.current && world.current && overlay.current) scene.current = { root: root.current, world: world.current, overlay: overlay.current, camera, viewport, index, byId, elements: elements.current, selected, tool, busy: busy || trash || !!editing, children, edgeElements: edgeElements.current }
  })
  useLayoutEffect(() => {
    gestures.cancel(); setEditing(null); setSelected([])
  }, [props.canvas.ready.id, gestures])
  // Authoritative replacement invalidates an in-flight gesture, even on the same object.
  useLayoutEffect(() => { gestures.cancel() }, [props.canvas, gestures])
  useEffect(() => {
    const el = root.current!, view = el.ownerDocument.defaultView!
    const wheel = (e: WheelEvent) => gestures.wheel(e), cancel = () => gestures.cancel()
    el.addEventListener('wheel', wheel, { passive: false }); view.addEventListener('blur', cancel)
    const resize = () => setSize({ width: el.clientWidth || 1000, height: el.clientHeight || 700 })
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(el)
    return () => { el.removeEventListener('wheel', wheel); view.removeEventListener('blur', cancel); observer?.disconnect(); gestures.dispose(); scene.current = null }
  }, [gestures])
  async function closeEditor() {
    if (exiting.current) return
    const boardId = props.canvas.ready.id
    exiting.current = true; setClosing(true); setEditorError('')
    try {
      await finishEditor.current?.()
      if (latest.current.props.canvas.ready.id === boardId) setEditing(current => current === editing ? null : current)
    } catch (error) {
      if (latest.current.props.canvas.ready.id === boardId) setEditorError(error instanceof Error ? error.message : String(error))
    } finally { exiting.current = false; setClosing(false) }
  }
  function recycle() {
    if (!chosen.length) return
    void commit([{ type: 'trash', ids: chosen.map(n => n.id), trash: { operationId: crypto.randomUUID(), deletedAt: new Date().toISOString() } }])
  }
  function arrange(kind: 'P' | 'L' | 'R') { void commit(layout(chosen, kind, 24, Math.floor(Math.random() * 4294967296))) }
  function shortcut(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target instanceof Element ? e.target : null
    if (!root.current?.contains(root.current.ownerDocument.activeElement) || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],button,[data-canvas-ui]') || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); gestures.cancel(); setEditing(null); setTool('select'); return }
    if (busy || trash || editing) return
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
    if (e.key === ' ') { e.preventDefault(); gestures.space = true }
    else if (mod && key === 'a') { e.preventDefault(); setSelected(active.nodes.map(n => n.id)) }
    else if (mod && key === 'z') { e.preventDefault(); void (e.shiftKey ? buffer.redo() : buffer.undo()) }
    else if (mod && key === 'g') { e.preventDefault(); void commit(e.shiftKey ? ungroupOperations(canvas, selected) : groupOperations(chosen, crypto.randomUUID())) }
    else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); recycle() }
    else if (!mod && ['p', 'l', 'r'].includes(key)) { e.preventDefault(); arrange(key.toUpperCase() as 'P' | 'L' | 'R') }
    else if (!mod && (e.key === '+' || e.key === '=' || e.key === '-')) { e.preventDefault(); setCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.zoom * (e.key === '-' ? 0.8 : 1.25))) }
  }
  const tools: Array<[Tool, string]> = [['select', '选择'], ['pan', '平移'], ['rect', '矩形'], ['arrow', '箭头'], ['edge', '连线'], ['path', '手绘']]
  const recycled = canvas.nodes.filter(n => n.ready.trash)
  async function addToDocument() {
    if (composing || !props.onAddToDocument) return
    setComposing(true); setCompositionError('')
    try { await props.onAddToDocument(chosen.map(n => n.id)); setMenu(null) }
    catch (error) { setCompositionError(error instanceof Error ? error.message : String(error)) }
    finally { setComposing(false) }
  }
  return <div className="rn-canvas" data-canvas-surface tabIndex={0} ref={root} aria-label={canvas.ready.title || '画板'}
    onContextMenu={event => {
      if (!props.onAddToDocument || busy || trash || editing || !chosen.length || (event.target instanceof Element && event.target.closest('[data-canvas-ui]'))) return
      event.preventDefault(); gestures.cancel()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    }}
    onKeyDown={shortcut} onKeyUp={e => { if (e.key === ' ') gestures.space = false }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) gestures.cancel() }}
    onPointerDown={e => gestures.down(e.nativeEvent)} onPointerMove={e => gestures.move(e.nativeEvent)} onPointerUp={e => gestures.up(e.nativeEvent)}
    onPointerCancel={() => gestures.cancel()} onLostPointerCapture={() => gestures.cancel()}
    onDoubleClick={e => {
      // A drag gesture captures the pointer on the root, so the browser retargets the double-click to the root:
      // find the card under the pointer instead of relying on the card's own handler.
      const hit = e.target instanceof Element && e.target !== e.currentTarget ? e.target : document.elementFromPoint(e.clientX, e.clientY)
      const card = hit?.closest<HTMLElement>('[data-node-id]'), node = card?.dataset.nodeId ? byId.get(card.dataset.nodeId) : undefined
      if (node && !hit?.closest('[data-canvas-ui]')) open(node)
    }}>
    <div className="canvas-toolbar" data-canvas-ui>
      <nav aria-label="画板路径">{props.breadcrumbs?.map(b => <button key={b.id} onClick={() => props.onNavigateAncestor?.(b.id)} disabled={!props.onNavigateAncestor || busy}>{b.title} /</button>)}<strong>{canvas.ready.title || '画板'}</strong></nav>
      <div role="toolbar" aria-label="画板工具">
        {tools.map(([value, label]) => <button key={value} disabled={busy || trash || !!editing || (['rect', 'arrow', 'path'].includes(value) && !props.prepareGraphic)} aria-pressed={tool === value} onClick={() => { gestures.cancel(); setTool(value); root.current?.focus() }}>{label}</button>)}
        <button disabled={busy || !buffer.canUndo} onClick={() => void buffer.undo()}>撤销</button><button disabled={busy || !buffer.canRedo} onClick={() => void buffer.redo()}>重做</button>
        <button disabled={busy || !!editing} aria-pressed={trash} onClick={() => { gestures.cancel(); setEditing(null); setTrash(!trash) }}>回收站</button>
      </div>
      {!trash && <div role="toolbar" aria-label="选区操作">
        <button disabled={busy || chosen.length < 2} onClick={() => void commit(groupOperations(chosen, crypto.randomUUID()))}>分组</button>
        <button disabled={busy || !chosen.some(n => n.ready.groupId || n.type === 'group')} onClick={() => void commit(ungroupOperations(canvas, selected))}>解组</button>
        {(['P', 'L', 'R'] as const).map(k => <button key={k} title={{ P: '画廊排版', L: '瀑布排版', R: '散开排版' }[k]} disabled={busy || chosen.length < 2} onClick={() => arrange(k)}>{k}</button>)}
        <button disabled={busy || !chosen.length} onClick={() => void commit(layerOperations(canvas, selected, 'front'))}>置顶</button><button disabled={busy || !chosen.length} onClick={() => void commit(layerOperations(canvas, selected, 'back'))}>置底</button>
        <button disabled={busy || !chosen.length} onClick={recycle}>回收</button>
        <button onClick={() => setCamera(c => zoomAt(c, { x: size.width / 2, y: size.height / 2 }, c.zoom / 1.25))}>−</button>
        <output aria-label="缩放比例">{Math.round(camera.zoom * 100)}%</output>
        <button onClick={() => setCamera(c => zoomAt(c, { x: size.width / 2, y: size.height / 2 }, c.zoom * 1.25))}>＋</button>
      </div>}
    </div>
    {buffer.error && <div className="canvas-message" role="alert" data-canvas-ui>{buffer.error}</div>}
    {menu && <div role="menu" aria-label="选区菜单" data-canvas-ui style={{ position: 'absolute', left: menu.x, top: menu.y, zIndex: 5, background: 'var(--bg-primary)', padding: 8 }}>
      <button role="menuitem" disabled={composing || busy} onClick={() => void addToDocument()}>{composing ? '正在添加…' : '添加到文档'}</button>
      <button disabled={composing} onClick={() => setMenu(null)}>关闭</button>
      {compositionError && <p role="alert">{compositionError}</p>}
    </div>}
    {busy && <div className="canvas-message" role="status">正在处理…</div>}
    {trash ? <section className="canvas-trash" data-canvas-ui aria-label="回收的卡片">
      <h2>回收站 · {recycled.length}</h2><button disabled={busy || !recycled.length} onClick={() => void commit([{ type: 'restore', ids: recycled.map(n => n.id) }])}>全部恢复</button>
      {recycled.map(n => <article key={n.id}><span>{n.type === 'text' ? n.text : n.type === 'link' ? n.url : n.type === 'group' ? n.label : n.file}</span><button disabled={busy} onClick={() => void commit([{ type: 'restore', ids: [n.id] }])}>恢复 {n.id}</button></article>)}
    </section> : <div className="canvas-world" ref={world} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
      <svg className="canvas-clusters" aria-hidden="true">{outlines.map(o => <path key={o.id} d={o.d} />)}</svg>
      <svg className="canvas-edges" aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>
        {active.edges.map(e => { const from = byId.get(e.fromNode)!, to = byId.get(e.toNode)!; return <g key={e.id}>
          <path ref={el => { if (el) edgeElements.current.set(e.id, { element: el, from, to, edge: e }); else edgeElements.current.delete(e.id) }} d={edgePath(from, to, e)} markerStart={e.fromEnd === 'arrow' ? `url(#${marker})` : undefined} markerEnd={e.toEnd !== 'none' ? `url(#${marker})` : undefined} />
          {e.label && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2}>{e.label}</text>}
        </g> })}
      </svg>
      {active.nodes.map(node => <CanvasCard key={node.id} node={node} selected={selected.includes(node.id)} visible={visibleIds.has(node.id)} element={bindElement} resolveAsset={props.resolveAsset}
        content={visibleIds.has(node.id) ? props.renderCard?.(node) : undefined}
        editor={editing === node.id ? <CanvasEditorLifecycle.Provider value={registerFinish}><div data-canvas-ui className="canvas-editor">
          <div inert={closing}>{props.renderTextEditor?.({ node, commit, close: () => { void closeEditor() } })}</div>
          {editorError && <p role="alert">{editorError}</p>}
          <button disabled={closing} onClick={() => void closeEditor()}>{closing ? '正在完成…' : '完成编辑'}</button>
        </div></CanvasEditorLifecycle.Provider> : undefined} />)}
      <svg className="canvas-overlay" ref={overlay} data-arrow-marker={marker} aria-hidden="true" />
    </div>}
    <div className="canvas-hint" aria-live="polite">{selected.length} 已选 · 空格拖动画布 · Shift 多选 · P / L / R 排版</div>
  </div>
}
