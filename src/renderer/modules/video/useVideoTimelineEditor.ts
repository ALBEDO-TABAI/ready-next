import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { exportTimelineWithFallback } from '../../components/creative/remotion/exportAdapter'
import { getDroppedFilesFromDataTransfer } from '../../utils/dragDrop'
import { DEFAULT_VIDEO_RENDER_SPEC, buildVideoProjectSchema } from './schema'
import type { ClipType, SelectedClip, SubtitleStyle, TimelineClip, VideoProjectSchema } from './types'

interface ClipSnapshot {
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
}

const FRAME_DURATION = 1 / 30
const MAX_HISTORY = 50
const DEFAULT_CANVAS_WIDTH = 1080
const DEFAULT_CANVAS_HEIGHT = 1920
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma', 'opus'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff'])

function buildClipVisualDefaults(trackId: string): Pick<
  TimelineClip,
  | 'trackId'
  | 'x'
  | 'y'
  | 'w'
  | 'h'
  | 'rotation'
  | 'opacity'
  | 'borderRadius'
  | 'playbackRate'
  | 'videoFadeIn'
  | 'videoFadeOut'
  | 'volumeDb'
  | 'audioFadeIn'
  | 'audioFadeOut'
  | 'captionsStatus'
> {
  return {
    trackId,
    x: 0,
    y: 0,
    w: DEFAULT_CANVAS_WIDTH,
    h: DEFAULT_CANVAS_HEIGHT,
    rotation: 0,
    opacity: 100,
    borderRadius: 0,
    playbackRate: 1,
    videoFadeIn: 0,
    videoFadeOut: 0,
    volumeDb: 0,
    audioFadeIn: 0,
    audioFadeOut: 0,
    captionsStatus: 'Captions already generated',
  }
}

interface UseVideoTimelineEditorParams {
  selectedFile: string | null
  selectWorkspaceFile: (path: string | null) => void
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
  setVideoRenderJob: (payload: {
    status?: 'idle' | 'queued' | 'rendering' | 'done' | 'error'
    outputPath?: string | null
    message?: string | null
  }) => void
}

export interface VideoProjectTab {
  id: string
  name: string
  path?: string
}

export function useVideoTimelineEditor({
  selectedFile,
  selectWorkspaceFile,
  setVideoSessionSnapshot,
  setVideoRenderJob,
}: UseVideoTimelineEditorParams) {
  const [activeTool, setActiveTool] = useState('select')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [videoDropActive, setVideoDropActive] = useState(false)
  const [videoClips, setVideoClips] = useState<TimelineClip[]>([
    { id: '1', type: 'video', start: 0, end: 45, label: 'hook', color: '#5B8DEF', ...buildClipVisualDefaults('video-1') },
    { id: '2', type: 'video', start: 45, end: 62, label: 'cut', color: '#E97A2B', ...buildClipVisualDefaults('video-1') },
    { id: '3', type: 'video', start: 62, end: 90, label: 'climax', color: '#5B8DEF', ...buildClipVisualDefaults('video-1') },
  ])
  const [subtitleClips, setSubtitleClips] = useState<TimelineClip[]>([
    {
      id: 's1',
      type: 'subtitle',
      start: 0,
      end: 15,
      label: 'Hello',
      subtitleText: 'Hello, welcome to Ready',
      color: '#10B981',
      ...buildClipVisualDefaults('subtitle-1'),
    },
    {
      id: 's2',
      type: 'subtitle',
      start: 15,
      end: 30,
      label: 'Thinking...',
      subtitleText: 'Thinking...',
      color: '#E97A2B',
      ...buildClipVisualDefaults('subtitle-1'),
    },
    {
      id: 's3',
      type: 'subtitle',
      start: 30,
      end: 45,
      label: 'Reason',
      subtitleText: 'Reason for hiatus',
      color: '#E97A2B',
      ...buildClipVisualDefaults('subtitle-1'),
    },
  ])
  const [audioClips, setAudioClips] = useState<TimelineClip[]>([])
  const [selectedClip, setSelectedClip] = useState<SelectedClip | null>(null)
  const [clipboardClip, setClipboardClip] = useState<TimelineClip | null>(null)
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>({
    fontFamily: 'Source Han Sans',
    fontWeight: 'Regular',
    fontSize: 60,
    color: '#FFFFFF',
  })
  const [history, setHistory] = useState<ClipSnapshot[]>([])
  const [future, setFuture] = useState<ClipSnapshot[]>([])
  const isUndoRedoRef = useRef(false)
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState('')
  const lastImportedSelectionRef = useRef<string | null>(null)
  const [activeProjectTabId, setActiveProjectTabId] = useState('video-project-main')
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const pushHistory = useCallback(() => {
    if (isUndoRedoRef.current) return
    setHistory((prev) => {
      const snapshot: ClipSnapshot = {
        videoClips: [...videoClips],
        subtitleClips: [...subtitleClips],
        audioClips: [...audioClips],
      }
      const next = [...prev, snapshot]
      if (next.length > MAX_HISTORY) next.shift()
      return next
    })
    setFuture([])
  }, [audioClips, subtitleClips, videoClips])

  const handleUndo = useCallback(() => {
    if (history.length === 0) return
    isUndoRedoRef.current = true
    const prev = history[history.length - 1]
    setFuture((f) => [
      ...f,
      { videoClips: [...videoClips], subtitleClips: [...subtitleClips], audioClips: [...audioClips] },
    ])
    setHistory((h) => h.slice(0, -1))
    setVideoClips(prev.videoClips)
    setSubtitleClips(prev.subtitleClips)
    setAudioClips(prev.audioClips)
    setTimeout(() => { isUndoRedoRef.current = false }, 0)
  }, [audioClips, history, subtitleClips, videoClips])

  const handleRedo = useCallback(() => {
    if (future.length === 0) return
    isUndoRedoRef.current = true
    const next = future[future.length - 1]
    setHistory((h) => [
      ...h,
      { videoClips: [...videoClips], subtitleClips: [...subtitleClips], audioClips: [...audioClips] },
    ])
    setFuture((f) => f.slice(0, -1))
    setVideoClips(next.videoClips)
    setSubtitleClips(next.subtitleClips)
    setAudioClips(next.audioClips)
    setTimeout(() => { isUndoRedoRef.current = false }, 0)
  }, [audioClips, future, subtitleClips, videoClips])

  const duration = Math.max(
    ...videoClips.map((c) => c.end),
    ...subtitleClips.map((c) => c.end),
    ...audioClips.map((c) => c.end),
    1,
  )

  const videoProjectSchema = useMemo<VideoProjectSchema>(() => buildVideoProjectSchema({
    projectId: activeProjectTabId,
    selectedFile,
    videoClips,
    subtitleClips,
    audioClips,
    duration,
    currentTime,
    isPlaying,
    zoom,
    fps: DEFAULT_VIDEO_RENDER_SPEC.fps,
    width: DEFAULT_VIDEO_RENDER_SPEC.width,
    height: DEFAULT_VIDEO_RENDER_SPEC.height,
  }), [
    activeProjectTabId,
    audioClips,
    currentTime,
    duration,
    isPlaying,
    selectedFile,
    subtitleClips,
    videoClips,
    zoom,
  ])

  const getSetterForType = useCallback((type: ClipType) => {
    if (type === 'video') return setVideoClips
    if (type === 'audio') return setAudioClips
    return setSubtitleClips
  }, [])

  const getClipsForType = useCallback((type: ClipType) => {
    if (type === 'video') return videoClips
    if (type === 'audio') return audioClips
    return subtitleClips
  }, [audioClips, subtitleClips, videoClips])

  const getSelectedClipData = useCallback(() => {
    if (!selectedClip) {
      return {
        clip: undefined as TimelineClip | undefined,
        type: 'video' as ClipType,
        setter: setVideoClips,
      }
    }
    const clips = getClipsForType(selectedClip.type)
    const setter = getSetterForType(selectedClip.type)
    return { clip: clips.find((c) => c.id === selectedClip.id), type: selectedClip.type, setter }
  }, [getClipsForType, getSetterForType, selectedClip])

  const handleSetCurrentTime = useCallback((time: number) => {
    setCurrentTime(Math.max(0, Math.min(time, duration)))
  }, [duration])

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev)
  }, [])

  const handlePrevFrame = useCallback(() => {
    setCurrentTime((prev) => Math.max(0, prev - FRAME_DURATION))
  }, [])

  const handleNextFrame = useCallback(() => {
    setCurrentTime((prev) => Math.min(duration, prev + FRAME_DURATION))
  }, [duration])

  const handleSelectClip = useCallback((id: string, type: ClipType) => {
    setSelectedClip({ id, type })
  }, [])

  const handleDragStart = useCallback(() => {
    pushHistory()
  }, [pushHistory])

  const handleSplit = useCallback(() => {
    if (!selectedClip) return
    const { clip, type, setter } = getSelectedClipData()
    if (!clip) return
    if (currentTime <= clip.start + 0.1 || currentTime >= clip.end - 0.1) return
    pushHistory()
    const leftClip: TimelineClip = {
      ...clip,
      id: `${clip.id}-L-${Date.now()}`,
      end: currentTime,
    }
    const rightClip: TimelineClip = {
      ...clip,
      id: `${clip.id}-R-${Date.now()}`,
      start: currentTime,
    }
    setter((prev) =>
      [...prev.filter((c) => c.id !== clip.id), leftClip, rightClip].sort((a, b) => a.start - b.start),
    )
    setSelectedClip({ id: leftClip.id, type })
  }, [currentTime, getSelectedClipData, pushHistory, selectedClip])

  const handleCopy = useCallback(() => {
    if (!selectedClip) return
    const { clip } = getSelectedClipData()
    if (!clip) return
    setClipboardClip({ ...clip })
  }, [getSelectedClipData, selectedClip])

  const handlePaste = useCallback(() => {
    if (!clipboardClip) return
    pushHistory()
    const dur = clipboardClip.end - clipboardClip.start
    const newClip: TimelineClip = {
      ...clipboardClip,
      id: `paste-${Date.now()}`,
      start: currentTime,
      end: currentTime + dur,
    }
    const setter = getSetterForType(clipboardClip.type)
    setter((prev) => [...prev, newClip].sort((a, b) => a.start - b.start))
    setSelectedClip({ id: newClip.id, type: clipboardClip.type })
  }, [clipboardClip, currentTime, getSetterForType, pushHistory])

  const handleDelete = useCallback(() => {
    if (!selectedClip) return
    const { clip, setter } = getSelectedClipData()
    if (!clip) return
    pushHistory()
    setter((prev) => prev.filter((c) => c.id !== clip.id))
    setSelectedClip(null)
  }, [getSelectedClipData, pushHistory, selectedClip])

  const handleClipMove = useCallback((clipId: string, trackType: ClipType, newStart: number, newEnd: number) => {
    const setter = getSetterForType(trackType)
    setter((prev) =>
      prev
        .map((c) => (c.id === clipId ? { ...c, start: Math.max(0, newStart), end: Math.max(0, newEnd) } : c))
        .sort((a, b) => a.start - b.start),
    )
  }, [getSetterForType])

  const handleClipTrim = useCallback((clipId: string, trackType: ClipType, newStart: number, newEnd: number) => {
    const setter = getSetterForType(trackType)
    setter((prev) =>
      prev
        .map((c) => (
          c.id === clipId
            ? { ...c, start: Math.max(0, newStart), end: Math.max(newStart + 0.1, newEnd) }
            : c
        ))
        .sort((a, b) => a.start - b.start),
    )
  }, [getSetterForType])

  const handleClipUpdate = useCallback((clipId: string, trackType: ClipType, updates: Partial<TimelineClip>) => {
    pushHistory()
    const setter = getSetterForType(trackType)
    setter((prev) => prev.map((c) => (c.id === clipId ? { ...c, ...updates } : c)))
  }, [getSetterForType, pushHistory])

  const runExportPipeline = useCallback(async () => {
    if (
      videoProjectSchema.timeline.summary.videoClips === 0
      && videoProjectSchema.timeline.summary.audioClips === 0
      && videoProjectSchema.timeline.summary.subtitleClips === 0
    ) {
      setExportMessage('No clips to export')
      setExportState('error')
      setVideoRenderJob({ status: 'error', message: 'No clips to export', outputPath: null })
      setTimeout(() => setExportState('idle'), 3000)
      return { success: false as const, error: 'No clips to export' }
    }

    setExportState('exporting')
    setExportMessage('Exporting...')
    setVideoRenderJob({ status: 'rendering', message: 'Exporting...', outputPath: null })

    try {
      const result = await exportTimelineWithFallback(videoProjectSchema)
      if (result.success) {
        setExportMessage(result.message)
        setExportState('done')
        setVideoRenderJob({ status: 'done', message: result.message, outputPath: result.path })
        setVideoSessionSnapshot({ lastArtifactPath: result.path })
        return result
      }
      setExportMessage(result.error || 'Export failed')
      setExportState('error')
      setVideoRenderJob({ status: 'error', message: result.error || 'Export failed', outputPath: null })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed'
      setExportMessage(message)
      setExportState('error')
      setVideoRenderJob({ status: 'error', message, outputPath: null })
      return { success: false as const, error: message }
    }
  }, [setVideoRenderJob, setVideoSessionSnapshot, videoProjectSchema])

  const handleExport = useCallback(async () => {
    const result = await runExportPipeline()
    setTimeout(() => setExportState('idle'), 5000)
    return result
  }, [runExportPipeline])

  const handleFileDrop = useCallback((filePath: string, fileName: string, trackType: ClipType, trackId?: string) => {
    pushHistory()
    const defaultDuration = 10
    const resolvedTrackId = trackId || (trackType === 'video' ? 'video-1' : trackType === 'audio' ? 'audio-1' : 'subtitle-1')
    const newClip: TimelineClip = {
      id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: trackType,
      start: currentTime,
      end: currentTime + defaultDuration,
      label: fileName,
      color: trackType === 'video' ? '#5B8DEF' : trackType === 'audio' ? '#8B5CF6' : '#10B981',
      source: filePath,
      ...buildClipVisualDefaults(resolvedTrackId),
    }

    const setter = getSetterForType(trackType)
    setter((prev) => [...prev, newClip].sort((a, b) => a.start - b.start))
    setSelectedClip({ id: newClip.id, type: trackType })

    if (trackType === 'video' || trackType === 'audio') {
      window.electronAPI?.video
        ?.getInfo(filePath)
        .then((result) => {
          if (result?.success && result.data?.duration) {
            const realDur = result.data.duration
            setter((prev) => prev.map((c) => (c.id === newClip.id ? { ...c, end: c.start + realDur } : c)))
          }
        })
        .catch(() => {
          /* ignore */
        })
    }
  }, [currentTime, getSetterForType, pushHistory])

  const getTrackTypeFromPath = useCallback((path: string): ClipType | null => {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    if (AUDIO_EXTS.has(ext)) return 'audio'
    if (VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext)) return 'video'
    return null
  }, [])

  const handleToolbarImportMedia = useCallback(() => {
    importInputRef.current?.click()
  }, [])

  const handleImportPickerChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    files.forEach((file) => {
      const maybePath = (file as File & { path?: string }).path
      const path = maybePath || file.name
      const trackType = getTrackTypeFromPath(path)
      if (!trackType) return
      handleFileDrop(path, file.name, trackType)
    })
    e.target.value = ''
  }, [getTrackTypeFromPath, handleFileDrop])

  const handleRootDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files')
      || types.has('application/x-ready-drag')
      || types.has('application/x-ready-file')
      || types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!videoDropActive) setVideoDropActive(true)
  }, [videoDropActive])

  const handleRootDragLeave = useCallback(() => {
    if (videoDropActive) setVideoDropActive(false)
  }, [videoDropActive])

  const handleRootDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return
    e.preventDefault()
    setVideoDropActive(false)

    droppedFiles.forEach((file) => {
      const trackType = getTrackTypeFromPath(file.path)
      if (!trackType) return
      handleFileDrop(file.path, file.name, trackType)
    })
  }, [getTrackTypeFromPath, handleFileDrop])

  useEffect(() => {
    if (!selectedFile) return
    if (selectedFile === lastImportedSelectionRef.current) return
    const trackType = getTrackTypeFromPath(selectedFile)
    if (!trackType) return
    lastImportedSelectionRef.current = selectedFile
    const fileName = selectedFile.split(/[\\/]/).pop() || selectedFile
    handleFileDrop(selectedFile, fileName, trackType)
  }, [getTrackTypeFromPath, handleFileDrop, selectedFile])

  const toolbarTitle = useMemo(() => {
    if (selectedFile) return selectedFile.split(/[\\/]/).pop() || selectedFile
    const primarySource = videoClips.find((clip) => clip.source)?.source
    if (primarySource) return primarySource.split(/[\\/]/).pop() || primarySource
    return '未命名项目'
  }, [selectedFile, videoClips])

  const sourceProjectTabs = useMemo(() => {
    const sourceMap = new Map<string, string>()
    if (selectedFile) {
      sourceMap.set(selectedFile, selectedFile.split(/[\\/]/).pop() || selectedFile)
    }
    for (const clip of [...videoClips, ...audioClips]) {
      if (!clip.source) continue
      if (!sourceMap.has(clip.source)) {
        sourceMap.set(clip.source, clip.source.split(/[\\/]/).pop() || clip.source)
      }
    }
    return Array.from(sourceMap.entries()).map(([path, name]) => ({
      id: `video-source:${path}`,
      name,
      path,
    }))
  }, [audioClips, selectedFile, videoClips])

  const projectTabs = useMemo<VideoProjectTab[]>(() => [
    { id: 'video-project-main', name: toolbarTitle, path: undefined },
    ...sourceProjectTabs,
  ], [sourceProjectTabs, toolbarTitle])

  useEffect(() => {
    if (!projectTabs.some((tab) => tab.id === activeProjectTabId)) {
      setActiveProjectTabId(projectTabs[0]?.id || 'video-project-main')
    }
  }, [activeProjectTabId, projectTabs])

  const handlePreviewTimeUpdate = useCallback((time: number) => {
    handleSetCurrentTime(time)
  }, [handleSetCurrentTime])

  const handlePreviewEnded = useCallback(() => {
    setIsPlaying(false)
    handleSetCurrentTime(duration)
  }, [duration, handleSetCurrentTime])

  const handleProjectTabClick = useCallback((tabId: string, path?: string) => {
    setActiveProjectTabId(tabId)
    if (path) selectWorkspaceFile(path)
  }, [selectWorkspaceFile])

  const handleProjectTabDragStart = useCallback((e: DragEvent, tab: VideoProjectTab) => {
    const payload = JSON.stringify({
      type: 'video-project' as const,
      projectId: 'video-project-main',
      name: tab.name,
      path: tab.path,
      duration,
      videoClipCount: videoClips.length,
      subtitleClipCount: subtitleClips.length,
      audioClipCount: audioClips.length,
      draggedAt: Date.now(),
    })
    e.dataTransfer.setData('application/x-ready-drag', payload)
    if (tab.path) e.dataTransfer.setData('text/plain', tab.path)
    e.dataTransfer.effectAllowed = 'copy'
  }, [audioClips.length, duration, subtitleClips.length, videoClips.length])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        handleDelete()
      } else if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        handleSplit()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault()
        handleCopy()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        e.preventDefault()
        handlePaste()
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        handleRedo()
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        handleUndo()
      } else if (e.key === ' ') {
        e.preventDefault()
        handleTogglePlay()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrevFrame()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNextFrame()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    handleCopy,
    handleDelete,
    handleNextFrame,
    handlePaste,
    handlePrevFrame,
    handleRedo,
    handleSplit,
    handleTogglePlay,
    handleUndo,
  ])

  return {
    activeTool,
    setActiveTool,
    isPlaying,
    currentTime,
    zoom,
    setZoom,
    isMuted,
    setIsMuted,
    videoDropActive,
    videoClips,
    subtitleClips,
    audioClips,
    selectedClip,
    subtitleStyle,
    setSubtitleStyle,
    history,
    future,
    exportState,
    exportMessage,
    activeProjectTabId,
    importInputRef,
    lastImportedSelectionRef,
    duration,
    videoProjectSchema,
    getTrackTypeFromPath,
    handleFileDrop,
    runExportPipeline,
    setExportState,
    setExportMessage,
    handleSetCurrentTime,
    handleTogglePlay,
    handlePrevFrame,
    handleNextFrame,
    handleSelectClip,
    handleDragStart,
    handleClipMove,
    handleClipTrim,
    handleClipUpdate,
    handleUndo,
    handleRedo,
    handleExport,
    handleToolbarImportMedia,
    handleImportPickerChange,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    toolbarTitle,
    projectTabs,
    handlePreviewTimeUpdate,
    handlePreviewEnded,
    handleProjectTabClick,
    handleProjectTabDragStart,
  }
}
