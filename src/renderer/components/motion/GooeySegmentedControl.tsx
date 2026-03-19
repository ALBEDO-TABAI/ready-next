import {
  type CSSProperties,
  type ElementType,
  type KeyboardEvent,
  type MouseEvent,
  useId,
  useMemo,
  useState,
} from 'react'
import { MotionConfig, motion, useReducedMotion } from 'framer-motion'

type ItemEvent = MouseEvent<HTMLButtonElement>
type ItemKeyboardEvent = KeyboardEvent<HTMLButtonElement>

export interface GooeySegmentedItem {
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

interface GooeySegmentedControlProps {
  items: GooeySegmentedItem[]
  ariaLabel?: string
  className?: string
  style?: CSSProperties
  itemClassName?: string
  itemStyle?: CSSProperties
  contentClassName?: string
}

const TRACK_SPRING = { type: 'spring', mass: 0.96, stiffness: 280, damping: 21 } as const
const BLOB_SPRING = { type: 'spring', mass: 0.72, stiffness: 360, damping: 22 } as const
const ITEM_SPRING = { type: 'spring', mass: 0.62, stiffness: 420, damping: 28 } as const
const PRESS_SPRING = { type: 'spring', mass: 0.54, stiffness: 520, damping: 24 } as const
const REDUCED_SPRING = { type: 'spring', mass: 0.8, stiffness: 800, damping: 60 } as const
export default function GooeySegmentedControl({
  items,
  ariaLabel,
  className,
  style,
  itemClassName,
  itemStyle,
  contentClassName,
}: GooeySegmentedControlProps) {
  const reduceMotion = useReducedMotion()
  const filterId = useId().replace(/:/g, '-')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pressedId, setPressedId] = useState<string | null>(null)

  const transition = reduceMotion ? REDUCED_SPRING : TRACK_SPRING
  const activeItem = useMemo(
    () => items.find((item) => item.active) ?? items.find((item) => item.secondaryActive) ?? null,
    [items],
  )

  return (
    <MotionConfig transition={transition}>
      <div
        data-gooey-segmented-control="topbar-modules"
        className={className}
        style={style}
        aria-label={ariaLabel}
      >
        <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
          <defs>
            <filter id={filterId} colorInterpolationFilters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="goo-blur" />
              <feColorMatrix
                in="goo-blur"
                mode="matrix"
                values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 26 -12"
                result="goo-alpha"
              />
              <feComposite in="SourceGraphic" in2="goo-alpha" operator="atop" result="goo-body" />
              <feBlend in="goo-body" in2="SourceGraphic" />
            </filter>
          </defs>
        </svg>

        <motion.div
          animate={
            hoveredId
              ? { scaleX: 1.018, scaleY: 0.986, y: -0.5 }
              : { scaleX: 1, scaleY: 1, y: 0 }
          }
          transition={reduceMotion ? REDUCED_SPRING : TRACK_SPRING}
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            padding: 3,
            borderRadius: 20,
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
            boxShadow: 'none',
            border: '1px solid transparent',
            backdropFilter: 'blur(18px) saturate(145%)',
            WebkitBackdropFilter: 'blur(18px) saturate(145%)',
            overflow: 'visible',
          }}
        >
          <motion.div
            aria-hidden="true"
            animate={
              hoveredId
                ? { opacity: 1, scale: 1.02 }
                : { opacity: 0.96, scale: 1 }
            }
            transition={reduceMotion ? REDUCED_SPRING : TRACK_SPRING}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 20,
              background:
                'radial-gradient(circle at 22% 16%, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0.18) 34%, rgba(255,255,255,0) 70%)',
              mixBlendMode: 'screen',
              pointerEvents: 'none',
            }}
          />

          <div
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              filter: `url(#${filterId})`,
              isolation: 'isolate',
            }}
          >
            {items.map((item) => {
              const Icon = item.icon
              const isPrimary = !!item.active
              const isSecondary = !!item.secondaryActive && !isPrimary
              const isActive = isPrimary || isSecondary
              const isHovered = hoveredId === item.id
              const isPressed = pressedId === item.id

              return (
                <motion.button
                  key={item.id}
                  type="button"
                  title={item.title}
                  aria-label={item.ariaLabel || item.label}
                  role={item.role}
                  aria-selected={item.role === 'tab' ? isActive : undefined}
                  tabIndex={item.tabIndex}
                  disabled={item.disabled}
                  onClick={item.onClick}
                  onKeyDown={item.onKeyDown}
                  onHoverStart={() => setHoveredId(item.id)}
                  onHoverEnd={() => setHoveredId((current) => (current === item.id ? null : current))}
                  onFocus={() => setHoveredId(item.id)}
                  onBlur={() => setHoveredId((current) => (current === item.id ? null : current))}
                  onTapStart={() => setPressedId(item.id)}
                  onTapCancel={() => setPressedId((current) => (current === item.id ? null : current))}
                  onTap={() => setPressedId(null)}
                  animate={
                    isPressed
                      ? { y: 0.2, scale: 0.98 }
                      : isHovered
                        ? { y: -0.8, scale: 1.012 }
                        : { y: 0, scale: 1 }
                  }
                  transition={reduceMotion ? REDUCED_SPRING : ITEM_SPRING}
                  className={itemClassName ? `relative ${itemClassName}` : 'relative'}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 24,
                    minWidth: 28,
                    padding: '0 8px',
                    borderRadius: 14,
                    border: 'none',
                    background: 'transparent',
                    cursor: item.disabled ? 'not-allowed' : 'pointer',
                    ...itemStyle,
                  }}
                >
                  {(isActive || isHovered) && (
                    <motion.span
                      layout
                      transition={reduceMotion ? REDUCED_SPRING : BLOB_SPRING}
                      animate={{
                        scaleX: isPressed ? 1.2 : isHovered && !isActive ? 1.12 : isHovered ? 1.08 : 1,
                        scaleY: isPressed ? 0.86 : isHovered ? 0.92 : 1,
                        opacity: isActive ? 0.98 : 0.82,
                      }}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 14,
                        background: isActive
                          ? 'linear-gradient(180deg, rgba(134, 226, 192, 0.96) 0%, rgba(78, 212, 169, 0.94) 100%)'
                          : 'linear-gradient(180deg, rgba(154, 237, 207, 0.7) 0%, rgba(101, 226, 182, 0.65) 100%)',
                        boxShadow: 'none',
                        transformOrigin: 'center center',
                        pointerEvents: 'none',
                      }}
                    />
                  )}

                  <motion.span
                    transition={reduceMotion ? REDUCED_SPRING : PRESS_SPRING}
                    animate={{
                      x: isPressed ? 0.4 : 0,
                      scale: isPressed ? 0.96 : 1,
                      color: isActive || isHovered ? 'var(--text-title)' : 'var(--text-gray)',
                    }}
                    className={contentClassName}
                    style={{
                      position: 'relative',
                      zIndex: 2,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      fontWeight: isActive ? 700 : 600,
                      textShadow: isActive ? '0 1px 0 rgba(255,255,255,0.22)' : 'none',
                    }}
                  >
                    {Icon ? <Icon className="flex-shrink-0" style={{ width: 13, height: 13 }} strokeWidth={2} /> : item.label}
                  </motion.span>
                </motion.button>
              )
            })}
          </div>

          {activeItem && (
            <span
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 20,
                pointerEvents: 'none',
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 40%, rgba(79, 181, 147, 0.04) 100%)',
                opacity: hoveredId ? 1 : 0.82,
              }}
            />
          )}
        </motion.div>
      </div>
    </MotionConfig>
  )
}
