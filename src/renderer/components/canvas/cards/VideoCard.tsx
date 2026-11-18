import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Maximize2, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import { CANVAS_PRESS } from '../../../modules/canvas/interaction/gestures'
import { clock } from './AudioCard'

// The video card (2026-11-18). Its picture is part of the card: a press on it picks the card and a drag moves it, as
// on a picture card. Playing is the card's own: a round mark in the middle (a press that does not move starts or
// pauses; a drag from it still moves the card) and a thin bar along the bottom (pause, position, sound, enlarge).
// The browser's built-in controls are not used on the board: they take every press on the picture, which left only
// the title strip to move a video by. The enlarged view shows them, away from the board.

/** The poster: a media fragment with preload="metadata" paints this moment as the still picture. */
const POSTER_AT = .1

export function VideoCard({ node, src, onEnlarge }: {
  node: Extract<CanvasNode, { type: 'file' }>; src?: string
  /** Show the video alone over the board (double-click does the same). */
  onEnlarge?: () => void
}) {
  const title = node.ready.preview?.title || node.ready.media?.originalName || '视频'
  const video = useRef<HTMLVideoElement>(null), mark = useRef<HTMLSpanElement>(null)
  const [playing, setPlaying] = useState(false), [started, setStarted] = useState(false), [failed, setFailed] = useState(false)
  const [time, setTime] = useState(0), [length, setLength] = useState((node.ready.media?.durationMs ?? 0) / 1000), [muted, setMuted] = useState(false)
  const toggle = useCallback(() => {
    const element = video.current
    if (!element) return
    if (!element.paused) { element.pause(); return }
    element.play().catch((cause: unknown) => {
      // silent-catch: a play() cut short by a pause is not an error; anything else is said on the card.
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setFailed(true)
    })
  }, [])
  // The board holds the pointer during a press, so the mark hears of an unmoved press from the board, not as a click.
  useEffect(() => {
    const element = mark.current
    if (!element) return
    element.addEventListener(CANVAS_PRESS, toggle)
    return () => element.removeEventListener(CANVAS_PRESS, toggle)
  }, [toggle, src, failed])
  const seek = (seconds: number) => {
    const element = video.current
    if (!element || !(length > 0)) return
    element.currentTime = Math.max(0, Math.min(length, seconds))
    setTime(element.currentTime); setStarted(true)
  }
  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture?.(event.pointerId)
    else if (!(event.buttons & 1)) return
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) seek((event.clientX - box.left) / box.width * length)
  }
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault(); event.stopPropagation()
    seek((video.current?.currentTime ?? 0) + (event.key === 'ArrowRight' ? 5 : -5))
  }
  const played = length > 0 ? Math.min(1, time / length) : 0
  return <figure className="cv-video" aria-label={title} title="双击放大" data-playing={playing || undefined} data-started={started || undefined}>
    <figcaption>{title}</figcaption>
    {src ? <div className="cv-video__stage">
      <video ref={video} preload="metadata" playsInline muted={muted} src={`${src}#t=${POSTER_AT}`}
        onPlay={() => { setPlaying(true); setStarted(true); setFailed(false) }} onPause={() => setPlaying(false)}
        onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
        onDurationChange={event => { const value = event.currentTarget.duration; if (Number.isFinite(value) && value > 0) setLength(value) }}
        onEnded={event => { event.currentTarget.currentTime = POSTER_AT; setPlaying(false); setStarted(false); setTime(0) }}
        onError={() => { setPlaying(false); setFailed(true) }} />
      {failed ? <p className="cv-video__note" role="alert">这段视频无法播放</p>
        : <span ref={mark} className="cv-video__mark" data-canvas-press aria-hidden>{playing ? <Pause /> : <Play />}</span>}
      {!started && !failed && length > 0 && <span className="cv-video__length">{clock(length * 1000)}</span>}
      {!failed && <div className="cv-video__bar">
        <button type="button" className="cv-video__button" data-fill aria-label={playing ? '暂停' : '播放'} title={playing ? '暂停' : '播放'} onClick={toggle}>{playing ? <Pause aria-hidden /> : <Play aria-hidden />}</button>
        <div className="cv-video__track" data-canvas-ui role="slider" tabIndex={0} aria-label="播放位置" title="播放位置" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(played * 100)}
          onPointerDown={scrub} onPointerMove={scrub} onKeyDown={nudge}><i className="cv-video__line"><i style={{ width: `${played * 100}%` }} /></i></div>
        <span className="cv-video__time">{clock(time * 1000)} / {length > 0 ? clock(length * 1000) : '--:--'}</span>
        <button type="button" className="cv-video__button" data-extra aria-label={muted ? '打开声音' : '静音'} title={muted ? '打开声音' : '静音'} aria-pressed={muted} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}</button>
        {onEnlarge && <button type="button" className="cv-video__button" data-extra aria-label="放大" title="放大" onClick={onEnlarge}><Maximize2 aria-hidden /></button>}
      </div>}
    </div> : <div className="cv-video__missing">视频</div>}
  </figure>
}
