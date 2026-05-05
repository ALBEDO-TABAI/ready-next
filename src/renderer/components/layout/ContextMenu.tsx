import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'

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
  lockBrowserView?: boolean
  portal?: boolean
  boundary?: { left: number; top: number; right: number; bottom: number }
}

export default function ContextMenu({ items, x, y, onClose, lockBrowserView = true, portal = false, boundary }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x, y })
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)

  const activateItem = (item: ContextMenuItem) => {
    if (item.disabled) return
    item.onClick?.()
    onClose()
  }

  useLayoutEffect(() => {
    if (!lockBrowserView) return
    window.dispatchEvent(
      new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, {
        detail: { source: 'context-menu', locked: true },
      }),
    )

    return () => {
      window.dispatchEvent(
        new CustomEvent(BROWSER_OVERLAY_LOCK_EVENT, {
          detail: { source: 'context-menu', locked: false },
        }),
      )
    }
  }, [lockBrowserView])

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minX = Math.max(8, boundary?.left ?? 8)
    const maxX = Math.max(minX, Math.min(vw - rect.width - 8, (boundary?.right ?? vw) - rect.width - 8))
    const minY = Math.max(8, boundary?.top ?? 8)
    const maxY = Math.max(minY, Math.min(vh - rect.height - 8, (boundary?.bottom ?? vh) - rect.height - 8))
    const nextX = Math.min(Math.max(x, minX), maxX)
    const nextY = Math.min(Math.max(y, minY), maxY)
    setAdjustedPos({ x: nextX, y: nextY })
  }, [boundary, items, x, y])

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

  const menu = (
    <div
      ref={menuRef}
      className="glass-surface-floating ready-floating-menu"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        width: 200,
        maxWidth: 'calc(100vw - 16px)',
        background: 'var(--chat-menu-frost-bg)',
        borderRadius: 12,
        border: '1px solid var(--surface-border)',
        boxShadow: 'var(--surface-shadow)',
        padding: '6px 0',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} style={{ height: 0, borderTop: '1px solid var(--border-default)' }} />
        }

        const color = item.danger ? 'var(--color-red)' : 'var(--text-body)'
        const isHovered = hoveredItemId === item.id

        return (
          <button
            key={item.id}
            className="ready-floating-menu-item"
            onPointerEnter={() => setHoveredItemId(item.id)}
            onPointerLeave={() => setHoveredItemId((current) => (current === item.id ? null : current))}
            onPointerDown={(event) => {
              if (event.button !== 0 || item.disabled) return
              event.preventDefault()
              event.stopPropagation()
              activateItem(item)
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              activateItem(item)
            }}
            disabled={item.disabled}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 36,
              padding: '8px 14px',
              border: 'none',
              background: isHovered ? 'var(--chat-menu-hover-bg)' : 'transparent',
              borderRadius: 8,
              cursor: item.disabled ? 'not-allowed' : 'pointer',
              width: 'calc(100% - 12px)',
              margin: '0 6px',
              transition: 'background 0.15s ease, opacity 0.15s ease',
              opacity: item.disabled ? 0.45 : 1,
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

  if (portal && typeof document !== 'undefined') {
    return createPortal(menu, document.body)
  }

  return menu
}
