// The settle: cards glide from where they were to where they now are (FLIP), 200ms on the standard curve.
// Dragging itself stays attached to the pointer; only the release, a layout, an undo or a redo settles.

const DURATION = 200, EASING = 'cubic-bezier(.2,.8,.2,1)', LIMIT = 400
type Box = { x: number; y: number; width: number; height: number }

export function captureFrames(elements: ReadonlyMap<string, HTMLElement>, ids?: Iterable<string>): Map<string, Box> {
  const frames = new Map<string, Box>()
  for (const id of ids ?? elements.keys()) {
    const el = elements.get(id)
    if (!el || frames.size >= LIMIT) continue
    const r = el.getBoundingClientRect()
    if (r.width && r.height) frames.set(id, { x: r.x, y: r.y, width: r.width, height: r.height })
  }
  return frames
}
/** Play from the captured frames to the current ones. `zoom` converts screen distances into the world's own units. */
export function playSettle(elements: ReadonlyMap<string, HTMLElement>, before: ReadonlyMap<string, Box>, zoom: number): number {
  const view = [...elements.values()][0]?.ownerDocument.defaultView
  if (!view || view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0
  let played = 0
  for (const [id, a] of before) {
    const el = elements.get(id)
    if (!el || typeof el.animate !== 'function') continue
    for (const running of el.getAnimations?.() ?? []) running.cancel()
    const b = el.getBoundingClientRect()
    if (!b.width || !b.height) continue
    const dx = (a.x - b.x) / zoom, dy = (a.y - b.y) / zoom, sx = a.width / b.width, sy = a.height / b.height
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) continue
    const base = el.style.transform
    el.animate([{ transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy}) ${base}`.trim() }, { transformOrigin: '0 0', transform: base || 'none' }], { duration: DURATION, easing: EASING })
    played++
  }
  return played
}
