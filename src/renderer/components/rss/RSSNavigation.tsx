import { Archive, Bookmark, Inbox, Mail, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'

const entries = [
  { id: 'all', label: '全部动态', icon: Inbox, query: { scope: 'inbox', filter: 'all' } },
  { id: 'unread', label: '未读', icon: Mail, query: { scope: 'inbox', filter: 'unread' } },
  { id: 'starred', label: '收藏', icon: Bookmark, query: { scope: 'inbox', filter: 'starred' } },
  { id: 'history', label: '历史底稿', icon: Archive, query: { scope: 'library', filter: 'all' } },
] as const

export default function RSSNavigation({ onNavigate }: { onNavigate(query: RSSQueryInput): void }) {
  const query = useRSSSession((state) => state.query)
  const collapsed = useRSSSession((state) => state.navigationCollapsed)
  const setCollapsed = useRSSSession((state) => state.setNavigationCollapsed)
  return <nav className={`rss-navigation glass-surface-floating ${collapsed ? 'is-collapsed' : ''}`} aria-label="RSS 内部导航">
    <button type="button" className="rss-navigation-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'} title={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'}>
      {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      {!collapsed && <span>资讯</span>}
    </button>
    {entries.map(({ id, icon: Icon, label, query: target }) => <button type="button" key={id} title={label} aria-label={label}
      aria-current={query.scope === target.scope && query.filter === target.filter ? 'page' : undefined}
      className="rss-navigation-item" onClick={() => onNavigate(target)}>
      <Icon size={17} />{!collapsed && <span>{label}</span>}
    </button>)}
  </nav>
}
