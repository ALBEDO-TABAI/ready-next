import { create } from 'zustand'

export interface VideoRenderJobSnapshot {
  status: 'idle' | 'queued' | 'rendering' | 'done' | 'error'
  outputPath: string | null
  message: string | null
  updatedAt: number | null
}

interface VideoSessionState {
  activeProjectId: string | null
  primarySourcePath: string | null
  schemaVersion: 1 | null
  timelineHash: string | null
  timelineSummary: {
    videoClips: number
    subtitleClips: number
    audioClips: number
    duration: number
  }
  renderSpec: {
    fps: number
    width: number
    height: number
  }
  previewState: {
    currentTime: number
    isPlaying: boolean
    zoom: number
  }
  lastArtifactPath: string | null
  renderJob: VideoRenderJobSnapshot
  setSessionSnapshot: (payload: {
    activeProjectId?: string | null
    primarySourcePath?: string | null
    schemaVersion?: 1 | null
    timelineHash?: string | null
    timelineSummary?: Partial<VideoSessionState['timelineSummary']>
    renderSpec?: Partial<VideoSessionState['renderSpec']>
    previewState?: Partial<VideoSessionState['previewState']>
    lastArtifactPath?: string | null
  }) => void
  setRenderJob: (payload: Partial<VideoRenderJobSnapshot>) => void
  reset: () => void
}

const INITIAL_RENDER_JOB: VideoRenderJobSnapshot = {
  status: 'idle',
  outputPath: null,
  message: null,
  updatedAt: null,
}

export const useVideoSession = create<VideoSessionState>((set) => ({
  activeProjectId: null,
  primarySourcePath: null,
  schemaVersion: 1,
  timelineHash: null,
  timelineSummary: {
    videoClips: 0,
    subtitleClips: 0,
    audioClips: 0,
    duration: 0,
  },
  renderSpec: {
    fps: 30,
    width: 1080,
    height: 1920,
  },
  previewState: {
    currentTime: 0,
    isPlaying: false,
    zoom: 1,
  },
  lastArtifactPath: null,
  renderJob: INITIAL_RENDER_JOB,
  setSessionSnapshot: (payload) => set((state) => ({
    activeProjectId: payload.activeProjectId ?? state.activeProjectId,
    primarySourcePath: payload.primarySourcePath ?? state.primarySourcePath,
    schemaVersion: payload.schemaVersion ?? state.schemaVersion,
    timelineHash: payload.timelineHash ?? state.timelineHash,
    timelineSummary: {
      ...state.timelineSummary,
      ...(payload.timelineSummary || {}),
    },
    renderSpec: {
      ...state.renderSpec,
      ...(payload.renderSpec || {}),
    },
    previewState: {
      ...state.previewState,
      ...(payload.previewState || {}),
    },
    lastArtifactPath: payload.lastArtifactPath ?? state.lastArtifactPath,
  })),
  setRenderJob: (payload) => set((state) => ({
    renderJob: {
      ...state.renderJob,
      ...payload,
      updatedAt: Date.now(),
    },
  })),
  reset: () => set({
    activeProjectId: null,
    primarySourcePath: null,
    schemaVersion: 1,
    timelineHash: null,
    timelineSummary: {
      videoClips: 0,
      subtitleClips: 0,
      audioClips: 0,
      duration: 0,
    },
    renderSpec: {
      fps: 30,
      width: 1080,
      height: 1920,
    },
    previewState: {
      currentTime: 0,
      isPlaying: false,
      zoom: 1,
    },
    lastArtifactPath: null,
    renderJob: INITIAL_RENDER_JOB,
  }),
}))
