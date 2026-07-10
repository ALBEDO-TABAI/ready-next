import { useRef, useState, useCallback, useEffect } from 'react'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'

interface DraggableModeSwitchProps {
  mode: 'edit' | 'preview'
  onChange: (mode: 'edit' | 'preview') => void
  /** 预览下沉态（预览内编辑）：再次点击预览时滑块下沉，内容可在预览中直接编辑。 */
  previewEditActive?: boolean
  onTogglePreviewEdit?: () => void
}

const getPositionForMode = (mode: 'edit' | 'preview') => (mode === 'preview' ? 0 : 1)

// Spring physics - softer, slower, less bounce
const SPRING_STIFFNESS = 120
const SPRING_DAMPING = 40
const SPRING_MASS = 1.8

// 下沉态的滑块缩放量：按进轨道的“按压”读感
const PREVIEW_EDIT_SINK_SCALE = 0.08
const THUMB_CLICK_SLOP_PX = 4

export default function DraggableModeSwitch({
  mode,
  onChange,
  previewEditActive = false,
  onTogglePreviewEdit,
}: DraggableModeSwitchProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(getPositionForMode(mode))
  const [isDragging, setIsDragging] = useState(false)
  const [sinkProgress, setSinkProgress] = useState(previewEditActive && mode === 'preview' ? 1 : 0)

  const dragStartXRef = useRef(0)
  const dragStartPosRef = useRef(0)
  const dragMovedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const sinkRafRef = useRef<number | null>(null)
  const sinkCurrentRef = useRef(previewEditActive && mode === 'preview' ? 1 : 0)
  const velocityRef = useRef(0)
  const targetRef = useRef(getPositionForMode(mode))
  const currentRef = useRef(getPositionForMode(mode))
  const isDraggingRef = useRef(false)
  const activePointerIdRef = useRef<number | null>(null)

  const isSunken = previewEditActive && mode === 'preview'

  // Sink ease runs in JS (like the position spring) so it never fights the
  // rAF-driven inline transform with a CSS transition.
  useEffect(() => {
    const target = isSunken ? 1 : 0
    if (sinkRafRef.current) cancelAnimationFrame(sinkRafRef.current)
    const step = () => {
      const current = sinkCurrentRef.current
      const delta = target - current
      if (Math.abs(delta) < 0.01) {
        sinkCurrentRef.current = target
        setSinkProgress(target)
        sinkRafRef.current = null
        return
      }
      sinkCurrentRef.current = current + delta * 0.28
      setSinkProgress(sinkCurrentRef.current)
      sinkRafRef.current = requestAnimationFrame(step)
    }
    sinkRafRef.current = requestAnimationFrame(step)
    return () => {
      if (sinkRafRef.current) {
        cancelAnimationFrame(sinkRafRef.current)
        sinkRafRef.current = null
      }
    }
  }, [isSunken])

  // Sync with external mode prop. `startSpringAnimation` is a
  // `useCallback(() => …, [])` declared below with stable identity for the
  // component lifetime, so omitting it from the deps array is intentional
  // (re-running on every render would restart the animation needlessly).
  useEffect(() => {
    if (!isDraggingRef.current) {
      targetRef.current = getPositionForMode(mode)
      startSpringAnimation()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode-only sync; see Y1.3 sub-plan §3.1
  }, [mode])

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

  // Smooth text styles - avoid font-weight changes which cause blur
  const getEditStyle = useCallback(() => {
    const distance = Math.abs(position - 1)
    const proximity = Math.max(0, 1 - distance)

    // Use opacity and color only - no font-weight or scale changes to avoid blur
    const isActive = proximity > 0.5

    return {
      opacity: 0.35 + proximity * 0.65,
      color: isActive ? 'rgba(255, 255, 255, 0.96)' : 'var(--text-muted, #666)',
      textShadow: isActive
        ? '0 0 1px rgba(255, 255, 255, 0.82), 0 0 3px rgba(255, 255, 255, 0.34)'
        : 'none',
    }
  }, [position])

  const getPreviewStyle = useCallback(() => {
    const distance = Math.abs(position - 0)
    const proximity = Math.max(0, 1 - distance)

    const isActive = proximity > 0.5

    return {
      opacity: 0.35 + proximity * 0.65,
      color: isActive ? 'rgba(255, 255, 255, 0.96)' : 'var(--text-muted, #666)',
      textShadow: isActive
        ? '0 0 1px rgba(255, 255, 255, 0.82), 0 0 3px rgba(255, 255, 255, 0.34)'
        : 'none',
    }
  }, [position])

  const cancelDrag = useCallback(() => {
    if (!isDraggingRef.current) return

    isDraggingRef.current = false
    activePointerIdRef.current = null
    setIsDragging(false)
    targetRef.current = getPositionForMode(mode)
    currentRef.current = targetRef.current
    setPosition(targetRef.current)
    startSpringAnimation()
  }, [mode, startSpringAnimation])

  const finishDrag = useCallback(() => {
    if (!isDraggingRef.current) return

    isDraggingRef.current = false
    activePointerIdRef.current = null
    setIsDragging(false)

    const snapToPreview = currentRef.current < 0.5
    targetRef.current = snapToPreview ? 0 : 1

    const newMode = snapToPreview ? 'preview' : 'edit'
    if (newMode !== mode) {
      onChange(newMode)
    }

    startSpringAnimation()
  }, [mode, onChange, startSpringAnimation])

  // Pointer down handler
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    isDraggingRef.current = true
    activePointerIdRef.current = e.pointerId
    setIsDragging(true)

    dragStartXRef.current = e.clientX
    dragStartPosRef.current = currentRef.current
    dragMovedRef.current = false

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || activePointerIdRef.current !== e.pointerId) return
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const halfWidth = rect.width / 2
    const deltaX = e.clientX - dragStartXRef.current
    if (Math.abs(deltaX) > THUMB_CLICK_SLOP_PX) {
      dragMovedRef.current = true
    }
    const deltaPos = deltaX / halfWidth

    let newPos = dragStartPosRef.current + deltaPos
    newPos = Math.max(0, Math.min(1, newPos))

    currentRef.current = newPos
    setPosition(newPos)
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return
    // A press on the thumb without real movement is a click: in preview mode
    // it toggles the sunken preview-edit state (滑块下沉，预览内可编辑).
    const wasClick = !dragMovedRef.current
    finishDrag()
    if (wasClick && mode === 'preview') {
      onTogglePreviewEdit?.()
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [finishDrag, mode, onTogglePreviewEdit])

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    cancelDrag()
  }, [cancelDrag])

  const handleLostPointerCapture = useCallback(() => {
    if (!isDraggingRef.current) return
    cancelDrag()
  }, [cancelDrag])

  // Click handler for labels
  const handleLabelClick = useCallback((targetMode: 'edit' | 'preview', e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    if (targetMode === mode) {
      // Re-clicking 预览 while already previewing sinks the thumb into
      // preview-edit (and lifts it back out on the next click).
      if (targetMode === 'preview') onTogglePreviewEdit?.()
      return
    }
    onChange(targetMode)
  }, [mode, onChange, onTogglePreviewEdit])

  const sinkScale = 1 - sinkProgress * PREVIEW_EDIT_SINK_SCALE

  return (
    <div
      ref={containerRef}
      className="draggable-mode-switch"
      data-mode={mode}
      data-dragging={isDragging}
      data-preview-edit={isSunken ? 'true' : undefined}
    >
      <div className="draggable-mode-switch__track" />

      {/* Draggable Thumb */}
      <div
        className={`draggable-mode-switch__thumb ${isDragging ? 'is-dragging' : ''}`}
        title={mode === 'preview' ? (isSunken ? '预览编辑中 · 点击退出' : '再点一下进入预览编辑') : undefined}
        style={{
          transform: `translateX(${position * 100}%) scale(calc(var(--ready-document-switch-thumb-scale, 1) * ${sinkScale}))`,
          cursor: isDragging ? 'grabbing' : 'pointer',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
      >
        <LiquidLens
          className="ready-slider-thumb-lens"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          radius={13}
          bevel={4}
          depth={8}
          ior={1.22}
          dome={0.7}
          strength={1.05}
          blur={0}
          frost={0}
          saturation={1}
          brightness={1}
          contrast={1}
          aberration={0}
          engine="backdrop"
        />
        <div className="draggable-mode-switch__thumb-glow" />
        <span className="draggable-mode-switch__thumb-label">
          {position < 0.5 ? '预览' : '编辑'}
        </span>
      </div>

      {/* Labels - fixed font-weight to avoid blur */}
      <button
        type="button"
        className={`draggable-mode-switch__label draggable-mode-switch__label--preview ${position < 0.5 ? 'is-active' : ''}`}
        style={getPreviewStyle()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => handleLabelClick('preview', e)}
      >
        预览
      </button>
      <button
        type="button"
        className={`draggable-mode-switch__label draggable-mode-switch__label--edit ${position >= 0.5 ? 'is-active' : ''}`}
        style={getEditStyle()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => handleLabelClick('edit', e)}
      >
        编辑
      </button>
    </div>
  )
}
