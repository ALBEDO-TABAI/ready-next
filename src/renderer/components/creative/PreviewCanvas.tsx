import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Play } from 'lucide-react'
import { Player, type PlayerRef } from '@remotion/player'
import type { TimelineClip, SubtitleStyle, SelectedClip } from '../../modules/video/types'
import TimelineRemotionComposition from './remotion/TimelineRemotionComposition'
import { toLocalFileUrl } from '../../utils/dragDrop'

interface PreviewCanvasProps {
  currentTime: number
  duration: number
  isPlaying: boolean
  onTogglePlay: () => void
  onTimeUpdate: (time: number) => void
  onPlaybackEnded: () => void
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  selectedClip: SelectedClip | null
  subtitleStyle: SubtitleStyle
  isMuted: boolean
}

const FPS = 30
const COMPOSITION_WIDTH = 1080
const COMPOSITION_HEIGHT = 1920
const PREVIEW_FRAME_WIDTH = 370
const PREVIEW_FRAME_HEIGHT = 690
const PREVIEW_INSET = 12

const UI_COLORS = {
  canvasBg: 'var(--bg-editor)',
  frameBg: 'var(--bg-primary)',
  frameBorder: 'var(--border-default)',
  frameShadow: 'var(--shadow-lg)',
  accent: 'var(--color-blue)',
  accentShadow: '0 8px 18px rgba(13,153,255,0.25)',
  selectionFallback: 'var(--border-default)',
  overlay: 'rgba(0, 0, 0, 0.2)',
}

function dbToLinear(db: number): number {
  const safeDb = Math.max(-60, Math.min(18, db))
  return Math.pow(10, safeDb / 20)
}

function isImageSource(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff', 'avif'].includes(ext)
}

export default function PreviewCanvas({
  currentTime,
  duration,
  isPlaying,
  onTogglePlay,
  onTimeUpdate,
  onPlaybackEnded,
  videoClips,
  subtitleClips,
  audioClips,
  selectedClip,
  subtitleStyle,
  isMuted,
}: PreviewCanvasProps) {
  const playerRef = useRef<PlayerRef>(null)
  const nativeVideoRef = useRef<HTMLVideoElement>(null)
  const syncingFrameRef = useRef(false)
  const lastExternalFrameRef = useRef(0)
  const lastPlayerFrameRef = useRef(0)

  const sourceVideoClips = useMemo(
    () =>
      [...videoClips]
        .filter((clip) => !!clip.source && clip.end > clip.start && !isImageSource(clip.source))
        .sort((a, b) => a.start - b.start),
    [videoClips],
  )

  // Native preview is smoother for a single video source and avoids Remotion's preview jitter.
  const useNativePreview = sourceVideoClips.length === 1
  const nativeClip = useNativePreview ? sourceVideoClips[0] : null
  const nativeClipDuration = nativeClip ? Math.max(0.1, nativeClip.end - nativeClip.start) : 0
  const nativeSrc = nativeClip?.source ? toLocalFileUrl(nativeClip.source) : ''

  const durationInFrames = useMemo(
    () => Math.max(1, Math.ceil(duration * FPS)),
    [duration],
  )

  const currentFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(currentTime * FPS)))

  const selectedVisualClip = useMemo(() => {
    if (!selectedClip) return null
    if (selectedClip.type === 'video') return videoClips.find((clip) => clip.id === selectedClip.id) || null
    if (selectedClip.type === 'audio') return audioClips.find((clip) => clip.id === selectedClip.id) || null
    return subtitleClips.find((clip) => clip.id === selectedClip.id) || null
  }, [audioClips, selectedClip, subtitleClips, videoClips])

  const visualOpacity = Math.max(0, Math.min(1, (selectedVisualClip?.opacity ?? 100) / 100))
  const visualRadius = Math.max(0, selectedVisualClip?.borderRadius ?? 0)
  const innerWidth = PREVIEW_FRAME_WIDTH - PREVIEW_INSET * 2
  const innerHeight = PREVIEW_FRAME_HEIGHT - PREVIEW_INSET * 2
  const scaleX = innerWidth / COMPOSITION_WIDTH
  const scaleY = innerHeight / COMPOSITION_HEIGHT

  const nativeLayout = useMemo(() => {
    const clip = nativeClip || selectedVisualClip
    const x = clip?.x ?? 0
    const y = clip?.y ?? 0
    const w = clip?.w ?? COMPOSITION_WIDTH
    const h = clip?.h ?? COMPOSITION_HEIGHT
    const rotation = clip?.rotation ?? 0
    const radius = Math.max(0, clip?.borderRadius ?? 0)
    return {
      left: x * scaleX,
      top: y * scaleY,
      width: Math.max(1, w * scaleX),
      height: Math.max(1, h * scaleY),
      borderRadius: Math.min(24, radius * Math.min(scaleX, scaleY)),
      opacity: visualOpacity,
      rotation,
    }
  }, [nativeClip, scaleX, scaleY, selectedVisualClip, visualOpacity])

  useEffect(() => {
    if (useNativePreview) {
      const video = nativeVideoRef.current
      if (!video) return
      if (nativeClip) {
        video.playbackRate = Math.max(0.25, Math.min(3, nativeClip.playbackRate ?? 1))
      }
      if (isPlaying) {
        void video.play().catch(() => {
          // Ignore autoplay rejections in development.
        })
      } else {
        video.pause()
      }
      return
    }

    const player = playerRef.current
    if (!player) return
    if (isPlaying) {
      player.play()
    } else {
      player.pause()
    }
  }, [isPlaying, useNativePreview])

  useEffect(() => {
    if (useNativePreview) {
      const video = nativeVideoRef.current
      if (!video || !nativeClip) return

      const target = Math.max(0, Math.min(nativeClipDuration, currentTime - nativeClip.start))
      const delta = Math.abs(video.currentTime - target)

      // While playing, only seek for explicit large jumps (scrub / skip).
      if (isPlaying) {
        if (delta > 0.8) {
          video.currentTime = target
        }
        return
      }

      if (delta > 0.03) {
        video.currentTime = target
      }
      return
    }

    const player = playerRef.current
    if (!player) return

    // During playback we use the player as the source of truth and avoid reverse seeks.
    if (isPlaying) return

    const frameDiff = Math.abs(player.getCurrentFrame() - currentFrame)
    if (frameDiff <= 1) return

    syncingFrameRef.current = true
    lastExternalFrameRef.current = currentFrame
    player.seekTo(currentFrame)
    requestAnimationFrame(() => {
      syncingFrameRef.current = false
    })
  }, [currentFrame, isPlaying, nativeClip, nativeClipDuration, useNativePreview])

  useEffect(() => {
    if (useNativePreview) {
      const video = nativeVideoRef.current
      if (!video) return
      video.muted = isMuted
      if (nativeClip) {
        video.volume = Math.max(0, Math.min(1, dbToLinear(nativeClip.volumeDb ?? 0)))
      }
      return
    }

    const player = playerRef.current
    if (!player) return
    if (isMuted) player.mute()
    else player.unmute()
  }, [isMuted, nativeClip, useNativePreview])

  useEffect(() => {
    if (useNativePreview) return

    const player = playerRef.current
    if (!player) return

    const handleFrameUpdate = (event: { detail: { frame: number } }) => {
      lastPlayerFrameRef.current = event.detail.frame
      if (syncingFrameRef.current) return
      if (!isPlaying && event.detail.frame === lastExternalFrameRef.current) return
      onTimeUpdate(event.detail.frame / FPS)
    }

    const handleEnded = () => {
      onPlaybackEnded()
    }

    player.addEventListener('frameupdate', handleFrameUpdate)
    player.addEventListener('ended', handleEnded)

    return () => {
      player.removeEventListener('frameupdate', handleFrameUpdate)
      player.removeEventListener('ended', handleEnded)
    }
  }, [isPlaying, onPlaybackEnded, onTimeUpdate, useNativePreview])

  const handleNativeTimeUpdate = () => {
    if (!nativeClip) return
    const video = nativeVideoRef.current
    if (!video) return

    const absolute = nativeClip.start + video.currentTime
    const clamped = Math.max(nativeClip.start, Math.min(nativeClip.end, absolute))
    onTimeUpdate(clamped)

    if (clamped >= nativeClip.end - 1 / FPS && isPlaying) {
      video.pause()
      onPlaybackEnded()
    }
  }

  const handleNativeEnded = () => {
    if (!nativeClip) return
    onTimeUpdate(nativeClip.end)
    onPlaybackEnded()
  }

  return (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ background: UI_COLORS.canvasBg, padding: 28 }}
    >
      <div
        className="relative"
        style={{
          width: PREVIEW_FRAME_WIDTH,
          height: PREVIEW_FRAME_HEIGHT,
          borderRadius: 14,
          background: UI_COLORS.frameBg,
          border: `1px solid ${UI_COLORS.frameBorder}`,
          boxShadow: UI_COLORS.frameShadow,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: PREVIEW_INSET,
            borderRadius: 10,
            overflow: 'hidden',
            background: UI_COLORS.frameBg,
          }}
        >
          {useNativePreview && nativeClip ? (
            <video
              ref={nativeVideoRef}
              src={nativeSrc}
              muted={isMuted}
              preload="metadata"
              playsInline
              onTimeUpdate={handleNativeTimeUpdate}
              onEnded={handleNativeEnded}
              style={{
                position: 'absolute',
                left: nativeLayout.left,
                top: nativeLayout.top,
                width: nativeLayout.width,
                height: nativeLayout.height,
                objectFit: 'cover',
                background: UI_COLORS.frameBg,
                borderRadius: nativeLayout.borderRadius,
                opacity: nativeLayout.opacity,
                transform: `rotate(${nativeLayout.rotation}deg)`,
                transformOrigin: 'center center',
              }}
            />
          ) : (
            <Player
              ref={playerRef}
              component={TimelineRemotionComposition}
              inputProps={{
                videoClips,
                subtitleClips,
                audioClips,
                subtitleStyle,
                isMuted,
                fps: FPS,
                width: COMPOSITION_WIDTH,
                height: COMPOSITION_HEIGHT,
              }}
              durationInFrames={durationInFrames}
              compositionWidth={COMPOSITION_WIDTH}
              compositionHeight={COMPOSITION_HEIGHT}
              fps={FPS}
              controls={false}
              clickToPlay={false}
              doubleClickToFullscreen={false}
              moveToBeginningWhenEnded={false}
              initiallyMuted={isMuted}
              style={{ width: '100%', height: '100%' }}
            />
          )}
        </div>

        {selectedClip ? (
          <div
            style={{
              position: 'absolute',
              inset: 10,
              border: `2px solid ${UI_COLORS.accent}`,
              borderRadius: Math.min(20, visualRadius + 2),
              pointerEvents: 'none',
            }}
          >
            {[
              { left: -4, top: -4 },
              { right: -4, top: -4 },
              { left: -4, bottom: -4 },
              { right: -4, bottom: -4 },
            ].map((dot: CSSProperties, idx) => (
              <span
                key={idx}
                style={{
                  position: 'absolute',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: UI_COLORS.accent,
                  ...dot,
                }}
              />
            ))}
            <span
              style={{
                position: 'absolute',
                left: '50%',
                bottom: -12,
                transform: 'translateX(-50%)',
                background: UI_COLORS.accent,
                color: 'var(--bg-primary)',
                borderRadius: 8,
                fontSize: 10,
                padding: '2px 8px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {COMPOSITION_WIDTH}x{COMPOSITION_HEIGHT}
            </span>
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 10,
              border: `1px dashed ${UI_COLORS.selectionFallback}`,
              borderRadius: 10,
              pointerEvents: 'none',
            }}
          />
        )}

        {!isPlaying && (
          <button
            onClick={onTogglePlay}
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: UI_COLORS.overlay }}
          >
            <div
              className="flex items-center justify-center rounded-full"
              style={{
                width: 54,
                height: 54,
                background: UI_COLORS.accent,
                boxShadow: UI_COLORS.accentShadow,
              }}
            >
              <Play className="ml-0.5 w-7 h-7 text-white" fill="currentColor" />
            </div>
          </button>
        )}
      </div>
    </div>
  )
}
