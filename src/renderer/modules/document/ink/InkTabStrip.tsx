import { userOpenedObject } from '../../workbench/navigation-open-event'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useDocTabs, type DocTab } from '../../../stores/useDocTabs'
import { Icon } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { useInkLayout } from './layout-state'
import { tip } from './overlay'
import { openToday } from '../../today/open-today'

const MOD = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl+'
const tabLabel = (tab: DocTab) => tab.kind === 'library' ? '阅读' : tab.title.replace(/\.(md|canvas)$/i, '') || '未命名'
function TabIcon({ tab }: { tab: DocTab }) {
  if (tab.kind === 'library') return <Icon name="library" size={14} stroke={1.6} />
  if (/\.canvas$/i.test(tab.path ?? '')) return <InkPageIcon kind="canvas" size={14} />
  if (tab.path && !/\.md$/i.test(tab.path)) return <Icon name="file" size={14} stroke={1.6} />
  return <InkPageIcon size={14} />
}

/** Inkwell's tab bar along the top edge of the page: 今日 (the mode's system tab, always first), the open documents and a
 *  new tab. The way back lives at the top-left of the page itself (W6 §4), not in this bar. */
export function InkTabStrip({ onNewTab }: { active: boolean; onNewTab(): void }) {
  const tabs = useDocTabs(state => state.tabs)
  const activeId = useDocTabs(state => state.activeTabId)
  const home = useInkLayout(state => state.home)
  const bar = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const dragged = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  // Keep the active tab in view when the strip overflows (without scrolling any ancestor).
  useEffect(() => {
    const element = strip.current, tab = element?.querySelector<HTMLElement>('.ink-tab.is-active')
    if (!element || !tab) return
    if (tab.offsetLeft < element.scrollLeft) element.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > element.scrollLeft + element.clientWidth) element.scrollLeft = tab.offsetLeft + tab.offsetWidth - element.clientWidth
  }, [activeId, home, tabs.length])
  const activate = (id: string) => { const tab = tabs.find(tab => tab.id === id); if (tab?.path) userOpenedObject({ mode: 'document', path: tab.path, title: tabLabel(tab) }); useInkLayout.getState().setHome(false); useDocTabs.getState().setActiveTab(id) }
  const close = (id: string) => useDocTabs.getState().closeTab(id)
  // ← / → move through 今日 and the documents as one row of tabs.
  const arrow = (event: KeyboardEvent, id: string) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const ids = ['today', ...tabs.map(tab => tab.id)]
    const next = ids[(ids.indexOf(id) + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length]
    if (next === 'today') openToday(); else activate(next)
    bar.current?.querySelector<HTMLElement>(next === 'today' ? '[data-today-tab]' : `[data-tab-id="${next}"]`)?.focus()
  }
  return <div className="ink-tabbar" aria-label="打开的文档" ref={bar}>
    <div className="ink-tablist" role="tablist" aria-label="文档标签">
    <div role="tab" aria-selected={home} tabIndex={home ? 0 : -1} title="今日" data-today-tab="" className={`ink-tab ink-tab--today${home ? ' is-active' : ''}`}
      onClick={openToday} onKeyDown={event => arrow(event, 'today')}>
      <span className="ink-tab-title">今日</span>
    </div>
    <div className="ink-tabstrip" ref={strip}
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
          onKeyDown={event => arrow(event, tab.id)}>
          <span className="ink-tab-icon"><TabIcon tab={tab} /></span>
          <span className="ink-tab-title">{label}</span>
          {tab.isDirty && <span className="ink-tab-dirty" aria-label="有未保存的修改" />}
          <button type="button" className="ink-tab-close" aria-label={`关闭 ${label}`} tabIndex={-1}
            onClick={event => { event.stopPropagation(); close(tab.id) }}><Icon name="x" size={12} stroke={2} /></button>
        </div>
      })}
    </div>
    </div>
    <button type="button" className="ink-tbar-icon ink-tbar-new" aria-label="新建标签页" {...tip('新建标签页', `${MOD}T`)} onClick={onNewTab}><Icon name="plus" size={16} /></button>
  </div>
}
