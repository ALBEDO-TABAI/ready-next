import { useEffect, useState } from 'react'
import {
  ALargeSmall, ArrowDown, ArrowUp, BringToFront, CalendarPlus, ChevronDown, ChevronRight, ChevronUp, Ellipsis, FilePlus2, FolderInput, FolderOutput, Group, Layers, LayoutGrid, Redo2, Scan, Search, SendToBack, Shapes, SlidersHorizontal, Sparkles, StickyNote, Trash2, Type, Undo2, Ungroup, X, type LucideIcon,
} from 'lucide-react'
import { Button, closeFloat, IconButton, Input, toggleMenu, type MenuEntry } from '../../ui'
import type { Tool } from './types'
import { ARRANGEMENTS, DOCK_TOOLS, DRAW_TOOL, SHAPE_TOOLS } from './chrome-tools'
import { toggleViewSettings, VIEW_SETTINGS } from './view-settings-float'
import type { Appearance } from '../../../../shared/ready-canvas/schema'

// The board's chrome (W4 §2.1, MS1): the content area is one stage; only a few controls float on it, in the
// float material. Every tool is a W1 icon button with a tooltip naming its key; its menus are the shared W1 menus.

const MORE_MENU = 'canvas-more-menu', SHAPES_MENU = 'canvas-shapes-menu', ARRANGE_MENU = 'canvas-arrange-menu', LAYER_MENU = 'canvas-layer-menu', TEXT_MENU = 'canvas-text-menu'

/** A chrome tool: the W1 icon button named by its label, the tooltip adding its key; a count is a badge. */
function ChromeTool({ label, icon: Glyph, shortcut, pressed, disabled, danger, badge, menu, onClick }: {
  label: string; icon: LucideIcon; shortcut?: string; pressed?: boolean; disabled?: boolean; danger?: boolean; badge?: number
  menu?: { id: string; open: boolean }; onClick(button: HTMLElement): void
}) {
  return <IconButton size="lg" className={[danger && 'is-danger', badge && 'canvas-count'].filter(Boolean).join(' ')}
    icon={<><Glyph aria-hidden />{badge ? <span className="canvas-icon-badge" aria-hidden>{badge}</span> : null}</>}
    title={shortcut ? `${label}（${shortcut}）` : label} aria-label={label} aria-keyshortcuts={shortcut} active={pressed} disabled={disabled}
    aria-haspopup={menu ? 'menu' : undefined} aria-expanded={menu ? menu.open : undefined} data-float-anchor={menu?.id}
    onClick={event => onClick(event.currentTarget)} />
}

/** A chrome menu opened from its button (shared W1 menu); it closes with the chrome that owns it. */
function useChromeMenu(id: string) {
  const [open, setOpen] = useState(false)
  useEffect(() => () => closeFloat(id), [id])
  const toggle = (button: HTMLElement, label: string, items: MenuEntry[], placement: 'top' | 'bottom' | 'bottom-end') =>
    toggleMenu(button, { id, label, items, placement, onOpenChange: setOpen })
  return { open, toggle }
}

/** Top left: where you are. A sub-board shows its parents; each one goes back. */
export function CanvasCrumbs({ title, breadcrumbs, busy, onNavigate }: {
  title: string; breadcrumbs?: Array<{ id: string; title: string }>; busy: boolean; onNavigate?(id: string): void
}) {
  return <nav className="canvas-crumbs rn-float" aria-label="画板路径" data-canvas-ui>
    {breadcrumbs?.map(crumb => <span key={crumb.id} className="canvas-crumb">
      <Button variant="ghost" size="sm" disabled={!onNavigate || busy} onClick={() => onNavigate?.(crumb.id)}>{crumb.title}</Button>
      <ChevronRight aria-hidden />
    </span>)}
    <strong>{title}</strong>
  </nav>
}

/** Top right: search, zoom (click for 100%), fit to content, the bin, and 更多 (export). */
export function CanvasCorner({ zoom, search, results, hit, recycled, trash, busy, more, onSearch, onStep, onZoomReset, onFit, onTrash }: {
  zoom: number; search: string | null; results: number; hit: number; recycled: number; trash: boolean; busy: boolean
  more?: MenuEntry[]
  onSearch(value: string | null): void; onStep(delta: 1 | -1): void; onZoomReset(): void; onFit(): void; onTrash(): void
}) {
  const moreMenu = useChromeMenu(MORE_MENU), [viewOpen, setViewOpen] = useState(false)
  useEffect(() => () => closeFloat(VIEW_SETTINGS), [])
  return <div className="canvas-corner rn-float" role="toolbar" aria-label="视图" data-canvas-ui>
    {search === null ? <ChromeTool label="在画板中搜索" icon={Search} shortcut="⌘F" disabled={trash} onClick={() => onSearch('')} /> : <span className="canvas-search">
      <Search aria-hidden />
      <Input aria-label="搜索卡片" placeholder="搜索卡片" autoFocus value={search} onChange={event => onSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); onStep(event.shiftKey ? -1 : 1) }
          if (event.key === 'Escape') { event.preventDefault(); onSearch(null) }
        }} />
      <output aria-live="polite">{search.trim() ? results ? hit >= 0 ? `${hit + 1}/${results}` : `${results} 张` : '无结果' : ''}</output>
      <IconButton size="lg" icon={<ChevronUp />} title="上一个" disabled={!results} onClick={() => onStep(-1)} />
      <IconButton size="lg" icon={<ChevronDown />} title="下一个" disabled={!results} onClick={() => onStep(1)} />
      <IconButton size="lg" icon={<X />} title="关闭搜索" onClick={() => onSearch(null)} />
    </span>}
    <Button variant="ghost" className="canvas-zoom" aria-label="缩放比例" title="回到 100%" onClick={onZoomReset}>{Math.round(zoom * 100)}%</Button>
    <ChromeTool label="适应内容" icon={Scan} shortcut="⇧1" disabled={trash} onClick={onFit} />
    <ChromeTool label="视图设置" icon={SlidersHorizontal} menu={{ id: VIEW_SETTINGS, open: viewOpen }} disabled={trash} onClick={button => toggleViewSettings(button, setViewOpen)} />
    <ChromeTool label="回收站" icon={Trash2} pressed={trash} badge={recycled} disabled={busy} onClick={onTrash} />
    {more && <ChromeTool label="更多" icon={Ellipsis} menu={{ id: MORE_MENU, open: moreMenu.open }} disabled={busy || trash}
      onClick={button => moreMenu.toggle(button, '更多', more, 'bottom-end')} />}
  </div>
}

/** Bottom centre: the tools. Shapes share one button; text and note cards are placed where you look. */
export function CanvasDock({ tool, lastShape, disabled, graphics, canUndo, canRedo, busy, onTool, onCard, onUndo, onRedo }: {
  tool: Tool; lastShape: Tool; disabled: boolean; graphics: boolean; canUndo: boolean; canRedo: boolean; busy: boolean
  onTool(tool: Tool): void; onCard(kind: 'text' | 'note'): void; onUndo(): void; onRedo(): void
}) {
  const shapesMenu = useChromeMenu(SHAPES_MENU)
  const shape = SHAPE_TOOLS.find(item => item.id === lastShape) ?? SHAPE_TOOLS[0]
  const shapeActive = SHAPE_TOOLS.some(item => item.id === tool)
  return <div className="canvas-dock rn-float" role="toolbar" aria-label="画板工具" data-canvas-ui>
    {DOCK_TOOLS.map(item => <ChromeTool key={item.id} label={item.label} icon={item.icon} shortcut={item.key} pressed={tool === item.id} disabled={disabled} onClick={() => onTool(item.id)} />)}
    <span className="canvas-dock-sep" aria-hidden />
    <ChromeTool label="文字卡" icon={Type} shortcut="T" disabled={disabled || busy} onClick={() => onCard('text')} />
    <ChromeTool label="便签" icon={StickyNote} shortcut="N" disabled={disabled || busy} onClick={() => onCard('note')} />
    <ChromeTool label="图形" icon={shapeActive ? shape.icon : Shapes} pressed={shapeActive} menu={{ id: SHAPES_MENU, open: shapesMenu.open }} disabled={disabled || !graphics}
      onClick={button => shapesMenu.toggle(button, '图形', SHAPE_TOOLS.map(item => ({ id: item.id, label: item.label, icon: <item.icon />, hint: item.key, checked: tool === item.id, onSelect: () => onTool(item.id) })), 'top')} />
    <ChromeTool label={DRAW_TOOL.label} icon={DRAW_TOOL.icon} shortcut={DRAW_TOOL.key} pressed={tool === DRAW_TOOL.id} disabled={disabled || !graphics} onClick={() => onTool(DRAW_TOOL.id)} />
    <span className="canvas-dock-sep" aria-hidden />
    <ChromeTool label="撤销" icon={Undo2} shortcut="⌘Z" disabled={busy || !canUndo} onClick={onUndo} />
    <ChromeTool label="重做" icon={Redo2} shortcut="⇧⌘Z" disabled={busy || !canRedo} onClick={onRedo} />
  </div>
}

/** Text card sizes (px; saved as `fontScale` in 24px units), weights and alignment: the data had them, the board now offers them. */
const TEXT_SIZES = [{ px: 13, label: '正文' }, { px: 18, label: '小标题' }, { px: 26, label: '大标题' }]
const TEXT_WEIGHTS: Array<{ id: NonNullable<Appearance['weight']>; label: string }> = [{ id: 'light', label: '细' }, { id: 'regular', label: '常规' }, { id: 'medium', label: '中等' }, { id: 'bold', label: '加粗' }]
const TEXT_ALIGNS: Array<{ id: NonNullable<Appearance['align']>; label: string }> = [{ id: 'left', label: '左对齐' }, { id: 'center', label: '居中' }, { id: 'right', label: '右对齐' }]

/** Above the selection: what you can do with these cards. */
export function SelectionBar({ left, top, count, edges = 0, text, canGroup, canUngroup, busy, actions }: {
  left: number; top: number; count: number; edges?: number;
  /** Set when every picked card is a text card or a note: what they share (a value is absent when they differ). */
  text?: { size?: number; weight?: Appearance['weight']; align?: Appearance['align'] }
  canGroup: boolean; canUngroup: boolean; busy: boolean
  actions: {
    group(): void; ungroup(): void; layout(kind: 'P' | 'L' | 'R'): void; layer(placement: 'front' | 'forward' | 'backward' | 'back'): void; remove(): void
    textStyle?(patch: Partial<Pick<Appearance, 'fontScale' | 'weight' | 'align'>>): void
    addToDocument?(): void; askAI?(): void; schedule?(): void
    collect?(): void; moveOut?(): void
  }
}) {
  const arrangeMenu = useChromeMenu(ARRANGE_MENU), layerMenu = useChromeMenu(LAYER_MENU), textMenu = useChromeMenu(TEXT_MENU)
  return <div className="canvas-selection-bar rn-float" role="toolbar" aria-label="选区操作" data-canvas-ui style={{ left, top }}>
    <span className="canvas-selection-count" aria-live="polite">{count ? `${count} 张` : `${edges} 条连线`}</span>
    {!count && <ChromeTool label="删除连线" icon={Trash2} shortcut="Delete" danger disabled={busy} onClick={actions.remove} />}
    {!!count && <>
    {canGroup && <ChromeTool label="分组" icon={Group} shortcut="⌘G" disabled={busy} onClick={actions.group} />}
    {canUngroup && <ChromeTool label="解组" icon={Ungroup} shortcut="⇧⌘G" disabled={busy} onClick={actions.ungroup} />}
    {actions.collect && <ChromeTool label="收进子画板" icon={FolderInput} disabled={busy} onClick={actions.collect} />}
    {actions.moveOut && <ChromeTool label="移出到上一级" icon={FolderOutput} disabled={busy} onClick={actions.moveOut} />}
    {count > 1 && <ChromeTool label="排版" icon={LayoutGrid} menu={{ id: ARRANGE_MENU, open: arrangeMenu.open }} disabled={busy}
      onClick={button => arrangeMenu.toggle(button, '排版', ARRANGEMENTS.map(item => ({ id: item.id, label: item.label, icon: <item.icon />, hint: item.key, onSelect: () => actions.layout(item.id) })), 'bottom')} />}
    {text && actions.textStyle && <ChromeTool label="文字" icon={ALargeSmall} menu={{ id: TEXT_MENU, open: textMenu.open }} disabled={busy}
      onClick={button => textMenu.toggle(button, '文字', [
        { kind: 'group', label: '字号' },
        ...TEXT_SIZES.map(item => ({ id: `size-${item.px}`, label: item.label, checked: text.size === item.px, onSelect: () => actions.textStyle!({ fontScale: item.px / 24 }) })),
        { kind: 'group', label: '粗细' },
        ...TEXT_WEIGHTS.map(item => ({ id: `weight-${item.id}`, label: item.label, checked: (text.weight ?? 'regular') === item.id, onSelect: () => actions.textStyle!({ weight: item.id }) })),
        { kind: 'group', label: '对齐' },
        ...TEXT_ALIGNS.map(item => ({ id: `align-${item.id}`, label: item.label, checked: (text.align ?? 'left') === item.id, onSelect: () => actions.textStyle!({ align: item.id }) })),
      ], 'bottom')} />}
    <ChromeTool label="层级" icon={Layers} menu={{ id: LAYER_MENU, open: layerMenu.open }} disabled={busy}
      onClick={button => layerMenu.toggle(button, '层级', [
        { id: 'front', label: '置顶', icon: <BringToFront />, onSelect: () => actions.layer('front') },
        { id: 'forward', label: '上移一层', icon: <ArrowUp />, hint: '⌥⌘]', onSelect: () => actions.layer('forward') },
        { id: 'backward', label: '下移一层', icon: <ArrowDown />, hint: '⌥⌘[', onSelect: () => actions.layer('backward') },
        { id: 'back', label: '置底', icon: <SendToBack />, onSelect: () => actions.layer('back') },
      ], 'bottom')} />
    {(actions.addToDocument || actions.askAI || actions.schedule) && <span className="canvas-dock-sep" aria-hidden />}
    {actions.addToDocument && <ChromeTool label="添加到文档" icon={FilePlus2} disabled={busy} onClick={actions.addToDocument} />}
    {actions.askAI && <ChromeTool label="问 AI" icon={Sparkles} disabled={busy} onClick={actions.askAI} />}
    {actions.schedule && <ChromeTool label="安排日程…" icon={CalendarPlus} disabled={busy} onClick={actions.schedule} />}
    <span className="canvas-dock-sep" aria-hidden />
    <ChromeTool label="删除" icon={Trash2} shortcut="Delete" danger disabled={busy} onClick={actions.remove} />
    </>}
  </div>
}
