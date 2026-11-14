import type { CSSProperties } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'

// The picture card (M4 2026-11-14): the picture fills its card (cover). A stored crop is honoured: a position crop
// (Stillroom's) moves the picture inside the frame, a rectangle crop shows exactly that part of it.

export function cropStyle(crop: NonNullable<NonNullable<CanvasNode['ready']['appearance']>['crop']> | undefined): CSSProperties | undefined {
  if (!crop) return undefined
  if (crop.mode === 'position') return { objectPosition: `${crop.x}% ${crop.y}%` }
  return { position: 'absolute', maxWidth: 'none', width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${-crop.x / crop.w * 100}%`, top: `${-crop.y / crop.h * 100}%`, objectFit: 'fill' }
}

export function ImageCard({ node, src }: { node: Extract<CanvasNode, { type: 'file' }>; src?: string }) {
  const title = node.ready.preview?.title || node.ready.media?.originalName || '图片'
  if (!src) return <figure className="cv-image is-missing" aria-label={title}><figcaption>图片</figcaption></figure>
  return <figure className="cv-image" aria-label={title} title="双击放大">
    <img draggable={false} loading="lazy" decoding="async" src={src} alt={title} style={cropStyle(node.ready.appearance?.crop)} />
  </figure>
}

export function VideoCard({ node, src }: { node: Extract<CanvasNode, { type: 'file' }>; src?: string }) {
  const title = node.ready.preview?.title || node.ready.media?.originalName || '视频'
  // preload="metadata" with a media fragment paints the first frame as the poster; the strip above stays draggable.
  return <figure className="cv-video" aria-label={title}>
    <figcaption>{title}</figcaption>
    {src ? <video controls preload="metadata" playsInline src={`${src}#t=0.1`} /> : <div className="cv-video__missing">视频</div>}
  </figure>
}
