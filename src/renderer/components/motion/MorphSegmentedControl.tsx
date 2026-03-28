import { type CSSProperties, type ElementType, type KeyboardEvent, type MouseEvent } from 'react'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'framer-motion'

type ItemEvent = MouseEvent<HTMLButtonElement>
type ItemKeyboardEvent = KeyboardEvent<HTMLButtonElement>

export interface MorphSegmentedItem {
  id: string
  label: string
  icon?: ElementType
  title?: string
  active?: boolean
  secondaryActive?: boolean
  disabled?: boolean
  ariaLabel?: string
  role?: string
  tabIndex?: number
  onClick?: (event: ItemEvent) => void
  onKeyDown?: (event: ItemKeyboardEvent) => void
}

interface MorphSegmentedControlProps {
  items: MorphSegmentedItem[]
  layoutId: string
  ariaLabel?: string
  className?: string
  style?: CSSProperties
  itemClassName?: string
  itemStyle?: CSSProperties
  contentClassName?: string
}

const SPRING_TRANSITION = { type: 'spring', stiffness: 460, damping: 22, mass: 0.6 } as const
const REDUCED_TRANSITION = { duration: 0.01 } as const
const PILL_TRANSITION = { type: 'spring', stiffness: 430, damping: 17, mass: 0.62 } as const

export default function MorphSegmentedControl({
  items,
  layoutId,
  ariaLabel,
  className,
  style,
  itemClassName,
  itemStyle,
  contentClassName,
}: MorphSegmentedControlProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_TRANSITION : SPRING_TRANSITION

  return (
    <MotionConfig transition={transition}>
      <LayoutGroup id={layoutId}>
        <div className={className} style={style} aria-label={ariaLabel}>
          {items.map((item) => {
            const Icon = item.icon
            const isPrimary = !!item.active
            const isSecondary = !!item.secondaryActive && !isPrimary
            const isActive = isPrimary || isSecondary

            return (
              <motion.button
                key={item.id}
                layout
                type="button"
                title={item.title}
                aria-label={item.ariaLabel || item.label}
                role={item.role}
                aria-selected={item.role === 'tab' ? isActive : undefined}
                tabIndex={item.tabIndex}
                disabled={item.disabled}
                onClick={item.onClick}
                onKeyDown={item.onKeyDown}
                whileHover={!item.disabled && !reduceMotion ? { y: -1 } : undefined}
                whileTap={!item.disabled && !reduceMotion ? { scale: 0.985, y: 0 } : undefined}
                className={itemClassName ? `relative ${itemClassName}` : 'relative'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  ...itemStyle,
                  background: 'transparent',
                }}
              >
                {isPrimary && (
                  <motion.span
                    layoutId={`${layoutId}-primary`}
                    transition={PILL_TRANSITION}
                    className="morph-pill morph-pill-primary"
                    aria-hidden="true"
                  />
                )}
                {isSecondary && (
                  <motion.span
                    layoutId={`${layoutId}-secondary`}
                    transition={PILL_TRANSITION}
                    className="morph-pill morph-pill-secondary"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={contentClassName}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: isActive ? 'var(--color-blue)' : 'var(--text-gray)',
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {Icon && <Icon className="flex-shrink-0" style={{ width: 13, height: 13 }} strokeWidth={2} />}
                </span>
              </motion.button>
            )
          })}
        </div>
      </LayoutGroup>
    </MotionConfig>
  )
}
