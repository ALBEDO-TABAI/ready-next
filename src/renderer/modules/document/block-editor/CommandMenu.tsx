import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem { id: string; label: string; detail?: string; run(): void | Promise<void> }
export interface MenuAnchor { left: number; bottom: number }
export function CommandMenu({ label, anchor, items, close, query: controlled, onQuery, pending = false, initialQuery = '' }: {
  label: string; anchor: MenuAnchor; items: MenuItem[]; close(): void
  initialQuery?: string; query?: string; onQuery?(value: string): void; pending?: boolean
}) {
  const [local, setLocal] = useState(initialQuery), [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(close); closeRef.current = close
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
  return createPortal(<div ref={panel} className="ready-block-popover" data-block-popup data-ready-native-overlay="" role="dialog" aria-label={label}
    style={{ left: Math.max(8, Math.min(anchor.left, window.innerWidth - 340)), top: Math.max(8, Math.min(anchor.bottom + 5, window.innerHeight - 340)) }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % Math.max(1, filtered.length)) }
      if (event.key === 'Enter') { event.preventDefault(); if (!pending) void filtered[index]?.run() }
    }}>
    <input ref={input} aria-label="搜索操作" role="combobox" aria-expanded aria-controls={id} aria-activedescendant={filtered[index] ? `${id}-${index}` : undefined}
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
    .ready-block-shell { position:relative; --color-gray:var(--text-muted); --color-brown:#95745b; --color-yellow:#b49b36; --color-pink:#c26b98; }
    /* Render blocks use content-visibility (paint containment), which clips anything outside their box.
       A block with a handle keeps its gutter inside its own box; containers without one stop clipping their children's gutters. */
    .ready-block-shell[data-actionable] { padding-inline-start:28px; margin-inline-start:-28px; }
    .ready-block-shell:not([data-actionable]) { content-visibility:visible; contain-intrinsic-size:none; }
    .ready-block-handle { position:absolute; left:2px; top:2px; width:23px; opacity:0; cursor:grab; color:var(--text-secondary); border:0; background:transparent; }
    .ready-block-shell:hover > .ready-block-handle, .ready-block-shell:focus-within > .ready-block-handle { opacity:1; }
    .ready-block-source { position:relative; }
    /* Source editing is a quiet corner control revealed on hover or keyboard focus, not a line of its own. */
    .ready-block-source-edit { position:absolute; top:6px; right:6px; z-index:1; padding:2px 8px; border:1px solid var(--border-color); border-radius:6px; font-size:12px; line-height:18px; color:var(--text-secondary); background:var(--bg-primary, #fff); opacity:0; transition:opacity .12s ease; }
    .ready-block-shell:hover .ready-block-source-edit, .ready-block-source-edit:focus-visible { opacity:1; }
    .ready-block-shell[data-drop=before] { box-shadow:0 -2px var(--accent-color, #e8401f); }
    .ready-block-shell[data-drop=after] { box-shadow:0 2px var(--accent-color, #e8401f); }
    .ready-block-popover { position:fixed; z-index:1000; width:320px; max-width:calc(100vw - 16px); padding:8px; border:1px solid var(--border-color); border-radius:14px; background:var(--bg-secondary, #fafafa); color:var(--text-primary); box-shadow:0 12px 40px #0002; backdrop-filter:blur(24px); font:13px/1.5 var(--font-sans, sans-serif); }
    .ready-block-popover [role=listbox] { max-height:270px; overflow:auto; }
    .ready-block-popover input { width:100%; padding:6px 8px; border:1px solid var(--border-color); border-radius:6px; color:inherit; background:transparent; }
    .ready-block-popover button { border:0; color:inherit; background:transparent; border-radius:6px; padding:6px 10px; text-align:left; }
    .ready-block-popover [role=option] { display:flex; flex-direction:column; width:100%; }
    .ready-block-popover button:hover, .ready-block-popover [aria-selected=true] { background:var(--bg-hover, #8882); }
    .ready-block-popover small { opacity:.65; overflow-wrap:anywhere; }
    .ready-block-toolbar { display:flex; flex-wrap:wrap; width:360px; gap:2px; }
    .ready-block-toolbar select { max-width:110px; background:transparent; color:inherit; }
  }`}</style>
}
