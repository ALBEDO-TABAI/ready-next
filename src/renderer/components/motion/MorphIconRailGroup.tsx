import type { CSSProperties, ElementType, MouseEvent } from 'react'
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
  /** Shown in the tooltip after the label, e.g. a shortcut. */
  hint?: string
}

interface MorphIconRailGroupProps {
  items: RailItem[]
  activeId: string
  expanded?: boolean
  /** The click event is passed so callers can read modifier keys (⌥/⇧-click opens a split). */
  onSelect?: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  /** A second item marked as present without being the selection (the split side). */
  secondaryId?: string | null
  layoutId: string
  className?: string
  style?: CSSProperties
}

export default function MorphIconRailGroup({
  items,
  activeId,
  expanded = true,
  onSelect,
  secondaryId = null,
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
        {items.map(({ id, label, hint, icon: Icon, activeIcon: ActiveIcon }) => {
          const isActive = activeId === id && expanded
          const isRemembered = activeId === id && !expanded
          return (
            <motion.button
              key={id}
              type="button"
              onClick={event => onSelect?.(id, event)}
              title={hint ? `${label} ${hint}` : label}
              aria-label={label}
              aria-pressed={isActive}
              data-active-glyph={ActiveIcon ? 'fill' : 'stroke'}
              data-split={secondaryId === id ? 'true' : undefined}
              // The press is the one press of the app (V9, workbench-sliders.css): no hover lift, no framer tap.
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
