import { useEffect, useRef, useState, type CSSProperties, type ElementType } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'framer-motion'
import '../../styles/workbench-sliders.css'
import {
  REDUCED_MOTION_TRANSITION,
  WORKBENCH_SLIDER_MOTION_TRANSITION,
} from '../../modules/workbench/slider-motion'

interface RailItem {
  id: string
  label: string
  icon: ElementType
}

interface MorphIconRailGroupProps {
  items: RailItem[]
  activeId: string
  expanded?: boolean
  onSelect?: (id: string) => void
  layoutId: string
  className?: string
  style?: CSSProperties
}

const THUMB_LIFT_BEFORE_SLIDE_MS = 1500
const THUMB_PRESS_SETTLE_MS = 750
const THUMB_DEPTH_TRANSITION = {
  duration: 0.75,
  ease: [0.22, 1, 0.36, 1],
} as const
const THUMB_LIFT_TRANSITION = {
  duration: 1.5,
  ease: [0.22, 1, 0.36, 1],
} as const
const ICON_RAIL_SLOWER_MOTION_TRANSITION = {
  ...WORKBENCH_SLIDER_MOTION_TRANSITION,
  stiffness: 60,
  damping: 38,
  mass: 3.2,
} as const

export default function MorphIconRailGroup({
  items,
  activeId,
  expanded = true,
  onSelect,
  layoutId,
  className,
  style,
}: MorphIconRailGroupProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_MOTION_TRANSITION : ICON_RAIL_SLOWER_MOTION_TRANSITION
  const [thumbId, setThumbId] = useState(activeId)
  const [thumbState, setThumbState] = useState<'elevated' | 'pressing' | 'resting'>(expanded ? 'elevated' : 'resting')
  const previousActiveIdRef = useRef(activeId)
  const previousExpandedRef = useRef(expanded)
  const slideTimerRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (slideTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(slideTimerRef.current)
      }
      if (settleTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(settleTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const previousActiveId = previousActiveIdRef.current
    const previousExpanded = previousExpandedRef.current

    if (slideTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(slideTimerRef.current)
      slideTimerRef.current = null
    }
    if (settleTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }

    if (!expanded) {
      setThumbId(activeId)
      if (reduceMotion || typeof window === 'undefined') {
        setThumbState('resting')
      } else {
        setThumbState('pressing')
        settleTimerRef.current = window.setTimeout(() => {
          setThumbState('resting')
          settleTimerRef.current = null
        }, THUMB_PRESS_SETTLE_MS)
      }
    } else if (!previousExpanded) {
      setThumbId(previousActiveId)
      setThumbState('elevated')

      if (previousActiveId !== activeId && typeof window !== 'undefined') {
        slideTimerRef.current = window.setTimeout(() => {
          setThumbId(activeId)
          slideTimerRef.current = null
        }, reduceMotion ? 0 : THUMB_LIFT_BEFORE_SLIDE_MS)
      }
    } else {
      setThumbState('elevated')
      setThumbId(activeId)
    }

    previousActiveIdRef.current = activeId
    previousExpandedRef.current = expanded
  }, [activeId, expanded, reduceMotion])

  return (
    <MotionConfig transition={transition}>
      <div className={['icon-rail-slider', className].filter(Boolean).join(' ')} style={style}>
        <div className="icon-rail-slider__track" />
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = thumbId === id && thumbState === 'elevated'
          const isRemembered = thumbId === id && thumbState !== 'elevated'
          const thumbVisible = thumbId === id
          return (
            <motion.button
              key={id}
              layout
              type="button"
              onClick={() => onSelect?.(id)}
              title={label}
              aria-label={label}
              whileHover={!reduceMotion ? { y: -1 } : undefined}
              whileTap={!reduceMotion ? { scale: 0.97, y: 0 } : undefined}
              className={`icon-rail-slider__button ${isRemembered ? 'is-remembered' : ''}${isActive ? ' is-active' : ''}`}
              style={{
                background: 'transparent',
                color: isActive
                  ? 'var(--color-blue)'
                  : isRemembered
                    ? 'color-mix(in srgb, var(--color-blue) 42%, var(--text-gray))'
                    : 'var(--text-gray)',
              }}
            >
              {thumbVisible ? (
                <motion.span
                  layoutId={`${layoutId}-thumb`}
                  animate={reduceMotion
                    ? undefined
                    : thumbState === 'resting'
                      ? { scale: 0.94, y: 1.2 }
                      : thumbState === 'pressing'
                        ? { scale: 0.965, y: 0.95 }
                        : { scale: 1, y: 0 }}
                  transition={reduceMotion
                    ? REDUCED_MOTION_TRANSITION
                    : thumbState === 'elevated'
                      ? THUMB_LIFT_TRANSITION
                      : THUMB_DEPTH_TRANSITION}
                  className={`icon-rail-slider__thumb ${thumbState === 'resting' ? 'is-resting' : thumbState === 'pressing' ? 'is-pressing' : 'is-elevated'}`}
                />
              ) : null}
              <span className="relative z-[1]">
                <Icon className="h-[15px] w-[15px]" strokeWidth={2} />
              </span>
            </motion.button>
          )
        })}
      </div>
    </MotionConfig>
  )
}
