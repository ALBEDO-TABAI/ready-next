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
  const initialIndex = modes.findIndex(m => m.id === activeMode)
  const [snapIndex, setSnapIndex] = useState(initialIndex)
  const [isDragging, setIsDragging] = useState(false)

  const dragStartXRef = useRef(0)
  const dragStartPosRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const animationIdRef = useRef(0)
  const velocityRef = useRef(0)
  const targetRef = useRef(initialIndex)
  const currentRef = useRef(initialIndex)
  const isDraggingRef = useRef(false)
  const skipClickAnimationRef = useRef(false)

  const writeThumbPos = useCallback((pos: number) => {
    const el = containerRef.current
    if (!el) return
    el.style.setProperty('--dmt-thumb-pos', String(pos))
  }, [])

  useEffect(() => {
    writeThumbPos(currentRef.current)
  }, [writeThumbPos])

  const cancelAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startClickAnimation = useCallback(() => {
    cancelAnimation()
    const animationId = ++animationIdRef.current
    const start = currentRef.current
    const target = targetRef.current

    if (Math.abs(target - start) < 0.001) {
      currentRef.current = target
      writeThumbPos(target)
      return
    }

    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const animate = (timestamp: number) => {
      if (animationId !== animationIdRef.current) return
      const elapsed = timestamp - startedAt
      const progress = elapsed / WORKBENCH_SLIDER_CLICK_DURATION_MS
      const eased = easeWorkbenchSliderClick(progress)
      const next = start + (target - start) * eased

      currentRef.current = next
      writeThumbPos(next)

      if (progress >= 1) {
        currentRef.current = target
        writeThumbPos(target)
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation, writeThumbPos])

  const startSpringAnimation = useCallback(() => {
    cancelAnimation()
    const animationId = ++animationIdRef.current

    const animate = () => {
      if (animationId !== animationIdRef.current) return
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
        writeThumbPos(target)
        rafRef.current = null
        return
      }

      writeThumbPos(currentRef.current)
      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation, writeThumbPos])

  useEffect(() => {
    if (isDraggingRef.current) return

    const index = modes.findIndex(m => m.id === activeMode)
    targetRef.current = index
    setSnapIndex(index)

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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDraggingRef.current = true
    setIsDragging(true)

    dragStartXRef.current = e.clientX
    dragStartPosRef.current = currentRef.current

    cancelAnimation()
  }, [cancelAnimation])

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
      writeThumbPos(newPos)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)

      const nextIndex = Math.round(currentRef.current)
      targetRef.current = nextIndex
      setSnapIndex(nextIndex)

      const newMode = modes[nextIndex].id
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
  }, [isDragging, activeMode, onChange, startSpringAnimation, writeThumbPos])

  const handleIconClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    onChange(modes[index].id)
  }, [onChange])

  return (
    <div
      ref={containerRef}
      className="draggable-mode-tabs"
      data-dragging={isDragging}
      style={{ ['--dmt-thumb-pos' as string]: String(currentRef.current) }}
    >
      <div className="draggable-mode-tabs__track" />

      <div
        className={`draggable-mode-tabs__thumb ${isDragging ? 'is-dragging' : ''}`}
        style={{ cursor: isDragging ? 'grabbing' : 'pointer' }}
        onMouseDown={handleMouseDown}
      >
        <div className="draggable-mode-tabs__thumb-glow" />
      </div>

      {modes.map((mode, index) => {
        const Icon = mode.icon
        return (
          <button
            key={mode.id}
            type="button"
            className={`draggable-mode-tabs__icon ${snapIndex === index ? 'is-active' : ''}`}
            data-mode={mode.id}
            style={{ ['--dmt-icon-index' as string]: String(index) }}
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
