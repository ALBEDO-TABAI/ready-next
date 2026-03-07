import {
  Play,
  Pause,
  StepBack,
  StepForward,
  Minus,
  Plus,
} from 'lucide-react'

interface PlaybackControlsProps {
  currentTime: number
  duration: number
  isPlaying: boolean
  onTogglePlay: () => void
  onPrevFrame: () => void
  onNextFrame: () => void
  zoom: number
  onZoomChange: (zoom: number) => void
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  const cs = Math.floor((safe % 1) * 100)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

export default function PlaybackControls({
  currentTime,
  duration,
  isPlaying,
  onTogglePlay,
  onPrevFrame,
  onNextFrame,
  zoom,
  onZoomChange,
}: PlaybackControlsProps) {
  const canZoomOut = zoom > 0.5
  const canZoomIn = zoom < 10
  const colors = {
    panelBg: 'var(--bg-primary)',
    panelBorder: 'var(--border-default)',
    inputBorder: 'var(--border-default)',
    inputBg: 'var(--bg-editor)',
    text: 'var(--text-body)',
    muted: 'var(--text-muted)',
    buttonBg: 'var(--bg-primary)',
    primaryBtnBg: 'var(--text-title)',
    primaryBtnText: 'var(--bg-primary)',
    accent: 'var(--color-blue)',
  }

  return (
    <div
      className="flex items-center justify-between px-3"
      style={{
        height: 44,
        flexShrink: 0,
        background: colors.panelBg,
        borderBottom: `1px solid ${colors.panelBorder}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            height: 28,
            minWidth: 92,
            borderRadius: 8,
            border: `1px solid ${colors.inputBorder}`,
            background: colors.inputBg,
            padding: '0 10px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: colors.text,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTimecode(currentTime)}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onPrevFrame}
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: `1px solid ${colors.inputBorder}`,
            background: colors.buttonBg,
            color: colors.muted,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title="Step backward"
        >
          <StepBack size={15} />
        </button>
        <button
          onClick={onTogglePlay}
          style={{
            width: 34,
            height: 34,
            borderRadius: 999,
            border: 'none',
            background: colors.primaryBtnBg,
            color: colors.primaryBtnText,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title="Play / Pause"
        >
          {isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" style={{ marginLeft: 1 }} />}
        </button>
        <button
          onClick={onNextFrame}
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            border: `1px solid ${colors.inputBorder}`,
            background: colors.buttonBg,
            color: colors.muted,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title="Step forward"
        >
          <StepForward size={15} />
        </button>
        <span style={{ fontSize: 12, color: colors.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
          {formatTimecode(duration)}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => onZoomChange(Math.max(0.5, zoom - 0.5))}
          disabled={!canZoomOut}
          title="Zoom out"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            border: `1px solid ${colors.inputBorder}`,
            background: colors.buttonBg,
            color: colors.muted,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canZoomOut ? 1 : 0.35,
            cursor: canZoomOut ? 'pointer' : 'not-allowed',
          }}
        >
          <Minus size={14} />
        </button>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.1}
          value={zoom}
          onChange={(e) => onZoomChange(parseFloat(e.target.value))}
          style={{ width: 120, accentColor: colors.accent }}
        />
        <button
          onClick={() => onZoomChange(Math.min(10, zoom + 0.5))}
          disabled={!canZoomIn}
          title="Zoom in"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            border: `1px solid ${colors.inputBorder}`,
            background: colors.buttonBg,
            color: colors.muted,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: canZoomIn ? 1 : 0.35,
            cursor: canZoomIn ? 'pointer' : 'not-allowed',
          }}
        >
          <Plus size={14} />
        </button>
        <span style={{ width: 38, textAlign: 'right', fontSize: 11, color: colors.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {zoom.toFixed(1)}x
        </span>
      </div>
    </div>
  )
}
