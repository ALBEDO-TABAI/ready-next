import { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import type { ElementType, MouseEvent as ReactMouseEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import type { WorkbenchMode } from '../../stores/useMode'
import { useTheme } from '../../stores/useTheme'
import { CalendarFilled, FileTextFilled, GlobeFilled } from '../../design/next/icons'
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

// The mode switch slot above the assistant composer (V20, V21): the four modes on a liquid-glass pill, the same glass as
// the composer and the project chip beside it. The thumb is a clear glass lens lying on the icons, flush with the pill:
// its full height, one cell wide (both modes of a split), touching the pill's edge but never crossing it; it bends what is
// under its rim. Each icon has a resting twin (outline, quiet ink) and a lit twin (the filled glyph, or 资讯's outline
// at a heavier stroke, white with a soft glow); the lens alone crossfades them (mode-switch.css), so the icon it leaves
// empties and the one it reaches fills as it glides or is dragged, before and after the mode commits. It shows the
// rail's state and switches through the rail's handlers (WorkbenchMode).
const MODE_TABS: Record<WorkbenchMode, { label: string; hint: string; icon: ElementType; activeIcon?: ElementType }> = {
  browser: { label: '浏览器', hint: '⌘1', icon: Globe, activeIcon: GlobeFilled },
  document: { label: '文档', hint: '⌘2', icon: FileText, activeIcon: FileTextFilled },
  rss: { label: '资讯', hint: '⌘3', icon: Rss },
  calendar: { label: '日历', hint: '⌘4', icon: Calendar, activeIcon: CalendarFilled },
}

// The pill's radius and the lens's: both are 40px tall, so the lens at either end is concentric with the pill.
const SLOT_RADIUS = 20
const LENS_RADIUS = 20

interface DraggableModeTabsProps {
  activeMode: WorkbenchMode
  splitMode?: WorkbenchMode | null
  onChange: (mode: WorkbenchMode) => void
  /** ⇧-click (or ⌥-click, as on the rail) opens the mode beside the current one. */
  onSplitToggle?: (mode: WorkbenchMode) => void
}

export default function DraggableModeTabs({
  activeMode,
  splitMode = null,
  onChange,
  onSplitToggle,
}: DraggableModeTabsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  // 减少透明（DL12）：no refraction or projection, the glass falls back to the panel colour (liquid-composer.css).
  const lensEngine = useTheme(state => state.transparency === 'reduced') ? 'off' : 'backdrop'
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
  // The span on screen: it follows the target span in step with the glide, so the lens's far end stays in the pill.
  const visualSpanRef = useRef(tabLayout.thumbSpan)
  const displayModesRef = useRef(tabLayout.displayModes)
  const isDraggingRef = useRef(false)
  const skipClickAnimationRef = useRef(false)

  const writeThumbMetrics = useCallback((pos: number, span = visualSpanRef.current) => {
    const el = containerRef.current
    if (!el) return
    // The lens never leaves the pill, whatever an animation asks for.
    el.style.setProperty('--dmt-thumb-pos', String(Math.max(0, Math.min(4 - span, pos))))
    el.style.setProperty('--dmt-thumb-span', String(span))
  }, [])

  // The thumb's place is written only here and by the animations, never through React's style prop, so a re-render in
  // the middle of a glide cannot put back a stale place or span; before the first paint, so it never flashes at 0.
  useLayoutEffect(() => {
    writeThumbMetrics(currentRef.current, visualSpanRef.current)
  }, [writeThumbMetrics])

  const cancelAnimation = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // A spring cut short must not hand its speed to the next one (the drag releases the lens at rest).
    velocityRef.current = 0
  }, [])

  const startClickAnimation = useCallback(() => {
    cancelAnimation()
    const animationId = ++animationIdRef.current
    const start = currentRef.current
    const target = targetRef.current
    const spanStart = visualSpanRef.current
    const spanTarget = thumbSpanRef.current

    // Reduced motion: the thumb lands without travelling.
    if (reduceMotion || (Math.abs(target - start) < 0.001 && Math.abs(spanTarget - spanStart) < 0.001)) {
      currentRef.current = target
      visualSpanRef.current = spanTarget
      writeThumbMetrics(target, spanTarget)
      return
    }

    // One clock for the start and every frame (a frame's own timestamp may count from another origin).
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const startedAt = now()

    const animate = () => {
      if (animationId !== animationIdRef.current) return
      const elapsed = now() - startedAt
      const progress = elapsed / WORKBENCH_SLIDER_CLICK_DURATION_MS
      const eased = easeWorkbenchSliderClick(progress)
      const next = start + (target - start) * eased
      // Place and span move on one curve: both ends satisfy start + span ≤ 4, so every frame between does too.
      const span = spanStart + (spanTarget - spanStart) * eased

      currentRef.current = next
      visualSpanRef.current = span
      writeThumbMetrics(next, span)

      if (progress >= 1) {
        currentRef.current = target
        visualSpanRef.current = spanTarget
        writeThumbMetrics(target, spanTarget)
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    rafRef.current = requestAnimationFrame(animate)
  }, [cancelAnimation, reduceMotion, writeThumbMetrics])

  const startSpringAnimation = useCallback(() => {
    cancelAnimation()
    const animationId = ++animationIdRef.current
    // After a drag the span settles at once; the clamp keeps the springing lens inside the pill.
    visualSpanRef.current = thumbSpanRef.current

    if (reduceMotion) {
      currentRef.current = targetRef.current
      velocityRef.current = 0
      writeThumbMetrics(targetRef.current)
      return
    }

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
  }, [cancelAnimation, reduceMotion, writeThumbMetrics])

  useEffect(() => {
    if (isDraggingRef.current) return

    displayModesRef.current = tabLayout.displayModes
    thumbSpanRef.current = tabLayout.thumbSpan
    targetRef.current = tabLayout.thumbStart
    setSnapIndex(tabLayout.activeIndex)

    if (skipClickAnimationRef.current) {
      skipClickAnimationRef.current = false
      startSpringAnimation()
      return
    }

    startClickAnimation()
  }, [activeMode, splitMode, startClickAnimation, startSpringAnimation, tabLayout])

  useEffect(() => {
    return () => {
      cancelAnimation()
    }
  }, [cancelAnimation])

  // The lens lets presses through to the icons, so a press on an icon it covers is a press on the thumb.
  const handleThumbMouseDown = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 0) return
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

      // One cell of thumb travel: the slot holds four cells edge to edge.
      const rect = container.getBoundingClientRect()
      const segmentWidth = rect.width / 4
      const deltaX = e.clientX - dragStartXRef.current
      const deltaPos = deltaX / segmentWidth

      let newPos = dragStartPosRef.current + deltaPos
      newPos = Math.max(0, Math.min(4 - visualSpanRef.current, newPos))

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

  const handleIconClick = useCallback((mode: WorkbenchMode, e: ReactMouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    if ((e.shiftKey || e.altKey) && onSplitToggle) {
      onSplitToggle(mode)
      return
    }
    onChange(mode)
  }, [onChange, onSplitToggle])

  return (
    <div
      ref={containerRef}
      className="draggable-mode-tabs"
      role="tablist"
      aria-label="模式"
      aria-multiselectable={tabLayout.splitIndex !== null}
      data-dragging={isDragging}
      data-split-active={tabLayout.splitIndex === null ? 'false' : 'true'}
      data-active-position={snapIndex}
    >
      <LiquidLens
        className="draggable-mode-tabs__surface"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        radius={SLOT_RADIUS}
        bevel={8}
        depth={18.5}
        ior={1.34}
        dome={0.65}
        profile="squircle"
        strength={2.4}
        blur={3.5}
        frost={0}
        blurBeforeRefraction
        saturation={1.18}
        brightness={1.05}
        contrast={0.84}
        aberration={0}
        engine={lensEngine}
        backdropContent={(
          <LiquidBackdropProjection
            className="draggable-mode-tabs__projection"
            sourceMaskRadius={SLOT_RADIUS}
          />
        )}
      />

      {/* Clear glass on top of the icons: no tint, blur or frost; the flat centre shows the 16px glyph sharp, the outer
          band (squircle roll-off, bending clearly across about 5px) bends what lies under the rim, with a thin colour
          fringe. */}
      <div className="draggable-mode-tabs__thumb" aria-hidden="true">
        <LiquidLens
          className="draggable-mode-tabs__thumb-lens"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          radius={LENS_RADIUS}
          bevel={12}
          depth={18}
          ior={1.5}
          dome={0}
          profile="squircle"
          strength={2}
          blur={0}
          frost={0}
          saturation={1}
          brightness={1}
          contrast={1}
          aberration={3}
          engine={lensEngine}
        />
      </div>

      {WORKBENCH_MODE_ORDER.map((mode, index) => {
        const { label, hint, icon: Icon, activeIcon: ActiveIcon } = MODE_TABS[mode]
        const visualIndex = tabLayout.visualIndexByMode[mode]
        const isPrimaryActive = activeMode === mode
        const isSplitActive = splitMode === mode
        const onThumb = isPrimaryActive || isSplitActive
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={onThumb}
            aria-label={label}
            title={`${label} ${hint}`}
            className={`draggable-mode-tabs__icon${isPrimaryActive ? ' is-active' : ''}${isSplitActive ? ' is-split-active' : ''}`}
            data-mode={mode}
            style={{
              ['--dmt-icon-index' as string]: String(visualIndex),
              ['--dmt-icon-shift' as string]: String(visualIndex - index),
            }}
            onMouseDown={onThumb ? handleThumbMouseDown : (e) => e.stopPropagation()}
            onClick={(e) => handleIconClick(mode, e)}
          >
            <span className="draggable-mode-tabs__glyphs">
              <Icon className="draggable-mode-tabs__glyph is-rest" strokeWidth={1.5} aria-hidden="true" />
              {ActiveIcon
                ? <ActiveIcon className="draggable-mode-tabs__glyph is-lit" strokeWidth={1.5} aria-hidden="true" />
                : <Icon className="draggable-mode-tabs__glyph is-lit" strokeWidth={2} aria-hidden="true" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}
