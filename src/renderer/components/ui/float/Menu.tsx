import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'

// Menu and context menu (W1 §5): one list, opened in a float by openMenu / openContextMenu
// (open-menu.tsx). Keyboard: ↑/↓ move, Home/End jump, Enter or Space chooses, Esc closes (the float
// host), typing a letter jumps to the next match.

export type MenuEntry =
  | { kind?: 'item'; id: string; label: string; icon?: ReactNode; hint?: string; checked?: boolean; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: 'separator' }
  | { kind: 'group'; label: string }

type MenuItem = Extract<MenuEntry, { onSelect: () => void }>
const isItem = (entry: MenuEntry): entry is MenuItem => entry.kind === undefined || entry.kind === 'item'

export function MenuList({ items, label, onDone }: { items: MenuEntry[]; label?: string; onDone: () => void }) {
  const enabled = items.map((entry, index) => (isItem(entry) && !entry.disabled ? index : -1)).filter(index => index >= 0)
  const [active, setActive] = useState(enabled[0] ?? -1)
  const listRef = useRef<HTMLDivElement>(null)
  const move = (to: number) => {
    setActive(to)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${to}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (index: number) => {
    const entry = items[index]
    if (!entry || !isItem(entry) || entry.disabled) return
    onDone()
    entry.onSelect()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = enabled.indexOf(active)
    if (event.key === 'ArrowDown') { event.preventDefault(); move(enabled[(at + 1) % enabled.length]) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(enabled[(at - 1 + enabled.length) % enabled.length]) }
    else if (event.key === 'Home') { event.preventDefault(); move(enabled[0]) }
    else if (event.key === 'End') { event.preventDefault(); move(enabled[enabled.length - 1]) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const key = event.key.toLowerCase()
      const order = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)]
      const next = order.find(index => (items[index] as MenuItem).label.toLowerCase().startsWith(key))
      if (next !== undefined) move(next)
    }
  }
  return (
    <div ref={listRef} className="rn-menu" role="menu" aria-label={label} tabIndex={-1} data-autofocus onKeyDown={onKeyDown}>
      {items.map((entry, index) => {
        if (entry.kind === 'separator') return <div key={`sep-${index}`} className="rn-menu__sep" role="separator" />
        if (entry.kind === 'group') return <div key={`group-${index}`} className="rn-menu__group" role="presentation">{entry.label}</div>
        const checkable = entry.checked !== undefined
        return (
          <button
            key={entry.id}
            type="button"
            data-index={index}
            role={checkable ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checkable ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            data-danger={entry.danger || undefined}
            data-highlighted={index === active || undefined}
            tabIndex={-1}
            className="rn-menu__item"
            onMouseEnter={() => !entry.disabled && setActive(index)}
            onClick={() => choose(index)}
          >
            {checkable ? <span className="rn-menu__check">{entry.checked ? <Check size={14} /> : null}</span> : entry.icon}
            <span className="rn-menu__label">{entry.label}</span>
            {entry.hint && <span className="rn-menu__hint">{entry.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}
