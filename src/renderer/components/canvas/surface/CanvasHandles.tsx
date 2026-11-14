import type { Rect } from '../../../modules/canvas/interaction/geometry'

// Stillroom's resize grips, in ink: four quarter arcs hugging the corners (scale in proportion) and four unseen
// strips along the edges (one dimension). The gesture layer reads `data-resize`; nothing here handles events.

const ARCS = [
  { handle: 'nw', d: 'M2,24 A22,22 0 0 1 24,2' },
  { handle: 'ne', d: 'M0,2 A22,22 0 0 1 22,24' },
  { handle: 'sw', d: 'M2,0 A22,22 0 0 0 24,22' },
  { handle: 'se', d: 'M22,0 A22,22 0 0 1 0,22' },
] as const

function Arcs() {
  return <>{ARCS.map(arc => <span key={arc.handle} className="canvas-arc" data-resize={arc.handle} data-corner={arc.handle} aria-hidden="true">
    <svg width="24" height="24" viewBox="0 0 24 24"><path d={arc.d} /></svg>
  </span>)}</>
}

/** A card's own grips: arcs at the corners, strips on the edges. Only the hovered or the one selected card has them. */
export function CardHandles({ edges = true }: { edges?: boolean }) {
  return <>
    {edges && (['l', 'r', 't', 'b'] as const).map(side => <span key={side} className="canvas-edge-grip" data-resize={side} data-side={side} aria-hidden="true" />)}
    <Arcs />
  </>
}

/** Around a multi-selection: its outline is drawn by the surface; these are the four arcs that scale it as one. */
export function HullHandles({ box }: { box: Rect }) {
  return <div className="canvas-hull-handles" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}><Arcs /></div>
}
