import { GraphicSchema, type Graphic } from './schema'
import { sha256 } from './serialization'

/** The ink a new drawing (rectangle, arrow, freehand) is saved with: it is written into the board file, so it is
 *  the drawing's own colour (content data), not an interface token. */
export const DEFAULT_GRAPHIC_STROKE = '#ff5a1f'

/** Old arrows are vectors from (0,0); their visible frame includes negative endpoints. */
export function graphicFrame(graphic: Graphic, width: number, height: number) {
  if (graphic.type !== 'arrow') return { x: 0, y: 0, width, height }
  return { x: Math.min(0, graphic.x2) - 12, y: Math.min(0, graphic.y2) - 12,
    width: Math.max(1, Math.abs(graphic.x2)) + 24, height: Math.max(1, Math.abs(graphic.y2)) + 24 }
}

/** No user-supplied markup; only validated numeric geometry and escaped paint values. */
export function graphicSvg(input: Graphic, width: number, height: number): string {
  const graphic = GraphicSchema.parse(input)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('Invalid SVG size')
  const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
  const style = `stroke="${escape(graphic.stroke)}" stroke-width="${graphic.strokeWidth}"`
  let body: string
  if (graphic.type === 'rect') body = `<rect width="${width}" height="${height}" fill="${escape(graphic.fill)}" ${style}/>`
  else if (graphic.type === 'arrow') body = `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${escape(graphic.stroke)}"/></marker></defs><line x1="0" y1="0" x2="${graphic.x2}" y2="${graphic.y2}" ${style} marker-end="url(#arrow)"/>`
  else body = `<polyline points="${graphic.points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${style}/>`
  const frame = graphicFrame(graphic, width, height)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="${frame.x} ${frame.y} ${frame.width} ${frame.height}" overflow="visible">${body}</svg>`
}

/** Where a drawing's SVG lives: beside the board, named by the SHA-256 of its bytes. Main derives the same path from
 *  the saved node on every write; a caller that predicts a different one sees the saved board differ from its own. */
export async function graphicAssetPath(canvasPath: string, graphic: Graphic, width: number, height: number): Promise<string> {
  return `${canvasPath.replace(/\.canvas$/i, '')}.assets/${await sha256(graphicSvg(graphic, width, height))}.svg`
}
