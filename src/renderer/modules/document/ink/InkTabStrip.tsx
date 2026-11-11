import { useEffect, useRef, useState } from 'react'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import { Icon } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { goBack, goForward, useInkHistory, useInkLayout } from './layout-state'
import { tip } from './overlay'
import { returnFromReference, useReferenceReturn } from '../../workbench/reference-return'

const MOD = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
const tabLabel = (tab: DocTab) => tab.kind === 'library' ? '阅读' : tab.title.replace(/\.(md|canvas)$/i, '') || '未命名'
function TabIcon({ tab }: { tab: DocTab }) {
  if (tab.kind === 'library') return <Icon name="library" size={14} stroke={1.6} />
  if (/\.canvas$/i.test(tab.path ?? '')) return <InkPageIcon kind="canvas" size={14} />
  if (tab.path && !/\.md$/i.test(tab.path)) return <Icon name="file" size={14} stroke={1.6} />
  return <InkPageIcon size={14} />
}

/** Inkwell's tab bar along the top edge of the page: history, the open documents and a new tab. */
export function InkTabStrip({ active, onNewTab }: { active: boolean; onNewTab(): void }) {
  const tabs = useDocTabs(state => state.tabs)
  const activeId = useDocTabs(state => state.activeTabId)
  const home = useInkLayout(state => state.home)
  const { canBack, canForward } = useInkHistory()
  const back = useReferenceReturn(state => state.destination === 'document' ? state.entry : null)
  const strip = useRef<HTMLDivElement>(null)
  const dragged = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      if (event.key === '[') goBack(); else goForward()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
  // Keep the active tab in view when the strip overflows (without scrolling any ancestor).
  useEffect(() => {
    const element = strip.current, tab = element?.querySelector<HTMLElement>('.ink-tab.is-active')
    if (!element || !tab) return
    if (tab.offsetLeft < element.scrollLeft) element.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollLeft = tab.offsetLeft + tab.offsetWidth - element.clientWidth
  }, [activeId, home, tabs.length])
  const activate = (id: string) => { useInkLayout.getState().setHome(false); useDocTabs.getState().setActiveTab(id) }
  const close = (id: string) => useDocTabs.getState().closeTab(id)
  return <div className="ink-tabbar" aria-label="打开的文档">
    <div className="ink-tabbar-nav">
      <button type="button" className="ink-tbar-icon" aria-label="后退" disabled={!canBack} {...tip('后退', `${MOD}[`)} onClick={goBack}><Icon name="chevronLeft" size={17} /></button>
      <button type="button" className="ink-tbar-icon" aria-label="前进" disabled={!canForward} {...tip('前进', `${MOD}]`)} onClick={goForward}><Icon name="chevronRight" size={17} /></button>
    </div>
    <div className="ink-tabstrip" role="tablist" aria-label="文档标签" ref={strip}
      onWheel={event => { const element = event.currentTarget; if (element.scrollWidth > element.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) element.scrollLeft += event.deltaY }}>
      {tabs.map((tab, index) => {
        const active = !home && tab.id === activeId
        const label = tabLabel(tab)
        return <div key={tab.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={tab.path ?? label} data-tab-id={tab.id}
          className={`ink-tab${active ? ' is-active' : ''}${dropAt === tab.id ? ' is-drop' : ''}`}
          draggable onDragStart={event => { dragged.current = tab.id; event.dataTransfer.effectAllowed = 'move' }}
          onDragOver={event => { if (dragged.current && dragged.current !== tab.id) { event.preventDefault(); setDropAt(tab.id) } }}
          onDragLeave={() => setDropAt(current => current === tab.id ? null : current)}
          onDrop={event => {
            event.preventDefault(); setDropAt(null)
            const from = tabs.findIndex(item => item.id === dragged.current); dragged.current = null
            if (from >= 0 && from !== index) useDocTabs.getState().reorderTabs(from, index)
          }}
          onDragEnd={() => { dragged.current = null; setDropAt(null) }}
          onClick={() => activate(tab.id)}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab.id) } }}
          onKeyDown={event => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
              if (next) { activate(next.id); (event.currentTarget.parentElement?.querySelector(`[data-tab-id="${next.id}"]`) as HTMLElement | null)?.focus() }
            }
          }}>
          <span className="ink-tab-icon"><TabIcon tab={tab} /></span>
          <span className="ink-tab-title">{label}</span>
          {tab.isDirty && <span className="ink-tab-dirty" aria-label="有未保存的修改" />}
          <button type="button" className="ink-tab-close" aria-label={`关闭 ${label}`} tabIndex={-1}
            onClick={event => { event.stopPropagation(); close(tab.id) }}><Icon name="x" size={12} stroke={2} /></button>
        </div>
      })}
    </div>
    <button type="button" className="ink-tbar-icon ink-tbar-new" aria-label="新建标签页" {...tip('新建标签页', `${MOD}T`)} onClick={onNewTab}><Icon name="plus" size={16} /></button>
    {/* After following a reference from another place, the way back sits at the end of the bar. */}
    {back && <button type="button" className="ink-return-chip" aria-label={`返回 ${back.label}`} title={`返回 ${back.label}`} onClick={returnFromReference}>
      <Icon name="chevronLeft" size={14} stroke={2} /><span>返回 {back.label}</span>
    </button>}
  </div>
}
