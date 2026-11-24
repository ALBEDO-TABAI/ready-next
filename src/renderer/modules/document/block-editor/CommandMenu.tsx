import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLeaveAsGhost } from '../../../components/ui/leave'

export interface MenuItem { id: string; label: string; detail?: string; run(): void | Promise<void> }
export interface MenuAnchor { left: number; bottom: number }
export function CommandMenu({ label, anchor, items, close, query: controlled, onQuery, pending = false, initialQuery = '' }: {
  label: string; anchor: MenuAnchor; items: MenuItem[]; close(): void
  initialQuery?: string; query?: string; onQuery?(value: string): void; pending?: boolean
}) {
  const [local, setLocal] = useState(initialQuery), [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close); closeRef.current = close
  useLeaveAsGhost(panel)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) closeRef.current() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const id = useId(), query = controlled ?? local
  const filtered = controlled === undefined ? items.filter(item => `${item.label} ${item.id}`.toLowerCase().includes(query.toLowerCase())) : items
  const index = Math.min(active, Math.max(0, filtered.length - 1))
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [index, filtered.length])
  return createPortal(<div ref={panel} className="rn-ui rn-float ready-block-popover" data-float-motion="down" data-block-popup data-ready-native-overlay="" role="dialog" aria-label={label}
    style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 340)), top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 340)) }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length)) }
      if (event.key === 'Enter') { event.preventDefault(); if (!pending) void filtered[index]?.run() }
    }}>
    <input ref={input} className="rn-field" aria-label="搜索操作" placeholder="搜索" role="combobox" aria-expanded aria-controls={id} aria-activedescendant={filtered[index] ? `${id}-${index}` : undefined}
      value={query} onChange={event => { setActive(0); if (onQuery) onQuery(event.target.value); else setLocal(event.target.value) }} />
    <div ref={list} id={id} role="listbox" aria-label={label} aria-busy={pending}>
      {filtered.map((item, i) => <button type="button" id={`${id}-${i}`} key={item.id} role="option" aria-selected={i === index} disabled={pending}
        onMouseEnter={() => setActive(i)} onClick={() => { void item.run() }}><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</button>)}
      {!filtered.length && <p role="status">{pending ? '搜索中…' : '没有匹配项'}</p>}
    </div>
  </div>, document.body)
}

export function BlockEditorStyles() {
  return <style>{`@layer components {
    .ready-block-shell { position:relative; }
    /* Render blocks use content-visibility (paint containment), which clips anything outside their box.
       A block with a handle keeps its gutter inside its own box; containers without one stop clipping their children's gutters. */
    .ready-block-shell[data-actionable] { padding-inline-start:28px; margin-inline-start:-28px; }
    .ready-block-shell:not([data-actionable]) { content-visibility:visible; contain-intrinsic-size:none; }
    /* The handle shows in --rn-d-1 and lingers a beat before fading (motion language M2), so a pointer sweeping down the page does not flicker every handle it passes. */
    .ready-block-handle { position:absolute; left:2px; top:2px; width:23px; opacity:0; cursor:grab; color:var(--rn-ink-3); border:0; background:transparent; transition:opacity var(--rn-d-2) var(--rn-ease-std) var(--rn-d-1); }
    .ready-block-shell:hover > .ready-block-handle, .ready-block-shell:focus-within > .ready-block-handle { opacity:1; transition-duration:var(--rn-d-1); transition-delay:0s; }
    .ready-block-container { min-width:0; }
    .ready-block-container.is-indented { padding-left:24px; }
    .ready-block-container.is-quote { border-left:2px solid var(--rn-hair-2); }
    /* A list entry's marker is its handle: drag it to move the entry among its siblings. */
    .ready-block-marker { float:left; width:24px; margin-left:-24px; text-align:center; user-select:none; cursor:grab; }
    button.ready-block-marker { appearance:none; padding:0; border:0; background:none; font:inherit; color:inherit; cursor:pointer; }
    /* A task's box is the document's one checkbox (V16): clear with an ink-3 edge; checked, an ink box whose check is a
       mask painted in --rn-on-inverse, so it reads in light and dark (never a fixed white glyph). */
    .ready-block-marker.is-task { position:relative; width:16px; height:16px; margin:.38em 0 0 -21px; border-radius:5px; box-shadow:inset 0 0 0 1.5px var(--rn-ink-3); }
    .ready-block-marker.is-task[data-checked=true] { background:var(--rn-inverse); box-shadow:none; }
    .ready-block-marker.is-task[data-checked=true]::after { content:''; position:absolute; inset:0; background:var(--rn-on-inverse); mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 12px no-repeat; }
    .ready-block-container[data-checked=true] > .ready-block-shell .note-preview-markdown-p { color:var(--rn-ink-3); text-decoration:line-through; }
    .ready-block-tail { display:block; width:100%; min-height:32px; margin:4px 0 0; padding:4px 2px; border:0; background:transparent; font:inherit; text-align:left; color:transparent; cursor:text; }
    .ready-block-tail:hover, .ready-block-tail:focus-visible { color:var(--rn-ink-3); outline:none; }
    .ready-block-source { position:relative; }
    /* Source editing is a quiet corner control revealed on hover or keyboard focus, not a line of its own. */
    .ready-block-source-edit { position:absolute; top:6px; right:6px; z-index:1; padding:2px 10px; border:0; border-radius:var(--rn-r-pill); font-size:12px; line-height:18px; color:var(--rn-ink-2); background:var(--rn-inlay); box-shadow:inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2), var(--rn-shadow-1); opacity:0; transition:opacity var(--rn-d-1) var(--rn-ease-std); }
    .ready-block-shell:hover .ready-block-source-edit, .ready-block-source-edit:focus-visible { opacity:1; }
    /* The page's properties are its frontmatter block: the same corner control opens its source. */
    .note-preview-properties { position:relative; }
    .note-preview-properties:hover > .ready-block-source-edit { opacity:1; }
    /* The line where a moved block, or a reference dragged in from outside, will land. */
    .ready-block-shell[data-drop=before], .ready-block-shell[data-ref-drop=before] { box-shadow:0 -2px var(--rn-accent); }
    .ready-block-shell[data-drop=after], .ready-block-shell[data-ref-drop=after] { box-shadow:0 2px var(--rn-accent); }
    /* A callout edits in place: its title is one editable line; an untitled callout shows its kind there. */
    .ready-callout-title[data-callout-title] > [data-rich-start] { flex:1; min-width:0; margin:0; font:inherit; color:inherit; cursor:text; }
    .ready-callout-title[data-callout-title] > [data-rich-start]:empty::after { content:var(--callout-placeholder); }
    .ready-callout-title[data-callout-title] > [data-rich-start]:empty:focus::after { color:var(--rn-ink-3); }
    /* Tables (plan §1.8): cells edit in place; the add bars and the row / column handles stay quiet until the pointer
       comes near. */
    .ready-table { position:relative; margin:6px 0 0; padding-bottom:24px; }
    .ready-table [data-table-cell] { min-width:48px; cursor:text; outline:none; }
    .ready-table [data-table-cell]:focus { box-shadow:inset 0 0 0 1.5px color-mix(in srgb, var(--rn-ink) 55%, transparent); }
    .ready-table__add { position:absolute; display:flex; align-items:center; justify-content:center; padding:0; border:0; border-radius:var(--rn-r-pill); color:var(--rn-ink-3); background:var(--rn-fill-2); opacity:0; cursor:pointer; transition:opacity var(--rn-d-1) var(--rn-ease-std), color var(--rn-d-1) var(--rn-ease-std), background var(--rn-d-1) var(--rn-ease-std); }
    .ready-table__add.is-row { left:0; right:0; bottom:0; height:20px; }
    .ready-table__add.is-column { top:0; bottom:24px; right:-24px; width:20px; }
    .ready-table[data-near~=row] .ready-table__add.is-row, .ready-table[data-near~=column] .ready-table__add.is-column, .ready-table__add:hover, .ready-table__add:focus-visible { opacity:1; }
    .ready-table__add:hover { color:var(--rn-ink); background:var(--rn-fill-3); }
    .ready-table__add svg, .ready-table__handle svg { width:14px; height:14px; stroke-width:var(--rn-icon-stroke); }
    .ready-table__handle { position:absolute; z-index:2; display:flex; align-items:center; justify-content:center; padding:0; border:0; border-radius:var(--rn-r-pill); color:var(--rn-ink-3); background:var(--rn-solid); box-shadow:inset 0 0 0 .5px var(--rn-hair-2), var(--rn-shadow-1); cursor:pointer; transform:translate(-50%, -50%); }
    .ready-table__handle:hover, .ready-table__handle:focus-visible { color:var(--rn-ink); }
    .ready-table__handle.is-column { top:0; width:28px; height:20px; }
    .ready-table__handle.is-row { left:0; width:20px; height:28px; }
    .ready-block-popover { position:fixed; z-index:1000; width:320px; max-width:calc(100vw - 16px); padding:8px; color:var(--rn-ink); }
    .ready-block-popover [role=listbox] { max-height:270px; overflow:auto; }
    .ready-block-popover button { border:0; color:inherit; background:transparent; border-radius:var(--rn-r-sm); padding:6px 10px; text-align:left; }
    .ready-block-popover [role=option] { display:flex; flex-direction:column; width:100%; }
    .ready-block-popover button:hover, .ready-block-popover [aria-selected=true] { background:var(--rn-fill-2); }
    .ready-block-popover small { color:var(--rn-ink-3); overflow-wrap:anywhere; }
    /* The slash menu (W3 §4.3): W1's float and menu language, --rn-* tokens only. */
    .ready-slash-menu { position: fixed; z-index: 1000; width: 300px; max-width: calc(100vw - 16px); padding: 6px; }
    .ready-slash-menu__list { max-height: 360px; overflow-y: auto; scrollbar-width: thin; }
    .ready-slash-menu__item { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: var(--rn-r-sm); cursor: pointer; }
    .ready-slash-menu__item[aria-selected='true'] { background: var(--rn-fill-2); }
    .ready-slash-menu__icon { display: flex; flex: none; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rn-r-sm); background: var(--rn-inlay); box-shadow: inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2); color: var(--rn-ink-2); }
    .ready-slash-menu__icon svg { width: 17px; height: 17px; stroke-width: var(--rn-icon-stroke); }
    .ready-slash-menu__text { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
    .ready-slash-menu__label { overflow: hidden; color: var(--rn-ink); font-size: var(--rn-fs-md); line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .ready-slash-menu__description { overflow: hidden; color: var(--rn-ink-3); font-size: var(--rn-fs-xs); line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
    .ready-slash-menu__empty { margin: 0; padding: 10px; color: var(--rn-ink-3); font-size: var(--rn-fs-sm); }
  }`}</style>
}
