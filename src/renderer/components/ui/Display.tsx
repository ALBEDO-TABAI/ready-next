import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

// Chip, Kbd, SectionHeader, EmptyState, Skeleton (W1 §5).
export function Chip({ icon, children, onClick, ...rest }: { icon?: ReactNode; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  if (!onClick) return <span className="rn-chip">{icon}{children}</span>
  return <button type="button" className="rn-chip" onClick={onClick} {...rest}>{icon}{children}</button>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rn-kbd">{children}</kbd>
}

export function SectionHeader({ title, actions, className = '' }: { title: ReactNode; actions?: ReactNode; className?: string }) {
  return <div className={`rn-section ${className}`.trim()} role="heading" aria-level={3}><span>{title}</span>{actions}</div>
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rn-empty">
      {icon}
      <div className="rn-empty__title">{title}</div>
      {body && <div className="rn-empty__body">{body}</div>}
      {action}
    </div>
  )
}

export function Skeleton({ width = '100%', height = 12, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <div className="rn-skeleton" aria-hidden="true" style={{ width, height, ...style }} />
}
