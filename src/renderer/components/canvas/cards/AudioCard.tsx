import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Pause, Play } from 'lucide-react'
import type { CanvasNode } from '../../../../shared/ready-canvas'
import { seekAudio, toggleAudio, useAudioPlayer } from '../../../modules/canvas/audio-player'
import { loadPeaks } from '../../../modules/canvas/waveform'

// The voice card (M4 2026-11-14): play or pause, the sound's own shape with the played part in ink, its length,
// when it was taken, and the transcript — or, honestly, that there is none and why. The signal colour is not used:
// progress is ink (V5).

const BARS = 44
export const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
const two = (value: number) => String(value).padStart(2, '0')
export const when = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日 ${two(date.getHours())}:${two(date.getMinutes())}`
/** When the sound was taken: the card's own stamp (a recording, a dropped file) or its FastCard source. */
export function capturedAt(node: CanvasNode): string | undefined {
  const value = node.ready.preview?.fetchedAt ?? node.ready.sources?.find(source => source.capturedAt)?.capturedAt
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined
}

export function AudioCard({ node, src, transcriptionAvailable, peaks: loadShape = loadPeaks }: {
  node: Extract<CanvasNode, { type: 'file' }>; src?: string
  /** Whether Ready can transcribe at all right now; undefined while unknown. */
  transcriptionAvailable?: boolean
  peaks?: (src: string, bars: number) => Promise<number[] | null>
}) {
  const media = node.ready.media, player = useAudioPlayer(node.id)
  const [shape, setShape] = useState<number[] | null>(null)
  useEffect(() => {
    let current = true
    setShape(null)
    if (src) void loadShape(src, BARS).then(value => { if (current) setShape(value) })
    return () => { current = false }
  }, [src, loadShape])
  const length = media?.durationMs ?? (player.duration ? player.duration * 1000 : undefined)
  const played = player.id === node.id && length ? Math.min(1, player.time * 1000 / length) : 0
  const stamp = capturedAt(node), transcript = media?.transcript?.trim()
  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width > 0) seekAudio(node.id, (event.clientX - box.left) / box.width, (length ?? 0) / 1000)
  }
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault(); event.stopPropagation()
    seekAudio(node.id, played + (event.key === 'ArrowRight' ? .05 : -.05), (length ?? 0) / 1000)
  }
  return <article className="cv-audio" aria-label="语音卡" data-playing={player.playing || undefined}>
    <header className="cv-audio__head">
      <strong className="cv-audio__title">{node.ready.preview?.title || media?.originalName || '录音'}</strong>
      {stamp && <time dateTime={stamp}>{when(new Date(stamp))}</time>}
    </header>
    <div className="cv-audio__player">
      <button type="button" className="cv-audio__play" aria-label={player.playing ? '暂停' : '播放'} disabled={!src}
        onClick={() => { if (src) void toggleAudio(node.id, src) }}>{player.playing ? <Pause aria-hidden /> : <Play aria-hidden />}</button>
      <div className="cv-audio__wave" data-canvas-ui role="slider" tabIndex={0} aria-label="播放位置" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(played * 100)}
        data-shape={shape ? 'peaks' : 'line'} onPointerDown={seek} onKeyDown={nudge}>
        {shape ? shape.map((peak, index) => <i key={index} data-played={(index + .5) / BARS <= played || undefined} style={{ height: `${Math.round(12 + peak * 88)}%` }} />)
          : <span className="cv-audio__line"><span style={{ width: `${played * 100}%` }} /></span>}
      </div>
      <span className="cv-audio__time">{player.id === node.id && (player.playing || player.time > 0) ? `${clock(player.time * 1000)} / ` : ''}{length === undefined ? '--:--' : clock(length)}</span>
    </div>
    {player.error && <p className="cv-audio__note" role="alert">{player.error}</p>}
    {transcript ? <p className="cv-audio__transcript">{transcript}</p>
      : <p className="cv-audio__note" data-untranscribed>未转写{transcriptionAvailable === false && <span> · 还没有接入能转写音频的模型</span>}</p>}
  </article>
}
