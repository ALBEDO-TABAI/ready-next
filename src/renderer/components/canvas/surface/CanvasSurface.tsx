import { readEventTransfer, READY_REF_MIME } from '../../../modules/calendar/linkage/transfer'
import { eventCard } from '../../../../shared/calendar-linkage'
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
import { CanvasCorner, CanvasCrumbs, CanvasDock, ChromeMenu, MenuItem, SelectionBar } from './CanvasChrome'
import { cardFrame } from '../../../modules/canvas/interaction/graphics'
import { useBoardCommands } from '../../../modules/canvas/board-commands'
import { CalendarPlus, ClipboardPaste, FileDown, FilePlus2, ImageDown, Sparkles, StickyNote, Trash2, Type } from 'lucide-react'

const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'pan', b: 'rect', a: 'arrow', c: 'edge', d: 'path' }

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

  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'card' | 'canvas'; world: { x: number; y: number } } | null>(null)
  const [lastShape, setLastShape] = useState<Tool>('rect'), [shapesOpen, setShapesOpen] = useState(false), [arrangeOpen, setArrangeOpen] = useState(false)
  const [search, setSearch] = useState<string | null>(null), [hit, setHit] = useState(-1)
  const [moreOpen, setMoreOpen] = useState(false), [capturing, setCapturing] = useState(false)
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
    else if (mod && key === 'f') { e.preventDefault(); setSearch(current => current ?? '') }
    else if (!mod && e.shiftKey && e.key === '!') { e.preventDefault(); fit() }
    else if (!mod && !e.shiftKey && TOOL_KEYS[key]) { e.preventDefault(); chooseTool(TOOL_KEYS[key]) }
    else if (!mod && !e.shiftKey && (key === 't' || key === 'n')) { e.preventDefault(); placeCard(key === 't' ? 'text' : 'note') }
    else if (!mod && (e.key === '+' || e.key === '=' || e.key === '-')) { e.preventDefault(); setCamera(zoomAt(camera, { x: size.width / 2, y: size.height / 2 }, camera.zoom * (e.key === '-' ? 0.8 : 1.25))) }
  }
  function chooseTool(next: Tool) {
    if (['rect', 'arrow', 'path'].includes(next) && !props.prepareGraphic) return
    gestures.cancel(); setTool(next); if (['rect', 'arrow', 'edge'].includes(next)) setLastShape(next)
  }
  /** 文字卡 and 便签: a new card where you are looking (or where you right-clicked), opened for writing. */
  function placeCard(kind: 'text' | 'note', at?: { x: number; y: number }) {
    if (busy || trash || editing) return
    const point = at ?? screenToWorld({ x: size.width / 2, y: size.height / 2 }, camera)
    const node = { id: crypto.randomUUID(), x: Math.round(point.x - 130), y: Math.round(point.y - 40), width: 260, height: 120, type: 'text' as const, text: '',
      ...(kind === 'note' ? { color: '3' } : {}), ready: { kind } }
    void commit([{ type: 'addNode', node }]).then(ok => { if (ok) { setSelected([node.id]); if (props.renderTextEditor) setEditing(node.id) } })
  }
  /** Fit every card in view (at most 100%), as the corner's 适应内容 and ⇧1 do; with cards given, fit those. */
  function fit(nodes: CanvasNode[] = active.nodes, margin = { x: 160, y: 220 }) {
    if (!nodes.length) { setCamera({ x: 40, y: 80, zoom: 1 }); return }
    const frames = nodes.map(cardFrame)
    const minX = Math.min(...frames.map(f => f.x)), minY = Math.min(...frames.map(f => f.y))
    const maxX = Math.max(...frames.map(f => f.x + f.width)), maxY = Math.max(...frames.map(f => f.y + f.height))
    const zoom = Math.max(0.05, Math.min(1, (size.width - margin.x) / Math.max(1, maxX - minX), (size.height - margin.y) / Math.max(1, maxY - minY)))
    setCamera({ zoom, x: size.width / 2 - (minX + maxX) / 2 * zoom, y: size.height / 2 - (minY + maxY) / 2 * zoom + (margin.y > margin.x ? 20 : 0) })
  }
  /** 导出 PNG: frame the chosen cards (or all), hide the chrome and the selection, let Main capture the stage, put everything back. */
  async function exportPng() {
    if (!props.captureImage || !root.current) return
    const before = camera, keep = selected
    setMoreOpen(false); setCapturing(true); setSelected([]); fit(chosen.length ? chosen : active.nodes, { x: 64, y: 64 })
    try {
      // A timer, not animation frames: a hidden or throttled window may never paint one, and the camera must settle first.
      await new Promise(resolve => setTimeout(resolve, 120))
      const rect = root.current.getBoundingClientRect()
      await props.captureImage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, canvas.ready.title || '画板')
    } catch (cause) { setCompositionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setCapturing(false); setCamera(before); setSelected(keep) }
  }
  const exportItems = props.onExport || props.captureImage ? <>
    {props.captureImage && <MenuItem label={chosen.length ? '把选中的卡片导出为 PNG' : '导出为 PNG'} icon={ImageDown} onSelect={() => void exportPng()} />}
    {props.onExport && <MenuItem label={chosen.length ? '把选中的卡片导出为 Markdown' : '导出为 Markdown'} icon={FileDown} onSelect={() => { setMoreOpen(false); void props.onExport!('md', selected).catch(cause => setCompositionError(String(cause))) }} />}
    {props.onExport && <MenuItem label={chosen.length ? '把选中的卡片导出为 PDF' : '导出为 PDF'} icon={FileDown} onSelect={() => { setMoreOpen(false); void props.onExport!('pdf', selected).catch(cause => setCompositionError(String(cause))) }} />}
  </> : undefined
  const commands = useBoardCommands({ text: () => placeCard('text'), note: () => placeCard('note'), fit: () => fit(),
    zoom100: () => setCamera(c => zoomAt(c, { x: size.width / 2, y: size.height / 2 }, 1)), search: () => setSearch(current => current ?? ''),
    bin: () => { gestures.cancel(); setEditing(null); setSearch(null); setTrash(true) } })
  const needle = search?.trim().toLocaleLowerCase() ?? ''
  const matches = needle ? active.nodes.filter(node => [node.type === 'text' ? node.text : '', node.type === 'link' ? node.url : '', node.type === 'group' ? node.label ?? '' : '',
    node.type === 'file' ? node.file : '', node.ready.preview?.title ?? '', node.ready.preview?.description ?? ''].some(text => text.toLocaleLowerCase().includes(needle))) : []
  const matchIds = new Set(matches.map(node => node.id))
  function step(delta: 1 | -1) {
    if (!matches.length) return
    // The first step goes to the first match, either way.
    const next = hit < 0 ? (delta > 0 ? 0 : matches.length - 1) : (Math.min(hit, matches.length - 1) + delta + matches.length) % matches.length, node = matches[next], frame = cardFrame(node)
    setHit(next); setSelected([node.id])
    setCamera(c => ({ ...c, x: size.width / 2 - (frame.x + frame.width / 2) * c.zoom, y: size.height / 2 - (frame.y + frame.height / 2) * c.zoom }))
  }
  const selectionBox = chosen.length && !editing && !trash && !menu && !capturing ? (() => {
    const frames = chosen.map(cardFrame)
    const left = Math.min(...frames.map(f => f.x)) * camera.zoom + camera.x, right = Math.max(...frames.map(f => f.x + f.width)) * camera.zoom + camera.x
    const top = Math.min(...frames.map(f => f.y)) * camera.zoom + camera.y
    return { left: Math.max(180, Math.min(size.width - 180, (left + right) / 2)), top: Math.max(68, top - 52) }
  })() : null
  const schedulable = props.onScheduleNode && chosen.length === 1 && ['text', 'note', 'document'].includes(chosen[0].ready.kind)
  async function paste(at: { x: number; y: number }) {
    const text = (await navigator.clipboard?.readText?.())?.trim()
    if (!text) throw new Error('剪贴板里没有文字或链接')
    const frame = { id: crypto.randomUUID(), x: Math.round(at.x - 130), y: Math.round(at.y - 40), width: 260, height: /^https?:\/\/\S+$/i.test(text) ? 195 : 120 }
    await commit([{ type: 'addNode', node: /^https?:\/\/\S+$/i.test(text) ? { ...frame, type: 'link', url: text, ready: { kind: 'link' } } : { ...frame, type: 'text', text, ready: { kind: 'text' } } }])
  }
  const recycled = canvas.nodes.filter(n => n.ready.trash)
  async function addToDocument() {
    if (composing || !props.onAddToDocument) return
    setComposing(true); setCompositionError('')
    try { await props.onAddToDocument(chosen.map(n => n.id)); setMenu(null) }
    catch (error) { setCompositionError(error instanceof Error ? error.message : String(error)) }
    finally { setComposing(false) }
  }
  return <div className="rn-canvas" data-canvas-surface data-capturing={capturing || undefined} tabIndex={0} ref={root} aria-label={canvas.ready.title || '画板'}
    onDragOver={event => { if (event.dataTransfer.types.includes(READY_REF_MIME) || props.acceptsDrop?.(event.dataTransfer.types)) { event.preventDefault(); event.stopPropagation() } }}
    onDrop={event => {
      try {
        if (props.onDropData && !busy && !trash && !editing) {
          const rect = event.currentTarget.getBoundingClientRect(), at = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, camera)
          if (props.onDropData(event.dataTransfer, { x: Math.round(at.x), y: Math.round(at.y) })) { event.preventDefault(); event.stopPropagation(); return }
        }
        const dropped = readEventTransfer(event.dataTransfer)
        if (!dropped) return
        event.preventDefault(); event.stopPropagation()
        if (busy || trash || editing) throw new Error('请先完成当前编辑')
        const rect = event.currentTarget.getBoundingClientRect(), point = screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, camera)
        void commit([{ type: 'addNode', node: eventCard(dropped.ref, { id: crypto.randomUUID(), x: Math.round(point.x), y: Math.round(point.y) }) }])
      } catch (cause) { setCompositionError(String(cause)) }
    }}
    onContextMenu={event => {
      if (busy || trash || editing || (event.target instanceof Element && event.target.closest('[data-canvas-ui]'))) return
      event.preventDefault(); gestures.cancel()
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-node-id]') : null
      if (card?.dataset.nodeId && !selected.includes(card.dataset.nodeId)) setSelected([card.dataset.nodeId])
      if (!card) setSelected([])
      const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
      setMenu({ x, y, kind: card ? 'card' : 'canvas', world: screenToWorld({ x, y }, camera) })
    }}
    onKeyDown={shortcut} onKeyUp={e => { if (e.key === ' ') gestures.space = false }}
    onFocus={() => commands.focus()} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) gestures.cancel() }}
    onPointerDown={e => gestures.down(e.nativeEvent)} onPointerMove={e => gestures.move(e.nativeEvent)} onPointerUp={e => gestures.up(e.nativeEvent)}
    onPointerCancel={() => gestures.cancel()} onLostPointerCapture={() => gestures.cancel()}
    onDoubleClick={e => {
      // A drag gesture captures the pointer on the root, so the browser retargets the double-click to the root:
      // find the card under the pointer instead of relying on the card's own handler.
      const hit = e.target instanceof Element && e.target !== e.currentTarget ? e.target : document.elementFromPoint(e.clientX, e.clientY)
      const card = hit?.closest<HTMLElement>('[data-node-id]'), node = card?.dataset.nodeId ? byId.get(card.dataset.nodeId) : undefined
      if (node && !hit?.closest('[data-canvas-ui]')) open(node)
    }}>
    {!capturing && <CanvasCrumbs title={canvas.ready.title || '画板'} breadcrumbs={props.breadcrumbs} busy={busy} onNavigate={props.onNavigateAncestor} />}
    {!capturing && <CanvasCorner zoom={camera.zoom} moreOpen={moreOpen} more={exportItems} onMore={setMoreOpen} search={search} results={matches.length} hit={Math.min(hit, matches.length - 1)} recycled={recycled.length} trash={trash} busy={busy || !!editing}
      onSearch={value => { setSearch(value); setHit(-1) }} onStep={step} onFit={() => fit()}
      onZoomReset={() => setCamera(c => zoomAt(c, { x: size.width / 2, y: size.height / 2 }, 1))}
      onTrash={() => { gestures.cancel(); setEditing(null); setSearch(null); setTrash(!trash) }} />}
    {!trash && !capturing && <CanvasDock tool={tool} lastShape={lastShape} shapesOpen={shapesOpen} disabled={busy || !!editing} graphics={!!props.prepareGraphic}
      canUndo={buffer.canUndo} canRedo={buffer.canRedo} busy={busy} onTool={chooseTool} onShapes={setShapesOpen} onCard={kind => placeCard(kind)}
      onUndo={() => void buffer.undo()} onRedo={() => void buffer.redo()} />}
    {selectionBox && <SelectionBar left={selectionBox.left} top={selectionBox.top} count={chosen.length} busy={busy || composing}
      canGroup={chosen.length > 1} canUngroup={chosen.some(n => n.ready.groupId || n.type === 'group')} arrangeOpen={arrangeOpen}
      actions={{
        group: () => void commit(groupOperations(chosen, crypto.randomUUID())), ungroup: () => void commit(ungroupOperations(canvas, selected)),
        arrange: setArrangeOpen, layout: arrange, front: () => void commit(layerOperations(canvas, selected, 'front')), back: () => void commit(layerOperations(canvas, selected, 'back')),
        remove: recycle,
        addToDocument: props.onAddToDocument ? () => void addToDocument() : undefined,
        askAI: props.onAskAI ? () => { void props.onAskAI!(chosen.map(n => n.id)).catch(cause => setCompositionError(cause instanceof Error ? cause.message : String(cause))) } : undefined,
        schedule: schedulable ? () => props.onScheduleNode!(chosen[0]) : undefined,
      }} />}
    {compositionError && !menu && <p role="alert" data-canvas-ui>{compositionError}</p>}
    {buffer.error && <div className="canvas-message" role="alert" data-canvas-ui>{buffer.error}</div>}
    {menu && <div className="canvas-context" data-canvas-ui style={{ left: menu.x, top: menu.y }}>
      <ChromeMenu label={menu.kind === 'card' ? '选区菜单' : '新建'} onClose={() => { setMenu(null); setCompositionError('') }}>
        {menu.kind === 'card' ? <>
          {props.onAddToDocument && <MenuItem label={composing ? '正在添加…' : '添加到文档'} icon={FilePlus2} disabled={composing || busy} onSelect={() => void addToDocument()} />}
          {props.onAskAI && chosen.length > 0 && <MenuItem label="问 AI" icon={Sparkles} disabled={busy || composing} onSelect={() => {
            void props.onAskAI!(chosen.map(n => n.id)).then(() => setMenu(null), cause => setCompositionError(cause instanceof Error ? cause.message : String(cause)))
          }} />}
          {schedulable && <MenuItem label="安排日程…" icon={CalendarPlus} disabled={busy || composing} onSelect={() => { props.onScheduleNode!(chosen[0]); setMenu(null) }} />}
          <MenuItem label="删除" icon={Trash2} shortcut="Delete" danger disabled={busy || composing} onSelect={() => { recycle(); setMenu(null) }} />
        </> : <>
          <MenuItem label="文字卡" icon={Type} shortcut="T" onSelect={() => { placeCard('text', menu.world); setMenu(null) }} />
          <MenuItem label="便签" icon={StickyNote} shortcut="N" onSelect={() => { placeCard('note', menu.world); setMenu(null) }} />
          {props.extraNewItems?.(menu.world, () => setMenu(null))}
          <MenuItem label="粘贴" icon={ClipboardPaste} shortcut="⌘V" onSelect={() => { void paste(menu.world).then(() => setMenu(null), cause => setCompositionError(cause instanceof Error ? cause.message : String(cause))) }} />
        </>}
        {compositionError && <p role="alert" className="canvas-menu-error">{compositionError}</p>}
      </ChromeMenu>
    </div>}
    {busy && <div className="canvas-message" role="status">正在处理…</div>}
    {trash ? <section className="canvas-trash" data-canvas-ui aria-label="回收的卡片">
      <div className="canvas-trash-head"><h2>回收站 · {recycled.length}</h2>
        <button disabled={busy || !recycled.length} onClick={() => void commit([{ type: 'restore', ids: recycled.map(n => n.id) }])}>全部恢复</button></div>
      {!recycled.length && <p className="canvas-menu-empty">回收站是空的。</p>}
      {recycled.map(n => <article key={n.id}><span>{n.type === 'text' ? n.text : n.type === 'link' ? n.url : n.type === 'group' ? n.label : n.file}</span>
        <div className="canvas-trash-actions"><button disabled={busy} aria-label={`恢复 ${n.id}`} onClick={() => void commit([{ type: 'restore', ids: [n.id] }])}>恢复</button></div></article>)}
    </section> : <div className="canvas-world" ref={world} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
      <svg className="canvas-clusters" aria-hidden="true">{outlines.map(o => <path key={o.id} d={o.d} />)}</svg>
      <svg className="canvas-edges" aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>
        {active.edges.map(e => { const from = byId.get(e.fromNode)!, to = byId.get(e.toNode)!; return <g key={e.id}>
          <path ref={el => { if (el) edgeElements.current.set(e.id, { element: el, from, to, edge: e }); else edgeElements.current.delete(e.id) }} d={edgePath(from, to, e)} markerStart={e.fromEnd === 'arrow' ? `url(#${marker})` : undefined} markerEnd={e.toEnd !== 'none' ? `url(#${marker})` : undefined} />
          {e.label && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2}>{e.label}</text>}
        </g> })}
      </svg>
      {active.nodes.map(node => <CanvasCard key={node.id} node={node} selected={selected.includes(node.id)} matched={matchIds.has(node.id)} visible={visibleIds.has(node.id)} element={bindElement} resolveAsset={props.resolveAsset}
        content={visibleIds.has(node.id) ? props.renderCard?.(node) : undefined}
        editor={editing === node.id ? <CanvasEditorLifecycle.Provider value={registerFinish}><div data-canvas-ui className="canvas-editor">
          <div inert={closing}>{props.renderTextEditor?.({ node, commit, close: () => { void closeEditor() } })}</div>
          {editorError && <p role="alert">{editorError}</p>}
          <button disabled={closing} onClick={() => void closeEditor()}>{closing ? '正在完成…' : '完成编辑'}</button>
        </div></CanvasEditorLifecycle.Provider> : undefined} />)}
      <svg className="canvas-overlay" ref={overlay} data-arrow-marker={marker} aria-hidden="true" />
    </div>}
  </div>
}
