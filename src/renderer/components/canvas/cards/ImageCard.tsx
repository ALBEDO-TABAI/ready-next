import { useState, type CSSProperties } from 'react'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import { cropRatio, type Crop, type PictureSize } from '../../../modules/canvas/interaction/crop'

// The picture card (M4 2026-11-14): the picture fills its card (cover) and is never stretched. A stored crop is
// honoured: a position crop (Stillroom's) moves the picture inside the frame; a rectangle crop shows that part of it,
// in a box that keeps the part's own aspect ratio and covers the card — a card whose shape differs from the crop's
// (resized by one edge) shows a little less of the part instead of distorting it.

/** The picture's place: for a position crop on the picture itself, for a rectangle crop inside the crop box. */
export function cropStyle(crop: Crop | undefined): CSSProperties | undefined {
  if (!crop) return undefined
  if (crop.mode === 'position') return { objectPosition: `${crop.x}% ${crop.y}%` }
  return { position: 'absolute', maxWidth: 'none', width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${-crop.x / crop.w * 100}%`, top: `${-crop.y / crop.h * 100}%`, objectFit: 'fill' }
}

export function ImageCard({ node, src }: { node: Extract<CanvasNode, { type: 'file' }>; src?: string }) {
  const title = node.ready.preview?.title || node.ready.media?.originalName || '图片', crop = node.ready.appearance?.crop
  const [loaded, setLoaded] = useState<PictureSize & { src: string }>()
  if (!src) return <figure className="cv-image is-missing" aria-label={title}><figcaption>图片</figcaption></figure>
  const measure = (image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth && image.naturalHeight && (loaded?.src !== src || loaded.width !== image.naturalWidth || loaded.height !== image.naturalHeight)) setLoaded({ src, width: image.naturalWidth, height: image.naturalHeight })
  }
  const picture = <img draggable={false} loading="lazy" decoding="async" src={src} alt={title} style={cropStyle(crop)} ref={measure} onLoad={event => measure(event.currentTarget)} />
  // Until the picture's own size is known the card's shape stands in: right after a crop the two are the same.
  const ratio = loaded?.src === src ? cropRatio(crop, loaded) : node.width / node.height
  return <figure className="cv-image" aria-label={title} title="双击放大">
    {crop?.mode === 'rect' ? <span className="cv-image__crop" style={{ '--cv-crop-ratio': String(ratio) } as CSSProperties}>{picture}</span> : picture}
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
