import type { CanvasEdge, CanvasNode, Graphic } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import { DEFAULT_GRAPHIC_STROKE } from '../../../../shared/ready-canvas/graphics'
import type { FrameWork, GraphicDraft, Tool } from '../../../components/canvas/surface/types'
import { cardFrame, resizedGraphic, visualBounds } from './graphics'
import { bounds, expand, intersects, rectBetween, screenToWorld, segmentHitsRect, snapRect, zoomAt, type Camera, type Point, type Rect, type SpatialIndex } from './geometry'

export interface GestureScene {
  root: HTMLElement; world: HTMLElement; overlay: SVGSVGElement
  camera: Camera; viewport: Rect; index: SpatialIndex<CanvasNode>; byId: Map<string, CanvasNode>
  elements: Map<string, HTMLElement>; selected: string[]; tool: Tool; busy: boolean
  children: Map<string, string[]>; edgeElements: Map<string, { element: SVGGElement; from: CanvasNode; to: CanvasNode; edge: CanvasEdge }>
}
type Drag = {
  pointerId: number; start: Point; latest: Point; camera: Camera; selection: string[]; moved: boolean
} & (
  | { kind: 'move' | 'resize'; nodes: CanvasNode[]; box: Rect; dx: number; dy: number; geometry: Rect | null; edges: GestureScene['edgeElements'] }
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

/** One RAF owns each transient gesture; no board state is changed until pointerup. */
export class CanvasGestures {
  private drag: Drag | null = null
  private frame: number | null = null
  private wheelCamera: Camera | null = null
  private wheelFrame: number | null = null
  private view: Window | null = null
  space = false
  constructor(private callbacks: GestureCallbacks) {}
  private local(e: { clientX: number; clientY: number }, scene: GestureScene): Point {
    const r = scene.root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  private expandSelection(ids: string[], scene: GestureScene): string[] {
    const found = new Set(ids), queue = [...ids]
    for (let i = 0; i < queue.length; i++) for (const id of scene.children.get(queue[i]) ?? []) if (!found.has(id)) { found.add(id); queue.push(id) }
    return [...found]
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
    const common = { pointerId: e.pointerId, start: p, latest: p, camera: { ...camera }, selection: [...s.selected], moved: false }
    if (this.space || e.button === 1 || s.tool === 'pan') this.drag = { ...common, kind: 'pan' }
    else if (s.tool === 'edge') {
      if (!node) return
      this.drag = { ...common, kind: 'edge', from: node }
    } else if (s.tool === 'rect' || s.tool === 'arrow' || s.tool === 'path') {
      this.drag = { ...common, kind: s.tool, points: [screenToWorld(p, camera)] }
    } else if (node) {
      const selected = e.shiftKey ? (s.selected.includes(node.id) ? s.selected.filter(i => i !== node.id) : [...s.selected, node.id]) : s.selected.includes(node.id) ? s.selected : [node.id]
      this.callbacks.select(selected)
      if (!selected.includes(node.id)) return
      const resizing = !!target?.closest('[data-resize]')
      const ids = resizing ? [node.id] : this.expandSelection(selected, s)
      const nodes = ids.flatMap(key => { const n = s.byId.get(key); return n ? [n] : [] }), moving = new Set(ids)
      const edges = new Map([...s.edgeElements].filter(([, edge]) => moving.has(edge.from.id) || moving.has(edge.to.id)))
      this.drag = { ...common, kind: resizing ? 'resize' : 'move', nodes, box: bounds(nodes.map(visualBounds)), dx: 0, dy: 0, geometry: null, edges }
    } else if (target?.closest('[data-edge-id]')) {
      // A connector is picked, never dragged: it follows its cards. ⇧ adds or removes it.
      const edge = target.closest('[data-edge-id]')!.getAttribute('data-edge-id')!
      this.callbacks.select(e.shiftKey || e.metaKey || e.ctrlKey ? (s.selected.includes(edge) ? s.selected.filter(i => i !== edge) : [...s.selected, edge]) : [edge])
      return
    } else {
      this.drag = { ...common, kind: 'marquee', additive: e.shiftKey ? s.selected : [] }
      if (!e.shiftKey) this.callbacks.select([])
    }
    s.root.setPointerCapture?.(e.pointerId)
  }
  move(e: PointerEvent): void {
    const s = this.callbacks.scene(), d = this.drag
    if (!s || !d || d.pointerId !== e.pointerId) return
    d.latest = this.local(e, s)
    d.moved ||= Math.hypot(d.latest.x - d.start.x, d.latest.y - d.start.y) > 2
    if (this.frame === null) this.frame = this.view!.requestAnimationFrame(() => { this.frame = null; this.draw() })
  }
  private draw(): void {
    const s = this.callbacks.scene(), d = this.drag
    if (!s || !d) return
    const p = screenToWorld(d.latest, d.camera), start = screenToWorld(d.start, d.camera)
    let candidates = 0, visited = 0, domWrites = 0
    s.overlay.replaceChildren()
    const shape = (tag: 'path' | 'rect', attrs: Record<string, string | number>) => {
      const el = s.root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
      s.overlay.append(el); domWrites++; return el
    }
    if (d.kind === 'move') {
      const raw = { ...d.box, x: d.box.x + p.x - start.x, y: d.box.y + p.y - start.y }, moving = new Set(d.nodes.map(n => n.id))
      const near = s.index.query(expand(raw, 100 / d.camera.zoom)).filter(n => !moving.has(n.id) && intersects(n, s.viewport))
      candidates = near.length; visited = s.index.lastVisited
      const snapped = snapRect(raw, near, 24, 6 / d.camera.zoom)
      d.dx = Math.round(snapped.x - d.box.x); d.dy = Math.round(snapped.y - d.box.y)
      for (const node of d.nodes) { const el = s.elements.get(node.id); if (el) { el.style.translate = `${d.dx}px ${d.dy}px`; domWrites++ } }
      for (const edge of d.edges.values()) {
        const moved = (n: CanvasNode): Rect => moving.has(n.id) ? { ...n, x: n.x + d.dx, y: n.y + d.dy } : n
        setEdge(edge.element, edgePath(moved(edge.from), moved(edge.to), edge.edge)); domWrites++
      }
      for (const g of snapped.guides) shape('path', { d: g.axis === 'x' ? `M${g.value},${g.start}V${g.end}` : `M${g.start},${g.value}H${g.end}`, class: 'canvas-guide' })
    } else if (d.kind === 'resize') {
      const n = d.nodes[0]
      d.geometry = { x: n.x, y: n.y, width: Math.max(48, Math.round(n.width + p.x - start.x)), height: Math.max(36, Math.round(n.height + p.y - start.y)) }
      const el = s.elements.get(n.id)
      if (el) {
        const graphic = n.ready.graphic ? resizedGraphic(n.ready.graphic, d.geometry.width / n.width, d.geometry.height / n.height) : undefined
        const frame = cardFrame({ ...n, ...d.geometry, ready: { ...n.ready, ...(graphic ? { graphic } : {}) } })
        el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`; el.style.width = `${frame.width}px`; el.style.height = `${frame.height}px`; domWrites += 4
      }
      for (const edge of d.edges.values()) { setEdge(edge.element, edgePath(edge.from.id === n.id ? d.geometry : edge.from, edge.to.id === n.id ? d.geometry : edge.to, edge.edge)); domWrites++ }
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
  up(e: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return
    const s = this.callbacks.scene()!
    this.drag.latest = this.local(e, s)
    this.drag.moved ||= Math.hypot(this.drag.latest.x - this.drag.start.x, this.drag.latest.y - this.drag.start.y) > 2
    if (this.frame !== null) { this.view!.cancelAnimationFrame(this.frame); this.frame = null }
    this.draw()
    const d = this.drag
    this.restoreDOM(s, d); this.drag = null
    if (s.root.hasPointerCapture?.(e.pointerId)) s.root.releasePointerCapture(e.pointerId)
    if (!d.moved) return
    if (d.kind === 'move') {
      if (!d.dx && !d.dy) return
      void this.callbacks.commit(d.nodes.map(n => ({ type: 'geometry', id: n.id, geometry: { x: n.x + d.dx, y: n.y + d.dy } })))
    } else if (d.kind === 'resize' && d.geometry) {
      const n = d.nodes[0], g = n.ready.graphic
      if (g) {
        const sx = d.geometry.width / n.width, sy = d.geometry.height / n.height
        const graphic = resizedGraphic(g, sx, sy)
        void this.callbacks.graphic({ ...d.geometry, id: n.id, graphic }, n)
      } else void this.callbacks.commit([{ type: 'geometry', id: n.id, geometry: d.geometry }])
    } else if (d.kind === 'edge') {
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
  private restoreDOM(s: GestureScene, d: Drag): void {
    s.overlay.replaceChildren()
    if (d.kind === 'move' || d.kind === 'resize') {
      for (const n of d.nodes) { const el = s.elements.get(n.id); if (el) { const frame = cardFrame(n); el.style.translate = ''; el.style.left = `${frame.x}px`; el.style.top = `${frame.y}px`; el.style.width = `${frame.width}px`; el.style.height = `${frame.height}px` } }
      for (const edge of d.edges.values()) setEdge(edge.element, edgePath(edge.from, edge.to, edge.edge))
    }
  }
  cancel(): void {
    if (this.frame !== null) this.view?.cancelAnimationFrame(this.frame)
    this.frame = null
    const s = this.callbacks.scene(), d = this.drag
    this.drag = null
    if (s && d) {
      this.restoreDOM(s, d)
      this.callbacks.select(d.selection); this.callbacks.camera(d.camera)
      if (s.root.hasPointerCapture?.(d.pointerId)) s.root.releasePointerCapture(d.pointerId)
    }
    this.space = false
  }
  wheel(e: WheelEvent): void {
    const s = this.callbacks.scene()
    if (!s || s.busy || this.drag) return
    e.preventDefault(); this.view = s.root.ownerDocument.defaultView
    const c = this.wheelCamera ?? s.camera, unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? s.root.clientHeight : 1
    this.wheelCamera = e.ctrlKey || e.metaKey ? zoomAt(c, this.local(e, s), c.zoom * Math.exp(-e.deltaY * unit * 0.002)) : { ...c, x: c.x - e.deltaX * unit, y: c.y - e.deltaY * unit }
    if (this.wheelFrame === null) this.wheelFrame = this.view!.requestAnimationFrame(() => this.finishWheel())
  }
  private finishWheel(): void {
    if (this.wheelFrame !== null) this.view?.cancelAnimationFrame(this.wheelFrame)
    this.wheelFrame = null
    if (this.wheelCamera) { this.callbacks.camera(this.wheelCamera); this.callbacks.measure?.({ kind: 'wheel', candidates: 0, visited: 0, domWrites: 1 }); this.wheelCamera = null }
  }
  dispose(): void { this.cancel(); if (this.wheelFrame !== null) this.view?.cancelAnimationFrame(this.wheelFrame); this.wheelFrame = null; this.wheelCamera = null }
}
