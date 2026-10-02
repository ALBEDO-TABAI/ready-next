import { PanelLeftClose, PanelLeftOpen, SlidersHorizontal, Newspaper } from 'lucide-react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS } from './organization-icons'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'

// 顶栏最左侧的导航开关，正对下方导航列，与文档 / 浏览器的标签列同宽对齐。
export function RSSNavigationToggle() {
  const collapsed = useRSSSession((state) => state.navigationCollapsed)
  const setCollapsed = useRSSSession((state) => state.setNavigationCollapsed)
  return <button type="button" className="rss-topbar__toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}
    aria-label={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'} title={collapsed ? '展开 RSS 导航' : '收起 RSS 导航'}>
    {collapsed ? <PanelLeftOpen size={16} strokeWidth={1.8} /> : <PanelLeftClose size={16} strokeWidth={1.8} />}
  </button>
}

// RSS 内部导航：画布 L 形的左列，透明地坐在画布材质上；选中是“被托起的白玻璃”，不画分隔线。
// 收起时只保留图标，名称由 title / aria-label 提供。
export default function RSSNavigation({ definitions, onNavigate, onManage, onDigests, managing = false }: {
  definitions: RSSDefinition[]
  onNavigate(query: RSSQueryInput): void
  onManage(): void
  onDigests(): void
  managing?: boolean
}) {
  const digestVisible = useRSSSession((state) => state.digestVisible)
  const query = useRSSSession((state) => state.query)
  const collapsed = useRSSSession((state) => state.navigationCollapsed)
  const activeId = query.collectionId || (query.scope === 'library' ? 'history' : query.filter === 'all' ? 'all' : query.filter)
  const onCollection = !digestVisible && !managing
  return <nav className={`rss-nav ${collapsed ? 'is-collapsed' : ''}`} aria-label="RSS 内部导航">
    <p className="rss-nav__label">栏目</p>
    <div className="rss-nav__list">
      {definitions.filter((entry) => entry.visible).map((definition) => {
        const Icon = RSS_DEFINITION_ICONS[definition.icon]
        return <button type="button" key={definition.id} title={definition.name} aria-label={definition.name}
          aria-current={onCollection && activeId === definition.id ? 'page' : undefined} className="rss-nav__item"
          onClick={() => onNavigate({ collectionId: definition.id, scope: definition.kind === 'history' ? 'library' : 'inbox',
            filter: definition.kind === 'unread' || definition.kind === 'starred' ? definition.kind : 'all', categoryId: undefined })}>
          <Icon size={16} strokeWidth={1.8} />{!collapsed && <span>{definition.name}</span>}
        </button>
      })}
    </div>
    <p className="rss-nav__label">整理</p>
    <div className="rss-nav__list">
      <button type="button" className="rss-nav__item" aria-label="日报与简报" title="日报与简报"
        aria-current={digestVisible && !managing ? 'page' : undefined} onClick={onDigests}>
        <Newspaper size={16} strokeWidth={1.8} />{!collapsed && <span>日报与简报</span>}
      </button>
    </div>
    <div className="rss-nav__foot">
      <button type="button" className="rss-nav__item" aria-label="管理栏目" title="管理栏目"
        aria-current={managing ? 'page' : undefined} onClick={onManage}>
        <SlidersHorizontal size={16} strokeWidth={1.8} />{!collapsed && <span>管理栏目</span>}
      </button>
    </div>
  </nav>
}
