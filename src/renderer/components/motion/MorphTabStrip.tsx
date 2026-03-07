import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { useTheme } from '../../stores/useTheme'

interface MorphTabStripProps extends HTMLAttributes<HTMLDivElement> {
  layoutId: string
}

interface MorphTabButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  layoutId: string
  active?: boolean
  secondaryActive?: boolean
  children: ReactNode
  contentClassName?: string
  contentStyle?: CSSProperties
}

const SPRING_TRANSITION = { type: 'spring', stiffness: 460, damping: 22, mass: 0.6 } as const
const REDUCED_TRANSITION = { duration: 0.01 } as const
const PILL_TRANSITION = { type: 'spring', stiffness: 430, damping: 17, mass: 0.62 } as const

export function MorphTabStrip({ layoutId, children, ...props }: MorphTabStripProps) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion ? REDUCED_TRANSITION : SPRING_TRANSITION

  return (
    <MotionConfig transition={transition}>
      <LayoutGroup id={layoutId}>
        <div {...props}>
          {children}
        </div>
      </LayoutGroup>
    </MotionConfig>
  )
}

export function MorphTabButton({
  layoutId,
  active = false,
  secondaryActive = false,
  children,
  className,
  style,
  contentClassName,
  contentStyle,
  ...buttonProps
}: MorphTabButtonProps) {
  const skin = useTheme((state) => state.skin)
  const enableMorph = skin === 'liquid-glass'
  const showPrimary = active
  const showSecondary = secondaryActive && !showPrimary

  return (
    <button
      type="button"
      className={className ? `relative ${className}` : 'relative'}
      style={style}
      {...buttonProps}
    >
      {enableMorph && showPrimary && (
        <motion.span
          layoutId={`${layoutId}-primary`}
          transition={PILL_TRANSITION}
          className="morph-pill morph-pill-primary"
          aria-hidden="true"
        />
      )}
      {enableMorph && showSecondary && (
        <motion.span
          layoutId={`${layoutId}-secondary`}
          transition={PILL_TRANSITION}
          className="morph-pill morph-pill-secondary"
          aria-hidden="true"
        />
      )}
      <span className={contentClassName} style={contentStyle}>
        {children}
      </span>
    </button>
  )
}
