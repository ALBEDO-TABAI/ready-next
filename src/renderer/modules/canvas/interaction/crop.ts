import type { Appearance, CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { CanvasOperation } from '../../../../shared/ready-canvas/operations'
import type { Rect } from './geometry'
import type { Handle } from './gestures'

// Cropping a picture card (M4 §11, 2026-11-14). The picture keeps its scale and its place; a frame chooses the part
// that stays. Everything is in the card's own coordinates (origin at the card's top-left corner before the crop, in
// world units, before the card's rotation), so the same numbers serve the overlay and the saved result. The
// attachment file is never touched: the result is `appearance.crop` (a rectangle in fractions of the picture) and the
// card's geometry, which takes the frame's size and therefore the crop's aspect ratio.

export interface PictureSize { width: number; height: number }
export type Crop = NonNullable<Appearance['crop']>
export interface CropSession { image: Rect; frame: Rect }
export type CropGrip = Handle | 'image'
export const MIN_CROP = 36

/** The part of the picture a stored crop shows, as a width / height ratio (undefined: the whole picture). */
export function cropRatio(crop: Crop | undefined, natural: PictureSize): number {
  return crop?.mode === 'rect' ? (crop.w * natural.width) / (crop.h * natural.height) : natural.width / natural.height
}

/** Where the whole picture lies relative to its card, as the card shows it: covering the card (no stretch), centred,
 *  moved by a position crop, or scaled so a rectangle crop covers the card. */
export function pictureRect(card: PictureSize, natural: PictureSize, crop?: Crop): Rect {
  if (crop?.mode === 'rect') {
    const partWidth = crop.w * natural.width, partHeight = crop.h * natural.height, scale = Math.max(card.width / partWidth, card.height / partHeight)
    const width = natural.width * scale, height = natural.height * scale
    return { x: (card.width - partWidth * scale) / 2 - crop.x * width + 0, y: (card.height - partHeight * scale) / 2 - crop.y * height + 0, width, height }
  }
  const scale = Math.max(card.width / natural.width, card.height / natural.height), width = natural.width * scale, height = natural.height * scale
  const at = crop?.mode === 'position' ? { x: crop.x / 100, y: crop.y / 100 } : { x: .5, y: .5 }
  return { x: (card.width - width) * at.x + 0, y: (card.height - height) * at.y + 0, width, height } // + 0: no negative zero
}

export function startCrop(node: Pick<CanvasNode, 'width' | 'height' | 'ready'>, natural: PictureSize): CropSession {
  return { image: pictureRect(node, natural, node.ready.appearance?.crop), frame: { x: 0, y: 0, width: node.width, height: node.height } }
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** One drag from `from`: a grip moves its sides of the frame (inside the picture, never smaller than MIN_CROP unless
 *  the picture is); 'image' slides the picture under the frame without uncovering any of it. */
export function dragCrop(from: CropSession, grip: CropGrip, dx: number, dy: number): CropSession {
  const { image, frame } = from
  if (grip === 'image') {
    return { frame, image: { ...image,
      x: clamp(image.x + dx, frame.x + frame.width - image.width, frame.x), y: clamp(image.y + dy, frame.y + frame.height - image.height, frame.y) } }
  }
  let left = frame.x, top = frame.y, right = frame.x + frame.width, bottom = frame.y + frame.height
  const least = { width: Math.min(MIN_CROP, image.width), height: Math.min(MIN_CROP, image.height) }
  if (grip === 'nw' || grip === 'sw' || grip === 'l') left = clamp(left + dx, image.x, right - least.width)
  if (grip === 'ne' || grip === 'se' || grip === 'r') right = clamp(right + dx, left + least.width, image.x + image.width)
  if (grip === 'nw' || grip === 'ne' || grip === 't') top = clamp(top + dy, image.y, bottom - least.height)
  if (grip === 'sw' || grip === 'se' || grip === 'b') bottom = clamp(bottom + dy, top + least.height, image.y + image.height)
  return { image, frame: { x: left, y: top, width: right - left, height: bottom - top } }
}

/** 还原: the frame takes in the whole picture again, at the scale it has now. */
export const wholePicture = (session: CropSession): CropSession => ({ image: session.image, frame: { ...session.image } })

const fraction = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1e6) / 1e6
const WHOLE = 1e-3

/** The crop the frame stands for; undefined when it holds the whole picture. */
export function sessionCrop({ image, frame }: CropSession): Extract<Crop, { mode: 'rect' }> | undefined {
  const x = fraction((frame.x - image.x) / image.width), y = fraction((frame.y - image.y) / image.height)
  const w = Math.max(1e-6, Math.min(fraction(frame.width / image.width), fraction(1 - x))), h = Math.max(1e-6, Math.min(fraction(frame.height / image.height), fraction(1 - y)))
  return x < WHOLE && y < WHOLE && w > 1 - WHOLE && h > 1 - WHOLE ? undefined : { mode: 'rect', x, y, w, h }
}

/** The one undoable step that applies a crop: the crop on the card's appearance and the card resized to the frame
 *  (so it has the crop's aspect ratio), staying where the frame was drawn — also on a rotated card, whose frame was
 *  drawn in the card's own turned axes. Nothing when the frame was left as it started. */
export function cropOperations(node: CanvasNode, start: CropSession, session: CropSession): CanvasOperation[] {
  const near = (a: Rect, b: Rect) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < .01)
  if (near(start.frame, session.frame) && near(start.image, session.image)) return []
  const { frame } = session, crop = sessionCrop(session)
  const width = Math.max(1, Math.round(frame.width)), height = Math.max(1, Math.round(frame.height))
  const turn = (node.ready.appearance?.rotation ?? 0) * Math.PI / 180
  const dx = frame.x + frame.width / 2 - node.width / 2, dy = frame.y + frame.height / 2 - node.height / 2
  const centre = { x: node.x + node.width / 2 + dx * Math.cos(turn) - dy * Math.sin(turn), y: node.y + node.height / 2 + dx * Math.sin(turn) + dy * Math.cos(turn) }
  const appearance: Appearance = { ...node.ready.appearance }
  if (crop) appearance.crop = crop
  else delete appearance.crop
  return [
    { type: 'appearance', id: node.id, appearance: Object.keys(appearance).length ? appearance : null },
    { type: 'geometry', id: node.id, geometry: { x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2), width, height } },
  ]
}
