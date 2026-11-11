import { Filter, Newspaper, Plus, Rss, SlidersHorizontal } from 'lucide-react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS } from './organization-icons'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'
import { ShellSidebarToggle } from '../../modules/workbench/shell/ShellSidebar'

// 资讯的导航器（W5 §4）：在外壳唯一的侧栏里（W2-T4）。默认落在“为你筛过的”；“全部 / 未读 / 收藏”按种类取名，
// 主题单列；“精选”并入“为你筛过的”，“历史底稿”成了“全部”里的筛选项，二者不再出现在导航里。
const SYSTEM_LABELS: Partial<Record<RSSDefinition['kind'], string>> = { all: '全部', unread: '未读', starred: '收藏' }

export default function RSSNavigation({ definitions, onNavigate, onSieve, onManage, onSources, onDigests, managing = false }: {
  definitions: RSSDefinition[]
  onNavigate(query: RSSQueryInput): void
  onSieve(): void
  onManage(focus?: string): void
  onSources(): void
  onDigests(): void
  managing?: boolean
}) {
  const digestVisible = useRSSSession((state) => state.digestVisible)
  const sieveVisible = useRSSSession((state) => state.sieveVisible)
  const query = useRSSSession((state) => state.query)
  const activeId = query.collectionId || (query.filter === 'all' ? 'all' : query.filter)
  const onCollection = !digestVisible && !managing && !sieveVisible
  const systems = (['all', 'unread', 'starred'] as const).flatMap(kind => definitions.filter(entry => entry.kind === kind).slice(0, 1))
  const topics = definitions.filter(entry => entry.kind === 'topic' && entry.visible)
  const item = (definition: RSSDefinition, label: string) => {
    const Icon = RSS_DEFINITION_ICONS[definition.icon]
    return <button type="button" key={definition.id} title={label} aria-label={label}
      aria-current={onCollection && activeId === definition.id ? 'page' : undefined} className="rss-nav__item"
      onClick={() => onNavigate({ collectionId: definition.id, scope: 'inbox',
        filter: definition.kind === 'unread' || definition.kind === 'starred' ? definition.kind : 'all', categoryId: undefined })}>
      <Icon size={16} strokeWidth={1.8} /><span>{label}</span>
    </button>
  }
  return <nav className="rss-nav" aria-label="资讯导航">
    <div className="rss-nav__head"><span>资讯</span><ShellSidebarToggle /></div>
    <div className="rss-nav__list">
      <button type="button" className="rss-nav__item" aria-label="为你筛过的" title="为你筛过的"
        aria-current={sieveVisible && !digestVisible && !managing ? 'page' : undefined} onClick={onSieve}>
        <Filter size={16} strokeWidth={1.8} /><span>为你筛过的</span>
      </button>
      {systems.map(definition => item(definition, SYSTEM_LABELS[definition.kind] ?? definition.name))}
    </div>
    <p className="rss-nav__label">主题</p>
    <div className="rss-nav__list">
      {topics.map(definition => item(definition, definition.name))}
      <button type="button" className="rss-nav__item rss-nav__item--quiet" aria-label="新建主题" title="新建主题" onClick={() => onManage('new-topic')}>
        <Plus size={16} strokeWidth={1.8} /><span>新建主题</span>
      </button>
    </div>
    <div className="rss-nav__list">
      <button type="button" className="rss-nav__item" aria-label="日报与简报" title="日报与简报"
        aria-current={digestVisible && !managing ? 'page' : undefined} onClick={onDigests}>
        <Newspaper size={16} strokeWidth={1.8} /><span>日报与简报</span>
      </button>
    </div>
    <div className="rss-nav__foot">
      <button type="button" className="rss-nav__item" aria-label="来源" title="来源" onClick={onSources}>
        <Rss size={16} strokeWidth={1.8} /><span>来源</span>
      </button>
      <button type="button" className="rss-nav__item" aria-label="筛子设置" title="筛子设置"
        aria-current={managing ? 'page' : undefined} onClick={() => onManage()}>
        <SlidersHorizontal size={16} strokeWidth={1.8} /><span>筛子设置</span>
      </button>
    </div>
  </nav>
}
