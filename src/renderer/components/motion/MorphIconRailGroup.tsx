import type { CSSProperties, ElementType } from 'react'
import { MotionConfig, motion, useReducedMotion } from 'framer-motion'
import {
  REDUCED_MOTION_TRANSITION,
  WORKBENCH_SLIDER_CLICK_TRANSITION,
} from '../../modules/workbench/slider-motion'

interface RailItem {
  id: string
  label: string
  icon: ElementType
  /** 闭合图形的激活态实心（负向填充）字形；缺省时激活态改为加粗描边 + 发光。 */
  activeIcon?: ElementType
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

  return (
    <MotionConfig transition={transition}>
      <div
        data-expanded={expanded ? 'true' : 'false'}
        className={['icon-rail-slider', className].filter(Boolean).join(' ')}
        style={style}
      >
        {items.map(({ id, label, icon: Icon, activeIcon: ActiveIcon }) => {
          const isActive = activeId === id && expanded
          const isRemembered = activeId === id && !expanded
          return (
            <motion.button
              key={id}
              type="button"
              onClick={() => onSelect?.(id)}
              title={label}
              aria-label={label}
              aria-pressed={isActive}
              data-active-glyph={ActiveIcon ? 'fill' : 'stroke'}
              whileHover={!reduceMotion ? { y: -0.4 } : undefined}
              whileTap={!reduceMotion ? { scale: 0.992, y: 0.4 } : undefined}
              className={`icon-rail-slider__button ${isRemembered ? 'is-remembered' : ''}${isActive ? ' is-active' : ''}`}
            >
              <span className="icon-rail-slider__button-icon">
                <Icon className="icon-rail-slider__glyph is-outline" strokeWidth={1.8} />
                {ActiveIcon ? <ActiveIcon className="icon-rail-slider__glyph is-filled" aria-hidden="true" /> : null}
              </span>
            </motion.button>
          )
        })}
      </div>
    </MotionConfig>
  )
}
