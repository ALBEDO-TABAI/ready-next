import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
import { LiquidLens } from './LiquidLens'
import { LiquidBackdropProjection } from './LiquidBackdropProjection'

interface LiquidFloatingPanelProps extends HTMLAttributes<HTMLDivElement> {
  contentClassName?: string
  contentStyle?: CSSProperties
  radius?: number
}

interface LiquidSurfaceLayerProps {
  className?: string
  radius?: number
  sourceMaskRadius?: number
  sourceSelector?: string
  withProjection?: boolean
  blur?: number
  frost?: number
  saturation?: number
  brightness?: number
  contrast?: number
}

export function LiquidSurfaceLayer({
  className = 'ready-liquid-popover__lens',
  radius = 16,
  sourceMaskRadius = radius,
  sourceSelector,
  withProjection = true,
  blur = 3.5,
  frost = 0,
  saturation = 1.18,
  brightness = 1.07,
  contrast = 0.84,
}: LiquidSurfaceLayerProps) {
  return (
    <LiquidLens
      className={className}
      radius={radius}
      bevel={22}
      depth={37}
      ior={1.34}
      dome={5}
      strength={6.4}
      blur={blur}
      frost={frost}
      blurBeforeRefraction
      saturation={saturation}
      brightness={brightness}
      contrast={contrast}
      aberration={0}
      engine="backdrop"
      backdropContent={withProjection ? (
        <LiquidBackdropProjection
          className="ready-liquid-popover__projection"
          cloneClassName="ready-liquid-popover__projection-clone"
          sourceSelector={sourceSelector}
          sourceMaskRadius={sourceMaskRadius}
        />
      ) : undefined}
    />
  )
}

export const LiquidFloatingPanel = forwardRef<HTMLDivElement, LiquidFloatingPanelProps>(
  function LiquidFloatingPanel({
    children,
    className,
    contentClassName,
    contentStyle,
    radius = 16,
    style,
    ...props
  }, ref) {
    const classes = ['glass-surface-floating', 'ready-floating-menu', 'ready-liquid-popover', className]
      .filter(Boolean)
      .join(' ')

    return (
      <div
        {...props}
        data-ready-native-overlay=""
        ref={ref}
        className={classes}
        style={{
          ...style,
          borderRadius: style?.borderRadius ?? radius,
          overflow: 'hidden',
          background: 'transparent',
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
        }}
      >
        <LiquidSurfaceLayer radius={radius} />
        <div className={contentClassName || 'ready-liquid-popover__content'} style={contentStyle}>
          {children}
        </div>
      </div>
    )
  },
)
