import { useRef, type CSSProperties, type PointerEvent } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas/schema'
import type { Rect } from '../../../modules/canvas/interaction/geometry'
import { dragCrop, type CropGrip, type CropSession, type PictureSize } from '../../../modules/canvas/interaction/crop'

// Crop mode on one picture card (M4 §11, 2026-11-14). The whole picture is laid out where the card shows it, dimmed;
// the frame holds the part that stays, at full strength. Grips move the frame's sides, a drag inside the frame slides
// the picture under it. It lives in the board's world layer (so it pans and zooms with the board, and turns with a
// rotated card); the surface owns the session, applies it on Enter or a click outside and drops it on Esc.

export interface CropState { id: string; src: string; natural: PictureSize; key: string; start: CropSession; session: CropSession }
/** What a crop session was started from: when any of it changes under the session, the session is dropped. */
export const cropKey = (node: CanvasNode): string => JSON.stringify([node.x, node.y, node.width, node.height, node.type === 'file' ? node.file : '', node.ready.appearance?.crop ?? null, node.ready.appearance?.rotation ?? 0])

/** The picture's own size: from the card's picture when it is already shown, else by loading the attachment. */
export function pictureSize(shown: HTMLImageElement | null | undefined, src: string): Promise<PictureSize> {
  if (shown?.naturalWidth && shown.naturalHeight) return Promise.resolve({ width: shown.naturalWidth, height: shown.naturalHeight })
  return new Promise((resolve, reject) => {
    const image = new Image(), unreadable = () => reject(new Error('这张图片读不出来，不能裁剪'))
    image.onload = () => { if (image.naturalWidth && image.naturalHeight) resolve({ width: image.naturalWidth, height: image.naturalHeight }); else unreadable() }
    image.onerror = unreadable
    image.src = src
  })
}

const GRIPS: Exclude<CropGrip, 'image'>[] = ['nw', 'ne', 'sw', 'se', 'l', 'r', 't', 'b']
const box = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

export function CropOverlay({ node, state, zoom, onChange }: { node: CanvasNode; state: CropState; zoom: number; onChange(session: CropSession): void }) {
  const drag = useRef<{ pointerId: number; grip: CropGrip; from: CropSession; x: number; y: number } | null>(null)
  const { image, frame } = state.session, rotation = node.ready.appearance?.rotation ?? 0
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const grip = event.target instanceof Element ? event.target.closest('[data-crop-grip]')?.getAttribute('data-crop-grip') as CropGrip | null | undefined : null
    if (!grip || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointerId: event.pointerId, grip, from: state.session, x: event.clientX, y: event.clientY }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== event.pointerId) return
    // Screen distance to the card's own axes: undo the zoom, then the card's turn.
    const sx = (event.clientX - d.x) / zoom, sy = (event.clientY - d.y) / zoom, turn = -rotation * Math.PI / 180
    onChange(dragCrop(d.from, d.grip, sx * Math.cos(turn) - sy * Math.sin(turn), sx * Math.sin(turn) + sy * Math.cos(turn)))
  }
  const up = (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) drag.current = null }
  return <div className="cv-crop" data-canvas-ui data-crop-ui role="group" aria-label="裁剪图片"
    style={{ left: node.x, top: node.y, width: node.width, height: node.height, transform: rotation ? `rotate(${rotation}deg)` : undefined, '--cv-crop-k': String(1 / zoom) } as CSSProperties}
    onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    <div className="cv-crop__ghost" style={box(image)}><img draggable={false} alt="" src={state.src} /></div>
    <div className="cv-crop__frame" data-crop-grip="image" style={box(frame)}>
      <img draggable={false} alt="保留的部分" src={state.src} style={{ left: image.x - frame.x, top: image.y - frame.y, width: image.width, height: image.height }} />
    </div>
    <div className="cv-crop__grips" style={box(frame)}>{GRIPS.map(grip => <span key={grip} className="cv-crop__grip" data-crop-grip={grip} aria-hidden="true" />)}</div>
  </div>
}
