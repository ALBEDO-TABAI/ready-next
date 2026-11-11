import { SlidersHorizontal, Newspaper } from 'lucide-react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS } from './organization-icons'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'
import { ShellSidebarToggle } from '../../modules/workbench/shell/ShellSidebar'

// 资讯的导航器：在外壳唯一的侧栏里（W2-T4），透明地坐在玻璃上；选中是“被托起的白玻璃”，不画分隔线。
// 宽度与收起归外壳管（⌘B）。
export default function RSSNavigation({ definitions, onNavigate, onManage, onDigests, managing = false }: {
  definitions: RSSDefinition[]
  onNavigate(query: RSSQueryInput): void
  onManage(): void
  onDigests(): void
  managing?: boolean
}) {
  const digestVisible = useRSSSession((state) => state.digestVisible)
  const query = useRSSSession((state) => state.query)
  const activeId = query.collectionId || (query.scope === 'library' ? 'history' : query.filter === 'all' ? 'all' : query.filter)
  const onCollection = !digestVisible && !managing
  return <nav className="rss-nav" aria-label="资讯导航">
    <div className="rss-nav__head"><span>资讯</span><ShellSidebarToggle /></div>
    <p className="rss-nav__label">栏目</p>
    <div className="rss-nav__list">
      {definitions.filter((entry) => entry.visible).map((definition) => {
        const Icon = RSS_DEFINITION_ICONS[definition.icon]
        return <button type="button" key={definition.id} title={definition.name} aria-label={definition.name}
          aria-current={onCollection && activeId === definition.id ? 'page' : undefined} className="rss-nav__item"
          onClick={() => onNavigate({ collectionId: definition.id, scope: definition.kind === 'history' ? 'library' : 'inbox',
            filter: definition.kind === 'unread' || definition.kind === 'starred' ? definition.kind : 'all', categoryId: undefined })}>
          <Icon size={16} strokeWidth={1.8} /><span>{definition.name}</span>
        </button>
      })}
    </div>
    <p className="rss-nav__label">整理</p>
    <div className="rss-nav__list">
      <button type="button" className="rss-nav__item" aria-label="日报与简报" title="日报与简报"
        aria-current={digestVisible && !managing ? 'page' : undefined} onClick={onDigests}>
        <Newspaper size={16} strokeWidth={1.8} /><span>日报与简报</span>
      </button>
    </div>
    <div className="rss-nav__foot">
      <button type="button" className="rss-nav__item" aria-label="管理栏目" title="管理栏目"
        aria-current={managing ? 'page' : undefined} onClick={onManage}>
        <SlidersHorizontal size={16} strokeWidth={1.8} /><span>管理栏目</span>
      </button>
    </div>
  </nav>
}
