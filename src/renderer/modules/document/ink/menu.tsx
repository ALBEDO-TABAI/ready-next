import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { openPopover, closePopover, type Anchor, type Placement } from './overlay'

// Ported from Inkwell's menu: grouped items with icons, submenus, switches, filtering and keyboard navigation.
export interface MenuItemSpec {
  kind?: 'item'
  id: string
  label: ReactNode
  /** plain text used for filtering and as the accessible name (defaults to label if string) */
  text?: string
  keywords?: string[]
  icon?: IconName | ReactNode
  shortcut?: string
  sub?: () => MenuSpec
  onSelect?: () => void
  checked?: boolean
  /** renders a switch on the right */
  toggle?: boolean
  danger?: boolean
  disabled?: boolean
  right?: ReactNode
  keepOpen?: boolean
  accent?: boolean
}
export interface MenuLabel { kind: 'label'; label: ReactNode }
export interface MenuCustom { kind: 'custom'; key: string; render: (close: () => void) => ReactNode }
export type MenuEntry = MenuItemSpec | MenuLabel | MenuCustom
export interface MenuSpec {
  width?: number
  search?: string
  groups: MenuEntry[][]
  footer?: ReactNode
  maxHeight?: number | string
  centered?: boolean
  className?: string
  label?: string
}

const isItem = (entry: MenuEntry): entry is MenuItemSpec => !entry.kind || entry.kind === 'item'
const itemText = (item: MenuItemSpec) => item.text ?? (typeof item.label === 'string' ? item.label : '')

export function openMenu(anchor: Anchor | (() => Anchor), spec: MenuSpec | (() => MenuSpec), opts: { placement?: Placement; offset?: number; id?: string; parent?: string; onClose?: () => void; anchorEl?: HTMLElement } = {}) {
  const id = opts.id || `menu-${Math.random().toString(36).slice(2, 8)}`
  opts.anchorEl?.setAttribute('data-popover-anchor', id)
  opts.anchorEl?.classList.add('is-open')
  openPopover({
    id, anchor, placement: opts.placement || 'bottom-start', offset: opts.offset ?? 4, parent: opts.parent,
    onClose: () => { opts.anchorEl?.classList.remove('is-open'); opts.onClose?.() },
    render: close => <Menu spec={typeof spec === 'function' ? spec() : spec} close={close} popId={id} />,
  })
  return id
}

export function Menu({ spec, close, popId, closeAll, initialActive = -1 }: { spec: MenuSpec; close: () => void; popId: string; closeAll?: () => void; initialActive?: number }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(initialActive)
  const subRef = useRef<{ id: string; item: string } | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  const doCloseAll = closeAll || close

  const groups = useMemo(() => {
    if (!query.trim()) return spec.groups
    const needle = query.trim().toLowerCase()
    const flat: MenuEntry[] = []
    for (const group of spec.groups) for (const entry of group) {
      if (!isItem(entry)) continue
      if ([itemText(entry), ...(entry.keywords || [])].join(' ').toLowerCase().includes(needle)) flat.push(entry)
    }
    return [flat]
  }, [query, spec])
  const items = groups.flat().filter(isItem).filter(item => !item.disabled)

  const openSub = (item: MenuItemSpec, element: HTMLElement) => {
    if (subRef.current?.item === item.id) return
    if (subRef.current) closePopover(subRef.current.id)
    if (!item.sub) { subRef.current = null; return }
    const id = `${popId}-sub`
    subRef.current = { id, item: item.id }
    const rect = element.getBoundingClientRect()
    const subSpec = item.sub()
    openPopover({ id, parent: popId, anchor: { left: rect.left - 4, right: rect.right + 4, top: subSpec.centered ? rect.top : rect.top - 6, bottom: rect.bottom },
      placement: subSpec.centered ? 'right-center' : 'right-start', offset: 0,
      onClose: () => { if (subRef.current?.id === id) subRef.current = null; element.classList.remove('is-sub-open') },
      render: closeSub => <Menu spec={subSpec} close={closeSub} popId={id} closeAll={doCloseAll} initialActive={subSpec.centered ? 0 : -1} /> })
    element.classList.add('is-sub-open')
  }
  const select = (item: MenuItemSpec, element?: HTMLElement) => {
    if (item.disabled) return
    if (item.sub) { if (element) openSub(item, element); return }
    if (!item.keepOpen && item.toggle === undefined) doCloseAll()
    item.onSelect?.()
  }

  useEffect(() => {
    const element = root.current!
    const onKey = (event: KeyboardEvent) => {
      const popover = element.closest('[data-popover-id]')
      if (!popover || !popover.contains(document.activeElement)) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(current => { const count = items.length; if (!count) return -1; return event.key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count })
      } else if (event.key === 'Enter') {
        const item = items[active]; if (!item) return
        event.preventDefault()
        select(item, element.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(item.id)}"]`) || undefined)
      } else if (event.key === 'ArrowRight') {
        const item = items[active]
        if (item?.sub) { event.preventDefault(); openSub(item, element.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(item.id)}"]`)!) }
      } else if (event.key === 'ArrowLeft' && popId.endsWith('-sub')) {
        event.preventDefault(); close()
      }
    }
    element.addEventListener('keydown', onKey)
    return () => element.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    const item = items[active]
    if (item) root.current?.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={root} className={`ink-menu ${spec.className || ''}`} style={{ width: spec.width ?? 265 }} role="menu" aria-label={spec.label} tabIndex={-1} data-autofocus={spec.search ? undefined : true}>
    {spec.search !== undefined && <div className="ink-menu-search-wrap">
      <input className="ink-menu-search" data-autofocus aria-label={spec.search} placeholder={spec.search} value={query} onChange={event => { setQuery(event.target.value); setActive(event.target.value ? 0 : -1) }} />
    </div>}
    <div className="ink-menu-body" style={{ maxHeight: spec.maxHeight }}>
      {groups.map((group, groupIndex) => <div key={groupIndex}>
        {groupIndex > 0 && <div className="ink-menu-divider" />}
        <div className="ink-menu-group">
          {group.map((entry, entryIndex) => {
            if (entry.kind === 'label') return <div key={`l${entryIndex}`} className="ink-menu-label">{entry.label}</div>
            if (entry.kind === 'custom') return <div key={entry.key}>{entry.render(doCloseAll)}</div>
            const index = items.indexOf(entry)
            return <div
              key={entry.id}
              data-item-id={entry.id}
              role={entry.toggle !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={entry.toggle !== undefined ? entry.toggle : undefined}
              aria-disabled={entry.disabled || undefined}
              aria-label={itemText(entry) || undefined}
              className={`ink-menu-item${index === active ? ' is-active' : ''}${entry.danger ? ' is-danger' : ''}${entry.disabled ? ' is-disabled' : ''}${entry.accent ? ' is-accent' : ''}`}
              onMouseMove={event => {
                if (index !== active) setActive(index)
                const element = event.currentTarget
                clearTimeout(hoverTimer.current)
                hoverTimer.current = window.setTimeout(() => { if (element.matches(':hover')) openSub(entry, element) }, entry.sub ? 60 : 160)
              }}
              onMouseLeave={() => setActive(-1)}
              onClick={event => select(entry, event.currentTarget)}
            >
              {entry.icon !== undefined && <span className="ink-menu-icon">{typeof entry.icon === 'string' ? <Icon name={entry.icon as IconName} size={18} /> : entry.icon}</span>}
              <span className="ink-menu-text">{entry.label}</span>
              {entry.right}
              {entry.shortcut && <span className="ink-menu-sc">{entry.shortcut}</span>}
              {entry.checked && <span className="ink-menu-check"><Icon name="check" size={16} /></span>}
              {entry.toggle !== undefined && <Switch on={entry.toggle} />}
              {entry.sub && <span className="ink-menu-chev"><Icon name="chevronRight" size={16} /></span>}
            </div>
          })}
        </div>
      </div>)}
      {query && items.length === 0 && <div className="ink-menu-group"><div className="ink-menu-empty">没有结果</div></div>}
    </div>
    {spec.footer && <><div className="ink-menu-divider" /><div className="ink-menu-footer">{spec.footer}</div></>}
  </div>
}

export function Switch({ on }: { on: boolean }) {
  return <span className={`ink-switch${on ? ' is-on' : ''}`} aria-hidden><span className="ink-switch-knob" /></span>
}
