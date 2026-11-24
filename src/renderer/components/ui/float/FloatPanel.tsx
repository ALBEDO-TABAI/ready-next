import { forwardRef, useCallback, useRef, type CSSProperties, type HTMLAttributes } from 'react'
import { useLeaveAsGhost } from '../leave'
import type { FloatMotion } from './Float'

// A float container placed by its caller (menus anchored in place, drawers, small panels): the
// float material (W1 §4, DL4) with no refraction engine — liquid glass belongs to the assistant
// composer alone (DL4a). It still marks itself so the native web view steps aside beneath it.
// Motion (motion language M2): it arrives from the side it opened from (`motion`, default down: a menu under its
// button; up: the composer's menus) and, unmounted, fades out in place as an inert copy.
export interface FloatPanelProps extends HTMLAttributes<HTMLDivElement> {
  contentClassName?: string
  contentStyle?: CSSProperties
  radius?: number
  motion?: FloatMotion | 'none'
}

export const FloatPanel = forwardRef<HTMLDivElement, FloatPanelProps>(
  function FloatPanel({ children, className, contentClassName, contentStyle, radius = 16, style, motion = 'down', ...props }, ref) {
    const own = useRef<HTMLDivElement | null>(null)
    useLeaveAsGhost(own)
    const setRef = useCallback((element: HTMLDivElement | null) => {
      own.current = element
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    }, [ref])
    return (
      <div
        {...props}
        ref={setRef}
        data-ready-native-overlay=""
        data-float-motion={motion === 'none' ? undefined : motion}
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
