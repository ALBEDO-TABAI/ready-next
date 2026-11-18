import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { CanvasNode, ReadyCanvas } from '../../../../shared/ready-canvas'
import { activeCanvasContent } from '../../../../shared/ready-canvas/operations'
import { closeFloat, IconButton, openFloat } from '../../ui'

// Slideshow (M4 2026-11-14): double-click a picture and it stands alone over the board; ← → (or space) step through
// the board's pictures in reading order, Esc or a click beside the picture closes. It is a float of the shared
// float host (so the native web view steps aside as for any float), sized to the board rather than the window.
// Videos stand in the same row (2026-11-18): here, away from the board's gestures, a video has the browser's own
// controls. The one the person opened plays at once; one stepped onto waits. Space plays or pauses a video.

export const SLIDESHOW = 'canvas-slideshow'
export interface Slide { id: string; src: string; title: string; kind: 'image' | 'video' }

/** The board's pictures and videos in reading order: rows from the top (cards within 200px count as one row), left to right. */
export function boardSlides(canvas: ReadyCanvas, resolveAsset: (path: string) => string | undefined): Slide[] {
  return activeCanvasContent(canvas).nodes
    .flatMap((node: CanvasNode) => node.type === 'file' && (node.ready.kind === 'image' || node.ready.kind === 'video') ? [node] : [])
    .sort((a, b) => Math.round(a.y / 200) - Math.round(b.y / 200) || a.x - b.x)
    .flatMap(node => {
      const src = resolveAsset(node.file), kind = node.ready.kind === 'video' ? 'video' as const : 'image' as const
      return src ? [{ id: node.id, src, kind, title: node.ready.preview?.title || node.ready.media?.originalName || (kind === 'video' ? '视频' : '图片') }] : []
    })
}

type Box = { left: number; top: number; width: number; height: number }
function SlideshowView({ slides, startId, startAt, bounds, close }: { slides: Slide[]; startId: string; startAt: number; bounds: () => Box; close(): void }) {
  const [index, setIndex] = useState(() => Math.max(0, slides.findIndex(slide => slide.id === startId)))
  const [box, setBox] = useState(bounds)
  const film = useRef<HTMLVideoElement>(null)
  // A video fills the room a picture of its shape would: its own shape once the file says it, 16:9 until then.
  const [shape, setShape] = useState<{ id: string; ratio: number } | null>(null)
  useLayoutEffect(() => {
    const update = () => setBox(bounds())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [bounds])
  const go = (delta: number) => setIndex(current => (current + delta + slides.length) % slides.length)
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === ' ' && film.current) {
        event.preventDefault(); event.stopPropagation()
        if (film.current.paused) film.current.play().catch(() => { /* silent-catch: a play() cut short by the next press is not an error; the video's own controls show its state. */ })
        else film.current.pause()
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); go(1) }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); go(-1) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }) // every render: the handler reads the latest slide count
  const slide = slides[index]
  if (!slide) return null
  const many = slides.length > 1
  return <div className="cv-slideshow" style={box} onClick={close}>
    {slide.kind === 'video'
      ? <video key={slide.id} ref={film} className="cv-slideshow__picture" controls playsInline preload="metadata" aria-label={slide.title} autoPlay={slide.id === startId}
        style={{ '--cv-film-ratio': String(shape?.id === slide.id ? shape.ratio : 16 / 9) } as CSSProperties}
        onLoadedMetadata={event => { const { videoWidth, videoHeight } = event.currentTarget; if (videoWidth > 0 && videoHeight > 0) setShape({ id: slide.id, ratio: videoWidth / videoHeight }) }}
        src={slide.id === startId && startAt > 0 ? `${slide.src}#t=${startAt.toFixed(2)}` : `${slide.src}#t=0.1`} onClick={event => event.stopPropagation()} />
      : <img key={slide.id} className="cv-slideshow__picture" draggable={false} src={slide.src} alt={slide.title} onClick={event => event.stopPropagation()} />}
    <div className="cv-slideshow__bar rn-float" onClick={event => event.stopPropagation()}>
      {many && <IconButton size="lg" icon={<ChevronLeft />} title="上一张（←）" onClick={() => go(-1)} />}
      <span className="cv-slideshow__caption"><span className="cv-slideshow__title">{slide.title}</span>{many && <span className="cv-slideshow__count">{index + 1} / {slides.length}</span>}</span>
      {many && <IconButton size="lg" icon={<ChevronRight />} title="下一张（→）" onClick={() => go(1)} />}
      <IconButton size="lg" icon={<X />} title="关闭（Esc）" onClick={close} />
    </div>
  </div>
}

export function openSlideshow(slides: Slide[], startId: string, board: () => HTMLElement | null, onClose?: () => void, startAt = 0): void {
  if (!slides.some(slide => slide.id === startId)) return
  const bounds = (): Box => { const rect = (board() ?? document.body).getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
  openFloat({ id: SLIDESHOW, role: 'dialog', label: '幻灯片', bare: true, anchor: () => { const b = bounds(); return { left: b.left, top: b.top, right: b.left, bottom: b.top } },
    onClose, render: close => <SlideshowView slides={slides} startId={startId} startAt={startAt} bounds={bounds} close={close} /> })
}
export const closeSlideshow = () => closeFloat(SLIDESHOW)
