import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react'

// A float container placed by its caller (menus anchored in place, drawers, small panels): the
// float material (W1 §4, DL4) with no refraction engine — liquid glass belongs to the assistant
// composer alone (DL4a). It still marks itself so the native web view steps aside beneath it.
export interface FloatPanelProps extends HTMLAttributes<HTMLDivElement> {
  contentClassName?: string
  contentStyle?: CSSProperties
  radius?: number
}

export const FloatPanel = forwardRef<HTMLDivElement, FloatPanelProps>(
  function FloatPanel({ children, className, contentClassName, contentStyle, radius = 16, style, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-ready-native-overlay=""
        className={['rn-float', 'rn-float-panel', className].filter(Boolean).join(' ')}
        style={{ ...style, borderRadius: style?.borderRadius ?? radius, overflow: 'hidden' }}
      >
        <div className={contentClassName || 'rn-float-panel__content'} style={contentStyle}>
          {children}
        </div>
      </div>
    )
  },
)
