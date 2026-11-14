import type { CanvasEdge, CanvasNode, Graphic } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { DEFAULT_GRAPHIC_STROKE } from '../../../../shared/ready-canvas/graphics'
import type { FrameWork, GraphicDraft, Tool } from '../../../components/canvas/surface/types'
import { cardFrame, visualBounds } from './graphics'
import { bounds, expand, intersects, rectBetween, screenToWorld, segmentHitsRect, snapRect, zoomAt, type Camera, type Point, type Rect, type SpatialIndex } from './geometry'
import { adaptiveDock, dockable, MIN_CARD_HEIGHT, MIN_CARD_WIDTH, placedNode, placementOperations, scaledPlacements, type AdaptiveDock, type DockItem, type Placement } from './adaptive'
import { SNAP_RADIUS, type BoardViewPrefs } from './preferences'
import { captureFrames, playSettle } from './settle'

/** Corner arcs scale; edge strips change one dimension. */
export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'l' | 'r' | 't' | 'b'
export interface GestureScene {
  root: HTMLElement; world: HTMLElement; overlay: SVGSVGElement
  camera: Camera; viewport: Rect; index: SpatialIndex<CanvasNode>; byId: Map<string, CanvasNode>
  elements: Map<string, HTMLElement>; selected: string[]; tool: Tool; busy: boolean; prefs: BoardViewPrefs
  children: Map<string, string[]>; edgeElements: Map<string, { element: SVGGElement; from: CanvasNode; to: CanvasNode; edge: CanvasEdge }>
}
type Edges = GestureScene['edgeElements']
type Drag = {
  pointerId: number; start: Point; latest: Point; camera: Camera; selection: string[]; moved: boolean
} & (
  | { kind: 'move'; pressed: string; toggled: boolean; nodes: CanvasNode[]; box: Rect; members: DockItem[]; memberBox: Rect | null; dx: number; dy: number; free: boolean; adaptive: AdaptiveDock | null; edges: Edges }
  | { kind: 'resize'; nodes: CanvasNode[]; box: Rect; handle: Handle; group: boolean; placements: Map<string, Placement> | null; edges: Edges }
  | { kind: 'pan' }
  | { kind: 'marquee'; additive: string[] }
  | { kind: 'rect' | 'arrow' | 'path'; points: Point[] }
  | { kind: 'edge'; from: CanvasNode }
)
interface GestureCallbacks {
  scene: () => GestureScene | null
  select: (ids: string[]) => void
  camera: (camera: Camera) => void
  commit: (ops: CanvasOperation[]) => Promise<boolean>
  /** One batch whose operations need the drawing attachment service (a scaled selection that holds a drawing). */
  transform: (build: (prepare?: (draft: GraphicDraft) => Promise<string>) => Promise<CanvasOperation[]>) => Promise<boolean>
  graphic: (draft: GraphicDraft, existing?: CanvasNode) => Promise<boolean>
  measure?: (work: FrameWork) => void
  /** A connector or drawing was accepted: the surface selects it and puts the select tool back. */
  drawn?: (kind: 'edge' | 'rect' | 'arrow' | 'path', id: string) => void
}
export function edgeEnds(a: Rect, b: Rect, edge?: CanvasEdge): [Point, Point] {
  const dx = b.x + b.width / 2 - a.x - a.width / 2, dy = b.y + b.height / 2 - a.y - a.height / 2
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const port = (r: Rect, side: 'left' | 'right' | 'top' | 'bottom'): Point => ({ x: r.x + (side === 'left' ? 0 : side === 'right' ? r.width : r.width / 2), y: r.y + (side === 'top' ? 0 : side === 'bottom' ? r.height : r.height / 2) })
  const start = port(a, edge?.fromSide ?? (horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top')))
  const end = port(b, edge?.toSide ?? (horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom')))
  return [start, end]
}
export function edgePath(a: Rect, b: Rect, edge?: CanvasEdge): string {
  const [start, end] = edgeEnds(a, b, edge)
  return `M${start.x},${start.y} L${end.x},${end.y}`
}
/** A connector is a group of two paths (the line and its wide hit area): both follow the cards. */
function setEdge(group: SVGGElement, d: string): void { for (const path of group.querySelectorAll('path')) path.setAttribute('d', d) }
const isMac = (): boolean => /mac/i.test(globalThis.navigator?.platform ?? '')

/** One RAF owns each transient gesture; no board state is changed until pointerup. */
export class CanvasGestures {
  private drag: Drag | null = null
  private frame: number | null = null
  private wheelCamera: Camera | null = null
  private wheelFrame: number | null = null
  private wheelZoom = false
  private wheelAt = -Infinity
  private view: Window | null = null
  space = false
  constructor(private callbacks: GestureCallbacks) {}
  get active(): boolean { return this.drag !== null }
  private local(e: { clientX: number; clientY: number }, scene: GestureScene): Point {
    const r = scene.root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  private expandSelection(ids: string[], scene: GestureScene): string[] {
    const found = new Set(ids), queue = [...ids]
    for (let i = 0; i < queue.length; i++) for (const id of scene.children.get(queue[i]) ?? []) if (!found.has(id)) { found.add(id); queue.push(id) }
    return [...found]
  }
  private touching(nodes: readonly CanvasNode[], s: GestureScene): Edges {
    const ids = new Set(nodes.map(n => n.id))
    return new Map([...s.edgeElements].filter(([, edge]) => ids.has(edge.from.id) || ids.has(edge.to.id)))
  }
  down(e: PointerEvent): void {
    const s = this.callbacks.scene()
    if (!s || s.busy || this.drag || (e.button !== 0 && e.button !== 1)) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('button,input,textarea,select,audio,video,[contenteditable]:not([contenteditable="false"]),[data-canvas-ui]') && !target?.closest('[data-resize]')) return
    const camera = this.wheelCamera ?? s.camera
    e.preventDefault(); s.root.focus(); this.finishWheel()
    this.view = s.root.ownerDocument.defaultView
    const p = this.local(e, s), id = target?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId, node = id ? s.byId.get(id) : undefined
    const handle = target?.closest('[data-resize]')?.getAttribute('data-resize') as Handle | null | undefined
    const common = { pointerId: e.pointerId, start: p, latest: p, camera: { ...camera }, selection: [...s.selected], moved: false }
    const toggles = e.shiftKey || e.metaKey || (e.ctrlKey && !isMac())
    if (this.space || e.button === 1 || s.tool === 'pan') this.drag = { ...common, kind: 'pan' }
    else if (s.tool === 'edge') {
      if (!node) return
      this.drag = { ...common, kind: 'edge', from: node }
    } else if (s.tool === 'rect' || s.tool === 'arrow' || s.tool === 'path') {
      this.drag = { ...common, kind: s.tool, points: [screenToWorld(p, camera)] }
    } else if (handle && !node) {
      // The selection hull's arcs: the whole selection scales as one.
      const nodes = this.expandSelection(s.selected, s).flatMap(key => { const n = s.byId.get(key); return n ? [n] : [] })
      if (!nodes.length) return
      this.drag = { ...common, kind: 'resize', nodes, box: bounds(nodes), handle, group: true, placements: null, edges: this.touching(nodes, s) }
    } else if (node) {
      const selected = handle ? [node.id] : toggles ? (s.selected.includes(node.id) ? s.selected.filter(i => i !== node.id) : [...s.selected, node.id]) : s.selected.includes(node.id) ? s.selected : [node.id]
      this.callbacks.select(selected)
      if (!selected.includes(node.id)) return
      if (handle) this.drag = { ...common, kind: 'resize', nodes: [node], box: node, handle, group: false, placements: null, edges: this.touching([node], s) }
      else {
        const nodes = this.expandSelection(selected, s).flatMap(key => { const n = s.byId.get(key); return n ? [n] : [] })
        const members = nodes.filter(dockable).map(n => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }))
        this.drag = { ...common, kind: 'move', pressed: node.id, toggled: toggles, nodes, box: bounds(nodes.map(visualBounds)), members, memberBox: members.length ? bounds(members) : null,
          dx: 0, dy: 0, free: e.shiftKey, adaptive: null, edges: this.touching(nodes, s) }
      }
    } else if (target?.closest('[data-edge-id]')) {
      // A connector is picked, never dragged: it follows its cards. ⇧ or ⌘ adds or removes it.
      const edge = target.closest('[data-edge-id]')!.getAttribute('data-edge-id')!
      this.callbacks.select(toggles ? (s.selected.includes(edge) ? s.selected.filter(i => i !== edge) : [...s.selected, edge]) : [edge])
      return
    } else {
      this.drag = { ...common, kind: 'marquee', additive: toggles ? s.selected : [] }
      if (!toggles) this.callbacks.select([])
    }
    s.root.setPointerCapture?.(e.pointerId)
  }
  move(e: PointerEvent): void {
    const s = this.callbacks.scene(), d = this.drag
    if (!s || !d || d.pointerId !== e.pointerId) return
    d.latest = this.local(e, s)
    if (d.kind === 'move') d.free = e.shiftKey
    d.moved ||= Math.hypot(d.latest.x - d.start.x, d.latest.y - d.start.y) > 2
    if (this.frame === null) this.frame = this.view!.requestAnimationFrame(() => { this.frame = null; this.draw() })
  }
  /** Where a resize puts its cards: cards scale in proportion from a corner (text follows), an edge changes one
   *  dimension; drawings and group frames stretch freely. */
  private resized(d: Extract<Drag, { kind: 'resize' }>, dx: number, dy: number): Map<string, Placement> {
    const b = d.box, h = d.handle, corner = h.length === 2, single = d.nodes[0]
    const east = h === 'ne' || h === 'se' || h === 'r', south = h === 'sw' || h === 'se' || h === 'b'
    const free = !d.group && !dockable(single)
    if (corner && !free) {
      const least = Math.max(...d.nodes.map(n => dockable(n) ? Math.max(MIN_CARD_WIDTH / n.width, MIN_CARD_HEIGHT / n.height) : Math.max(1 / n.width, 1 / n.height)))
      const k = Math.max(least, (b.width + (east ? dx : -dx)) / b.width, (b.height + (south ? dy : -dy)) / b.height)
      const origin = { x: east ? b.x : b.x + b.width, y: south ? b.y : b.y + b.height }
      const placements = scaledPlacements(d.nodes, origin, origin, k)
      if (!d.group) {
        // Rounding must not move the corner that stays put.
        const p = placements.get(single.id)!
        if (!east) p.x = b.x + b.width - p.width
        if (!south) p.y = b.y + b.height - p.height
      }
      return placements
    }
    let { x, y, width, height } = single
    const least = single.ready.kind === 'graphic' ? { width: 1, height: 1 } : single.type === 'group' ? { width: 48, height: 36 } : { width: MIN_CARD_WIDTH, height: MIN_CARD_HEIGHT }
    if (corner || h === 'l' || h === 'r') { width = Math.max(least.width, Math.round(single.width + (east ? dx : -dx))); if (!east) x = single.x + single.width - width }
    if (corner || h === 't' || h === 'b') { height = Math.max(least.height, Math.round(single.height + (south ? dy : -dy))); if (!south) y = single.y + single.height - height }
    return new Map([[single.id, { x, y, width, height }]])
  }
  /** Write geometry straight to the DOM: the fast path while dragging, and the landing before the commit answers. */
  private place(s: GestureScene, nodes: readonly CanvasNode[], placements: ReadonlyMap<string, Placement>, edges: Edges): number {
    let writes = 0
    for (const n of nodes) {
      const el = s.elements.get(n.id), p = placements.get(n.id)
      if (!el || !p) continue
      const frame = cardFrame(placedNode(n, p))
      el.style.translate = ''; el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`; el.style.width = `${frame.width}px`; el.style.height = `${frame.height}px`; writes += 4
      if (p.fontScale !== undefined) { el.style.setProperty('--canvas-font', `${p.fontScale * 24}px`); writes++ }
    }
    const at = (n: CanvasNode): Rect => placements.get(n.id) ?? n
    for (const edge of edges.values()) { setEdge(edge.element, edgePath(at(edge.from), at(edge.to), edge.edge)); writes++ }
    return writes
  }
  /** Put cards and connectors back to what the board says (a cancelled or refused gesture). */
  private reset(s: GestureScene, ids: Iterable<string>): void {
    const set = new Set(ids)
    for (const id of set) {
      const el = s.elements.get(id), n = s.byId.get(id)
      if (!el || !n) continue
      const frame = cardFrame(n), font = n.ready.appearance?.fontScale
      el.style.translate = ''; el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`; el.style.width = `${frame.width}px`; el.style.height = `${frame.height}px`
      if (font) el.style.setProperty('--canvas-font', `${font * 24}px`); else el.style.removeProperty('--canvas-font')
    }
    for (const edge of s.edgeElements.values()) if (set.has(edge.from.id) || set.has(edge.to.id)) setEdge(edge.element, edgePath(edge.from, edge.to, edge.edge))
  }
  private draw(): void {
    const s = this.callbacks.scene(), d = this.drag
    if (!s || !d) return
    const p = screenToWorld(d.latest, d.camera), start = screenToWorld(d.start, d.camera)
    let candidates = 0, visited = 0, domWrites = 0
    s.overlay.replaceChildren()
    if (d.moved) s.root.setAttribute('data-gesture', d.kind)
    const shape = (tag: 'path' | 'rect', attrs: Record<string, string | number>) => {
      const el = s.root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
      s.overlay.append(el); domWrites++; return el
    }
    if (d.kind === 'move') {
      let dx = p.x - start.x, dy = p.y - start.y
      const previous = d.adaptive, moving = new Set(d.nodes.map(n => n.id))
      d.adaptive = null
      if (!d.free && s.prefs.magneticSnap) {
        const raw = { ...d.box, x: d.box.x + dx, y: d.box.y + dy }, reach = SNAP_RADIUS / d.camera.zoom
        const near = s.index.query(expand(raw, reach * 1.6 + s.prefs.gap + 100 / d.camera.zoom)).filter(n => !moving.has(n.id) && intersects(n, s.viewport))
        candidates = near.length; visited = s.index.lastVisited
        if (s.prefs.adaptiveScale && d.memberBox) {
          d.adaptive = adaptiveDock(d.members.map(m => ({ ...m, x: m.x + dx, y: m.y + dy })), near.filter(dockable), s.prefs.gap, reach, previous)
        }
        if (d.adaptive && d.memberBox) {
          const a = d.adaptive
          dx = a.dragX - d.memberBox.x; dy = a.dragY - d.memberBox.y
          // Where the scaled selection will land, and the mark across the seam.
          shape('rect', { x: a.x, y: a.y, width: d.memberBox.width * a.k, height: d.memberBox.height * a.k, rx: 16, class: 'canvas-dock-ghost' })
          shape('path', { d: `M${a.marker.x1},${a.marker.y1}L${a.marker.x2},${a.marker.y2}`, class: 'canvas-dock-mark' })
        } else {
          const snapped = snapRect(raw, near.filter(n => n.type !== 'group'), s.prefs.gap, reach, s.prefs.smartGuides)
          dx = snapped.x - d.box.x; dy = snapped.y - d.box.y
          for (const g of snapped.guides) shape('path', { d: g.axis === 'x' ? `M${g.value},${g.start}V${g.end}` : `M${g.start},${g.value}H${g.end}`, class: 'canvas-guide' })
        }
      }
      d.dx = Math.round(dx); d.dy = Math.round(dy)
      for (const node of d.nodes) { const el = s.elements.get(node.id); if (el) { el.style.translate = `${d.dx}px ${d.dy}px`; domWrites++ } }
      for (const edge of d.edges.values()) {
        const moved = (n: CanvasNode): Rect => moving.has(n.id) ? { ...n, x: n.x + d.dx, y: n.y + d.dy } : n
        setEdge(edge.element, edgePath(moved(edge.from), moved(edge.to), edge.edge)); domWrites++
      }
    } else if (d.kind === 'resize') {
      d.placements = this.resized(d, p.x - start.x, p.y - start.y)
      domWrites += this.place(s, d.nodes, d.placements, d.edges)
      if (d.group) shape('rect', { ...expand(bounds([...d.placements.values()]), 12), rx: 20, class: 'canvas-hull-live' })
    } else if (d.kind === 'pan') {
      this.callbacks.camera({ ...d.camera, x: d.camera.x + d.latest.x - d.start.x, y: d.camera.y + d.latest.y - d.start.y })
    } else if (d.kind === 'marquee') {
      const r = rectBetween(start, p), found = s.index.query(r)
      candidates = found.length; visited = s.index.lastVisited
      shape('rect', { ...r, class: 'canvas-marquee' })
      // Connectors the marquee crosses are picked with the cards.
      const crossed = [...s.edgeElements].filter(([, edge]) => segmentHitsRect(...edgeEnds(edge.from, edge.to, edge.edge), r)).map(([id]) => id)
      this.callbacks.select([...new Set([...d.additive, ...found.map(n => n.id), ...crossed])])
    } else if (d.kind === 'edge') {
      shape('path', { d: `M${d.from.x + d.from.width / 2},${d.from.y + d.from.height / 2} L${p.x},${p.y}`, class: 'canvas-preview' })
    } else if (d.kind === 'rect') shape('rect', { ...rectBetween(start, p), class: 'canvas-preview' })
    else if (d.kind === 'arrow' || d.kind === 'path') {
      if (d.kind === 'path' && (d.points.at(-1)?.x !== p.x || d.points.at(-1)?.y !== p.y)) d.points.push(p)
      shape('path', { d: d.kind === 'arrow' ? `M${start.x},${start.y} L${p.x},${p.y}` : d.points.map((v, i) => `${i ? 'L' : 'M'}${v.x},${v.y}`).join(' '), class: 'canvas-preview', ...(d.kind === 'arrow' ? { 'marker-end': `url(#${s.overlay.dataset.arrowMarker})` } : {}) })
    }
    this.callbacks.measure?.({ kind: d.kind, candidates, visited, domWrites })
  }
  /** The cards take their final place at once (gliding there from where the pointer left them); the board follows
   *  when the one commit is accepted, and they go back if it is refused. */
  private land(s: GestureScene, nodes: readonly CanvasNode[], placements: ReadonlyMap<string, Placement>, edges: Edges, glide: boolean): void {
    const ids = nodes.map(n => n.id), before = glide ? captureFrames(s.elements, ids) : null
    this.place(s, nodes, placements, edges)
    if (before) playSettle(s.elements, before, s.camera.zoom)
    const plain = nodes.every(n => { const p = placements.get(n.id)!; return p.width === n.width && p.height === n.height && p.fontScale === undefined })
    const accepted = plain
      ? this.callbacks.commit(nodes.flatMap(n => { const p = placements.get(n.id)!; return p.x === n.x && p.y === n.y ? [] : [{ type: 'geometry' as const, id: n.id, geometry: { x: p.x, y: p.y } }] }))
      : this.callbacks.transform(prepare => placementOperations(nodes, placements, prepare))
    void accepted.then(ok => { const now = this.callbacks.scene(); if (!ok && now) this.reset(now, ids) })
  }
  private end(s: GestureScene, pointerId: number): void {
    s.overlay.replaceChildren(); s.root.removeAttribute('data-gesture')
    this.drag = null
    if (s.root.hasPointerCapture?.(pointerId)) s.root.releasePointerCapture(pointerId)
  }
  up(e: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return
    const s = this.callbacks.scene()!
    this.drag.latest = this.local(e, s)
    if (this.drag.kind === 'move') this.drag.free = e.shiftKey
    this.drag.moved ||= Math.hypot(this.drag.latest.x - this.drag.start.x, this.drag.latest.y - this.drag.start.y) > 2
    if (this.frame !== null) { this.view!.cancelAnimationFrame(this.frame); this.frame = null }
    this.draw()
    const d = this.drag
    this.end(s, e.pointerId)
    if (d.kind === 'move') {
      if (d.moved && d.adaptive && d.memberBox) this.land(s, d.nodes, scaledPlacements(d.nodes, d.memberBox, d.adaptive, d.adaptive.k), d.edges, true)
      else if (d.moved && (d.dx || d.dy)) this.land(s, d.nodes, new Map(d.nodes.map(n => [n.id, { x: n.x + d.dx, y: n.y + d.dy, width: n.width, height: n.height }])), d.edges, true)
      else {
        this.reset(s, d.nodes.map(n => n.id))
        // A plain click on one card of a multi-selection narrows the selection to it (Stillroom).
        if (!d.moved && !d.toggled && d.selection.length > 1) this.callbacks.select([d.pressed])
      }
    } else if (d.kind === 'resize') {
      if (d.moved && d.placements) this.land(s, d.nodes, d.placements, d.edges, false)
      else this.reset(s, d.nodes.map(n => n.id))
    }
    if (!d.moved) return
    if (d.kind === 'edge') {
      const p = screenToWorld(d.latest, d.camera), to = s.index.query({ ...p, width: 0, height: 0 }).filter(n => n.id !== d.from.id).at(-1)
      const id = crypto.randomUUID()
      if (to) void this.callbacks.commit([{ type: 'addEdge', edge: { id, fromNode: d.from.id, toNode: to.id, toEnd: 'arrow' } }]).then(ok => { if (ok) this.callbacks.drawn?.('edge', id) })
    } else if (d.kind === 'rect' || d.kind === 'arrow' || d.kind === 'path') {
      const start = screenToWorld(d.start, d.camera), end = screenToWorld(d.latest, d.camera)
      const r = rectBetween(start, end), paint = { stroke: DEFAULT_GRAPHIC_STROKE, strokeWidth: 2 }
      const frame = d.kind === 'path' ? bounds(d.points.map(p => ({ ...p, width: 1, height: 1 }))) : r
      const x = Math.round(d.kind === 'arrow' ? start.x : frame.x), y = Math.round(d.kind === 'arrow' ? start.y : frame.y)
      const graphic: Graphic = d.kind === 'rect' ? { type: 'rect', ...paint, fill: 'transparent' } : d.kind === 'arrow' ? { type: 'arrow', ...paint, x2: Math.round(end.x) - x, y2: Math.round(end.y) - y } : { type: 'path', ...paint, points: d.points.map(p => ({ x: p.x - x, y: p.y - y })) }
      const id = crypto.randomUUID(), kind = d.kind
      void this.callbacks.graphic({ id, x, y, width: Math.max(1, Math.round(frame.width)), height: Math.max(1, Math.round(frame.height)), graphic }).then(ok => { if (ok) this.callbacks.drawn?.(kind, id) })
    }
  }
  cancel(): void {
    if (this.frame !== null) this.view?.cancelAnimationFrame(this.frame)
    this.frame = null
    const s = this.callbacks.scene(), d = this.drag
    this.drag = null
    if (s && d) {
      s.overlay.replaceChildren(); s.root.removeAttribute('data-gesture')
      if (d.kind === 'move' || d.kind === 'resize') this.reset(s, d.nodes.map(n => n.id))
      this.callbacks.select(d.selection); this.callbacks.camera(d.camera)
      if (s.root.hasPointerCapture?.(d.pointerId)) s.root.releasePointerCapture(d.pointerId)
    }
    this.space = false
  }
  /** Pinch and ⌘/Ctrl-wheel zoom; a trackpad's two fingers pan; a notched mouse wheel zooms (as Stillroom). A wheel
   *  run is classified by its first event and keeps that reading, so a fast two-finger swipe never turns into a zoom:
   *  a notch reports whole multiples of 120 in the legacy delta, a trackpad starts with a few pixels. */
  wheel(e: WheelEvent): void {
    const s = this.callbacks.scene()
    if (!s || s.busy || this.drag) return
    e.preventDefault(); this.view = s.root.ownerDocument.defaultView
    const c = this.wheelCamera ?? s.camera, unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.root.clientHeight : 1
    const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY || 0
    if (e.timeStamp - this.wheelAt > 180) this.wheelZoom = e.deltaMode === 1 || (e.deltaX === 0 && legacy !== 0 && legacy % 120 === 0)
    this.wheelAt = e.timeStamp
    if (e.ctrlKey || e.metaKey) this.wheelCamera = zoomAt(c, this.local(e, s), c.zoom * Math.exp(-e.deltaY * unit * 0.002))
    else if (this.wheelZoom) this.wheelCamera = zoomAt(c, this.local(e, s), c.zoom * Math.pow(1.1, legacy ? legacy / 120 : -e.deltaY / 3))
    else this.wheelCamera = { ...c, x: c.x - e.deltaX * unit, y: c.y - e.deltaY * unit }
    if (this.wheelFrame === null) this.wheelFrame = this.view!.requestAnimationFrame(() => this.finishWheel())
  }
  private finishWheel(): void {
    if (this.wheelFrame !== null) this.view?.cancelAnimationFrame(this.wheelFrame)
    this.wheelFrame = null
    if (this.wheelCamera) { this.callbacks.camera(this.wheelCamera); this.callbacks.measure?.({ kind: 'wheel', candidates: 0, visited: 0, domWrites: 1 }); this.wheelCamera = null }
  }
  dispose(): void { this.cancel(); if (this.wheelFrame !== null) this.view?.cancelAnimationFrame(this.wheelFrame); this.wheelFrame = null; this.wheelCamera = null }
}
