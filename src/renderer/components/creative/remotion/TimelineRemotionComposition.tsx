import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame } from 'remotion'
import { Audio, Video } from '@remotion/media'
import { type CSSProperties } from 'react'
import { type SubtitleStyle, type TimelineClip } from '../../../pages/modes/VideoMode'
import { getDroppedFileKind, toLocalFileUrl } from '../../../utils/dragDrop'

export interface TimelineRemotionCompositionProps {
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  subtitleStyle: SubtitleStyle
  isMuted: boolean
  fps: number
  width: number
  height: number
}

function toFrame(timeInSeconds: number, fps: number): number {
  return Math.max(0, Math.round(timeInSeconds * fps))
}

function getSubtitleWeight(fontWeight: string): number {
  if (fontWeight === 'Bold') return 700
  if (fontWeight === 'Light') return 300
  return 400
}

function isImageSource(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return getDroppedFileKind({ ext }) === 'image'
}

function normalizeTimedClips(clips: TimelineClip[]) {
  return [...clips]
    .filter((clip) => clip.end > clip.start)
    .sort((a, b) => a.start - b.start)
}

function dbToLinear(db: number): number {
  const safeDb = Math.max(-60, Math.min(18, db))
  return Math.pow(10, safeDb / 20)
}

export default function TimelineRemotionComposition({
  videoClips,
  subtitleClips,
  audioClips,
  subtitleStyle,
  isMuted,
  fps,
  width,
  height,
}: TimelineRemotionCompositionProps) {
  const frame = useCurrentFrame()
  const normalizedVideoClips = normalizeTimedClips(videoClips)
  const normalizedSubtitleClips = normalizeTimedClips(subtitleClips)
  const normalizedAudioClips = normalizeTimedClips(audioClips)

  const subtitleWeight = getSubtitleWeight(subtitleStyle.fontWeight)

  return (
    <AbsoluteFill style={{ width, height, backgroundColor: '#1A1A1A' }}>
      {normalizedVideoClips.map((clip) => {
        if (!clip.source) return null
        const from = toFrame(clip.start, fps)
        const durationInFrames = Math.max(1, toFrame(clip.end - clip.start, fps))
        const localFrame = frame - from
        const fadeInFrames = Math.max(0, toFrame(clip.videoFadeIn ?? 0, fps))
        const fadeOutFrames = Math.max(0, toFrame(clip.videoFadeOut ?? 0, fps))
        const baseOpacity = Math.max(0, Math.min(1, (clip.opacity ?? 100) / 100))
        const fadeInFactor = fadeInFrames > 0
          ? interpolate(localFrame, [0, fadeInFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
          : 1
        const fadeOutFactor = fadeOutFrames > 0
          ? interpolate(localFrame, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
          : 1
        const visualOpacity = Math.max(0, Math.min(1, baseOpacity * fadeInFactor * fadeOutFactor))
        const clipWidth = Math.max(1, clip.w ?? width)
        const clipHeight = Math.max(1, clip.h ?? height)
        const clipX = clip.x ?? 0
        const clipY = clip.y ?? 0
        const clipRotation = clip.rotation ?? 0
        const clipRadius = Math.max(0, clip.borderRadius ?? 0)
        const playbackRate = Math.max(0.25, Math.min(3, clip.playbackRate ?? 1))
        const baseVolume = dbToLinear(clip.volumeDb ?? 0)
        const clipVolume = (f: number) => {
          const inFrames = Math.max(0, toFrame(clip.audioFadeIn ?? 0, fps))
          const outFrames = Math.max(0, toFrame(clip.audioFadeOut ?? 0, fps))
          const fadeIn = inFrames > 0
            ? interpolate(f, [0, inFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
            : 1
          const fadeOut = outFrames > 0
            ? interpolate(f, [durationInFrames - outFrames, durationInFrames], [1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
            : 1
          return Math.max(0, Math.min(1.8, baseVolume * fadeIn * fadeOut))
        }
        const src = toLocalFileUrl(clip.source)
        const commonStyle: CSSProperties = {
          position: 'absolute',
          left: clipX,
          top: clipY,
          width: clipWidth,
          height: clipHeight,
          objectFit: 'cover',
          backgroundColor: '#FFFFFF',
          opacity: visualOpacity,
          borderRadius: clipRadius,
          transform: `rotate(${clipRotation}deg)`,
          transformOrigin: 'center center',
        }

        return (
          <Sequence
            key={clip.id}
            from={from}
            durationInFrames={durationInFrames}
            premountFor={Math.ceil(fps * 0.5)}
          >
            {isImageSource(clip.source) ? (
              <Img src={src} style={commonStyle} />
            ) : (
              <Video
                src={src}
                style={commonStyle}
                muted={isMuted}
                volume={clipVolume}
                playbackRate={playbackRate}
                fallbackOffthreadVideoProps={{
                  acceptableTimeShiftInSeconds: 1.2,
                  pauseWhenBuffering: true,
                }}
              />
            )}
          </Sequence>
        )
      })}

      {normalizedAudioClips.map((clip) => {
        if (!clip.source) return null
        const from = toFrame(clip.start, fps)
        const durationInFrames = Math.max(1, toFrame(clip.end - clip.start, fps))
        const baseVolume = dbToLinear(clip.volumeDb ?? 0)
        const playbackRate = Math.max(0.25, Math.min(3, clip.playbackRate ?? 1))
        const fadeInFrames = Math.max(0, toFrame(clip.audioFadeIn ?? 0, fps))
        const fadeOutFrames = Math.max(0, toFrame(clip.audioFadeOut ?? 0, fps))
        const volume = (f: number) => {
          const fadeIn = fadeInFrames > 0
            ? interpolate(f, [0, fadeInFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
            : 1
          const fadeOut = fadeOutFrames > 0
            ? interpolate(f, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
            : 1
          return Math.max(0, Math.min(1.8, baseVolume * fadeIn * fadeOut))
        }
        return (
          <Sequence
            key={clip.id}
            from={from}
            durationInFrames={durationInFrames}
            premountFor={Math.ceil(fps * 0.5)}
          >
            <Audio
              src={toLocalFileUrl(clip.source)}
              muted={isMuted}
              volume={volume}
              playbackRate={playbackRate}
            />
          </Sequence>
        )
      })}

      {normalizedSubtitleClips.map((clip) => {
        const text = clip.subtitleText || clip.label
        if (!text) return null
        const from = toFrame(clip.start, fps)
        const durationInFrames = Math.max(1, toFrame(clip.end - clip.start, fps))

        return (
          <Sequence
            key={clip.id}
            from={from}
            durationInFrames={durationInFrames}
            premountFor={Math.ceil(fps * 0.2)}
          >
            <AbsoluteFill
              style={{
                justifyContent: 'flex-end',
                alignItems: 'center',
                paddingBottom: 90,
                pointerEvents: 'none',
              }}
            >
              <div
                style={{
                  maxWidth: '82%',
                  padding: '10px 16px',
                  borderRadius: 8,
                  background: 'rgba(0,0,0,0.53)',
                  color: subtitleStyle.color,
                  fontFamily: subtitleStyle.fontFamily,
                  fontWeight: subtitleWeight,
                  fontSize: Math.max(12, Math.min(subtitleStyle.fontSize / 4, 30)),
                  lineHeight: 1.35,
                  textAlign: 'center',
                  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                }}
              >
                {text}
              </div>
            </AbsoluteFill>
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}
