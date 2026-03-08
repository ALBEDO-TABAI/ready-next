import { type CSSProperties, type ElementType } from 'react'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { useTheme } from '../../stores/useTheme'

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

const SPRING_TRANSITION = { type: 'spring', stiffness: 460, damping: 22, mass: 0.6 } as const
const REDUCED_TRANSITION = { duration: 0.01 } as const
const PILL_TRANSITION = { type: 'spring', stiffness: 430, damping: 17, mass: 0.62 } as const

export default function MorphIconRailGroup({
  items,
  activeId,
  onSelect,
  layoutId,
  className,
  style,
}: MorphIconRailGroupProps) {
  const skin = useTheme((state) => state.skin)
  const reduceMotion = useReducedMotion()
  const enableMorph = skin === 'liquid-glass'
  const transition = reduceMotion ? REDUCED_TRANSITION : SPRING_TRANSITION

  return (
    <MotionConfig transition={transition}>
      <LayoutGroup id={layoutId}>
        <div className={className} style={style}>
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
                whileHover={enableMorph && !reduceMotion ? { y: -1 } : undefined}
                whileTap={enableMorph && !reduceMotion ? { scale: 0.97, y: 0 } : undefined}
                className="relative flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-colors duration-200"
                style={{
                  background: !enableMorph && isActive ? 'var(--color-blue-light)' : 'transparent',
                  color: isActive ? 'var(--color-blue)' : 'var(--text-gray)',
                }}
              >
                {enableMorph && isActive && (
                  <motion.span
                    layoutId={`${layoutId}-active`}
                    transition={PILL_TRANSITION}
                    className="morph-pill morph-pill-primary"
                    aria-hidden="true"
                  />
                )}
                <span className="relative z-[1]">
                  <Icon className="h-[15px] w-[15px]" strokeWidth={2} />
                </span>
              </motion.button>
            )
          })}
        </div>
      </LayoutGroup>
    </MotionConfig>
  )
}
