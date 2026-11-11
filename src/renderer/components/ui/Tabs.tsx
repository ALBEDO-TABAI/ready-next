import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'

// Tabs / TabStrip (W1 §5): one tab list for views and for open documents. ←/→ move between tabs,
// Home/End jump, Delete closes a closable tab (WAI-ARIA tabs); its close button shows on hover and
// when selected, and Enter/Space on the button close the tab instead of selecting it.
export interface TabItem { id: string; label: string; icon?: ReactNode; closable?: boolean }

export function Tabs({ items, value, onChange, onClose, label }: { items: TabItem[]; value: string; onChange: (id: string) => void; onClose?: (id: string) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const focusAt = (index: number) => {
    const next = items[(index + items.length) % items.length]
    onChange(next.id)
    ref.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = items.findIndex(item => item.id === value)
    if (event.key === 'ArrowRight') { event.preventDefault(); focusAt(at + 1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); focusAt(at - 1) }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0) }
    else if (event.key === 'End') { event.preventDefault(); focusAt(items.length - 1) }
  }
  return (
    <div ref={ref} className="rn-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map(item => {
        const selected = item.id === value
        return (
          <div key={item.id} role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} data-tab-id={item.id} className="rn-tab"
            onClick={() => onChange(item.id)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onChange(item.id) }
              else if (event.key === 'Delete' && item.closable && onClose) { event.preventDefault(); onClose(item.id) }
            }}>
            {item.icon}
            <span className="rn-tab__label">{item.label}</span>
            {item.closable && onClose && (
              <span role="button" tabIndex={-1} aria-label={`关闭 ${item.label}`} className="rn-tab__close"
                onClick={event => { event.stopPropagation(); onClose(item.id) }}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  onClose(item.id)
                }}>
                <X aria-hidden="true" />
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
