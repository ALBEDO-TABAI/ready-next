import type { CSSProperties, ElementType } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'framer-motion'
import '../../styles/workbench-sliders.css'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'
import {
  REDUCED_MOTION_TRANSITION,
  WORKBENCH_SLIDER_CLICK_TRANSITION,
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
  const transition = reduceMotion ? REDUCED_MOTION_TRANSITION : WORKBENCH_SLIDER_CLICK_TRANSITION
  const thumbIndex = Math.max(items.findIndex(({ id }) => id === activeId), 0)
  const thumbOffset = thumbIndex * ICON_RAIL_ITEM_PITCH

  return (
    <MotionConfig transition={transition}>
      <div
        data-expanded={expanded ? 'true' : 'false'}
        className={['icon-rail-slider', className].filter(Boolean).join(' ')}
        style={style}
      >
        <div className="icon-rail-slider__track" />
        <motion.span
          aria-hidden="true"
          className="icon-rail-slider__thumb-shell"
          initial={false}
          animate={{ y: thumbOffset }}
          transition={transition}
        >
          <span className="icon-rail-slider__thumb">
            <LiquidLens
              className="ready-slider-thumb-lens"
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
              radius={16}
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
          </span>
        </motion.span>
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = activeId === id && expanded
          const isRemembered = activeId === id && !expanded
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
