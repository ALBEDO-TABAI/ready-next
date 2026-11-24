import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { MenuAnchor } from './CommandMenu'
import { useLeaveAsGhost } from '../../../components/ui/leave'
import { SLASH_GROUPS, type SlashItem } from './slash-items'

// The slash menu (W3 §4.3) in W1's menu language. It never takes focus: the query is what follows “/” in the
// page itself, and EditorTools routes ↑ ↓ Enter Esc here while the menu is open. Items keep the editor
// focused on pointer down, so choosing one with the mouse still edits the same block.

export function SlashMenu({ anchor, items, active, onActive, onChoose, onClose }: {
  anchor: MenuAnchor; items: SlashItem[]; active: number
  onActive(index: number): void; onChoose(item: SlashItem): void; onClose(): void
}) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  // Opens downward from the caret and fades out in place when closed (motion language M2).
  useLeaveAsGhost(panel)
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) closeRef.current() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  useEffect(() => { panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [active, items.length])
  const groups = SLASH_GROUPS.map(group => ({ group, entries: items.map((item, index) => ({ item, index })).filter(entry => entry.item.group === group) }))
    .filter(entry => entry.entries.length)
  return createPortal(<div ref={panel} className="rn-ui rn-float ready-slash-menu" data-float-motion="down" data-block-popup data-ready-native-overlay=""
    style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 316)), top: Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - 380)) }}
    onMouseDown={event => event.preventDefault()}>
    <div role="listbox" id={id} aria-label="插入块" className="ready-slash-menu__list">
      {groups.map(({ group, entries }) => <div key={group} role="group" aria-label={group}>
        <div className="rn-menu__group" aria-hidden>{group}</div>
        {entries.map(({ item, index }) => {
          const Glyph = item.icon
          return <div key={item.id} id={`${id}-${index}`} role="option" aria-selected={index === active} data-slash-item={item.id}
            className="ready-slash-menu__item" onMouseMove={() => { if (index !== active) onActive(index) }} onClick={() => onChoose(item)}>
            <span className="ready-slash-menu__icon"><Glyph aria-hidden /></span>
            <span className="ready-slash-menu__text"><span className="ready-slash-menu__label">{item.label}</span>
              <span className="ready-slash-menu__description">{item.description}</span></span>
          </div>
        })}
      </div>)}
      {!items.length && <p role="status" className="ready-slash-menu__empty">没有匹配的块</p>}
    </div>
  </div>, document.body)
}
