import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'

// Button and IconButton (W1 §5, DL5): primary is solid ink — one per screen at most — never the
// signal colour. Heights 32 (default) or 28 (sm).
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', icon, className = '', type = 'button', children, ...rest }, ref) => (
    <button ref={ref} type={type} className={`rn-btn ${className}`.trim()} data-variant={variant} data-size={size} {...rest}>
      {icon}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon: ReactNode
  /** Accessible name; also the native tooltip unless a tooltip() is spread on it. */
  title: string
  /** A toggle that is on (pressed). */
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  style?: CSSProperties
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, title, active, size = 'md', className = '', type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`rn-icon-btn ${className}`.trim()}
      data-size={size}
      aria-label={title}
      title={title}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      {icon}
    </button>
  ),
)
IconButton.displayName = 'IconButton'
