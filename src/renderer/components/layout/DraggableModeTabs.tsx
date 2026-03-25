import { useRef, useState, useCallback, useEffect } from 'react'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import type { WorkbenchMode } from '../../stores/useMode'
import '../../styles/workbench-sliders.css'

const modes: { id: WorkbenchMode; icon: typeof Globe }[] = [
  { id: 'browser', icon: Globe },
  { id: 'document', icon: FileText },
  { id: 'rss', icon: Rss },
  { id: 'calendar', icon: Calendar },
]

// Spring physics - softer, slower, less bounce
const SPRING_STIFFNESS = 120
const SPRING_DAMPING = 40
const SPRING_MASS = 1.8

interface DraggableModeTabsProps {
  activeMode: WorkbenchMode
  onChange: (mode: WorkbenchMode) => void
}

export default function DraggableModeTabs({ activeMode, onChange }: DraggableModeTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(() => modes.findIndex(m => m.id === activeMode))
  const [isDragging, setIsDragging] = useState(false)

  const dragStartXRef = useRef(0)
  const dragStartPosRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const velocityRef = useRef(0)
  const targetRef = useRef(modes.findIndex(m => m.id === activeMode))
  const currentRef = useRef(modes.findIndex(m => m.id === activeMode))
  const isDraggingRef = useRef(false)

  // Sync with external activeMode prop
  useEffect(() => {
    if (!isDraggingRef.current) {
      const index = modes.findIndex(m => m.id === activeMode)
      targetRef.current = index
      startSpringAnimation()
    }
  }, [activeMode])

  // Spring animation loop
  const startSpringAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    const animate = () => {
      const target = targetRef.current
      const displacement = target - currentRef.current
      const springForce = displacement * SPRING_STIFFNESS
      const dampingForce = velocityRef.current * SPRING_DAMPING
      const acceleration = (springForce - dampingForce) / SPRING_MASS

      velocityRef.current += acceleration * 0.016
      currentRef.current += velocityRef.current * 0.016

      if (Math.abs(target - currentRef.current) < 0.002 && Math.abs(velocityRef.current) < 0.02) {
        currentRef.current = target
        velocityRef.current = 0
        setPosition(target)
        rafRef.current = null
        return
      }

      setPosition(currentRef.current)
      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Mouse down handler
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingRef.current = true
    setIsDragging(true)

    dragStartXRef.current = e.clientX
    dragStartPosRef.current = currentRef.current

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // Global mouse move handler
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const segmentWidth = rect.width / 4
      const deltaX = e.clientX - dragStartXRef.current
      const deltaPos = deltaX / segmentWidth

      let newPos = dragStartPosRef.current + deltaPos
      newPos = Math.max(0, Math.min(3, newPos))

      currentRef.current = newPos
      setPosition(newPos)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)

      // Snap to nearest mode
      const snapIndex = Math.round(currentRef.current)
      targetRef.current = snapIndex

      const newMode = modes[snapIndex].id
      if (newMode !== activeMode) {
        onChange(newMode)
      }

      startSpringAnimation()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp, { once: true })

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, activeMode, onChange, startSpringAnimation])

  // Click handler for icons
  const handleIconClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    onChange(modes[index].id)
  }, [onChange])

  // Calculate icon styles based on proximity to thumb center
  const getIconStyle = useCallback((index: number) => {
    const distance = Math.abs(position - index)
    const proximity = Math.max(0, 1 - distance * 0.8)

    return {
      opacity: 0.4 + proximity * 0.6,
      color: proximity > 0.5
        ? 'var(--color-blue, #5B8DEF)'
        : 'var(--text-muted, #666)',
    }
  }, [position])

  const thumbStyle: React.CSSProperties = {
    transform: `translateX(${position * 100}%)`,
    cursor: isDragging ? 'grabbing' : 'pointer',
  }

  return (
    <div
      ref={containerRef}
      className="draggable-mode-tabs"
      data-dragging={isDragging}
    >
      <div className="draggable-mode-tabs__track" />

      {/* Draggable Thumb */}
      <div
        className={`draggable-mode-tabs__thumb ${isDragging ? 'is-dragging' : ''}`}
        style={thumbStyle}
        onMouseDown={handleMouseDown}
      >
        <div className="draggable-mode-tabs__thumb-glow" />
      </div>

      {/* Icons */}
      {modes.map((mode, index) => {
        const Icon = mode.icon
        return (
          <button
            key={mode.id}
            type="button"
            className={`draggable-mode-tabs__icon ${Math.round(position) === index ? 'is-active' : ''}`}
            style={getIconStyle(index)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => handleIconClick(index, e)}
            title={mode.id}
          >
            <Icon style={{ width: 13, height: 13 }} strokeWidth={2} />
          </button>
        )
      })}
    </div>
  )
}
