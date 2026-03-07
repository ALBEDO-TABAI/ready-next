import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  onClose: () => void
}

export default function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x, y })

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nextX = x + rect.width > vw ? Math.max(8, vw - rect.width - 8) : x
    const nextY = y + rect.height > vh ? Math.max(8, vh - rect.height - 8) : y
    setAdjustedPos({ x: nextX, y: nextY })
  }, [items, x, y])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const timer = window.setTimeout(() => {
      window.addEventListener('click', handleClick)
      window.addEventListener('contextmenu', handleClick)
    }, 50)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('contextmenu', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="glass-surface-floating"
      style={{
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        width: 200,
        maxWidth: 'calc(100vw - 16px)',
        background: 'var(--surface-floating-bg)',
        borderRadius: 10,
        border: '1px solid var(--surface-border)',
        boxShadow: 'var(--surface-shadow)',
        padding: '6px 0',
        zIndex: 220,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} style={{ height: 0, borderTop: '1px solid var(--border-default)' }} />
        }

        const color = item.danger ? 'var(--color-red)' : 'var(--text-body)'

        return (
          <button
            key={item.id}
            onClick={() => {
              if (item.disabled) return
              item.onClick?.()
              onClose()
            }}
            disabled={item.disabled}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 36,
              padding: '8px 14px',
              border: 'none',
              background: 'transparent',
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              width: '100%',
              transition: 'background 0.15s ease, opacity 0.15s ease',
              opacity: item.disabled ? 0.45 : 1,
            }}
            onMouseEnter={(event) => {
              if (!item.disabled) event.currentTarget.style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              {item.icon ? (
                <span style={{ width: 16, height: 16, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {item.icon}
                </span>
              ) : (
                <span style={{ width: 16, height: 16, flexShrink: 0 }} />
              )}
              <span
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 14,
                  fontWeight: 500,
                  color,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.label}
              </span>
            </div>
            {item.shortcut ? (
              <span
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--text-light)',
                  marginLeft: 12,
                  flexShrink: 0,
                }}
              >
                {item.shortcut}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
