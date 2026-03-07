import { useState, useRef, useEffect } from 'react'
import {
  MousePointer2, Hand, Frame, Square, Type, PenTool, Circle, Layers,
} from 'lucide-react'
import type { ActiveTool, ShapeType } from './types'

interface ImageToolsRailProps {
  activeTool: ActiveTool
  onToolChange: (tool: ActiveTool) => void
  shapeType: ShapeType
  onShapeTypeChange: (type: ShapeType) => void
  showLayers: boolean
  onToggleLayers: () => void
}

const tools: { id: ActiveTool; icon: typeof MousePointer2; label: string }[] = [
  { id: 'select', icon: MousePointer2, label: 'Select' },
  { id: 'pan', icon: Hand, label: 'Pan/Hand' },
  { id: 'frame', icon: Frame, label: 'Frame' },
  { id: 'shape', icon: Square, label: 'Shape' },
  { id: 'text', icon: Type, label: 'Text' },
  { id: 'pen', icon: PenTool, label: 'Pen' },
]

export default function ImageToolsRail({
  activeTool,
  onToolChange,
  shapeType,
  onShapeTypeChange,
  showLayers,
  onToggleLayers,
}: ImageToolsRailProps) {
  const [showShapeMenu, setShowShapeMenu] = useState(false)
  const [hoveredTool, setHoveredTool] = useState<ActiveTool | null>(null)
  const [hoveredLayers, setHoveredLayers] = useState(false)
  const shapeMenuRef = useRef<HTMLDivElement>(null)
  const shapeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        shapeMenuRef.current &&
        !shapeMenuRef.current.contains(e.target as Node) &&
        shapeButtonRef.current &&
        !shapeButtonRef.current.contains(e.target as Node)
      ) {
        setShowShapeMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleShapeClick = () => {
    if (activeTool === 'shape') {
      setShowShapeMenu((prev) => !prev)
    } else {
      onToolChange('shape')
      setShowShapeMenu(true)
    }
  }

  const ShapeIcon = shapeType === 'ellipse' ? Circle : Square

  return (
    <div
      style={{
        width: 48,
        height: '100%',
        background: 'var(--bg-toolbar)',
        borderRight: '1px solid var(--border-default)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        gap: 4,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {tools.map((tool) => {
        const isShape = tool.id === 'shape'
        const Icon = isShape ? ShapeIcon : tool.icon
        const isActive = activeTool === tool.id
        const isHovered = hoveredTool === tool.id

        return (
          <div key={tool.id} style={{ position: 'relative' }}>
            <button
              ref={isShape ? shapeButtonRef : undefined}
              onClick={isShape ? handleShapeClick : () => onToolChange(tool.id)}
              onMouseEnter={() => setHoveredTool(tool.id)}
              onMouseLeave={() => setHoveredTool(null)}
              title={tool.label}
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                background: isActive
                  ? 'var(--bg-slider)'
                  : isHovered
                    ? 'rgba(0,0,0,0.04)'
                    : 'transparent',
                color: isActive ? 'var(--text-secondary)' : 'var(--text-gray)',
                transition: 'background 150ms ease',
              }}
            >
              <Icon style={{ width: 16, height: 16 }} strokeWidth={2} />
            </button>

            {isShape && showShapeMenu && (
              <div
                ref={shapeMenuRef}
                style={{
                  position: 'absolute',
                  left: 40,
                  top: 0,
                  zIndex: 50,
                  background: 'var(--bg-primary)',
                  borderRadius: 8,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                  border: '1px solid var(--border-default)',
                  padding: '4px 0',
                  minWidth: 128,
                }}
              >
                <button
                  onClick={() => { onShapeTypeChange('rect'); setShowShapeMenu(false) }}
                  onMouseEnter={(e) => {
                    if (shapeType !== 'rect') e.currentTarget.style.background = 'rgba(0,0,0,0.04)'
                  }}
                  onMouseLeave={(e) => {
                    if (shapeType !== 'rect') e.currentTarget.style.background = 'transparent'
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 12px',
                    fontSize: 12,
                    border: 'none',
                    cursor: 'pointer',
                    background: shapeType === 'rect' ? 'var(--bg-slider)' : 'transparent',
                    color: shapeType === 'rect' ? 'var(--text-secondary)' : 'var(--text-gray)',
                    transition: 'background 150ms ease',
                  }}
                >
                  <Square style={{ width: 14, height: 14 }} strokeWidth={2} />
                  Rectangle
                </button>
                <button
                  onClick={() => { onShapeTypeChange('ellipse'); setShowShapeMenu(false) }}
                  onMouseEnter={(e) => {
                    if (shapeType !== 'ellipse') e.currentTarget.style.background = 'rgba(0,0,0,0.04)'
                  }}
                  onMouseLeave={(e) => {
                    if (shapeType !== 'ellipse') e.currentTarget.style.background = 'transparent'
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 12px',
                    fontSize: 12,
                    border: 'none',
                    cursor: 'pointer',
                    background: shapeType === 'ellipse' ? 'var(--bg-slider)' : 'transparent',
                    color: shapeType === 'ellipse' ? 'var(--text-secondary)' : 'var(--text-gray)',
                    transition: 'background 150ms ease',
                  }}
                >
                  <Circle style={{ width: 14, height: 14 }} strokeWidth={2} />
                  Ellipse
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Layers toggle button at bottom */}
      <button
        onClick={onToggleLayers}
        onMouseEnter={() => setHoveredLayers(true)}
        onMouseLeave={() => setHoveredLayers(false)}
        title="图层面板"
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          background: showLayers
            ? 'var(--bg-slider)'
            : hoveredLayers
              ? 'rgba(0,0,0,0.04)'
              : 'transparent',
          color: showLayers ? 'var(--text-secondary)' : 'var(--text-gray)',
          transition: 'background 150ms ease',
        }}
      >
        <Layers style={{ width: 16, height: 16 }} strokeWidth={2} />
      </button>
    </div>
  )
}
