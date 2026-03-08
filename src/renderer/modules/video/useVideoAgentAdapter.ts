import { useEffect } from 'react'
import { registerModuleAgentHandler } from '../../utils/moduleAgentBridge'
import { createVideoAgentHandler } from './video-agent-handler'
import { buildVideoProjectSchema } from './schema'
import type { TimelineClip } from './types'

interface UseVideoAgentAdapterParams {
  activeProjectTabId: string
  selectedFile: string | null
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  duration: number
  currentTime: number
  isPlaying: boolean
  zoom: number
  setVideoSessionSnapshot: (payload: {
    activeProjectId?: string | null
    primarySourcePath?: string | null
    schemaVersion?: 1 | null
    timelineHash?: string | null
    timelineSummary?: { videoClips: number; subtitleClips: number; audioClips: number; duration: number }
    previewState?: { currentTime: number; isPlaying: boolean; zoom: number }
    renderSpec?: { fps: number; width: number; height: number }
    lastArtifactPath?: string | null
  }) => void
  setVideoRenderJob: (payload: { status?: 'idle' | 'queued' | 'rendering' | 'done' | 'error'; outputPath?: string | null; message?: string | null }) => void
  getTrackTypeFromPath: (path: string) => 'video' | 'subtitle' | 'audio' | null
  handleFileDrop: (path: string, name: string, type: 'video' | 'subtitle' | 'audio') => void
  runExportPipeline: () => Promise<{ success: true; path: string; message: string } | { success: false; error: string }>
  setExportState: (value: 'idle' | 'exporting' | 'done' | 'error') => void
  setExportMessage: (value: string) => void
  selectWorkspaceFile: (path: string | null) => void
  lastImportedSelectionRef: React.MutableRefObject<string | null>
}

export function useVideoAgentAdapter(params: UseVideoAgentAdapterParams): void {
  const {
    activeProjectTabId,
    selectedFile,
    videoClips,
    subtitleClips,
    audioClips,
    duration,
    currentTime,
    isPlaying,
    zoom,
    setVideoSessionSnapshot,
    setVideoRenderJob,
    getTrackTypeFromPath,
    handleFileDrop,
    runExportPipeline,
    setExportState,
    setExportMessage,
    selectWorkspaceFile,
    lastImportedSelectionRef,
  } = params

  useEffect(() => {
    const schema = buildVideoProjectSchema({
      projectId: activeProjectTabId,
      selectedFile,
      videoClips,
      subtitleClips,
      audioClips,
      duration,
      currentTime,
      isPlaying,
      zoom,
    })
    setVideoSessionSnapshot({
      activeProjectId: schema.projectId,
      primarySourcePath: schema.primarySourcePath,
      schemaVersion: schema.schemaVersion,
      timelineHash: schema.timeline.hash,
      timelineSummary: schema.timeline.summary,
      previewState: schema.previewState,
      renderSpec: {
        fps: schema.composition.fps,
        width: schema.composition.width,
        height: schema.composition.height,
      },
    })
  }, [
    activeProjectTabId,
    audioClips,
    currentTime,
    duration,
    isPlaying,
    selectedFile,
    setVideoSessionSnapshot,
    subtitleClips,
    videoClips,
    zoom,
  ])

  useEffect(() => {
    return registerModuleAgentHandler('video', createVideoAgentHandler({
      activeProjectTabId,
      selectedFile,
      videoClips,
      subtitleClips,
      audioClips,
      duration,
      currentTime,
      isPlaying,
      zoom,
      setVideoSessionSnapshot,
      setVideoRenderJob,
      getTrackTypeFromPath,
      handleFileDrop,
      runExportPipeline,
      setExportState,
      setExportMessage,
      selectWorkspaceFile,
      lastImportedSelectionRef,
    }))
  }, [
    activeProjectTabId,
    audioClips,
    currentTime,
    duration,
    getTrackTypeFromPath,
    handleFileDrop,
    isPlaying,
    lastImportedSelectionRef,
    runExportPipeline,
    selectWorkspaceFile,
    selectedFile,
    setExportMessage,
    setExportState,
    setVideoRenderJob,
    setVideoSessionSnapshot,
    subtitleClips,
    videoClips,
    zoom,
  ])
}
