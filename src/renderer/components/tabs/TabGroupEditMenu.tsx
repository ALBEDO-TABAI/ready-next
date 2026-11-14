import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleX, Plus, Ungroup } from 'lucide-react'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import { TAB_GROUP_COLORS } from '../../../shared/tab-groups'
import { tabGroupColorVar } from './tab-group-visuals'
import { Input } from '../ui'
// The swatches are user-content colours (see tab-group-visuals.ts).
import '../../modules/document/content-palette.css'

export const TAB_GROUP_EDIT_MENU_WIDTH = 220
// Projected outer height (name + swatches + a divider + the menu's three actions with its own
// separator). Used by hosts to reserve space; a slight overshoot is fine, an undershoot clips the menu.
export const TAB_GROUP_EDIT_MENU_EST_HEIGHT = 200

// Edge-style group edit menu CONTENT (name input, nine-color swatches, icon actions), drawn with
// the shared primitives: the name is an Input, the actions are menu items (the menu primitive's
// look), the swatches are the group's user-content colours. Hosts own the float surface
// (`.rn-float`) and positioning.
//
// Rename commit semantics (P2/P3 review lineage): commit on Enter / blur, and once more
// on UNMOUNT — on macOS clicking a <button> does not blur the input, so an action that
// unmounts the menu would otherwise lose the pending edit. `lastCommittedRef` dedupes the
// blur+unmount pair. Hosts key this component by group id so switching groups commits
// against the OLD group's draft, never the new one's.
export default function TabGroupEditMenu({
  group,
  onRename,
  onRecolor,
  onNewTab,
  onDisband,
  onDelete,
  onRequestClose,
}: {
  group: TabGroup
  onRename: (name: string) => void
  onRecolor: (color: TabGroupColor) => void
  onNewTab: () => void
  onDisband: () => void
  onDelete: () => void
  onRequestClose: () => void
}) {
  const [name, setName] = useState(group.name)
  const lastCommittedRef = useRef(group.name)
  const nameRef = useRef(name)
  nameRef.current = name
  const renameRef = useRef(onRename)
  renameRef.current = onRename
  const commitName = () => {
    if (nameRef.current === lastCommittedRef.current) return
    lastCommittedRef.current = nameRef.current
    renameRef.current(nameRef.current)
  }
  const commitRef = useRef(commitName)
  commitRef.current = commitName
  useEffect(() => () => commitRef.current(), [])

  return (
    <div className="flex flex-col" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-col gap-[8px]" style={{ padding: '10px 10px 9px' }}>
        <Input
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="分组名称"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { commitName(); onRequestClose() }
            if (event.key === 'Escape') onRequestClose()
          }}
          className="w-full"
          style={{ height: 30, padding: '0 9px', fontSize: 'var(--rn-fs-sm)' }}
        />
        <div className="flex items-center justify-between">
          {TAB_GROUP_COLORS.map((color) => {
            const selected = color === group.color
            return (
              <button
                key={color}
                type="button"
                aria-label={color}
                title={color}
                // Keep focus (and the IME caret) in the name input while recoloring; also
                // avoids the global :focus-visible ring lingering on the swatch.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRecolor(color)}
                className="flex-shrink-0 rounded-full transition-transform hover:scale-[1.15]"
                style={{
                  width: 16,
                  height: 16,
                  background: selected ? 'transparent' : tabGroupColorVar(color),
                  border: selected ? `4.5px solid ${tabGroupColorVar(color)}` : 'none',
                }}
              />
            )
          })}
        </div>
      </div>
      <div aria-hidden className="rn-menu__sep" style={{ margin: 0 }} />
      <div className="rn-menu" style={{ minWidth: 0 }}>
        <MenuAction icon={<Plus aria-hidden="true" />} label="分组中新建标签页" onClick={onNewTab} />
        <MenuAction icon={<Ungroup aria-hidden="true" />} label="取消分组" onClick={onDisband} />
        <div aria-hidden className="rn-menu__sep" />
        <MenuAction icon={<CircleX aria-hidden="true" />} label="关闭分组标签页" onClick={onDelete} danger />
      </div>
    </div>
  )
}

// A menu item with the menu primitive's look (.rn-menu__item, highlighted under the pointer); mouse-down
// keeps focus (and the IME caret) in the name input, so the pending name commits on unmount as before.
function MenuAction({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      data-danger={danger || undefined}
      data-highlighted={hovered || undefined}
      className="rn-menu__item"
    >
      {icon}
      <span className="rn-menu__label">{label}</span>
    </button>
  )
}
