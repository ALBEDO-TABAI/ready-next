import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import EditorToolbar from '../../components/creative/EditorToolbar'
import PreviewCanvas from '../../components/creative/PreviewCanvas'
import PropertiesPanel from '../../components/creative/PropertiesPanel'
import PlaybackControls from '../../components/creative/PlaybackControls'
import Timeline from '../../components/creative/Timeline'
import { exportTimelineWithFallback } from '../../components/creative/remotion/exportAdapter'
import { useWorkspace } from '../../stores/useWorkspace'
import { getDroppedFilesFromDataTransfer } from '../../utils/dragDrop'
import { MorphTabButton, MorphTabStrip } from '../../components/motion/MorphTabStrip'

// ── Shared data models (consumed by sub-components) ──────────────────

export interface TimelineClip {
  id: string
  type: 'video' | 'subtitle' | 'audio'
  start: number      // seconds
  end: number         // seconds
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

export interface TimelineState {
  schemaVersion: 1
  tracks: {
    id: string
    type: 'video' | 'subtitle' | 'audio'
    clips: TimelineClip[]
  }[]
  currentTime: number
  duration: number
  zoom: number
}

export interface SubtitleStyle {
  fontFamily: string
  fontWeight: string
  fontSize: number
  color: string
}

// ── History snapshot for undo/redo ───────────────────────────────────

interface ClipSnapshot {
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
}

// ── Constants ────────────────────────────────────────────────────────

const FRAME_DURATION = 1 / 30 // one frame at 30fps
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

// ── Container component ──────────────────────────────────────────────

export default function VideoMode() {
  const selectedFile = useWorkspace((state) => state.selectedFile)
  const selectWorkspaceFile = useWorkspace((state) => state.selectFile)
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

  // Subtitle style state
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>({
    fontFamily: 'Source Han Sans',
    fontWeight: 'Regular',
    fontSize: 60,
    color: '#FFFFFF',
  })

  // Undo/Redo history
  const [history, setHistory] = useState<ClipSnapshot[]>([])
  const [future, setFuture] = useState<ClipSnapshot[]>([])
  const isUndoRedoRef = useRef(false)

  // Export state
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle')
  const [exportMessage, setExportMessage] = useState('')
  const lastImportedSelectionRef = useRef<string | null>(null)
  const [activeProjectTabId, setActiveProjectTabId] = useState('video-project-main')
  const importInputRef = useRef<HTMLInputElement | null>(null)

  // ── Push to history (called before any clip mutation) ──────────

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
  }, [videoClips, subtitleClips, audioClips])

  // ── Undo ──────────────────────────────────────────────────────

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
  }, [history, videoClips, subtitleClips, audioClips])

  // ── Redo ──────────────────────────────────────────────────────

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
  }, [future, videoClips, subtitleClips, audioClips])

  // ── Computed values ────────────────────────────────────────────

  const duration = Math.max(
    ...videoClips.map((c) => c.end),
    ...subtitleClips.map((c) => c.end),
    ...audioClips.map((c) => c.end),
    1,
  )

  // ── Track helpers ──────────────────────────────────────────────

  const getSetterForType = useCallback((type: ClipType) => {
    if (type === 'video') return setVideoClips
    if (type === 'audio') return setAudioClips
    return setSubtitleClips
  }, [])

  const getClipsForType = useCallback(
    (type: ClipType) => {
      if (type === 'video') return videoClips
      if (type === 'audio') return audioClips
      return subtitleClips
    },
    [videoClips, audioClips, subtitleClips],
  )

  const getSelectedClipData = useCallback(() => {
    if (!selectedClip)
      return {
        clip: undefined as TimelineClip | undefined,
        type: 'video' as ClipType,
        setter: setVideoClips,
      }
    const clips = getClipsForType(selectedClip.type)
    const setter = getSetterForType(selectedClip.type)
    return { clip: clips.find((c) => c.id === selectedClip.id), type: selectedClip.type, setter }
  }, [selectedClip, getClipsForType, getSetterForType])

  // ── Handlers ─────────────────────────────────────────────────

  const handleSetCurrentTime = useCallback(
    (time: number) => {
      setCurrentTime(Math.max(0, Math.min(time, duration)))
    },
    [duration],
  )

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

  // Called by Timeline when a drag (move or trim) begins
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
      [...prev.filter((c) => c.id !== clip.id), leftClip, rightClip].sort(
        (a, b) => a.start - b.start,
      ),
    )
    setSelectedClip({ id: leftClip.id, type })
  }, [selectedClip, currentTime, getSelectedClipData, pushHistory])

  const handleCopy = useCallback(() => {
    if (!selectedClip) return
    const { clip } = getSelectedClipData()
    if (!clip) return
    setClipboardClip({ ...clip })
  }, [selectedClip, getSelectedClipData])

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
  }, [selectedClip, getSelectedClipData, pushHistory])

  const handleClipMove = useCallback(
    (clipId: string, trackType: ClipType, newStart: number, newEnd: number) => {
      // History is pushed by onDragStart, not here (called per-frame during drag)
      const setter = getSetterForType(trackType)
      setter((prev) =>
        prev
          .map((c) =>
            c.id === clipId
              ? { ...c, start: Math.max(0, newStart), end: Math.max(0, newEnd) }
              : c,
          )
          .sort((a, b) => a.start - b.start),
      )
    },
    [getSetterForType],
  )

  // ── Clip trim handler (called per-frame during edge drag) ─────

  const handleClipTrim = useCallback(
    (clipId: string, trackType: ClipType, newStart: number, newEnd: number) => {
      const setter = getSetterForType(trackType)
      setter((prev) =>
        prev
          .map((c) =>
            c.id === clipId
              ? { ...c, start: Math.max(0, newStart), end: Math.max(newStart + 0.1, newEnd) }
              : c,
          )
          .sort((a, b) => a.start - b.start),
      )
    },
    [getSetterForType],
  )

  // ── Clip update (from PropertiesPanel) ─────────────────────────

  const handleClipUpdate = useCallback(
    (clipId: string, trackType: ClipType, updates: Partial<TimelineClip>) => {
      pushHistory()
      const setter = getSetterForType(trackType)
      setter((prev) =>
        prev.map((c) => (c.id === clipId ? { ...c, ...updates } : c)),
      )
    },
    [getSetterForType, pushHistory],
  )

  // ── Export handler ───────────────────────────────────────────

  const handleExport = useCallback(async () => {
    if (videoClips.length === 0 && audioClips.length === 0 && subtitleClips.length === 0) {
      setExportMessage('No clips to export')
      setExportState('error')
      setTimeout(() => setExportState('idle'), 3000)
      return
    }

    setExportState('exporting')
    setExportMessage('Exporting...')

    try {
      const result = await exportTimelineWithFallback({
        videoClips,
        subtitleClips,
        audioClips,
        duration,
        fps: 30,
        width: 1080,
        height: 1920,
      })

      if (result.success) {
        setExportMessage(result.message)
        setExportState('done')
      } else {
        setExportMessage(result.error || 'Export failed')
        setExportState('error')
      }
    } catch (err) {
      setExportMessage(err instanceof Error ? err.message : 'Export failed')
      setExportState('error')
    }

    setTimeout(() => setExportState('idle'), 5000)
  }, [videoClips, subtitleClips, audioClips, duration])

  // ── File drop handler ─────────────────────────────────────────

  const handleFileDrop = useCallback(
    (filePath: string, fileName: string, trackType: ClipType, trackId?: string) => {
      pushHistory()
      const defaultDuration = 10
      const resolvedTrackId = trackId || (trackType === 'video' ? 'video-1' : trackType === 'audio' ? 'audio-1' : 'subtitle-1')
      const newClip: TimelineClip = {
        id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: trackType,
        start: currentTime,
        end: currentTime + defaultDuration,
        label: fileName,
        color:
          trackType === 'video'
            ? '#5B8DEF'
            : trackType === 'audio'
              ? '#8B5CF6'
              : '#10B981',
        source: filePath,
        ...buildClipVisualDefaults(resolvedTrackId),
      }

      const setter = getSetterForType(trackType)
      setter((prev) => [...prev, newClip].sort((a, b) => a.start - b.start))
      setSelectedClip({ id: newClip.id, type: trackType })

      // Try to get real duration via electronAPI
      if (trackType === 'video' || trackType === 'audio') {
        window.electronAPI?.video
          ?.getInfo(filePath)
          .then((result) => {
            if (result?.success && result.data?.duration) {
              const realDur = result.data.duration
              setter((prev) =>
                prev.map((c) =>
                  c.id === newClip.id ? { ...c, end: c.start + realDur } : c,
                ),
              )
            }
          })
          .catch(() => {
            /* ignore - use default duration */
          })
      }
    },
    [currentTime, getSetterForType, pushHistory],
  )

  const getTrackTypeFromPath = useCallback((path: string): ClipType | null => {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    if (AUDIO_EXTS.has(ext)) return 'audio'
    if (VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext)) return 'video'
    return null
  }, [])

  const handleToolbarImportMedia = useCallback(() => {
    importInputRef.current?.click()
  }, [])

  const handleImportPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
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

  const handleRootDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const types = new Set(Array.from(e.dataTransfer.types || []))
    const canAccept =
      types.has('Files') ||
      types.has('application/x-ready-drag') ||
      types.has('application/x-ready-file') ||
      types.has('text/plain')
    if (!canAccept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!videoDropActive) setVideoDropActive(true)
  }, [videoDropActive])

  const handleRootDragLeave = useCallback(() => {
    if (videoDropActive) setVideoDropActive(false)
  }, [videoDropActive])

  const handleRootDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
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
    if (selectedFile) {
      return selectedFile.split(/[\\/]/).pop() || selectedFile
    }
    const primarySource = videoClips.find((clip) => clip.source)?.source
    if (primarySource) {
      return primarySource.split(/[\\/]/).pop() || primarySource
    }
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

  const projectTabs = useMemo(() => {
    return [
      { id: 'video-project-main', name: toolbarTitle, path: undefined as string | undefined },
      ...sourceProjectTabs,
    ]
  }, [sourceProjectTabs, toolbarTitle])

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
    if (path) {
      selectWorkspaceFile(path)
    }
  }, [selectWorkspaceFile])

  const handleProjectTabDragStart = useCallback((e: React.DragEvent, tab: { id: string; name: string; path?: string }) => {
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
    if (tab.path) {
      e.dataTransfer.setData('text/plain', tab.path)
    }
    e.dataTransfer.effectAllowed = 'copy'
  }, [audioClips.length, duration, subtitleClips.length, videoClips.length])

  // ── Keyboard shortcuts ─────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when typing in form elements
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
    handleDelete,
    handleSplit,
    handleCopy,
    handlePaste,
    handleTogglePlay,
    handlePrevFrame,
    handleNextFrame,
    handleUndo,
    handleRedo,
  ])

  // ── Render ───────────────────────────────────────────────────

  return (
    <div
      className="workbench-mode-root relative"
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      style={{
        background: videoDropActive ? 'var(--color-blue-light)' : 'var(--bg-primary)',
        transition: 'background 0.15s ease',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <input
        ref={importInputRef}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={handleImportPickerChange}
        style={{ display: 'none' }}
      />

      {videoDropActive && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ zIndex: 40 }}
        >
          <div
            className="glass-surface-floating"
            style={{
              padding: '10px 16px',
              borderRadius: 12,
              border: '1px dashed var(--color-blue)',
              background: 'var(--surface-floating-bg)',
              color: 'var(--color-blue)',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            松开以导入到时间线（图片/视频到视频轨，音频到音轨）
          </div>
        </div>
      )}

      <div
        className="glass-surface-panel flex items-center gap-1 overflow-hidden flex-shrink-0"
        style={{
          height: 34,
          padding: '0 8px',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--surface-toolbar-bg)',
        }}
      >
        <MorphTabStrip layoutId="video-tabs" className="flex items-center gap-1 min-w-0 flex-1">
          {projectTabs.map((tab) => {
            const isActive = tab.id === activeProjectTabId
            return (
              <MorphTabButton
                key={tab.id}
                layoutId="video-tabs"
                active={isActive}
                draggable
                onDragStart={(e) => handleProjectTabDragStart(e, tab)}
                onClick={() => handleProjectTabClick(tab.id, tab.path)}
                className="relative min-w-0 rounded-[8px] border px-2.5 py-1 text-[11px] transition-all"
                style={{
                  flex: '1 1 0',
                  maxWidth: 220,
                  borderColor: isActive ? 'var(--color-blue)' : 'var(--border-default)',
                  color: isActive ? 'var(--color-blue)' : 'var(--text-body)',
                  background: isActive ? 'var(--color-blue-light)' : 'var(--surface-card-bg)',
                }}
                contentClassName="relative z-[1] block truncate"
                title={tab.path || tab.name}
              >
                {tab.name}
              </MorphTabButton>
            )
          })}
        </MorphTabStrip>
      </div>

      <EditorToolbar
        title={toolbarTitle}
        activeTool={activeTool}
        onToolChange={setActiveTool}
        onImportMedia={handleToolbarImportMedia}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        onExport={handleExport}
        exportState={exportState}
        exportMessage={exportMessage}
      />

      <div className="flex-1 flex overflow-hidden" style={{ minHeight: 0, background: 'var(--bg-content)' }}>
        <PreviewCanvas
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          onTogglePlay={handleTogglePlay}
          onTimeUpdate={handlePreviewTimeUpdate}
          onPlaybackEnded={handlePreviewEnded}
          videoClips={videoClips}
          subtitleClips={subtitleClips}
          audioClips={audioClips}
          selectedClip={selectedClip}
          subtitleStyle={subtitleStyle}
          isMuted={isMuted}
        />
        <PropertiesPanel
          selectedClip={selectedClip}
          videoClips={videoClips}
          subtitleClips={subtitleClips}
          audioClips={audioClips}
          subtitleStyle={subtitleStyle}
          onSubtitleStyleChange={setSubtitleStyle}
          onClipUpdate={handleClipUpdate}
        />
      </div>

      <PlaybackControls
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        onPrevFrame={handlePrevFrame}
        onNextFrame={handleNextFrame}
        zoom={zoom}
        onZoomChange={setZoom}
      />

      <div style={{ height: 278, minHeight: 278 }}>
        <Timeline
          videoClips={videoClips}
          subtitleClips={subtitleClips}
          audioClips={audioClips}
          currentTime={currentTime}
          duration={duration}
          zoom={zoom}
          selectedClip={selectedClip}
          onTimeChange={handleSetCurrentTime}
          onSelectClip={handleSelectClip}
          onClipMove={handleClipMove}
          onFileDrop={handleFileDrop}
          onClipTrim={handleClipTrim}
          onDragStart={handleDragStart}
        />
      </div>
    </div>
  )
}
