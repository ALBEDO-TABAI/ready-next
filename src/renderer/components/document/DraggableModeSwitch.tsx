import { useRef, useState, useCallback, useEffect } from 'react'

interface DraggableModeSwitchProps {
  mode: 'edit' | 'preview'
  onChange: (mode: 'edit' | 'preview') => void
}

// Spring physics - softer, slower, less bounce
const SPRING_STIFFNESS = 120
const SPRING_DAMPING = 40
const SPRING_MASS = 1.8

export default function DraggableModeSwitch({ mode, onChange }: DraggableModeSwitchProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(mode === 'edit' ? 0 : 1)
  const [isDragging, setIsDragging] = useState(false)

  const dragStartXRef = useRef(0)
  const dragStartPosRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const velocityRef = useRef(0)
  const targetRef = useRef(mode === 'edit' ? 0 : 1)
  const currentRef = useRef(mode === 'edit' ? 0 : 1)
  const isDraggingRef = useRef(false)

  // Sync with external mode prop
  useEffect(() => {
    if (!isDraggingRef.current) {
      targetRef.current = mode === 'edit' ? 0 : 1
      startSpringAnimation()
    }
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
    const distance = Math.abs(position - 0)
    const proximity = Math.max(0, 1 - distance)

    // Use opacity and color only - no font-weight or scale changes to avoid blur
    return {
      opacity: 0.35 + proximity * 0.65,
      color: proximity > 0.5
        ? 'var(--text-title, #1a1a1a)'
        : 'var(--text-muted, #666)',
    }
  }, [position])

  const getPreviewStyle = useCallback(() => {
    const distance = Math.abs(position - 1)
    const proximity = Math.max(0, 1 - distance)

    return {
      opacity: 0.35 + proximity * 0.65,
      color: proximity > 0.5
        ? 'var(--text-title, #1a1a1a)'
        : 'var(--text-muted, #666)',
    }
  }, [position])

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
      const halfWidth = rect.width / 2
      const deltaX = e.clientX - dragStartXRef.current
      const deltaPos = deltaX / halfWidth

      let newPos = dragStartPosRef.current + deltaPos
      newPos = Math.max(0, Math.min(1, newPos))

      currentRef.current = newPos
      setPosition(newPos)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      setIsDragging(false)

      const snapToEdit = currentRef.current < 0.5
      targetRef.current = snapToEdit ? 0 : 1

      const newMode = snapToEdit ? 'edit' : 'preview'
      if (newMode !== mode) {
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
  }, [isDragging, mode, onChange, startSpringAnimation])

  // Click handler for labels
  const handleLabelClick = useCallback((targetMode: 'edit' | 'preview', e: React.MouseEvent) => {
    e.stopPropagation()
    if (isDraggingRef.current) return
    onChange(targetMode)
  }, [onChange])

  return (
    <div
      ref={containerRef}
      className="draggable-mode-switch"
      data-mode={mode}
      data-dragging={isDragging}
    >
      <div className="draggable-mode-switch__track" />

      {/* Draggable Thumb */}
      <div
        className={`draggable-mode-switch__thumb ${isDragging ? 'is-dragging' : ''}`}
        style={{
          transform: `translateX(${position * 100}%)`,
          cursor: isDragging ? 'grabbing' : 'pointer',
        }}
        onMouseDown={handleMouseDown}
      >
        <div className="draggable-mode-switch__thumb-glow" />
      </div>

      {/* Labels - fixed font-weight to avoid blur */}
      <button
        type="button"
        className={`draggable-mode-switch__label draggable-mode-switch__label--edit ${position < 0.5 ? 'is-active' : ''}`}
        style={getEditStyle()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => handleLabelClick('edit', e)}
      >
        编辑
      </button>
      <button
        type="button"
        className={`draggable-mode-switch__label draggable-mode-switch__label--preview ${position >= 0.5 ? 'is-active' : ''}`}
        style={getPreviewStyle()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => handleLabelClick('preview', e)}
      >
        预览
      </button>
    </div>
  )
}
