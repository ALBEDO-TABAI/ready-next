import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react'
import { CircleX, Plus, Ungroup } from 'lucide-react'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import { TAB_GROUP_COLORS } from '../../../shared/tab-groups'
import { tabGroupColorSoft, tabGroupColorVar } from './tab-group-visuals'

export const TAB_GROUP_EDIT_MENU_WIDTH = 220
// Projected outer height (name + swatches + two dividers + three actions). Used by hosts
// to reserve space (overlay window height floor / doc-rail flip-up estimate); a slight
// overshoot is fine, an undershoot clips the menu.
export const TAB_GROUP_EDIT_MENU_EST_HEIGHT = 192

// Edge-style group edit menu CONTENT (name input, nine-color swatches, icon actions).
// Hosts own the floating surface + positioning: the document rail portals it to <body>,
// the browser overlay window absolutely positions it inside the child window.
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
  const [nameFocused, setNameFocused] = useState(false)
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
        <input
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="群组名称"
          onChange={(event) => setName(event.target.value)}
          onFocus={() => setNameFocused(true)}
          onBlur={() => { setNameFocused(false); commitName() }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { commitName(); onRequestClose() }
            if (event.key === 'Escape') onRequestClose()
          }}
          className="w-full text-[12px] outline-none"
          style={{
            height: 30,
            borderRadius: 8,
            padding: '0 9px',
            background: 'var(--bg-content)',
            color: 'var(--text-title)',
            border: `1px solid ${nameFocused ? tabGroupColorVar(group.color) : 'color-mix(in srgb, var(--text-title) 12%, transparent)'}`,
            boxShadow: nameFocused ? `0 0 0 2.5px ${tabGroupColorSoft(group.color, 22)}` : 'none',
          }}
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
      <MenuDivider />
      <div className="flex flex-col" style={{ padding: 5 }}>
        <MenuAction icon={Plus} label="群组中新建标签页" onClick={onNewTab} />
        <MenuAction icon={Ungroup} label="取消群组" onClick={onDisband} />
      </div>
      <MenuDivider />
      <div className="flex flex-col" style={{ padding: 5 }}>
        <MenuAction icon={CircleX} label="关闭群组标签页" onClick={onDelete} danger />
      </div>
    </div>
  )
}

function MenuDivider() {
  return <div aria-hidden style={{ height: 1, flexShrink: 0, background: 'color-mix(in srgb, var(--text-title) 8%, transparent)' }} />
}

function MenuAction({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: ComponentType<{ style?: CSSProperties; strokeWidth?: number }>
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="flex items-center gap-[8px] rounded-[6px] text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
      style={{ height: 28, padding: '0 7px', color: danger ? 'var(--color-red)' : 'var(--text-body)' }}
    >
      <Icon style={{ width: 14, height: 14, flexShrink: 0, opacity: danger ? 1 : 0.72 }} strokeWidth={2} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
