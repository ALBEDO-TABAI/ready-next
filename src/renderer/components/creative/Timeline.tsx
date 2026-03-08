import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX, Plus } from 'lucide-react'
import type { TimelineClip, ClipType, SelectedClip } from '../../modules/video/types'
import {
  getDroppedFileKind,
  getDroppedFilesFromDataTransfer,
  type DroppedFile,
} from '../../utils/dragDrop'

interface TimelineProps {
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  currentTime: number
  duration: number
  zoom: number
  selectedClip: SelectedClip | null
  onTimeChange: (time: number) => void
  onSelectClip: (id: string, type: ClipType) => void
  onClipMove: (clipId: string, trackType: ClipType, newStart: number, newEnd: number) => void
  onFileDrop: (filePath: string, fileName: string, trackType: ClipType, trackId?: string) => void
  onClipTrim: (clipId: string, trackType: ClipType, newStart: number, newEnd: number) => void
  onDragStart: () => void
}

interface TrackRow {
  id: string
  type: ClipType
  label: string
}

interface TrackUiState {
  visible: boolean
  locked: boolean
  muted: boolean
}

const TRACK_HEADER_WIDTH = 178
const ROW_HEIGHT = 56
const MIN_ZOOM = 0.5
const DEFAULT_PPS = 8
const TRIM_HANDLE_PX = 8

const BASE_ROWS: TrackRow[] = [
  { id: 'video-1', type: 'video', label: 'V1' },
  { id: 'subtitle-1', type: 'subtitle', label: 'C1' },
  { id: 'audio-1', type: 'audio', label: 'A1' },
]

const DEFAULT_ROW_BY_TYPE: Record<ClipType, string> = {
  video: 'video-1',
  subtitle: 'subtitle-1',
  audio: 'audio-1',
}

const DEFAULT_TRACK_STATE: TrackUiState = {
  visible: true,
  locked: false,
  muted: false,
}

const UI_COLORS = {
  panelBg: 'var(--bg-primary)',
  panelBorder: 'var(--border-default)',
  rulerBg: 'var(--bg-editor)',
  rulerTickMajor: 'var(--text-light)',
  rulerTickMinor: 'var(--border-default)',
  rulerText: 'var(--text-light)',
  rowBg: 'var(--bg-primary)',
  rowHoverBg: 'var(--color-blue-light)',
  rowBorder: 'var(--border-default)',
  trackHeaderBg: 'var(--bg-editor)',
  trackHeaderBorder: 'var(--border-default)',
  text: 'var(--text-body)',
  muted: 'var(--text-muted)',
  mutedStrong: 'var(--text-light)',
  buttonBg: 'var(--bg-primary)',
  buttonBorder: 'var(--border-default)',
  accent: 'var(--color-blue)',
  trackCanvasBg: 'var(--bg-content)',
}

function formatRulerTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function getTickInterval(pps: number): { major: number; minor: number } {
  if (pps >= 52) return { major: 1, minor: 0.5 }
  if (pps >= 22) return { major: 2, minor: 1 }
  if (pps >= 10) return { major: 5, minor: 1 }
  if (pps >= 5) return { major: 10, minor: 2 }
  return { major: 20, minor: 5 }
}

function isImageSource(path?: string): boolean {
  if (!path) return false
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff', 'avif'].includes(ext)
}

function getTargetTrackType(file: DroppedFile, fallbackTrackType: ClipType): ClipType | null {
  const kind = getDroppedFileKind(file)
  if (kind === 'audio') return 'audio'
  if (kind === 'video' || kind === 'image') {
    return fallbackTrackType === 'audio' ? 'video' : fallbackTrackType
  }
  return null
}

function getTrackLabelPrefix(type: ClipType): string {
  if (type === 'video') return 'V'
  if (type === 'audio') return 'A'
  return 'C'
}

function getClipColors(type: ClipType, source?: string) {
  if (type === 'audio') {
    return {
      background: '#EEF2FF',
      border: 'rgba(30, 64, 175, 0.22)',
      text: '#1E3A8A',
      pattern: 'repeating-linear-gradient(90deg, rgba(30,64,175,0.34) 0 2px, transparent 2px 6px)',
    }
  }

  if (type === 'subtitle') {
    return {
      background: '#DBEAFE',
      border: 'rgba(29, 78, 216, 0.24)',
      text: '#1D4ED8',
      pattern: 'repeating-linear-gradient(90deg, rgba(29,78,216,0.12) 0 10px, transparent 10px 18px)',
    }
  }

  if (isImageSource(source)) {
    return {
      background: '#FCE7F3',
      border: 'rgba(190, 24, 93, 0.2)',
      text: '#9D174D',
      pattern: 'repeating-linear-gradient(90deg, rgba(190,24,93,0.12) 0 8px, transparent 8px 16px)',
    }
  }

  return {
    background: '#FFEDD5',
    border: 'rgba(194, 65, 12, 0.2)',
    text: '#9A3412',
    pattern: 'repeating-linear-gradient(90deg, rgba(234,88,12,0.14) 0 8px, transparent 8px 16px)',
  }
}

export default function Timeline({
  videoClips,
  subtitleClips,
  audioClips,
  currentTime,
  duration,
  zoom,
  selectedClip,
  onTimeChange,
  onSelectClip,
  onClipMove,
  onFileDrop,
  onClipTrim,
  onDragStart,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const trackCanvasRef = useRef<HTMLDivElement>(null)

  const [scrollLeft, setScrollLeft] = useState(0)
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false)
  const [dropHighlight, setDropHighlight] = useState<string | null>(null)
  const [nextTrackType, setNextTrackType] = useState<ClipType>('video')
  const [extraTracks, setExtraTracks] = useState<TrackRow[]>([])
  const [trackUi, setTrackUi] = useState<Record<string, TrackUiState>>(() => ({
    'video-1': { ...DEFAULT_TRACK_STATE },
    'subtitle-1': { ...DEFAULT_TRACK_STATE },
    'audio-1': { ...DEFAULT_TRACK_STATE },
  }))

  const [dragClip, setDragClip] = useState<{
    clipId: string
    trackType: ClipType
    startOffset: number
    clipDuration: number
  } | null>(null)

  const [trimClip, setTrimClip] = useState<{
    clipId: string
    trackType: ClipType
    edge: 'left' | 'right'
    originalStart: number
    originalEnd: number
  } | null>(null)

  const rows = useMemo(() => [...BASE_ROWS, ...extraTracks], [extraTracks])
  const pps = DEFAULT_PPS * Math.max(MIN_ZOOM, zoom)
  const rightPaneWidth = Math.max(320, (containerRef.current?.clientWidth || 0) - TRACK_HEADER_WIDTH)
  const timelineWidth = Math.max(duration * pps, rightPaneWidth + scrollLeft)
  const playheadX = currentTime * pps - scrollLeft
  const tickConfig = getTickInterval(pps)

  const firstRowByType = useMemo(() => {
    const map: Record<ClipType, string> = {
      video: DEFAULT_ROW_BY_TYPE.video,
      subtitle: DEFAULT_ROW_BY_TYPE.subtitle,
      audio: DEFAULT_ROW_BY_TYPE.audio,
    }
    rows.forEach((row) => {
      if (!map[row.type]) map[row.type] = row.id
    })
    return map
  }, [rows])

  const getRowState = useCallback((rowId: string): TrackUiState => {
    return trackUi[rowId] || DEFAULT_TRACK_STATE
  }, [trackUi])

  const updateRowState = useCallback((rowId: string, updates: Partial<TrackUiState>) => {
    setTrackUi((prev) => ({
      ...prev,
      [rowId]: {
        ...(prev[rowId] || DEFAULT_TRACK_STATE),
        ...updates,
      },
    }))
  }, [])

  const clipsForRow = useCallback((row: TrackRow): TimelineClip[] => {
    const source = row.type === 'video' ? videoClips : row.type === 'audio' ? audioClips : subtitleClips
    const fallbackId = DEFAULT_ROW_BY_TYPE[row.type]
    return source
      .filter((clip) => (clip.trackId || fallbackId) === row.id)
      .sort((a, b) => a.start - b.start)
  }, [audioClips, subtitleClips, videoClips])

  const xToTime = useCallback((clientX: number) => {
    if (!trackCanvasRef.current) return 0
    const rect = trackCanvasRef.current.getBoundingClientRect()
    const x = clientX - rect.left + scrollLeft
    return Math.max(0, Math.min(x / pps, duration))
  }, [duration, pps, scrollLeft])

  const handleRulerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onTimeChange(xToTime(e.clientX))
    setIsDraggingPlayhead(true)
  }, [onTimeChange, xToTime])

  useEffect(() => {
    if (!isDraggingPlayhead) return

    const onMove = (e: MouseEvent) => onTimeChange(xToTime(e.clientX))
    const onUp = () => setIsDraggingPlayhead(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isDraggingPlayhead, onTimeChange, xToTime])

  const handleClipMouseDown = useCallback((e: React.MouseEvent, row: TrackRow, clip: TimelineClip) => {
    const rowState = getRowState(row.id)
    if (rowState.locked || !rowState.visible) return

    e.preventDefault()
    e.stopPropagation()
    onSelectClip(clip.id, row.type)

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const clipWidth = rect.width

    if (mouseX <= TRIM_HANDLE_PX) {
      onDragStart()
      setTrimClip({
        clipId: clip.id,
        trackType: row.type,
        edge: 'left',
        originalStart: clip.start,
        originalEnd: clip.end,
      })
      return
    }

    if (mouseX >= clipWidth - TRIM_HANDLE_PX) {
      onDragStart()
      setTrimClip({
        clipId: clip.id,
        trackType: row.type,
        edge: 'right',
        originalStart: clip.start,
        originalEnd: clip.end,
      })
      return
    }

    onDragStart()
    const time = xToTime(e.clientX)
    setDragClip({
      clipId: clip.id,
      trackType: row.type,
      startOffset: time - clip.start,
      clipDuration: clip.end - clip.start,
    })
  }, [getRowState, onDragStart, onSelectClip, xToTime])

  useEffect(() => {
    if (!dragClip) return

    const onMove = (e: MouseEvent) => {
      const time = xToTime(e.clientX)
      const newStart = Math.max(0, time - dragClip.startOffset)
      const newEnd = newStart + dragClip.clipDuration
      onClipMove(dragClip.clipId, dragClip.trackType, newStart, newEnd)
    }
    const onUp = () => setDragClip(null)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragClip, onClipMove, xToTime])

  useEffect(() => {
    if (!trimClip) return

    const onMove = (e: MouseEvent) => {
      const time = xToTime(e.clientX)
      if (trimClip.edge === 'left') {
        const newStart = Math.max(0, Math.min(time, trimClip.originalEnd - 0.1))
        onClipTrim(trimClip.clipId, trimClip.trackType, newStart, trimClip.originalEnd)
      } else {
        const newEnd = Math.max(trimClip.originalStart + 0.1, time)
        onClipTrim(trimClip.clipId, trimClip.trackType, trimClip.originalStart, newEnd)
      }
    }
    const onUp = () => setTrimClip(null)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onClipTrim, trimClip, xToTime])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    const mainlyHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey
    if (!mainlyHorizontal || !containerRef.current) return

    e.preventDefault()
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    const maxScroll = Math.max(0, timelineWidth - rightPaneWidth)
    setScrollLeft((prev) => Math.max(0, Math.min(prev + delta, maxScroll)))
  }, [rightPaneWidth, timelineWidth])

  const handleDrop = useCallback((e: React.DragEvent, row: TrackRow) => {
    e.preventDefault()
    setDropHighlight(null)

    const droppedFiles = getDroppedFilesFromDataTransfer(e.dataTransfer)
    if (droppedFiles.length === 0) return

    for (const file of droppedFiles) {
      const trackType = getTargetTrackType(file, row.type)
      if (!trackType) continue
      const targetTrackId = trackType === row.type ? row.id : firstRowByType[trackType]
      onFileDrop(file.path, file.name, trackType, targetTrackId)
    }
  }, [firstRowByType, onFileDrop])

  const handleAddTrack = useCallback(() => {
    const existingCount = rows.filter((row) => row.type === nextTrackType).length
    const index = existingCount + 1
    const id = `${nextTrackType}-${index}`
    const label = `${getTrackLabelPrefix(nextTrackType)}${index}`

    setExtraTracks((prev) => [...prev, { id, type: nextTrackType, label }])
    setTrackUi((prev) => ({
      ...prev,
      [id]: { ...DEFAULT_TRACK_STATE },
    }))
  }, [nextTrackType, rows])

  const rulerTicks: { time: number; major: boolean }[] = []
  for (let t = 0; t <= duration; t += tickConfig.minor) {
    const rounded = Math.round(t * 1000) / 1000
    const major = Math.abs((rounded / tickConfig.major) - Math.round(rounded / tickConfig.major)) < 0.001
    rulerTicks.push({ time: rounded, major })
  }

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        background: UI_COLORS.panelBg,
        borderTop: `1px solid ${UI_COLORS.panelBorder}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 36,
          borderBottom: `1px solid ${UI_COLORS.panelBorder}`,
          display: 'flex',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: TRACK_HEADER_WIDTH,
            borderRight: `1px solid ${UI_COLORS.trackHeaderBorder}`,
            background: UI_COLORS.trackHeaderBg,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 8px',
          }}
        >
          <button
            onClick={handleAddTrack}
            style={{
              height: 24,
              borderRadius: 7,
              border: `1px solid ${UI_COLORS.buttonBorder}`,
              background: UI_COLORS.buttonBg,
              color: UI_COLORS.text,
              fontSize: 11,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 8px',
            }}
          >
            <Plus size={12} />
            Add Track
          </button>
          <select
            value={nextTrackType}
            onChange={(e) => setNextTrackType(e.target.value as ClipType)}
            style={{
              height: 24,
              borderRadius: 7,
              border: `1px solid ${UI_COLORS.buttonBorder}`,
              background: UI_COLORS.buttonBg,
              color: UI_COLORS.muted,
              fontSize: 11,
              padding: '0 6px',
            }}
          >
            <option value="video">Video</option>
            <option value="subtitle">Caption</option>
            <option value="audio">Audio</option>
          </select>
        </div>

        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'hidden',
            cursor: 'pointer',
            background: UI_COLORS.rulerBg,
          }}
          onMouseDown={handleRulerMouseDown}
          ref={trackCanvasRef}
        >
          {rulerTicks.map(({ time, major }) => {
            const x = time * pps - scrollLeft
            if (x < -40 || x > rightPaneWidth + 40) return null
            return (
              <div key={time} style={{ position: 'absolute', left: x, bottom: 0 }}>
                <div
                  style={{
                    width: 1,
                    height: major ? 12 : 6,
                    background: major ? UI_COLORS.rulerTickMajor : UI_COLORS.rulerTickMinor,
                  }}
                />
                {major ? (
                  <span
                    style={{
                      position: 'absolute',
                      bottom: 13,
                      left: 4,
                      fontSize: 10,
                      color: UI_COLORS.rulerText,
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatRulerTime(time)}
                  </span>
                ) : null}
              </div>
            )
          })}

          {playheadX >= -2 ? (
            <div
              style={{
                position: 'absolute',
                left: playheadX,
                top: 0,
                bottom: 0,
                width: 2,
                background: UI_COLORS.accent,
                zIndex: 30,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: -5,
                  left: -4,
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: UI_COLORS.accent,
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={containerRef}
        onWheel={handleWheel}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          background: UI_COLORS.panelBg,
        }}
      >
        {rows.map((row) => {
          const rowState = getRowState(row.id)
          const rowClips = clipsForRow(row)
          const isDropTarget = dropHighlight === row.id

          return (
            <div
              key={row.id}
              style={{
                height: ROW_HEIGHT,
                display: 'flex',
                borderBottom: `1px solid ${UI_COLORS.rowBorder}`,
                background: isDropTarget ? UI_COLORS.rowHoverBg : UI_COLORS.rowBg,
              }}
              onDragOver={(e) => {
                const types = new Set(Array.from(e.dataTransfer.types || []))
                const canAccept =
                  types.has('Files') ||
                  types.has('application/x-ready-drag') ||
                  types.has('application/x-ready-file') ||
                  types.has('text/plain')
                if (!canAccept) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropHighlight(row.id)
              }}
              onDragLeave={() => setDropHighlight(null)}
              onDrop={(e) => handleDrop(e, row)}
            >
              <div
                style={{
                  width: TRACK_HEADER_WIDTH,
                  borderRight: `1px solid ${UI_COLORS.trackHeaderBorder}`,
                  background: UI_COLORS.trackHeaderBg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 10px',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: UI_COLORS.text, fontWeight: 600 }}>{row.label}</span>
                  <span style={{ fontSize: 10, color: UI_COLORS.mutedStrong }}>{row.type}</span>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <button
                    onClick={() => updateRowState(row.id, { visible: !rowState.visible })}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      border: `1px solid ${UI_COLORS.buttonBorder}`,
                      background: UI_COLORS.buttonBg,
                      color: UI_COLORS.muted,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    title={rowState.visible ? 'Hide track' : 'Show track'}
                  >
                    {rowState.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  {row.type === 'audio' ? (
                    <button
                      onClick={() => updateRowState(row.id, { muted: !rowState.muted })}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        border: `1px solid ${UI_COLORS.buttonBorder}`,
                        background: UI_COLORS.buttonBg,
                        color: UI_COLORS.muted,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title={rowState.muted ? 'Unmute track' : 'Mute track'}
                    >
                      {rowState.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                    </button>
                  ) : (
                    <button
                      onClick={() => updateRowState(row.id, { locked: !rowState.locked })}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        border: `1px solid ${UI_COLORS.buttonBorder}`,
                        background: UI_COLORS.buttonBg,
                        color: UI_COLORS.muted,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title={rowState.locked ? 'Unlock track' : 'Lock track'}
                    >
                      {rowState.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                  )}
                </div>
              </div>

              <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: UI_COLORS.trackCanvasBg }}>
                <div
                  style={{
                    width: timelineWidth,
                    height: '100%',
                    position: 'relative',
                    opacity: rowState.visible ? 1 : 0.2,
                  }}
                >
                  {rowClips.map((clip) => {
                    const left = clip.start * pps - scrollLeft
                    const width = Math.max(8, (clip.end - clip.start) * pps)
                    const isSelected = selectedClip?.id === clip.id && selectedClip.type === row.type
                    const isDragging = dragClip?.clipId === clip.id
                    const isTrimming = trimClip?.clipId === clip.id
                    const colors = getClipColors(row.type, clip.source)
                    const isAudio = row.type === 'audio'

                    return (
                      <div
                        key={clip.id}
                        onMouseDown={(e) => handleClipMouseDown(e, row, clip)}
                        style={{
                          position: 'absolute',
                          left,
                          top: 9,
                          width,
                          height: ROW_HEIGHT - 18,
                          borderRadius: 8,
                          border: `1px solid ${colors.border}`,
                          background: colors.background,
                          color: colors.text,
                          padding: '0 8px',
                          display: 'flex',
                          alignItems: 'center',
                          fontSize: 11,
                          fontWeight: 600,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          cursor: rowState.locked ? 'not-allowed' : (isDragging ? 'grabbing' : isTrimming ? 'ew-resize' : 'grab'),
                          boxShadow: isSelected ? `0 0 0 2px ${UI_COLORS.accent} inset` : 'none',
                          zIndex: isDragging || isTrimming ? 20 : 10,
                          pointerEvents: rowState.locked ? 'none' : 'auto',
                          backgroundImage: isAudio
                            ? 'repeating-linear-gradient(90deg, rgba(31,41,55,0.26) 0 2px, transparent 2px 6px), linear-gradient(180deg, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0.4) 100%)'
                            : colors.pattern,
                        }}
                        title={`${clip.label} (${clip.start.toFixed(2)}s - ${clip.end.toFixed(2)}s)`}
                      >
                        {width > 26 ? clip.label : ''}
                      </div>
                    )
                  })}

                  {playheadX >= -2 ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: playheadX,
                        top: 0,
                        bottom: 0,
                        width: 2,
                        background: UI_COLORS.accent,
                        pointerEvents: 'none',
                        zIndex: 30,
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
