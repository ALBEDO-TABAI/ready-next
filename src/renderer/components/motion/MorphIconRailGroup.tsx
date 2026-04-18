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

const THUMB_REOPEN_DELAY_MS = 140
const THUMB_REST_SETTLE_MS = 120
const THUMB_DEPTH_TRANSITION = {
  duration: 0.14,
  ease: [0.22, 1, 0.36, 1],
} as const
const ICON_RAIL_ITEM_PITCH = 40

export default function MorphIconRailGroup({
  items,
  activeId,
  expanded = true,
  onSelect,
  layoutId: _layoutId,
  className,
  style,
}: MorphIconRailGroupProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_MOTION_TRANSITION : WORKBENCH_SLIDER_MOTION_TRANSITION
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
        }, THUMB_REST_SETTLE_MS)
      }
    } else if (!previousExpanded) {
      setThumbId(previousActiveId)
      setThumbState('elevated')

      if (previousActiveId !== activeId && typeof window !== 'undefined') {
        slideTimerRef.current = window.setTimeout(() => {
          setThumbId(activeId)
          slideTimerRef.current = null
        }, reduceMotion ? 0 : THUMB_REOPEN_DELAY_MS)
      }
    } else {
      setThumbState('elevated')
      setThumbId(activeId)
    }

    previousActiveIdRef.current = activeId
    previousExpandedRef.current = expanded
  }, [activeId, expanded, reduceMotion])

  const thumbIndex = Math.max(items.findIndex(({ id }) => id === thumbId), 0)
  const thumbOffset = thumbIndex * ICON_RAIL_ITEM_PITCH

  return (
    <MotionConfig transition={transition}>
      <div className={['icon-rail-slider', className].filter(Boolean).join(' ')} style={style}>
        <div className="icon-rail-slider__track" />
        <motion.span
          aria-hidden="true"
          className="icon-rail-slider__thumb-shell"
          animate={reduceMotion ? { y: thumbOffset } : { y: thumbOffset }}
          transition={transition}
        >
          <span
            className={`icon-rail-slider__thumb ${thumbState === 'resting' ? 'is-resting' : thumbState === 'pressing' ? 'is-pressing' : 'is-elevated'}`}
          />
        </motion.span>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = thumbId === id && thumbState === 'elevated'
          const isRemembered = thumbId === id && thumbState !== 'elevated'
          return (
            <motion.button
              key={id}
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
