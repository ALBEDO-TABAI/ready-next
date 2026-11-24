import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { LayoutGroup, MotionConfig, motion, useReducedMotion } from 'framer-motion'
import { REDUCED_TRANSITION, SPRING_INDICATOR, SPRING_PILL } from '../../design/next/motion'

interface MorphTabStripProps extends HTMLAttributes<HTMLDivElement> {
  layoutId: string
}

interface MorphTabButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  layoutId: string
  active?: boolean
  secondaryActive?: boolean
  suppressLiquidPill?: boolean
  children: ReactNode
  contentClassName?: string
  contentStyle?: CSSProperties
}

const SPRING_TRANSITION = SPRING_INDICATOR
const PILL_TRANSITION = SPRING_PILL

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
  suppressLiquidPill = false,
  children,
  className,
  style,
  contentClassName,
  contentStyle,
  ...buttonProps
}: MorphTabButtonProps) {
  const showPrimary = active
  const showSecondary = secondaryActive && !showPrimary

  return (
    <button
      type="button"
      className={className ? `relative ${className}` : 'relative'}
      style={style}
      {...buttonProps}
    >
      {showPrimary && !suppressLiquidPill && (
        <motion.span
          layoutId={`${layoutId}-primary`}
          transition={PILL_TRANSITION}
          className="morph-pill morph-pill-primary"
          aria-hidden="true"
        />
      )}
      {showSecondary && !suppressLiquidPill && (
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
