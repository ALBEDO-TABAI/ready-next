import type { TimelineClip, TimelineSummary, TimelineTrack, VideoProjectSchema } from './types'

export const DEFAULT_VIDEO_RENDER_SPEC = {
  fps: 30,
  width: 1080,
  height: 1920,
} as const

function buildTimelineTracks(
  videoClips: TimelineClip[],
  subtitleClips: TimelineClip[],
  audioClips: TimelineClip[],
): TimelineTrack[] {
  return [
    { id: 'video', type: 'video', clips: videoClips },
    { id: 'subtitle', type: 'subtitle', clips: subtitleClips },
    { id: 'audio', type: 'audio', clips: audioClips },
  ]
}

export function hashVideoTimeline(input: unknown): string {
  const raw = JSON.stringify(input)
  let hash = 0
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i)
    hash |= 0
  }
  return `timeline-${Math.abs(hash).toString(36)}`
}

export function resolvePrimaryVideoSource(
  selectedFile: string | null,
  videoClips: TimelineClip[],
  audioClips: TimelineClip[],
): string | null {
  return (
    selectedFile
    || videoClips.find((clip) => clip.source)?.source
    || audioClips.find((clip) => clip.source)?.source
    || null
  )
}

export function buildTimelineSummary(
  videoClips: TimelineClip[],
  subtitleClips: TimelineClip[],
  audioClips: TimelineClip[],
  duration: number,
): TimelineSummary {
  return {
    videoClips: videoClips.length,
    subtitleClips: subtitleClips.length,
    audioClips: audioClips.length,
    duration,
  }
}

export function buildVideoProjectSchema(input: {
  projectId: string | null
  selectedFile: string | null
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  duration: number
  currentTime: number
  isPlaying: boolean
  zoom: number
  fps?: number
  width?: number
  height?: number
}): VideoProjectSchema {
  const fps = input.fps ?? DEFAULT_VIDEO_RENDER_SPEC.fps
  const width = input.width ?? DEFAULT_VIDEO_RENDER_SPEC.width
  const height = input.height ?? DEFAULT_VIDEO_RENDER_SPEC.height
  const summary = buildTimelineSummary(input.videoClips, input.subtitleClips, input.audioClips, input.duration)
  const tracks = buildTimelineTracks(input.videoClips, input.subtitleClips, input.audioClips)
  const hash = hashVideoTimeline({
    tracks,
    summary,
    width,
    height,
    fps,
  })

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    primarySourcePath: resolvePrimaryVideoSource(input.selectedFile, input.videoClips, input.audioClips),
    timeline: {
      schemaVersion: 1,
      hash,
      tracks,
      summary,
      duration: input.duration,
      currentTime: input.currentTime,
      zoom: input.zoom,
    },
    composition: {
      width,
      height,
      fps,
      duration: input.duration,
      videoClips: input.videoClips,
      subtitleClips: input.subtitleClips,
      audioClips: input.audioClips,
    },
    previewState: {
      currentTime: input.currentTime,
      isPlaying: input.isPlaying,
      zoom: input.zoom,
    },
  }
}

export function buildRenderTimelineRequest(schema: VideoProjectSchema, output: string) {
  return {
    output,
    width: schema.composition.width,
    height: schema.composition.height,
    fps: schema.composition.fps,
    duration: schema.composition.duration,
    tracks: {
      video: schema.composition.videoClips,
      subtitle: schema.composition.subtitleClips,
      audio: schema.composition.audioClips,
    },
  }
}
