import { useState, useRef, useCallback } from 'react'
import type { ReactNode, ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlignLeft,
  AlignCenterHorizontal,
  AlignRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  Plus,
  ChevronDown,
  ArrowDown,
  ArrowRight,
  Eye,
  EyeOff,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Download,
} from 'lucide-react'
import type { CanvasObject, CanvasSize } from './types'
import { CANVAS_PRESETS } from './types'

const FONT_FAMILIES = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'monospace', label: 'Monospace' },
]

export type AlignAction = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'

interface ImageInspectorProps {
  selectedObject: CanvasObject | null
  selectedCount: number
  onChange: (updates: Partial<CanvasObject>) => void
  onAlign?: (action: AlignAction) => void
  collapsed: boolean
  onToggleCollapse: () => void
  onExport: () => void
  exportFormat: string
  onExportFormatChange: (fmt: string) => void
  exportScale: number
  onExportScaleChange: (scale: number) => void
  children?: ReactNode
}

export default function ImageInspector({
  selectedObject,
  selectedCount,
  onChange,
  onAlign,
  collapsed,
  onToggleCollapse,
  onExport,
  exportFormat,
  onExportFormatChange,
  exportScale,
  onExportScaleChange,
  children,
}: ImageInspectorProps) {
  if (collapsed) {
    return (
      <div
        style={{
          width: 36,
          background: 'var(--bg-toolbar)',
          borderLeft: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 10,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggleCollapse}
          title="展开面板"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: 'var(--text-gray)',
            padding: 0,
          }}
        >
          <PanelRightOpen style={{ width: 16, height: 16 }} />
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        width: 268,
        background: 'var(--bg-toolbar)',
        borderLeft: '1px solid var(--border-default)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {/* Collapse button bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '6px 8px',
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggleCollapse}
          title="折叠面板"
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            background: 'transparent',
            color: 'var(--text-gray)',
            padding: 0,
          }}
        >
          <PanelRightClose style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {/* Scrollable properties area */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {selectedObject ? (
          <>
            {/* 1. Alignment Row — functional for multi-select */}
            <AlignmentRow onAlign={onAlign} multiSelect={selectedCount > 1} />

            <Divider />

            {/* 2. Dimensions + Rotation */}
            <DimensionsSection selectedObject={selectedObject} onChange={onChange} />

            {/* Text-specific section */}
            {selectedObject.type === 'text' && (
              <>
                <Divider />
                <TextSection selectedObject={selectedObject} onChange={onChange} />
              </>
            )}

            <Divider />

            {/* 3. Auto Layout */}
            <AutoLayoutSection selectedObject={selectedObject} onChange={onChange} />

            <Divider />

            {/* 4. Fill */}
            <FillSection selectedObject={selectedObject} onChange={onChange} />

            <Divider />

            {/* 5. Stroke */}
            <StrokeSection selectedObject={selectedObject} onChange={onChange} />

            <Divider />

            {/* 6. Effects */}
            <EffectsSection selectedObject={selectedObject} onChange={onChange} />
          </>
        ) : (
          <div
            style={{
              textAlign: 'center',
              paddingTop: 32,
              paddingBottom: 32,
              color: 'var(--text-gray)',
            }}
          >
            <Layers
              style={{
                width: 32,
                height: 32,
                margin: '0 auto 8px',
                opacity: 0.5,
              }}
            />
            <p
              style={{
                fontSize: 12,
                fontFamily: 'Inter, sans-serif',
                margin: 0,
                color: 'var(--text-gray)',
              }}
            >
              选择对象查看属性
            </p>
          </div>
        )}
      </div>

      {/* Export section — always at bottom */}
      <ExportSection
        onExport={onExport}
        exportFormat={exportFormat}
        onExportFormatChange={onExportFormatChange}
        exportScale={exportScale}
        onExportScaleChange={onExportScaleChange}
      />

      {/* LayerPanel slot — removed from here, moved to left side */}
      {children}
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: 'var(--border-default)',
        width: '100%',
        flexShrink: 0,
      }}
    />
  )
}

function AlignmentRow({ onAlign, multiSelect }: { onAlign?: (action: AlignAction) => void; multiSelect?: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null)

  const iconStyle = (id: string): React.CSSProperties => ({
    width: 14,
    height: 14,
    color: hovered === id ? 'var(--text-secondary)' : 'var(--text-gray)',
    cursor: onAlign ? 'pointer' : 'default',
    flexShrink: 0,
    transition: 'color 0.15s ease',
  })

  const handleClick = (action: AlignAction) => {
    onAlign?.(action)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
      }}
    >
      <AlignLeft
        style={iconStyle('left')}
        onMouseEnter={() => setHovered('left')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('left')}
      />
      <AlignCenterHorizontal
        style={iconStyle('center-h')}
        onMouseEnter={() => setHovered('center-h')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('center-h')}
      />
      <AlignRight
        style={iconStyle('right')}
        onMouseEnter={() => setHovered('right')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('right')}
      />
      <span
        style={{
          color: 'var(--border-default)',
          fontFamily: 'Inter, sans-serif',
          fontSize: 14,
          lineHeight: '14px',
          userSelect: 'none',
        }}
      >
        |
      </span>
      <AlignStartVertical
        style={iconStyle('top')}
        onMouseEnter={() => setHovered('top')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('top')}
      />
      <AlignCenterVertical
        style={iconStyle('center-v')}
        onMouseEnter={() => setHovered('center-v')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('center-v')}
      />
      <AlignEndVertical
        style={iconStyle('bottom')}
        onMouseEnter={() => setHovered('bottom')}
        onMouseLeave={() => setHovered(null)}
        onClick={() => handleClick('bottom')}
      />
    </div>
  )
}

function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
      }}
    >
      <span
        style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-secondary)',
        }}
      >
        {title}
      </span>
      {onAdd && (
        <Plus
          style={{
            width: 14,
            height: 14,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
          onClick={onAdd}
        />
      )}
    </div>
  )
}

// ─── Dimensions ─────────────────────────────────────────────────

function DimensionsSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="X" value={selectedObject.x} onChange={(v) => onChange({ x: v })} />
        <NumberField label="Y" value={selectedObject.y} onChange={(v) => onChange({ y: v })} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="W" value={selectedObject.width} onChange={(v) => onChange({ width: Math.max(1, v) })} min={1} />
        <NumberField label="H" value={selectedObject.height} onChange={(v) => onChange({ height: Math.max(1, v) })} min={1} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="R" value={selectedObject.rotation ?? 0} onChange={(v) => onChange({ rotation: v })} />
        <div style={{ flex: 1 }} />
      </div>
    </div>
  )
}

// ─── Auto Layout ────────────────────────────────────────────────

function AutoLayoutSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  const dir = selectedObject.layoutDirection || 'vertical'
  const gap = selectedObject.layoutGap ?? 0
  const padH = selectedObject.layoutPaddingH ?? 0
  const padV = selectedObject.layoutPaddingV ?? 0
  const align = selectedObject.layoutAlign || 'start'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Auto Layout" />

      {/* Direction + alignment row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Direction toggle */}
        <button
          onClick={() => onChange({ layoutDirection: dir === 'vertical' ? 'horizontal' : 'vertical' })}
          title={dir === 'vertical' ? '垂直方向' : '水平方向'}
          style={{
            width: 28,
            height: 28,
            borderRadius: 4,
            border: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
            padding: 0,
          }}
        >
          {dir === 'vertical' ? (
            <ArrowDown style={{ width: 14, height: 14 }} />
          ) : (
            <ArrowRight style={{ width: 14, height: 14 }} />
          )}
        </button>

        {/* Alignment buttons */}
        {(['start', 'center', 'end', 'stretch'] as const).map((a) => (
          <button
            key={a}
            onClick={() => onChange({ layoutAlign: a })}
            style={{
              height: 20,
              padding: '0 6px',
              borderRadius: 3,
              border: align === a ? '1px solid var(--text-secondary)' : '1px solid transparent',
              background: align === a ? 'var(--bg-hover)' : 'transparent',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              fontSize: 10,
              color: align === a ? 'var(--text-secondary)' : 'var(--text-gray)',
            }}
          >
            {a === 'start' ? '起' : a === 'center' ? '中' : a === 'end' ? '末' : '拉'}
          </button>
        ))}
      </div>

      {/* Gap + Padding */}
      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="间距" value={gap} onChange={(v) => onChange({ layoutGap: Math.max(0, v) })} min={0} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="水平" value={padH} onChange={(v) => onChange({ layoutPaddingH: Math.max(0, v) })} min={0} />
        <NumberField label="垂直" value={padV} onChange={(v) => onChange({ layoutPaddingV: Math.max(0, v) })} min={0} />
      </div>
    </div>
  )
}

// ─── Fill ───────────────────────────────────────────────────────

function FillSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  const fillEnabled = selectedObject.fillEnabled !== false // default true
  const fillColor = selectedObject.fill || '#FFFFFF'
  const hexDisplay = fillColor.replace('#', '').toUpperCase()
  const opacity = Math.round((selectedObject.fillOpacity ?? 1) * 100)

  const [localHex, setLocalHex] = useState(hexDisplay)
  const [hexFocused, setHexFocused] = useState(false)
  const [localOpacity, setLocalOpacity] = useState(String(opacity))
  const [opacityFocused, setOpacityFocused] = useState(false)

  const prevHexRef = useRef(hexDisplay)
  if (!hexFocused && prevHexRef.current !== hexDisplay) {
    prevHexRef.current = hexDisplay
    setLocalHex(hexDisplay)
  }

  const prevOpacityRef = useRef(opacity)
  if (!opacityFocused && prevOpacityRef.current !== opacity) {
    prevOpacityRef.current = opacity
    setLocalOpacity(String(opacity))
  }

  const commitHex = (raw: string) => {
    const cleaned = raw.replace('#', '').trim()
    if (/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
      onChange({ fill: '#' + cleaned })
      setLocalHex(cleaned.toUpperCase())
    } else if (/^[0-9A-Fa-f]{3}$/.test(cleaned)) {
      const expanded = cleaned.split('').map((c) => c + c).join('')
      onChange({ fill: '#' + expanded })
      setLocalHex(expanded.toUpperCase())
    } else {
      setLocalHex(hexDisplay)
    }
  }

  const commitOpacity = (raw: string) => {
    const parsed = Number(raw)
    if (!isNaN(parsed)) {
      const clamped = Math.min(100, Math.max(0, Math.round(parsed)))
      onChange({ fillOpacity: clamped / 100 })
      setLocalOpacity(String(clamped))
    } else {
      setLocalOpacity(String(opacity))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader
        title="Fill"
        onAdd={() => onChange({ fillEnabled: true, fill: selectedObject.fill || '#FFFFFF', fillOpacity: 1 })}
      />

      {fillEnabled && (
        <div
          style={{
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          {/* Left: swatch + hex */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                border: '1px solid var(--border-default)',
                background: fillColor,
                flexShrink: 0,
                position: 'relative',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <input
                type="color"
                value={fillColor}
                onChange={(e) => onChange({ fill: e.target.value })}
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  width: 28,
                  height: 28,
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  opacity: 0,
                }}
              />
            </div>
            <input
              type="text"
              value={hexFocused ? localHex : hexDisplay}
              onChange={(e) => {
                const val = e.target.value.replace('#', '')
                if (/^[0-9A-Fa-f]{0,6}$/.test(val)) setLocalHex(val)
              }}
              onFocus={() => { setHexFocused(true); setLocalHex(hexDisplay) }}
              onBlur={() => { setHexFocused(false); commitHex(localHex) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitHex(localHex); (e.target as HTMLInputElement).blur() } }}
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 12,
                color: 'var(--text-secondary)',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: 52,
                padding: 0,
              }}
            />
          </div>

          {/* Right: opacity input + eye */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 44,
                height: 24,
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 4px',
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                value={opacityFocused ? localOpacity : String(opacity)}
                onChange={(e) => {
                  setLocalOpacity(e.target.value)
                  const v = Number(e.target.value)
                  if (!isNaN(v)) onChange({ fillOpacity: Math.min(100, Math.max(0, Math.round(v))) / 100 })
                }}
                onFocus={() => { setOpacityFocused(true); setLocalOpacity(String(opacity)) }}
                onBlur={() => { setOpacityFocused(false); commitOpacity(localOpacity) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { commitOpacity(localOpacity); (e.target as HTMLInputElement).blur() } }}
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  padding: 0,
                  width: '100%',
                  minWidth: 0,
                  textAlign: 'center',
                }}
              />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, color: 'var(--text-gray)' }}>%</span>
            </div>
            <button
              onClick={() => onChange({ fillEnabled: !fillEnabled })}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Eye style={{ width: 14, height: 14, color: 'var(--text-gray)' }} />
            </button>
          </div>
        </div>
      )}

      {!fillEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28 }}>
          <EyeOff style={{ width: 14, height: 14, color: 'var(--color-red)' }} />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: 'var(--text-gray)' }}>已隐藏</span>
          <button
            onClick={() => onChange({ fillEnabled: true })}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              fontSize: 11,
              color: 'var(--color-blue)',
            }}
          >
            显示
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Stroke ─────────────────────────────────────────────────────

function StrokeSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  const strokeEnabled = selectedObject.strokeEnabled ?? false
  const strokeColor = selectedObject.stroke || '#333333'
  const strokeHex = strokeColor.replace('#', '').toUpperCase()
  const strokeWidth = selectedObject.strokeWidth ?? 1

  const [localHex, setLocalHex] = useState(strokeHex)
  const [hexFocused, setHexFocused] = useState(false)

  const prevRef = useRef(strokeHex)
  if (!hexFocused && prevRef.current !== strokeHex) {
    prevRef.current = strokeHex
    setLocalHex(strokeHex)
  }

  const commitHex = (raw: string) => {
    const cleaned = raw.replace('#', '').trim()
    if (/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
      onChange({ stroke: '#' + cleaned })
      setLocalHex(cleaned.toUpperCase())
    } else if (/^[0-9A-Fa-f]{3}$/.test(cleaned)) {
      const expanded = cleaned.split('').map((c) => c + c).join('')
      onChange({ stroke: '#' + expanded })
      setLocalHex(expanded.toUpperCase())
    } else {
      setLocalHex(strokeHex)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader
        title="Stroke"
        onAdd={() => onChange({ strokeEnabled: true, stroke: selectedObject.stroke || '#333333', strokeWidth: selectedObject.strokeWidth || 1 })}
      />

      {strokeEnabled && (
        <div
          style={{
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          {/* Left: swatch + hex */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                border: '1px solid var(--border-default)',
                background: strokeColor,
                flexShrink: 0,
                position: 'relative',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <input
                type="color"
                value={strokeColor}
                onChange={(e) => onChange({ stroke: e.target.value })}
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  width: 28,
                  height: 28,
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  opacity: 0,
                }}
              />
            </div>
            <input
              type="text"
              value={hexFocused ? localHex : strokeHex}
              onChange={(e) => {
                const val = e.target.value.replace('#', '')
                if (/^[0-9A-Fa-f]{0,6}$/.test(val)) setLocalHex(val)
              }}
              onFocus={() => { setHexFocused(true); setLocalHex(strokeHex) }}
              onBlur={() => { setHexFocused(false); commitHex(localHex) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitHex(localHex); (e.target as HTMLInputElement).blur() } }}
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 12,
                color: 'var(--text-secondary)',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                width: 52,
                padding: 0,
              }}
            />
          </div>

          {/* Right: width + visibility */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 44,
                height: 24,
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                value={String(strokeWidth)}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (!isNaN(v) && v >= 0) onChange({ strokeWidth: Math.max(0, Math.round(v)) })
                }}
                style={{
                  width: '100%',
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  padding: '0 4px',
                  textAlign: 'center',
                }}
              />
            </div>
            <button
              onClick={() => onChange({ strokeEnabled: false })}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Eye style={{ width: 14, height: 14, color: 'var(--text-gray)' }} />
            </button>
          </div>
        </div>
      )}

      {!strokeEnabled && selectedObject.stroke && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28 }}>
          <EyeOff style={{ width: 14, height: 14, color: 'var(--text-gray)' }} />
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: 'var(--text-gray)' }}>已禁用</span>
        </div>
      )}
    </div>
  )
}

// ─── Effects ────────────────────────────────────────────────────

function EffectsSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  const shadowEnabled = selectedObject.shadowEnabled ?? false
  const shadowColor = selectedObject.shadowColor || '#00000040'
  const shadowX = selectedObject.shadowOffsetX ?? 0
  const shadowY = selectedObject.shadowOffsetY ?? 4
  const shadowBlur = selectedObject.shadowBlur ?? 8

  // For the shadow color hex (strip alpha)
  const hexPart = shadowColor.slice(0, 7)
  const shadowHex = hexPart.replace('#', '').toUpperCase().slice(0, 6)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader
        title="Effects"
        onAdd={() => onChange({
          shadowEnabled: true,
          shadowColor: '#00000040',
          shadowOffsetX: 0,
          shadowOffsetY: 4,
          shadowBlur: 8,
        })}
      />

      {shadowEnabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Shadow header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: 'var(--text-secondary)' }}>
              阴影
            </span>
            <button
              onClick={() => onChange({ shadowEnabled: false })}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Eye style={{ width: 14, height: 14, color: 'var(--text-gray)' }} />
            </button>
          </div>

          {/* Shadow color swatch + hex */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: 2,
                border: '1px solid var(--border-default)',
                background: hexPart,
                flexShrink: 0,
                position: 'relative',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
            >
              <input
                type="color"
                value={hexPart}
                onChange={(e) => onChange({ shadowColor: e.target.value + '40' })}
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  width: 28,
                  height: 28,
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  opacity: 0,
                }}
              />
            </div>
            <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: 'var(--text-secondary)' }}>
              {shadowHex}
            </span>
          </div>

          {/* X / Y offsets */}
          <div style={{ display: 'flex', gap: 8 }}>
            <NumberField label="X" value={shadowX} onChange={(v) => onChange({ shadowOffsetX: v })} />
            <NumberField label="Y" value={shadowY} onChange={(v) => onChange({ shadowOffsetY: v })} />
          </div>

          {/* Blur */}
          <div style={{ display: 'flex', gap: 8 }}>
            <NumberField label="模糊" value={shadowBlur} onChange={(v) => onChange({ shadowBlur: Math.max(0, v) })} min={0} />
            <div style={{ flex: 1 }} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Export Section ──────────────────────────────────────────────

function ExportSection({
  onExport,
  exportFormat,
  onExportFormatChange,
  exportScale,
  onExportScaleChange,
}: {
  onExport: () => void
  exportFormat: string
  onExportFormatChange: (fmt: string) => void
  exportScale: number
  onExportScaleChange: (scale: number) => void
}) {
  return (
    <div
      style={{
        borderTop: '1px solid var(--border-default)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        flexShrink: 0,
        background: 'var(--bg-toolbar)',
      }}
    >
      <span
        style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-secondary)',
        }}
      >
        导出
      </span>

      {/* Format + Scale row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <select
          value={exportFormat}
          onChange={(e) => onExportFormatChange(e.target.value)}
          style={{
            flex: 1,
            height: 28,
            borderRadius: 4,
            border: '1px solid var(--border-default)',
            padding: '0 8px',
            fontFamily: 'Inter, sans-serif',
            fontSize: 12,
            color: 'var(--text-secondary)',
            background: 'var(--bg-toolbar)',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="webp">WebP</option>
        </select>
        <select
          value={String(exportScale)}
          onChange={(e) => onExportScaleChange(Number(e.target.value))}
          style={{
            width: 64,
            height: 28,
            borderRadius: 4,
            border: '1px solid var(--border-default)',
            padding: '0 8px',
            fontFamily: 'Inter, sans-serif',
            fontSize: 12,
            color: 'var(--text-secondary)',
            background: 'var(--bg-toolbar)',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          <option value="1">1x</option>
          <option value="2">2x</option>
          <option value="3">3x</option>
        </select>
      </div>

      {/* Export button */}
      <button
        onClick={onExport}
        style={{
          width: '100%',
          height: 32,
          borderRadius: 6,
          border: 'none',
          background: 'var(--color-blue)',
          color: '#FFFFFF',
          fontFamily: 'Inter, sans-serif',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
      >
        <Download style={{ width: 14, height: 14 }} />
        导出图片
      </button>
    </div>
  )
}

// ─── Text Section ───────────────────────────────────────────────

function TextSection({
  selectedObject,
  onChange,
}: {
  selectedObject: CanvasObject
  onChange: (updates: Partial<CanvasObject>) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Text" />

      <select
        value={selectedObject.fontFamily || 'Inter'}
        onChange={(e) => onChange({ fontFamily: e.target.value })}
        style={{
          height: 28,
          borderRadius: 4,
          border: '1px solid var(--border-default)',
          padding: '0 8px',
          fontFamily: 'Inter, sans-serif',
          fontSize: 12,
          color: 'var(--text-secondary)',
          background: 'var(--bg-toolbar)',
          outline: 'none',
          width: '100%',
          cursor: 'pointer',
        }}
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      <div style={{ display: 'flex', gap: 8 }}>
        <NumberField label="Size" value={selectedObject.fontSize ?? 14} onChange={(v) => onChange({ fontSize: Math.max(1, v) })} min={1} />
        <div style={{ flex: 1 }}>
          <select
            value={selectedObject.fontWeight || '400'}
            onChange={(e) => onChange({ fontWeight: e.target.value })}
            style={{
              width: '100%',
              height: 28,
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              padding: '0 8px',
              fontFamily: 'Inter, sans-serif',
              fontSize: 12,
              color: 'var(--text-secondary)',
              background: 'var(--bg-toolbar)',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="100">Thin</option>
            <option value="300">Light</option>
            <option value="400">Regular</option>
            <option value="500">Medium</option>
            <option value="600">Semibold</option>
            <option value="700">Bold</option>
            <option value="900">Black</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {(['left', 'center', 'right'] as const).map((align) => {
          const isActive = (selectedObject.textAlign || 'left') === align
          return (
            <button
              key={align}
              onClick={() => onChange({ textAlign: align })}
              style={{
                flex: 1,
                height: 28,
                borderRadius: 4,
                border: `1px solid ${isActive ? 'var(--text-secondary)' : 'var(--border-default)'}`,
                background: isActive ? 'var(--bg-hover)' : 'transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              {align === 'left' ? (
                <AlignLeft style={{ width: 14, height: 14 }} />
              ) : align === 'center' ? (
                <AlignCenterHorizontal style={{ width: 14, height: 14 }} />
              ) : (
                <AlignRight style={{ width: 14, height: 14 }} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── NumberField ─────────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const [localValue, setLocalValue] = useState<string>(String(value))
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const prevValueRef = useRef(value)
  if (!isFocused && prevValueRef.current !== value) {
    prevValueRef.current = value
    setLocalValue(String(value))
  }

  const clamp = (v: number): number => {
    let result = v
    if (min !== undefined) result = Math.max(min, result)
    if (max !== undefined) result = Math.min(max, result)
    return result
  }

  const commitValue = (raw: string) => {
    const parsed = Number(raw)
    if (!isNaN(parsed)) {
      const clamped = clamp(Math.round(parsed))
      onChange(clamped)
      setLocalValue(String(clamped))
    } else {
      setLocalValue(String(value))
    }
  }

  return (
    <div
      style={{
        flex: 1,
        height: 28,
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        padding: '0 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: 'Inter, sans-serif',
          fontSize: 12,
          color: 'var(--text-gray)',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {label}
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={isFocused ? localValue : String(value)}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const raw = e.target.value
          setLocalValue(raw)
          const parsed = Number(raw)
          if (!isNaN(parsed) && raw.trim() !== '') onChange(clamp(Math.round(parsed)))
        }}
        onFocus={() => { setIsFocused(true); setTimeout(() => inputRef.current?.select(), 0) }}
        onBlur={() => { setIsFocused(false); commitValue(localValue) }}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); commitValue(localValue); inputRef.current?.blur() }
          else if (e.key === 'ArrowUp') { e.preventDefault(); const inc = e.shiftKey ? step * 10 : step; const nv = clamp(value + inc); onChange(nv); setLocalValue(String(nv)) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); const dec = e.shiftKey ? step * 10 : step; const nv = clamp(value - dec); onChange(nv); setLocalValue(String(nv)) }
        }}
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'Inter, sans-serif',
          fontSize: 12,
          color: 'var(--text-secondary)',
          padding: 0,
          width: '100%',
          minWidth: 0,
        }}
      />
    </div>
  )
}
