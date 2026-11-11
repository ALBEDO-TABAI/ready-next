import { useEffect, useRef, type ReactNode } from 'react'
import {
  BringToFront, CalendarPlus, ChevronDown, ChevronRight, ChevronUp, Ellipsis, FilePlus2, Group, LayoutGrid, Redo2, Scan, Search, SendToBack, Shapes, Sparkles, StickyNote, Trash2, Type, Undo2, Ungroup, X, type LucideIcon,
} from 'lucide-react'
import type { Tool } from './types'
import { ARRANGEMENTS, DOCK_TOOLS, DRAW_TOOL, SHAPE_TOOLS } from './chrome-tools'

// The board's chrome (W4 §2.1, MS1): the content area is one stage; only a few controls float on it, in the
// float material. Every tool has an icon, a tooltip with its key, and a keyboard path.

export function IconButton({ label, icon: Glyph, shortcut, pressed, disabled, danger, badge, onClick }: {
  label: string; icon: LucideIcon; shortcut?: string; pressed?: boolean; disabled?: boolean; danger?: boolean; badge?: number; onClick(): void
}) {
  return <button type="button" className={`canvas-icon${danger ? ' is-danger' : ''}`} aria-label={label} title={shortcut ? `${label}（${shortcut}）` : label}
    aria-pressed={pressed} disabled={disabled} onClick={() => onClick()}>
    <Glyph aria-hidden />{badge ? <span className="canvas-icon-badge" aria-hidden>{badge}</span> : null}
  </button>
}

/** A small list of choices opened from a chrome button; closes on outside pointer down and Esc. */
export function ChromeMenu({ label, children, onClose }: { label: string; children: ReactNode; onClose(): void }) {
  const panel = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.parentElement?.contains(event.target)) close.current() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key) }
  }, [])
  return <div ref={panel} className="canvas-popover rn-float" role="menu" aria-label={label} data-canvas-ui>{children}</div>
}

export function MenuItem({ label, icon: Glyph, shortcut, checked, disabled, danger, onSelect }: {
  label: string; icon?: LucideIcon; shortcut?: string; checked?: boolean; disabled?: boolean; danger?: boolean; onSelect(): void
}) {
  return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-label={label} aria-checked={checked} disabled={disabled}
    className={`canvas-menu-item${danger ? ' is-danger' : ''}`} onClick={() => onSelect()}>
    {Glyph ? <Glyph aria-hidden /> : <span className="canvas-menu-gap" />}<span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
  </button>
}

/** Top left: where you are. A sub-board shows its parents; each one goes back. */
export function CanvasCrumbs({ title, breadcrumbs, busy, onNavigate }: {
  title: string; breadcrumbs?: Array<{ id: string; title: string }>; busy: boolean; onNavigate?(id: string): void
}) {
  return <nav className="canvas-crumbs rn-float" aria-label="画板路径" data-canvas-ui>
    {breadcrumbs?.map(crumb => <span key={crumb.id} className="canvas-crumb">
      <button type="button" disabled={!onNavigate || busy} onClick={() => onNavigate?.(crumb.id)}>{crumb.title}</button>
      <ChevronRight aria-hidden />
    </span>)}
    <strong>{title}</strong>
  </nav>
}

/** Top right: search, zoom (click for 100%), fit to content, the bin. */
export function CanvasCorner({ zoom, search, results, hit, recycled, trash, busy, moreOpen, more, onMore, onSearch, onStep, onZoomReset, onFit, onTrash }: {
  zoom: number; search: string | null; results: number; hit: number; recycled: number; trash: boolean; busy: boolean
  moreOpen: boolean; more?: ReactNode; onMore(open: boolean): void
  onSearch(value: string | null): void; onStep(delta: 1 | -1): void; onZoomReset(): void; onFit(): void; onTrash(): void
}) {
  return <div className="canvas-corner rn-float" role="toolbar" aria-label="视图" data-canvas-ui>
    {search === null ? <IconButton label="在画板中搜索" icon={Search} shortcut="⌘F" disabled={trash} onClick={() => onSearch('')} /> : <span className="canvas-search">
      <Search aria-hidden />
      <input aria-label="搜索卡片" placeholder="搜索卡片" autoFocus value={search} onChange={event => onSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1) }
          if (event.key === 'Escape') { event.preventDefault(); onSearch(null) }
        }} />
      <output aria-live="polite">{search.trim() ? results ? hit >= 0 ? `${hit + 1}/${results}` : `${results} 张` : '无结果' : ''}</output>
      <IconButton label="上一个" icon={ChevronUp} disabled={!results} onClick={() => onStep(-1)} />
      <IconButton label="下一个" icon={ChevronDown} disabled={!results} onClick={() => onStep(1)} />
      <IconButton label="关闭搜索" icon={X} onClick={() => onSearch(null)} />
    </span>}
    <button type="button" className="canvas-zoom" aria-label="缩放比例" title="回到 100%" onClick={onZoomReset}>{Math.round(zoom * 100)}%</button>
    <IconButton label="适应内容" icon={Scan} shortcut="⇧1" disabled={trash} onClick={onFit} />
    <IconButton label="回收站" icon={Trash2} pressed={trash} badge={recycled} disabled={busy} onClick={onTrash} />
    {more && <span className="canvas-dock-anchor">
      <IconButton label="更多" icon={Ellipsis} pressed={moreOpen} disabled={busy || trash} onClick={() => onMore(!moreOpen)} />
      {moreOpen && <ChromeMenu label="更多" onClose={() => onMore(false)}>{more}</ChromeMenu>}
    </span>}
  </div>
}

/** Bottom centre: the tools. Shapes share one button; text and note cards are placed where you look. */
export function CanvasDock({ tool, lastShape, shapesOpen, disabled, graphics, canUndo, canRedo, busy, onTool, onShapes, onCard, onUndo, onRedo }: {
  tool: Tool; lastShape: Tool; shapesOpen: boolean; disabled: boolean; graphics: boolean; canUndo: boolean; canRedo: boolean; busy: boolean
  onTool(tool: Tool): void; onShapes(open: boolean): void; onCard(kind: 'text' | 'note'): void; onUndo(): void; onRedo(): void
}) {
  const shape = SHAPE_TOOLS.find(item => item.id === lastShape) ?? SHAPE_TOOLS[0]
  const shapeActive = SHAPE_TOOLS.some(item => item.id === tool)
  return <div className="canvas-dock rn-float" role="toolbar" aria-label="画板工具" data-canvas-ui>
    {DOCK_TOOLS.map(item => <IconButton key={item.id} label={item.label} icon={item.icon} shortcut={item.key} pressed={tool === item.id} disabled={disabled} onClick={() => onTool(item.id)} />)}
    <span className="canvas-dock-sep" aria-hidden />
    <IconButton label="文字卡" icon={Type} shortcut="T" disabled={disabled || busy} onClick={() => onCard('text')} />
    <IconButton label="便签" icon={StickyNote} shortcut="N" disabled={disabled || busy} onClick={() => onCard('note')} />
    <span className="canvas-dock-anchor">
      <IconButton label="图形" icon={shapeActive ? shape.icon : Shapes} pressed={shapeActive} disabled={disabled || !graphics} onClick={() => onShapes(!shapesOpen)} />
      {shapesOpen && <ChromeMenu label="图形" onClose={() => onShapes(false)}>
        {SHAPE_TOOLS.map(item => <MenuItem key={item.id} label={item.label} icon={item.icon} shortcut={item.key} checked={tool === item.id}
          onSelect={() => { onTool(item.id); onShapes(false) }} />)}
      </ChromeMenu>}
    </span>
    <IconButton label={DRAW_TOOL.label} icon={DRAW_TOOL.icon} shortcut={DRAW_TOOL.key} pressed={tool === DRAW_TOOL.id} disabled={disabled || !graphics} onClick={() => onTool(DRAW_TOOL.id)} />
    <span className="canvas-dock-sep" aria-hidden />
    <IconButton label="撤销" icon={Undo2} shortcut="⌘Z" disabled={busy || !canUndo} onClick={onUndo} />
    <IconButton label="重做" icon={Redo2} shortcut="⇧⌘Z" disabled={busy || !canRedo} onClick={onRedo} />
  </div>
}

/** Above the selection: what you can do with these cards. */
export function SelectionBar({ left, top, count, canGroup, canUngroup, arrangeOpen, busy, actions }: {
  left: number; top: number; count: number; canGroup: boolean; canUngroup: boolean; arrangeOpen: boolean; busy: boolean
  actions: {
    group(): void; ungroup(): void; arrange(open: boolean): void; layout(kind: 'P' | 'L' | 'R'): void; front(): void; back(): void; remove(): void
    addToDocument?(): void; askAI?(): void; schedule?(): void
  }
}) {
  return <div className="canvas-selection-bar rn-float" role="toolbar" aria-label="选区操作" data-canvas-ui style={{ left, top }}>
    <span className="canvas-selection-count" aria-live="polite">{count} 张</span>
    {canGroup && <IconButton label="分组" icon={Group} shortcut="⌘G" disabled={busy} onClick={actions.group} />}
    {canUngroup && <IconButton label="解组" icon={Ungroup} shortcut="⇧⌘G" disabled={busy} onClick={actions.ungroup} />}
    {count > 1 && <span className="canvas-dock-anchor">
      <IconButton label="排版" icon={LayoutGrid} pressed={arrangeOpen} disabled={busy} onClick={() => actions.arrange(!arrangeOpen)} />
      {arrangeOpen && <ChromeMenu label="排版" onClose={() => actions.arrange(false)}>
        {ARRANGEMENTS.map(item => <MenuItem key={item.id} label={item.label} icon={item.icon} shortcut={item.key} onSelect={() => { actions.layout(item.id); actions.arrange(false) }} />)}
      </ChromeMenu>}
    </span>}
    <IconButton label="置顶" icon={BringToFront} disabled={busy} onClick={actions.front} />
    <IconButton label="置底" icon={SendToBack} disabled={busy} onClick={actions.back} />
    {(actions.addToDocument || actions.askAI || actions.schedule) && <span className="canvas-dock-sep" aria-hidden />}
    {actions.addToDocument && <IconButton label="添加到文档" icon={FilePlus2} disabled={busy} onClick={actions.addToDocument} />}
    {actions.askAI && <IconButton label="问 AI" icon={Sparkles} disabled={busy} onClick={actions.askAI} />}
    {actions.schedule && <IconButton label="安排日程…" icon={CalendarPlus} disabled={busy} onClick={actions.schedule} />}
    <span className="canvas-dock-sep" aria-hidden />
    <IconButton label="删除" icon={Trash2} shortcut="Delete" danger disabled={busy} onClick={actions.remove} />
  </div>
}
