import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import type { PageNode, PageRoot } from '../../../../shared/document-pages'
import { useDocTabs } from '../../../stores/useDocTabs'
import { useWorkspace } from '../../../stores/useWorkspace'
import { requestWorkbenchModeOpen } from '../../workbench/mode-transition'
import { createPageTreeStore, flattenPages } from '../page-ui/page-state'
import { Icon } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { eventTimeLabel, useInkLayout, useUpcomingEvents } from './layout-state'

function greeting(now = new Date()): string {
  const hour = now.getHours()
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
}
function ago(ms: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days} 天前` : new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

/** The document home: what was open recently, favourites and what is coming up. */
export function InkHome({ roots, visible }: { roots: PageRoot[]; visible: boolean }) {
  const api = window.electronAPI.documentPages
  const store = useMemo(() => createPageTreeStore(api), [api])
  const { trees, states } = useStore(store)
  const rootsKey = JSON.stringify(roots)
  useEffect(() => { void store.getState().load(roots) }, [store, rootsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const upcoming = useUpcomingEvents(visible, 6)
  const all = flattenPages(trees).filter(node => node.kind === 'page' || node.kind === 'canvas')
  const byId = new Map(all.map(node => [node.objectId, node]))
  const recent = states.filter(state => state.lastVisitedAt !== null && byId.has(state.objectId))
    .sort((a, b) => b.lastVisitedAt! - a.lastVisitedAt!).slice(0, 8).map(state => ({ node: byId.get(state.objectId)!, at: state.lastVisitedAt! }))
  const favorites = states.filter(state => state.favorite && byId.has(state.objectId)).map(state => byId.get(state.objectId)!)
  const open = (node: PageNode) => {
    useWorkspace.getState().selectFile(node.path)
    useInkLayout.getState().setHome(false)
    useDocTabs.getState().openTab(node.path)
    void api.visit(node.objectId)
  }
  return <div className="ink-home" aria-label="主页">
    <h1 className="ink-home-greeting">{greeting()}</h1>
    <section className="ink-home-section" aria-label="最近访问">
      <h2 className="ink-home-label"><Icon name="restore" size={14} stroke={1.8} />最近访问</h2>
      {recent.length ? <div className="ink-home-cards">{recent.map(({ node, at }) => <button key={node.objectId} type="button" className="ink-home-card" onClick={() => open(node)} title={node.path}>
        <span className="ink-home-card-band" />
        <span className="ink-home-card-icon"><InkPageIcon value={node.icon} kind={node.kind} size={28} emojiSize={26} /></span>
        <span className="ink-home-card-title">{node.title}</span>
        <span className="ink-home-card-meta">{ago(at)}</span>
      </button>)}</div> : <p className="ink-home-empty">打开过的页面会出现在这里。</p>}
    </section>
    {favorites.length > 0 && <section className="ink-home-section" aria-label="收藏">
      <h2 className="ink-home-label"><Icon name="star" size={14} stroke={1.8} />收藏</h2>
      <div className="ink-home-list">{favorites.map(node => <button key={node.objectId} type="button" className="ink-home-row" onClick={() => open(node)}>
        <InkPageIcon value={node.icon} kind={node.kind} size={18} /><span>{node.title}</span>
      </button>)}</div>
    </section>}
    <section className="ink-home-section" aria-label="即将开始">
      <h2 className="ink-home-label"><Icon name="calendar" size={14} stroke={1.8} />即将开始</h2>
      <div className="ink-home-list">
        {upcoming === null && <p className="ink-home-empty">正在读取日程…</p>}
        {upcoming?.length === 0 && <p className="ink-home-empty">未来一周没有日程。</p>}
        {upcoming?.map(item => <button key={item.key} type="button" className="ink-home-row" onClick={() => { void window.electronAPI.calendar.revealEvent(item.eventId); requestWorkbenchModeOpen('calendar') }}>
          <span className="ink-sb-event-dot" style={{ background: item.color }} /><span className="ink-home-time">{eventTimeLabel(item)}</span><span>{item.title}</span>
        </button>)}
        <button type="button" className="ink-home-row is-muted" onClick={() => requestWorkbenchModeOpen('calendar')}><Icon name="calendar" size={16} />打开日历</button>
      </div>
    </section>
  </div>
}
