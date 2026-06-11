import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import type { WorkbenchMode } from '../../stores/useMode'
import '../../styles/workbench-sliders.css'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'
import { LiquidBackdropProjection } from '../ui/liquid-glass/LiquidBackdropProjection'
import { WORKBENCH_MODE_ORDER } from '../../modules/workbench/mode-split'
import { resolveWorkbenchModeTabLayout } from '../../modules/workbench/mode-tabs-layout'
import {
  easeWorkbenchSliderClick,
  WORKBENCH_SLIDER_CLICK_DURATION_MS,
  WORKBENCH_SLIDER_FRAME_STEP,
  WORKBENCH_SLIDER_SPRING,
} from '../../modules/workbench/slider-motion'

const modeIcons: Record<WorkbenchMode, typeof Globe> = {
  browser: Globe,
  document: FileText,
  rss: Rss,
  calendar: Calendar,
}

const modes: { id: WorkbenchMode; icon: typeof Globe }[] = [
  { id: 'browser', icon: Globe },
  { id: 'document', icon: FileText },
  { id: 'rss', icon: Rss },
  { id: 'calendar', icon: Calendar },
]

interface DraggableModeTabsProps {
  activeMode: WorkbenchMode
  splitMode?: WorkbenchMode | null
  onChange: (mode: WorkbenchMode) => void
  onSplitToggle?: (mode: WorkbenchMode) => void
}

export default function DraggableModeTabs({
  activeMode,
  splitMode = null,
  onChange,
  onSplitToggle,
}: DraggableModeTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const tabLayout = useMemo(
    () => resolveWorkbenchModeTabLayout(activeMode, splitMode),
    [activeMode, splitMode],
  )
  const initialIndex = tabLayout.thumbStart
  const [snapIndex, setSnapIndex] = useState(initialIndex)
  const [isDragging, setIsDragging] = useState(false)

  const dragStartXRef = useRef(0)
  const dragStartPosRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const animationIdRef = useRef(0)
  const velocityRef = useRef(0)
  const targetRef = useRef(initialIndex)
  const currentRef = useRef(initialIndex)
  const thumbSpanRef = useRef(tabLayout.thumbSpan)
  const displayModesRef = useRef(tabLayout.displayModes)
  const isDraggingRef = useRef(false)
  const skipClickAnimationRef = useRef(false)

  const writeThumbMetrics = useCallback((pos: number, span = thumbSpanRef.current) => {
    const el = containerRef.current
    if (!el) return
    el.style.setProperty('--dmt-thumb-pos', String(pos))
    el.style.setProperty('--dmt-thumb-span', String(span))
  }, [])

  useEffect(() => {
    writeThumbMetrics(currentRef.current, thumbSpanRef.current)
  }, [writeThumbMetrics])

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
      writeThumbMetrics(target)
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
      writeThumbMetrics(next)

      if (progress >= 1) {
        currentRef.current = target
        writeThumbMetrics(target)
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation, writeThumbMetrics])

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
        writeThumbMetrics(target)
        rafRef.current = null
        return
      }

      writeThumbMetrics(currentRef.current)
      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation, writeThumbMetrics])

  useEffect(() => {
    if (isDraggingRef.current) return

    displayModesRef.current = tabLayout.displayModes
    thumbSpanRef.current = tabLayout.thumbSpan
    writeThumbMetrics(currentRef.current, tabLayout.thumbSpan)
    targetRef.current = tabLayout.thumbStart
    setSnapIndex(tabLayout.activeIndex)

    if (skipClickAnimationRef.current) {
      skipClickAnimationRef.current = false
      startSpringAnimation()
      return
    }

    startClickAnimation()
  }, [activeMode, splitMode, startClickAnimation, startSpringAnimation, tabLayout, writeThumbMetrics])

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
      newPos = Math.max(0, Math.min(4 - thumbSpanRef.current, newPos))

      currentRef.current = newPos
      writeThumbMetrics(newPos)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)

      const nextIndex = Math.round(currentRef.current)
      targetRef.current = nextIndex
      setSnapIndex(nextIndex)

      const newMode = displayModesRef.current[nextIndex] ?? activeMode
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
  }, [isDragging, activeMode, onChange, startSpringAnimation, writeThumbMetrics])

  const handleIconClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    const mode = modes[index].id
    if (e.shiftKey && onSplitToggle) {
      onSplitToggle(mode)
      return
    }
    onChange(mode)
  }, [onChange, onSplitToggle])

  return (
    <div
      ref={containerRef}
      className="draggable-mode-tabs"
      data-dragging={isDragging}
      data-split-active={tabLayout.splitIndex === null ? 'false' : 'true'}
      data-active-position={snapIndex}
      style={{
        ['--dmt-thumb-pos' as string]: String(currentRef.current),
        ['--dmt-thumb-span' as string]: String(thumbSpanRef.current),
      }}
    >
      <LiquidLens
        className="draggable-mode-tabs__surface"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        radius={19}
        bevel={2.5}
        depth={18.5}
        ior={1.34}
        dome={1.6}
        strength={2.6}
        blur={0.875}
        frost={0}
        blurBeforeRefraction
        saturation={1.18}
        brightness={1.05}
        contrast={0.84}
        aberration={0}
        engine="backdrop"
        backdropContent={(
          <LiquidBackdropProjection
            className="draggable-mode-tabs__projection"
            sourceMaskRadius={19}
          />
        )}
      />
      <div className="draggable-mode-tabs__track" />

      <div
        className={`draggable-mode-tabs__thumb ${isDragging ? 'is-dragging' : ''}`}
        style={{ cursor: isDragging ? 'grabbing' : 'pointer' }}
        onMouseDown={handleMouseDown}
      >
        <LiquidLens
          className="ready-slider-thumb-lens"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          radius={16}
          bevel={6}
          depth={14}
          ior={1.3}
          dome={1.15}
          strength={1.42}
          blur={0}
          frost={0}
          saturation={1}
          brightness={1}
          contrast={1}
          aberration={0}
          engine="backdrop"
        />
        <div className="draggable-mode-tabs__thumb-glow" />
      </div>

      {WORKBENCH_MODE_ORDER.map((modeId, index) => {
        const Icon = modeIcons[modeId]
        const mode = { id: modeId, icon: Icon }
        const visualIndex = tabLayout.visualIndexByMode[mode.id]
        const isPrimaryActive = activeMode === mode.id
        const isSplitActive = splitMode === mode.id
        return (
          <button
            key={mode.id}
            type="button"
            className={`draggable-mode-tabs__icon ${isPrimaryActive ? 'is-active' : ''} ${isSplitActive ? 'is-split-active' : ''}`}
            data-mode={mode.id}
            data-split-active={isSplitActive ? 'true' : undefined}
            style={{
              ['--dmt-icon-index' as string]: String(visualIndex),
              ['--dmt-icon-shift' as string]: String(visualIndex - index),
            }}
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
