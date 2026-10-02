import { PanelLeftClose, PanelLeftOpen, SlidersHorizontal, Newspaper } from 'lucide-react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS } from './organization-icons'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'

export default function RSSNavigation({ definitions, onNavigate, onManage, onDigests }: { definitions: RSSDefinition[]; onNavigate(query: RSSQueryInput): void; onManage(): void; onDigests(): void }) {
  const digestVisible = useRSSSession((state) => state.digestVisible)
  const query = useRSSSession((state) => state.query)
  const collapsed = useRSSSession((state) => state.navigationCollapsed)
  const setCollapsed = useRSSSession((state) => state.setNavigationCollapsed)
  return <nav className={`rss-navigation glass-surface-floating ${collapsed ? 'is-collapsed' : ''}`} aria-label="RSS 内部导航">
    <button type="button" className="rss-navigation-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'} title={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'}>
      {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      {!collapsed && <span>资讯</span>}
    </button>
    {definitions.filter((entry) => entry.visible).map((definition) => {
      const Icon = RSS_DEFINITION_ICONS[definition.icon]
      const activeId = query.collectionId || (query.scope === 'library' ? 'history' : query.filter === 'all' ? 'all' : query.filter)
      return <button type="button" key={definition.id} title={definition.name} aria-label={definition.name}
        aria-current={!digestVisible && activeId === definition.id ? 'page' : undefined} className="rss-navigation-item"
        onClick={() => onNavigate({ collectionId: definition.id, scope: definition.kind === 'history' ? 'library' : 'inbox',
          filter: definition.kind === 'unread' || definition.kind === 'starred' ? definition.kind : 'all', categoryId: undefined })}>
        <Icon size={17} />{!collapsed && <span>{definition.name}</span>}
      </button>
    })}
    <button type="button" className="rss-navigation-item" aria-label="日报与简报" title="日报与简报" aria-current={digestVisible ? 'page' : undefined} onClick={onDigests}><Newspaper size={17} />{!collapsed && <span>日报与简报</span>}</button>
    <button type="button" className="rss-navigation-item" aria-label="管理栏目" title="管理栏目" onClick={onManage}><SlidersHorizontal size={17} />{!collapsed && <span>管理栏目</span>}</button>

  </nav>
}
