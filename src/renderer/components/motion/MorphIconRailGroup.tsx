import { type CSSProperties, type ElementType } from 'react'
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
  onSelect?: (id: string) => void
  layoutId: string
  className?: string
  style?: CSSProperties
}

export default function MorphIconRailGroup({
  items,
  activeId,
  onSelect,
  layoutId,
  className,
  style,
}: MorphIconRailGroupProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_MOTION_TRANSITION : WORKBENCH_SLIDER_MOTION_TRANSITION

  return (
    <MotionConfig transition={transition}>
      <div className={['icon-rail-slider', className].filter(Boolean).join(' ')} style={style}>
        <div className="icon-rail-slider__track" />
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = activeId === id
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
              className={`icon-rail-slider__button ${isActive ? 'is-active' : ''}`}
              style={{
                background: 'transparent',
                color: isActive ? 'var(--color-blue)' : 'var(--text-gray)',
              }}
            >
              {isActive ? (
                <motion.span
                  layoutId={`${layoutId}-thumb`}
                  className="icon-rail-slider__thumb"
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
