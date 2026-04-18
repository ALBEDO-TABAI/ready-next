import { type CSSProperties, type ReactNode, forwardRef } from 'react'

interface IconButtonProps {
  icon: ReactNode
  onClick?: () => void
  title?: string
  disabled?: boolean
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  variant?: 'ghost' | 'solid' | 'outline'
  className?: string
  style?: CSSProperties
}

const sizeMap = {
  sm: { button: 20, icon: 12 },
  md: { button: 24, icon: 14 },
  lg: { button: 32, icon: 16 },
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, onClick, title, disabled, active, size = 'md', variant = 'ghost', className = '', style }, ref) => {
    const sizes = sizeMap[size]

    const baseClasses = 'flex items-center justify-center rounded transition-[background-color,color,opacity,transform] duration-200 ease-out'
    const variantClasses = {
      ghost: 'hover:bg-black/5 active:scale-[0.98]',
      solid: 'bg-[var(--color-blue-light)] active:scale-[0.98]',
      outline: 'border border-[var(--border-input)] hover:bg-black/5 active:scale-[0.98]',
    }

    const activeColor = active ? 'var(--color-blue)' : 'var(--text-light)'

    return (
      <button
        ref={ref}
        onClick={onClick}
        title={title}
        disabled={disabled}
        data-liquid-button={variant}
        className={`${baseClasses} ${variantClasses[variant]} ${className}`}
        style={{
          width: sizes.button,
          height: sizes.button,
          minWidth: sizes.button,
          minHeight: sizes.button,
          color: activeColor,
          flexShrink: 0,
          padding: 0,
          border: variant === 'outline' ? undefined : 'none',
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          ...style,
        }}
      >
        {icon}
      </button>
    )
  }
)

IconButton.displayName = 'IconButton'
