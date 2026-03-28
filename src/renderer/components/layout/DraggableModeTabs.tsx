import { useRef, useState, useCallback, useEffect } from 'react'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import type { WorkbenchMode } from '../../stores/useMode'
import '../../styles/workbench-sliders.css'
import {
  easeWorkbenchSliderClick,
  WORKBENCH_SLIDER_CLICK_DURATION_MS,
  WORKBENCH_SLIDER_FRAME_STEP,
  WORKBENCH_SLIDER_SPRING,
} from '../../modules/workbench/slider-motion'

const modes: { id: WorkbenchMode; icon: typeof Globe }[] = [
  { id: 'browser', icon: Globe },
  { id: 'document', icon: FileText },
  { id: 'rss', icon: Rss },
  { id: 'calendar', icon: Calendar },
]

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
  const skipClickAnimationRef = useRef(false)

  const cancelAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startClickAnimation = useCallback(() => {
    cancelAnimation()
    const start = currentRef.current
    const target = targetRef.current

    if (Math.abs(target - start) < 0.001) {
      currentRef.current = target
      setPosition(target)
      return
    }

    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const animate = (timestamp: number) => {
      const elapsed = timestamp - startedAt
      const progress = elapsed / WORKBENCH_SLIDER_CLICK_DURATION_MS
      const eased = easeWorkbenchSliderClick(progress)
      const next = start + (target - start) * eased

      currentRef.current = next
      setPosition(next)

      if (progress >= 1) {
        currentRef.current = target
        setPosition(target)
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation])

  const startSpringAnimation = useCallback(() => {
    cancelAnimation()

    const animate = () => {
      const target = targetRef.current
      const displacement = target - currentRef.current
      const springForce = displacement * WORKBENCH_SLIDER_SPRING.stiffness
      const dampingForce = velocityRef.current * WORKBENCH_SLIDER_SPRING.damping
      const acceleration = (springForce - dampingForce) / WORKBENCH_SLIDER_SPRING.mass

      velocityRef.current += acceleration * WORKBENCH_SLIDER_FRAME_STEP
      currentRef.current += velocityRef.current * WORKBENCH_SLIDER_FRAME_STEP

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
  }, [cancelAnimation])

  // Sync with external activeMode prop
  useEffect(() => {
    if (isDraggingRef.current) return

    const index = modes.findIndex(m => m.id === activeMode)
    targetRef.current = index

    if (skipClickAnimationRef.current) {
      skipClickAnimationRef.current = false
      startSpringAnimation()
      return
    }

    startClickAnimation()
  }, [activeMode, startClickAnimation, startSpringAnimation])

  useEffect(() => {
    return () => {
      cancelAnimation()
    }
  }, [cancelAnimation])

  // Mouse down handler
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingRef.current = true
    setIsDragging(true)

    dragStartXRef.current = e.clientX
    dragStartPosRef.current = currentRef.current

    cancelAnimation()
  }, [cancelAnimation])

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
        skipClickAnimationRef.current = true
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
            data-mode={mode.id}
            style={getIconStyle(index)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => handleIconClick(index, e)}
            title={mode.id}
          >
            <Icon style={{ width: 15, height: 15 }} strokeWidth={2} />
          </button>
        )
      })}
    </div>
  )
}
