import { writeReadyRefTransfer } from '../../../../shared/ready-ref'
import { readEventTransfer, READY_REF_MIME } from '../../../modules/calendar/linkage/transfer'
import { eventCard } from '../../../../shared/calendar-linkage'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent } from 'react'
import type { Appearance, CanvasNode } from '../../../../shared/ready-canvas/schema'
import { activeCanvasContent, type CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { CanvasGestures, edgeEnds, edgePath, type GestureScene } from '../../../modules/canvas/interaction/gestures'
import { SpatialIndex, bounds, clusters, expand, layout, screenToWorld, zoomAt, type Camera } from '../../../modules/canvas/interaction/geometry'
import { rememberCamera, rememberedCamera, useBoardView } from '../../../modules/canvas/interaction/preferences'
import { captureFrames, playSettle } from '../../../modules/canvas/interaction/settle'
import { CARDS_MIME, cardsPayload, cardsText, parseCards, pasteOperations, type CardsPayload } from '../../../modules/canvas/interaction/clipboard'
import { neighbour, type Direction } from '../../../modules/canvas/interaction/navigate'
import { DEFAULT_FONT_SCALE } from '../../../modules/canvas/interaction/adaptive'
import { HullHandles } from './CanvasHandles'
import { groupOperations, layerOperations, ungroupOperations } from '../../../modules/canvas/interaction/operations'
import { visualBounds } from '../../../modules/canvas/interaction/graphics'
import { silhouettePath } from '../../../modules/canvas/interaction/outline'
import { CanvasCard } from './CanvasCard'
import { useCanvasBuffer } from './useCanvasBuffer'
import type { CanvasSurfaceProps, Tool } from './types'
import { CanvasEditorLifecycle } from './editor-lifecycle'
import { CanvasCorner, CanvasCrumbs, CanvasDock, SelectionBar } from './CanvasChrome'
import { Button, closeFloat, EmptyState, MenuList, openFloat, type FloatAnchor, type MenuEntry } from '../../ui'
import { cardFrame } from '../../../modules/canvas/interaction/graphics'
import { useBoardCommands } from '../../../modules/canvas/board-commands'
import { subBoardDrop } from '../../../modules/canvas/drop-into-board'
import { subBoardBarActions, subBoardItems } from './sub-board-actions'
import { CalendarPlus, ClipboardPaste, CopyPlus, FileDown, FilePlus2, ImageDown, Sparkles, StickyNote, Trash2, Type } from 'lucide-react'

const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'pan', b: 'rect', a: 'arrow', c: 'edge', d: 'path' }
const CONTEXT_MENU = 'canvas-context-menu'
const HOME_CAMERA: Camera = { x: 40, y: 80, zoom: 1 }
const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
/** The cards last copied here, for the right-click 粘贴 (which can only read the clipboard's text). */
let copied: CardsPayload | null = null

export function CanvasSurface(props: CanvasSurfaceProps) {
  const buffer = useCanvasBuffer(props), { canvas, busy, commit } = buffer
  const [selected, setSelected] = useState<string[]>([]), [tool, setTool] = useState<Tool>('select'), [trash, setTrash] = useState(false)
  const finishEditor = useRef<(() => Promise<void>) | null>(null), exiting = useRef(false)
  const [editorError, setEditorError] = useState(''), [closing, setClosing] = useState(false)
  const registerFinish = useCallback((finish: () => Promise<void>) => {
    finishEditor.current = finish
    return () => { if (finishEditor.current === finish) finishEditor.current = null }
  }, [])
  const [editing, setEditing] = useState<string | null>(null), [camera, setCamera] = useState<Camera>(() => props.initialCamera ?? rememberedCamera(props.canvas.ready.id) ?? HOME_CAMERA)
  const view = useBoardView(), [hover, setHover] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 1000, height: 700 })
  useEffect(() => {
    const node = canvas.nodes.find(node => node.id === props.revealNode?.nodeId && !node.ready.trash)
    if (!node) return
    setSelected([node.id]); setCamera({ x: size.width / 2 - node.x - node.width / 2, y: size.height / 2 - node.y - node.height / 2, zoom: 1 })
  }, [props.revealNode?.requestId, size.width, size.height]) // eslint-disable-line react-hooks/exhaustive-deps -- a navigation request runs once; editing must not recenter

  // The right-click menu: what was clicked and where (the shared W1 menu opens at the pointer, inside the board).
  const [menu, setMenu] = useState<{ kind: 'card' | 'edge' | 'canvas'; world: { x: number; y: number }; client: { x: number; y: number } } | null>(null)
  const [lastShape, setLastShape] = useState<Tool>('rect')
  const [search, setSearch] = useState<string | null>(null), [hit, setHit] = useState(-1)
  const [capturing, setCapturing] = useState(false)
  const [composing, setComposing] = useState(false), [compositionError, setCompositionError] = useState('')
  const root = useRef<HTMLDivElement>(null), world = useRef<HTMLDivElement>(null), overlay = useRef<SVGSVGElement>(null)
  const elements = useRef(new Map<string, HTMLElement>()), edgeElements = useRef<GestureScene['edgeElements']>(new Map())
  const latest = useRef({ buffer, props, camera }), scene = useRef<GestureScene | null>(null)
  latest.current = { buffer, props, camera }
  const gestures = useMemo(() => new CanvasGestures({ scene: () => scene.current, select: setSelected, camera: setCamera,
    commit: ops => latest.current.buffer.commit(ops), transform: build => latest.current.buffer.transform(build), graphic: (draft, node) => latest.current.buffer.graphic(draft, node), measure: work => latest.current.props.onFrameWork?.(work),
    // One connector or shape, then back to the select tool with the new thing picked (Delete removes it); freehand keeps drawing.
    drawn: (kind, id) => { if (kind !== 'path') { setSelected([id]); setTool('select') } },
    ...subBoardDrop((ids, target) => latest.current.props.subBoards?.moveInto?.(ids, target)) }), []) // M4 §9: cards dropped onto a sub-board card
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
  // Stillroom's clusters: cards within 24 of each other; the outline shows only around the hovered card's cluster.
  const outlines = useMemo(() => clusters(visible.filter(n => n.type !== 'group' && n.ready.kind !== 'graphic')).filter(c => c.length > 1).map(c => ({ ids: new Set(c.map(n => n.id)), d: silhouettePath(c, 24, 40) })), [visible])
  const chosen = selected.flatMap(id => { const n = byId.get(id); return n ? [n] : [] })
  // What a gesture on the selection carries: the picked cards and the members of picked groups.
  const carried = useMemo(() => {
    const ids = new Set(selected.filter(id => byId.has(id))), queue = [...ids]
    for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) ?? []) if (!ids.has(id)) { ids.add(id); queue.push(id) }
    return active.nodes.filter(n => ids.has(n.id))
  }, [selected, byId, children, active])
  // Node and connector ids share one namespace (the format rejects duplicates), so one selection holds both.
  const chosenEdges = active.edges.filter(edge => selected.includes(edge.id))
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
    if (root.current && world.current && overlay.current) scene.current = { root: root.current, world: world.current, overlay: overlay.current, camera, viewport, index, byId, elements: elements.current, selected, tool, busy: busy || trash || !!editing, prefs: view, children, edgeElements: edgeElements.current }
  })
  const boardId = useRef(props.canvas.ready.id)
  useLayoutEffect(() => {
    gestures.cancel(); setEditing(null); setSelected([]); setHover(null)
    // Another board in the same surface opens where it was left (M4 §9.1: the camera is this machine's state).
    if (boardId.current !== props.canvas.ready.id) { boardId.current = props.canvas.ready.id; setCamera(rememberedCamera(props.canvas.ready.id) ?? HOME_CAMERA) }
  }, [props.canvas.ready.id, gestures])
  useEffect(() => {
    if (capturing) return
    const id = props.canvas.ready.id, timer = setTimeout(() => rememberCamera(id, camera), 300)
    return () => clearTimeout(timer)
  }, [camera, capturing, props.canvas.ready.id])
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
  /** Delete: cards go to the bin; a connector is removed outright (undo brings it back). A connector between two
   *  cards that are binned together is left alone: it is hidden with them and returns with them. */
  function recycle() {
    if (!chosen.length && !chosenEdges.length) return
    const binned = new Set(chosen.map(n => n.id)), operations: CanvasOperation[] = []
    if (chosen.length) operations.push({ type: 'trash', ids: [...binned], trash: { operationId: crypto.randomUUID(), deletedAt: new Date().toISOString() } })
    for (const edge of chosenEdges) if (!binned.has(edge.fromNode) || !binned.has(edge.toNode)) operations.push({ type: 'deleteEdge', id: edge.id })
    void commit(operations)
  }
  /** Cards glide to where an edit puts them (a layout, an undo, a redo); 还原排版 is undo. */
  function settled(edit: () => Promise<boolean>) {
    const before = captureFrames(elements.current, visibleIds)
    void edit().then(ok => { if (ok) root.current?.ownerDocument.defaultView?.requestAnimationFrame(() => playSettle(elements.current, before, latest.current.camera.zoom)) })
  }
  function arrange(kind: 'P' | 'L' | 'R') { settled(() => commit(layout(chosen, kind, view.gap, Math.floor(Math.random() * 4294967296)))) }
  const undo = () => settled(() => buffer.undo()), redo = () => settled(() => buffer.redo())
  function duplicate() {
    const payload = cardsPayload(carried, active.edges)
    if (!payload) return
    const { operations, ids } = pasteOperations(payload, { offset: { x: 24, y: 24 } })
    void commit(operations).then(ok => { if (ok) setSelected(ids) })
  }
  /** Arrow keys: from the picked card to the nearest one that way (from nothing: the card nearest the middle). */
  function focusCard(direction: Direction) {
    const pool = active.nodes.filter(n => n.type !== 'group').map(n => ({ ...n, ...visualBounds(n) })), from = chosen.length === 1 ? pool.find(n => n.id === chosen[0].id) : undefined
    const middle = screenToWorld({ x: size.width / 2, y: size.height / 2 }, camera)
    const next = from ? neighbour(pool, from, direction) : [...pool].sort((a, b) => Math.hypot(a.x + a.width / 2 - middle.x, a.y + a.height / 2 - middle.y) - Math.hypot(b.x + b.width / 2 - middle.x, b.y + b.height / 2 - middle.y))[0]
    if (!next) return
    setSelected([next.id])
    // Bring it into view with the smallest pan.
    const pad = 96, left = next.x * camera.zoom + camera.x, top = next.y * camera.zoom + camera.y, right = left + next.width * camera.zoom, bottom = top + next.height * camera.zoom
    const dx = left < pad ? pad - left : right > size.width - pad ? Math.min(size.width - pad - right, pad - left) : 0
    const dy = top < pad ? pad - top : bottom > size.height - pad ? Math.min(size.height - pad - bottom, pad - top) : 0
    if (dx || dy) setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }))
  }
  const inField = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-canvas-ui]')
  function copyCards(event: ClipboardEvent<HTMLDivElement>, cut: boolean) {
    if (inField(event.target) || trash || editing || (cut && busy)) return
    const payload = cardsPayload(carried, active.edges)
    if (!payload) return
    event.preventDefault(); copied = payload
    event.clipboardData.setData(CARDS_MIME, JSON.stringify(payload)); event.clipboardData.setData('text/plain', cardsText(payload))
    if (cut) recycle()
  }
  const pasteRun = useRef({ key: '', count: 0 })
  /** Cards copied on this board land a step away from their originals (each further paste one step more); cards
   *  from another board land in the middle of the view. */
  function placeCards(payload: CardsPayload, at?: { x: number; y: number }) {
    const key = payload.nodes.map(n => n.id).join(), here = !at && payload.nodes.some(n => byId.has(n.id))
    pasteRun.current = { key, count: pasteRun.current.key === key ? pasteRun.current.count + 1 : 1 }
    const step = 24 * pasteRun.current.count
    const { operations, ids } = pasteOperations(payload, here ? { offset: { x: step, y: step } } : { centre: at ?? screenToWorld({ x: size.width / 2, y: size.height / 2 }, camera) })
    return commit(operations).then(ok => { if (ok) setSelected(ids) })
  }
  function pasteCards(event: ClipboardEvent<HTMLDivElement>) {
    // Pictures and files on the clipboard belong to the media layer, not to this handler.
    if (inField(event.target) || busy || trash || editing || event.clipboardData.files.length) return
    const cards = parseCards(event.clipboardData.getData(CARDS_MIME)), text = event.clipboardData.getData('text/plain').trim()
    if (!cards && !text) return
    event.preventDefault()
    if (cards) void placeCards(cards)
    else void commit([{ type: 'addNode', node: textOrLink(text, screenToWorld({ x: size.width / 2, y: size.height / 2 }, camera)) }])
  }
  const textual = chosen.length > 0 && chosen.every(n => n.type === 'text' && n.ready.kind !== 'draft')
  const shared = <T,>(read: (node: CanvasNode) => T): T | undefined => chosen.every(n => read(n) === read(chosen[0])) ? read(chosen[0]) : undefined
  function textStyle(patch: Partial<Pick<Appearance, 'fontScale' | 'weight' | 'align'>>) {
    void commit(chosen.map(n => ({ type: 'appearance' as const, id: n.id, appearance: { ...n.ready.appearance, ...patch } })))
  }
  function shortcut(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target instanceof Element ? e.target : null
    if (!root.current?.contains(root.current.ownerDocument.activeElement) || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],button,[data-canvas-ui]') || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') { e.preventDefault(); gestures.cancel(); setEditing(null); setTool('select'); return }
    if (busy || trash || editing) return
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
    if (e.key === ' ') { e.preventDefault(); gestures.space = true }
    else if (mod && key === 'a') { e.preventDefault(); setSelected([...active.nodes.map(n => n.id), ...active.edges.map(edge => edge.id)]) }
    // M4 §9: the last cross-board move when the board's own history is empty; ⌥↑ to the parent board.
    else if (mod && key === 'z' && !e.shiftKey && !buffer.canUndo && props.subBoards?.undo) { e.preventDefault(); props.subBoards.undo() }
    else if (!mod && e.altKey && e.key === 'ArrowUp' && props.subBoards?.openParent) { e.preventDefault(); props.subBoards.openParent() }
    else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
    else if (mod && e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) { e.preventDefault(); if (chosen.length) void commit(layerOperations(canvas, chosen.map(n => n.id), e.code === 'BracketRight' ? 'forward' : 'backward')) }
    else if (mod && !e.shiftKey && key === 'd') { e.preventDefault(); duplicate() }
    else if (!mod && !e.altKey && ARROWS[e.key]) { e.preventDefault(); focusCard(ARROWS[e.key]) }
    else if (!mod && e.key === 'Enter' && chosen.length === 1) { e.preventDefault(); open(chosen[0]) }
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
    setCapturing(true); setSelected([]); fit(chosen.length ? chosen : active.nodes, { x: 64, y: 64 })
    try {
      // A timer, not animation frames: a hidden or throttled window may never paint one, and the camera must settle first.
      await new Promise(resolve => setTimeout(resolve, 120))
      const rect = root.current.getBoundingClientRect()
      await props.captureImage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, canvas.ready.title || '画板')
    } catch (cause) { setCompositionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setCapturing(false); setCamera(before); setSelected(keep) }
  }
  const exportItems: MenuEntry[] | undefined = props.onExport || props.captureImage ? [
    ...(props.captureImage ? [{ id: 'png', label: chosen.length ? '把选中的卡片导出为 PNG' : '导出为 PNG', icon: <ImageDown />, onSelect: () => void exportPng() }] : []),
    ...(props.onExport ? (['md', 'pdf'] as const).map(kind => ({ id: kind, label: `${chosen.length ? '把选中的卡片导出为' : '导出为'} ${kind === 'md' ? 'Markdown' : 'PDF'}`, icon: <FileDown />,
      onSelect: () => { void props.onExport!(kind, selected).catch(cause => setCompositionError(String(cause))) } })) : []),
    ...(props.moreItems ?? []),
  ] : undefined
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
  const selectionBox = (chosen.length || chosenEdges.length) && !editing && !trash && !menu && !capturing ? (() => {
    // Connectors alone: the bar sits over the picked lines (their end points stand in for card frames).
    const frames = chosen.length ? chosen.map(cardFrame) : chosenEdges.flatMap(edge => edgeEnds(byId.get(edge.fromNode)!, byId.get(edge.toNode)!, edge).map(point => ({ ...point, width: 0, height: 0 })))
    const left = Math.min(...frames.map(f => f.x)) * camera.zoom + camera.x, right = Math.max(...frames.map(f => f.x + f.width)) * camera.zoom + camera.x
    const top = Math.min(...frames.map(f => f.y)) * camera.zoom + camera.y
    return { left: Math.max(180, Math.min(size.width - 180, (left + right) / 2)), top: Math.max(68, top - 52) }
  })() : null
  // More than one card picked: one outline around them all, with its own four arcs (Stillroom's selection hull).
  const hull = carried.length > 1 && !editing && !trash && !capturing && tool === 'select'
  const schedulable = props.onScheduleNode && chosen.length === 1 && ['text', 'note', 'document'].includes(chosen[0].ready.kind)
  function textOrLink(text: string, at: { x: number; y: number }): CanvasNode {
    const link = /^https?:\/\/\S+$/i.test(text), frame = { id: crypto.randomUUID(), x: Math.round(at.x - 130), y: Math.round(at.y - 40), width: 260, height: link ? 195 : 120 }
    return link ? { ...frame, type: 'link', url: text, ready: { kind: 'link' } } : { ...frame, type: 'text', text, ready: { kind: 'text' } }
  }
  async function paste(at: { x: number; y: number }) {
    const text = (await navigator.clipboard?.readText?.())?.trim()
    // The menu can only read the clipboard's text: when it is the reading of the cards copied here, paste those cards.
    if (copied && text && text === cardsText(copied).trim()) { await placeCards(copied, at); return }
    if (!text) throw new Error('剪贴板里没有文字或链接')
    await commit([{ type: 'addNode', node: textOrLink(text, at) }])
  }
  const recycled = canvas.nodes.filter(n => n.ready.trash)
  const fail = (cause: unknown) => setCompositionError(cause instanceof Error ? cause.message : String(cause))
  // The right-click menu is the shared W1 menu at the pointer, kept inside the board; a pick closes it and runs.
  // It opens after the render that selected the clicked card, so its items read the new selection.
  const contextItems = useRef<() => MenuEntry[]>(() => [])
  contextItems.current = () => {
    if (!menu) return []
    if (menu.kind === 'edge') return [{ id: 'delete-edge', label: chosenEdges.length > 1 ? `删除 ${chosenEdges.length} 条连线` : '删除连线', icon: <Trash2 />, hint: 'Delete', danger: true, disabled: busy || composing, onSelect: recycle }]
    if (menu.kind === 'card') return [
      ...(props.onAddToDocument ? [{ id: 'add', label: '添加到文档', icon: <FilePlus2 />, disabled: composing || busy, onSelect: () => void addToDocument() }] : []),
      ...(props.onAskAI && chosen.length > 0 ? [{ id: 'ask', label: '问 AI', icon: <Sparkles />, disabled: busy || composing, onSelect: () => { void props.onAskAI!(chosen.map(n => n.id)).catch(fail) } }] : []),
      ...(schedulable ? [{ id: 'schedule', label: '安排日程…', icon: <CalendarPlus />, disabled: busy || composing, onSelect: () => props.onScheduleNode!(chosen[0]) }] : []),
      { id: 'duplicate', label: '创建副本', icon: <CopyPlus />, hint: '⌘D', disabled: busy || composing, onSelect: duplicate },
      ...subBoardItems(props.subBoards, chosen, busy || composing),
      { id: 'delete', label: '删除', icon: <Trash2 />, hint: 'Delete', danger: true, disabled: busy || composing, onSelect: recycle },
    ]
    const anchor: FloatAnchor = { left: menu.client.x, top: menu.client.y, right: menu.client.x, bottom: menu.client.y }
    return [
      { id: 'text', label: '文字卡', icon: <Type />, hint: 'T', onSelect: () => placeCard('text', menu.world) },
      { id: 'note', label: '便签', icon: <StickyNote />, hint: 'N', onSelect: () => placeCard('note', menu.world) },
      ...(props.extraNewItems?.(menu.world, { anchor, bounds: () => (root.current ?? document.body).getBoundingClientRect() }) ?? []),
      { id: 'paste', label: '粘贴', icon: <ClipboardPaste />, hint: '⌘V', onSelect: () => { void paste(menu.world).catch(fail) } },
    ]
  }
  useEffect(() => {
    if (!menu) return
    const host = root.current
    openFloat({
      id: CONTEXT_MENU, placement: 'bottom-start',
      anchor: { left: menu.client.x, top: menu.client.y, right: menu.client.x, bottom: menu.client.y },
      bounds: () => (host ?? document.body).getBoundingClientRect(),
      onClose: () => { setMenu(current => current === menu ? null : current); if (host?.isConnected) host.focus({ preventScroll: true }) },
      render: close => <MenuList items={contextItems.current()} label={menu.kind === 'card' ? '选区菜单' : menu.kind === 'edge' ? '连线菜单' : '新建'} onDone={close} />,
    })
    return () => closeFloat(CONTEXT_MENU)
  }, [menu])
  // 清空 asks once more in place (no system dialog); it undoes like any edit while the board stays open.
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  useEffect(() => { if (!confirmEmpty) return; const timer = setTimeout(() => setConfirmEmpty(false), 4000); return () => clearTimeout(timer) }, [confirmEmpty])
  function emptyBin() {
    if (!confirmEmpty) { setConfirmEmpty(true); return }
    setConfirmEmpty(false)
    void commit([{ type: 'purge', ids: recycled.map(n => n.id), edgeIds: canvas.edges.filter(e => e.ready?.trash).map(e => e.id) }])
  }
  async function addToDocument() {
    if (composing || !props.onAddToDocument) return
    setComposing(true); setCompositionError('')
    try { await props.onAddToDocument(chosen.map(n => n.id)) }
    catch (error) { setCompositionError(error instanceof Error ? error.message : String(error)) }
    finally { setComposing(false) }
  }
  return <div className="rn-canvas" data-canvas-surface data-tool={tool} data-square-media={view.roundedMedia ? undefined : true} data-capturing={capturing || undefined}
    onCopy={event => copyCards(event, false)} onCut={event => copyCards(event, true)} onPaste={pasteCards} tabIndex={0} ref={root} aria-label={canvas.ready.title || '画板'}
    onDragStart={event => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-node-id]') : null
      const node = card?.dataset.nodeId ? byId.get(card.dataset.nodeId) : null
      if (!event.altKey || !node || editing) { event.preventDefault(); return }
      event.stopPropagation()
      writeReadyRefTransfer(event.dataTransfer, { kind: 'canvas', id: canvas.ready.id, node: node.id }, node.ready.preview?.title || (node.type === 'text' ? node.text.slice(0, 100) : '画板卡片'))
    }}
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
      const edge = card || !(event.target instanceof Element) ? undefined : event.target.closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? undefined
      if (card?.dataset.nodeId && !selected.includes(card.dataset.nodeId)) setSelected([card.dataset.nodeId])
      // A connector's menu acts on connectors only: keep a pure connector selection that holds it, else pick just it.
      if (edge && !(selected.includes(edge) && !chosen.length)) setSelected([edge])
      if (!card && !edge) setSelected([])
      const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
      setCompositionError('')
      setMenu({ kind: card ? 'card' : edge ? 'edge' : 'canvas', world: screenToWorld({ x, y }, camera), client: { x: event.clientX, y: event.clientY } })
    }}
    onKeyDown={shortcut} onKeyUp={e => { if (e.key === ' ') gestures.space = false }}
    onFocus={() => commands.focus()} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) gestures.cancel() }}
    onPointerDown={e => { if (!e.altKey) gestures.down(e.nativeEvent) }} onPointerUp={e => gestures.up(e.nativeEvent)}
    onPointerMove={e => {
      gestures.move(e.nativeEvent)
      // The hovered card shows its grips and its cluster's outline; a gesture in progress keeps what it started with.
      if (!gestures.active) { const over = e.target instanceof Element && !e.target.closest('[data-canvas-ui]') ? e.target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null : null; if (over !== hover) setHover(over) }
    }}
    onPointerLeave={() => { if (!gestures.active) setHover(null) }}
    onPointerCancel={() => gestures.cancel()} onLostPointerCapture={() => gestures.cancel()}
    onDoubleClick={e => {
      // A drag gesture captures the pointer on the root, so the browser retargets the double-click to the root:
      // find the card under the pointer instead of relying on the card's own handler.
      const hit = e.target instanceof Element && e.target !== e.currentTarget ? e.target : document.elementFromPoint(e.clientX, e.clientY)
      const card = hit?.closest<HTMLElement>('[data-node-id]'), node = card?.dataset.nodeId ? byId.get(card.dataset.nodeId) : undefined
      if (node && !hit?.closest('[data-canvas-ui]')) open(node)
    }}>
    {!capturing && !!props.breadcrumbs?.length && <CanvasCrumbs title={canvas.ready.title || '画板'} breadcrumbs={props.breadcrumbs} busy={busy} onNavigate={props.onNavigateAncestor} />}
    {!capturing && <CanvasCorner zoom={camera.zoom} more={exportItems} search={search} results={matches.length} hit={Math.min(hit, matches.length - 1)} recycled={recycled.length} trash={trash} busy={busy || !!editing}
      onSearch={value => { setSearch(value); setHit(-1) }} onStep={step} onFit={() => fit()}
      onZoomReset={() => setCamera(c => zoomAt(c, { x: size.width / 2, y: size.height / 2 }, 1))}
      onTrash={() => { gestures.cancel(); setEditing(null); setSearch(null); setTrash(!trash) }} />}
    {!trash && !capturing && <CanvasDock tool={tool} lastShape={lastShape} disabled={busy || !!editing} graphics={!!props.prepareGraphic}
      canUndo={buffer.canUndo || !!props.subBoards?.undo} canRedo={buffer.canRedo} busy={busy} onTool={chooseTool} onCard={kind => placeCard(kind)}
      onUndo={() => { if (buffer.canUndo || !props.subBoards?.undo) undo(); else props.subBoards.undo() }} onRedo={redo} />}
    {selectionBox && <SelectionBar left={selectionBox.left} top={selectionBox.top} count={chosen.length} edges={chosenEdges.length} busy={busy || composing}
      text={textual ? { size: shared(n => Math.round((n.ready.appearance?.fontScale ?? DEFAULT_FONT_SCALE) * 24)), weight: shared(n => n.ready.appearance?.weight), align: shared(n => n.ready.appearance?.align) } : undefined}
      canGroup={chosen.length > 1} canUngroup={chosen.some(n => n.ready.groupId || n.type === 'group')}
      actions={{
        group: () => void commit(groupOperations(chosen, crypto.randomUUID())), ungroup: () => void commit(ungroupOperations(canvas, selected)),
        layout: arrange, layer: placement => void commit(layerOperations(canvas, chosen.map(n => n.id), placement)),
        remove: recycle, textStyle: textual ? textStyle : undefined, ...subBoardBarActions(props.subBoards, chosen),
        addToDocument: props.onAddToDocument ? () => void addToDocument() : undefined,
        askAI: props.onAskAI ? () => { void props.onAskAI!(chosen.map(n => n.id)).catch(fail) } : undefined,
        schedule: schedulable ? () => props.onScheduleNode!(chosen[0]) : undefined,
      }} />}
    {compositionError && !menu && <p role="alert" data-canvas-ui>{compositionError}</p>}
    {buffer.error && <div className="canvas-message" role="alert" data-canvas-ui>{buffer.error}</div>}
    {busy && <div className="canvas-message" role="status">正在处理…</div>}
    {trash ? <section className="canvas-trash" data-canvas-ui aria-label="回收的卡片">
      <div className="canvas-trash-head"><h2>回收站 · {recycled.length}</h2>
        <Button size="sm" disabled={busy || !recycled.length} onClick={() => void commit([{ type: 'restore', ids: recycled.map(n => n.id), edgeIds: canvas.edges.filter(e => e.ready?.trash).map(e => e.id) }])}>全部恢复</Button>
        <Button size="sm" variant="danger" disabled={busy || !recycled.length} onClick={emptyBin}>{confirmEmpty ? '确认清空' : '清空'}</Button></div>
      {!recycled.length && <EmptyState title="回收站是空的" />}
      {recycled.map(n => <article key={n.id}>{props.renderCard?.(n) ?? <span>{n.type === 'text' ? n.text : n.type === 'link' ? n.url : n.type === 'group' ? n.label : n.file}</span>}
        <div className="canvas-trash-actions"><Button size="sm" disabled={busy} aria-label={`恢复 ${n.id}`} onClick={() => void commit([{ type: 'restore', ids: [n.id] }])}>恢复</Button>
          <Button size="sm" variant="danger" disabled={busy} aria-label={`永久删除 ${n.id}`} onClick={() => void commit([{ type: 'purge', ids: [n.id] }])}>永久删除</Button></div></article>)}
    </section> : <div className="canvas-world" ref={world} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
      <svg className="canvas-clusters" aria-hidden="true">{outlines.map(o => <path key={o.d} d={o.d} data-on={(!!hover && o.ids.has(hover) && !(hull && carried.some(n => o.ids.has(n.id)))) || undefined} />)}</svg>
      <svg className="canvas-edges" aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="13" markerHeight="13" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" /></marker></defs>
        {active.edges.map(e => { const from = byId.get(e.fromNode)!, to = byId.get(e.toNode)!, d = edgePath(from, to, e); return <g key={e.id} data-edge-id={e.id} data-selected={selected.includes(e.id) || undefined}
          ref={el => { if (el) edgeElements.current.set(e.id, { element: el, from, to, edge: e }); else edgeElements.current.delete(e.id) }}>
          <path className="canvas-edge-line" d={d} markerStart={e.fromEnd === 'arrow' ? `url(#${marker})` : undefined} markerEnd={e.toEnd !== 'none' ? `url(#${marker})` : undefined} />
          <path className="canvas-edge-hit" d={d} />
          {e.label && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2}>{e.label}</text>}
        </g> })}
      </svg>
      {active.nodes.map(node => <CanvasCard key={node.id} node={node} selected={selected.includes(node.id)} matched={matchIds.has(node.id)}
        grouped={hull && selected.includes(node.id)} handles={tool === 'select' && !busy && !editing && !capturing && (hull ? false : selected.includes(node.id) || hover === node.id)} visible={visibleIds.has(node.id)} element={bindElement} resolveAsset={props.resolveAsset}
        content={visibleIds.has(node.id) ? props.renderCard?.(node) : undefined}
        editor={editing === node.id ? <CanvasEditorLifecycle.Provider value={registerFinish}><div data-canvas-ui className="canvas-editor">
          <div inert={closing}>{props.renderTextEditor?.({ node, commit, close: () => { void closeEditor() } })}</div>
          {editorError && <p role="alert">{editorError}</p>}
          <Button size="sm" disabled={closing} onClick={() => void closeEditor()}>{closing ? '正在完成…' : '完成编辑'}</Button>
        </div></CanvasEditorLifecycle.Provider> : undefined} />)}
      {hull && <>
        <svg className="canvas-hull" aria-hidden="true"><path d={silhouettePath(carried.map(cardFrame), 12, 28)} /></svg>
        <HullHandles box={expand(bounds(carried), 12)} />
      </>}
      <svg className="canvas-overlay" ref={overlay} data-arrow-marker={marker} aria-hidden="true" />
    </div>}
  </div>
}
