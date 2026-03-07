import {
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  RotateCcw,
} from 'lucide-react'
import { type TimelineClip, type SelectedClip, type ClipType, type SubtitleStyle } from '../../pages/modes/VideoMode'

interface PropertiesPanelProps {
  selectedClip: SelectedClip | null
  videoClips: TimelineClip[]
  subtitleClips: TimelineClip[]
  audioClips: TimelineClip[]
  subtitleStyle: SubtitleStyle
  onSubtitleStyleChange: (style: SubtitleStyle) => void
  onClipUpdate: (clipId: string, trackType: ClipType, updates: Partial<TimelineClip>) => void
}

const CANVAS_WIDTH = 1080
const CANVAS_HEIGHT = 1920

const UI_COLORS = {
  panelBg: 'var(--bg-primary)',
  panelBorder: 'var(--border-default)',
  cardBg: 'var(--bg-primary)',
  cardBorder: 'var(--border-default)',
  inputBg: 'var(--bg-editor)',
  inputBorder: 'var(--border-default)',
  text: 'var(--text-body)',
  textTitle: 'var(--text-title)',
  muted: 'var(--text-muted)',
  mutedStrong: 'var(--text-light)',
  sliderAccent: 'var(--text-body)',
  dashedBorder: 'var(--border-default)',
  emptyBg: 'var(--bg-editor)',
}

interface ClipInspectorValues {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  opacity: number
  borderRadius: number
  playbackRate: number
  videoFadeIn: number
  videoFadeOut: number
  volumeDb: number
  audioFadeIn: number
  audioFadeOut: number
  captionsStatus: string
}

function withDefaults(clip: TimelineClip): ClipInspectorValues {
  return {
    x: clip.x ?? 0,
    y: clip.y ?? 0,
    w: clip.w ?? CANVAS_WIDTH,
    h: clip.h ?? CANVAS_HEIGHT,
    rotation: clip.rotation ?? 0,
    opacity: clip.opacity ?? 100,
    borderRadius: clip.borderRadius ?? 0,
    playbackRate: clip.playbackRate ?? 1,
    videoFadeIn: clip.videoFadeIn ?? 0,
    videoFadeOut: clip.videoFadeOut ?? 0,
    volumeDb: clip.volumeDb ?? 0,
    audioFadeIn: clip.audioFadeIn ?? 0,
    audioFadeOut: clip.audioFadeOut ?? 0,
    captionsStatus: clip.captionsStatus || 'Captions already generated',
  }
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds)
  const mins = Math.floor(safe / 60)
  const secs = Math.floor(safe % 60)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

function sectionCard(title: string, children: React.ReactNode) {
  return (
    <section
      style={{
        border: `1px solid ${UI_COLORS.cardBorder}`,
        borderRadius: 10,
        background: UI_COLORS.cardBg,
        padding: 10,
      }}
    >
      <div style={{ fontSize: 11, color: UI_COLORS.mutedStrong, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {title}
      </div>
      {children}
    </section>
  )
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  min,
  max,
  step,
}: {
  label: string
  value: number
  onChange: (next: number) => void
  suffix?: string
  min?: number
  max?: number
  step?: number
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: UI_COLORS.mutedStrong }}>{label}</span>
      <div
        style={{
          height: 30,
          borderRadius: 8,
          border: `1px solid ${UI_COLORS.inputBorder}`,
          background: UI_COLORS.inputBg,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value || 0))}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 12,
            color: UI_COLORS.text,
          }}
        />
        {suffix ? <span style={{ fontSize: 10, color: UI_COLORS.mutedStrong }}>{suffix}</span> : null}
      </div>
    </label>
  )
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  valueText,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
  valueText: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: UI_COLORS.muted }}>{label}</span>
        <span style={{ fontSize: 11, color: UI_COLORS.mutedStrong, fontVariantNumeric: 'tabular-nums' }}>{valueText}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: UI_COLORS.sliderAccent }}
      />
    </div>
  )
}

function AlignButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: `1px solid ${UI_COLORS.inputBorder}`,
        background: UI_COLORS.cardBg,
        color: UI_COLORS.muted,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  )
}

export default function PropertiesPanel({
  selectedClip,
  videoClips,
  subtitleClips,
  audioClips,
  subtitleStyle,
  onSubtitleStyleChange,
  onClipUpdate,
}: PropertiesPanelProps) {
  const getSelectedClipData = (): TimelineClip | null => {
    if (!selectedClip) return null
    if (selectedClip.type === 'video') return videoClips.find((c) => c.id === selectedClip.id) || null
    if (selectedClip.type === 'audio') return audioClips.find((c) => c.id === selectedClip.id) || null
    return subtitleClips.find((c) => c.id === selectedClip.id) || null
  }

  const clip = getSelectedClipData()
  const values = clip ? withDefaults(clip) : null

  const updateSelected = (updates: Partial<TimelineClip>) => {
    if (!selectedClip || !clip) return
    onClipUpdate(clip.id, selectedClip.type, updates)
  }

  const applyAlign = (mode: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom') => {
    if (!values) return
    const updates: Partial<TimelineClip> = {}
    if (mode === 'left') updates.x = 0
    if (mode === 'center-horizontal') updates.x = Math.round((CANVAS_WIDTH - values.w) / 2)
    if (mode === 'right') updates.x = Math.round(CANVAS_WIDTH - values.w)
    if (mode === 'top') updates.y = 0
    if (mode === 'center-vertical') updates.y = Math.round((CANVAS_HEIGHT - values.h) / 2)
    if (mode === 'bottom') updates.y = Math.round(CANVAS_HEIGHT - values.h)
    updateSelected(updates)
  }

  return (
    <aside
      style={{
        width: 294,
        flexShrink: 0,
        background: UI_COLORS.panelBg,
        borderLeft: `1px solid ${UI_COLORS.panelBorder}`,
        padding: 10,
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: UI_COLORS.textTitle, fontWeight: 700 }}>Inspector</div>

        {!clip || !values ? (
          <div
            style={{
              border: `1px dashed ${UI_COLORS.dashedBorder}`,
              borderRadius: 10,
              background: UI_COLORS.emptyBg,
              padding: 16,
              fontSize: 12,
              color: UI_COLORS.mutedStrong,
            }}
          >
            Select a clip to edit source, layout, video and audio properties.
          </div>
        ) : (
          <>
            {sectionCard('Source', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: UI_COLORS.text, wordBreak: 'break-all' }}>
                  {clip.source || clip.label}
                </div>
                <div style={{ fontSize: 11, color: UI_COLORS.mutedStrong }}>
                  Duration: {formatDuration(Math.max(0, clip.end - clip.start))}
                </div>
              </div>
            ))}

            {sectionCard('Layout', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
                  <AlignButton title="Align Left" onClick={() => applyAlign('left')}><AlignStartHorizontal size={14} /></AlignButton>
                  <AlignButton title="Align Horizontal Centers" onClick={() => applyAlign('center-horizontal')}><AlignCenterHorizontal size={14} /></AlignButton>
                  <AlignButton title="Align Right" onClick={() => applyAlign('right')}><AlignEndHorizontal size={14} /></AlignButton>
                  <AlignButton title="Align Top" onClick={() => applyAlign('top')}><AlignStartVertical size={14} /></AlignButton>
                  <AlignButton title="Align Vertical Centers" onClick={() => applyAlign('center-vertical')}><AlignCenterVertical size={14} /></AlignButton>
                  <AlignButton title="Align Bottom" onClick={() => applyAlign('bottom')}><AlignEndVertical size={14} /></AlignButton>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <NumberField label="X" value={values.x} onChange={(next) => updateSelected({ x: next })} />
                  <NumberField label="Y" value={values.y} onChange={(next) => updateSelected({ y: next })} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <NumberField label="W" value={values.w} min={1} onChange={(next) => updateSelected({ w: Math.max(1, next) })} />
                  <NumberField label="H" value={values.h} min={1} onChange={(next) => updateSelected({ h: Math.max(1, next) })} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 28px', gap: 8, alignItems: 'end' }}>
                  <NumberField label="Rotation" value={values.rotation} suffix="°" onChange={(next) => updateSelected({ rotation: next })} />
                  <button
                    onClick={() => updateSelected({ rotation: 0 })}
                    title="Reset rotation"
                    style={{
                      width: 28,
                      height: 30,
                      borderRadius: 8,
                      border: `1px solid ${UI_COLORS.inputBorder}`,
                      background: UI_COLORS.cardBg,
                      color: UI_COLORS.muted,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              </div>
            ))}

            {sectionCard('Fill', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SliderField
                  label="Opacity"
                  value={values.opacity}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(next) => updateSelected({ opacity: next })}
                  valueText={`${Math.round(values.opacity)}%`}
                />
                <SliderField
                  label="Border Radius"
                  value={values.borderRadius}
                  min={0}
                  max={140}
                  step={1}
                  onChange={(next) => updateSelected({ borderRadius: next })}
                  valueText={`${Math.round(values.borderRadius)}px`}
                />
              </div>
            ))}

            {sectionCard('Video', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SliderField
                  label="Playback Rate"
                  value={values.playbackRate}
                  min={0.25}
                  max={3}
                  step={0.05}
                  onChange={(next) => updateSelected({ playbackRate: next })}
                  valueText={`${values.playbackRate.toFixed(2)}x`}
                />
                <SliderField
                  label="Fade In"
                  value={values.videoFadeIn}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(next) => updateSelected({ videoFadeIn: next })}
                  valueText={`${values.videoFadeIn.toFixed(1)}s`}
                />
                <SliderField
                  label="Fade Out"
                  value={values.videoFadeOut}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(next) => updateSelected({ videoFadeOut: next })}
                  valueText={`${values.videoFadeOut.toFixed(1)}s`}
                />
              </div>
            ))}

            {sectionCard('Audio', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <SliderField
                  label="Volume"
                  value={values.volumeDb}
                  min={-30}
                  max={12}
                  step={0.5}
                  onChange={(next) => updateSelected({ volumeDb: next })}
                  valueText={`${values.volumeDb.toFixed(1)} dB`}
                />
                <SliderField
                  label="Fade In"
                  value={values.audioFadeIn}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(next) => updateSelected({ audioFadeIn: next })}
                  valueText={`${values.audioFadeIn.toFixed(1)}s`}
                />
                <SliderField
                  label="Fade Out"
                  value={values.audioFadeOut}
                  min={0}
                  max={10}
                  step={0.1}
                  onChange={(next) => updateSelected({ audioFadeOut: next })}
                  valueText={`${values.audioFadeOut.toFixed(1)}s`}
                />
              </div>
            ))}

            {sectionCard('Captions', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 11, color: UI_COLORS.muted }}>{values.captionsStatus}</div>
                <button
                  onClick={() => {
                    updateSelected({ captionsStatus: 'Captions regenerated' })
                    if (selectedClip?.type === 'subtitle') {
                      onSubtitleStyleChange({
                        ...subtitleStyle,
                        fontSize: Math.max(10, subtitleStyle.fontSize),
                      })
                    }
                  }}
                  style={{
                    height: 34,
                    borderRadius: 8,
                    border: `1px solid ${UI_COLORS.inputBorder}`,
                    background: UI_COLORS.cardBg,
                    color: UI_COLORS.text,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Regenerate captions
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
