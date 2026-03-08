export interface TimelineClip {
  id: string
  type: 'video' | 'subtitle' | 'audio'
  start: number
  end: number
  label: string
  color: string
  source?: string
  subtitleText?: string
  trackId?: string
  x?: number
  y?: number
  w?: number
  h?: number
  rotation?: number
  opacity?: number
  borderRadius?: number
  playbackRate?: number
  videoFadeIn?: number
  videoFadeOut?: number
  volumeDb?: number
  audioFadeIn?: number
  audioFadeOut?: number
  captionsStatus?: string
}

export type ClipType = 'video' | 'subtitle' | 'audio'

export interface SelectedClip {
  id: string
  type: ClipType
}

export interface SubtitleStyle {
  fontFamily: string
  fontWeight: string
  fontSize: number
  color: string
}

export interface TimelineTrack {
  id: string
  type: ClipType
  clips: TimelineClip[]
}

export interface TimelineState {
  schemaVersion: 1
  tracks: TimelineTrack[]
  currentTime: number
  duration: number
  zoom: number
}

export interface TimelineSummary {
  videoClips: number
  subtitleClips: number
  audioClips: number
  duration: number
}

export interface TimelineSnapshot {
  schemaVersion: 1
  hash: string
  tracks: TimelineTrack[]
  summary: TimelineSummary
  duration: number
  currentTime: number
  zoom: number
}

export interface RenderCompositionProps {
  width: number
  height: number
  fps: number
  duration: number
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
}

export interface VideoProjectSchema {
  schemaVersion: 1
  projectId: string | null
  primarySourcePath: string | null
  timeline: TimelineSnapshot
  composition: RenderCompositionProps
  previewState: {
    currentTime: number
    isPlaying: boolean
    zoom: number
  }
}
