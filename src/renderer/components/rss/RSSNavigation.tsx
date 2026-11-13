import { Filter, Newspaper, Plus, Rss, SlidersHorizontal } from 'lucide-react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import { RSS_DEFINITION_ICONS } from './organization-icons'
import { useRSSSession } from '../../stores/useRSSSession'
import type { RSSQueryInput } from '../../../shared/rss-workspace'
import { ListRow } from '../ui/Structure'

// 资讯的导航器（W5 §4）：在外壳唯一的侧栏里（W2-T4）。默认落在“为你筛过的”；“全部 / 未读 / 收藏”按种类取名，
// 主题单列；“精选”并入“为你筛过的”，“历史底稿”成了“全部”里的筛选项，二者不再出现在导航里。
// 每一行是共享的 ListRow（W1 §5）：当前行用信号色，图标是发光的白字形。
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
    return <ListRow key={definition.id} title={label} aria-label={label} className="rss-nav__item" icon={<Icon size={16} />} label={label}
      current={onCollection && activeId === definition.id}
      onClick={() => onNavigate({ collectionId: definition.id, scope: 'inbox',
        filter: definition.kind === 'unread' || definition.kind === 'starred' ? definition.kind : 'all', categoryId: undefined })} />
  }
  // The header row is the shell's (V15): it stays put above the scrolling list, as in the other navigators.
  return <>
  <div className="shell-navigator__head"><span className="shell-navigator__title">资讯</span></div>
  <nav className="rss-nav" aria-label="资讯导航">
    <div className="rss-nav__list">
      <ListRow className="rss-nav__item" aria-label="为你筛过的" title="为你筛过的" icon={<Filter size={16} />} label="为你筛过的"
        current={sieveVisible && !digestVisible && !managing} onClick={onSieve} />
      {systems.map(definition => item(definition, SYSTEM_LABELS[definition.kind] ?? definition.name))}
    </div>
    <p className="rss-nav__label">主题</p>
    <div className="rss-nav__list">
      {topics.map(definition => item(definition, definition.name))}
      <ListRow className="rss-nav__item rss-nav__item--quiet" aria-label="新建主题" title="新建主题" icon={<Plus size={16} />} label="新建主题" onClick={() => onManage('new-topic')} />
    </div>
    <div className="rss-nav__list">
      <ListRow className="rss-nav__item" aria-label="日报与简报" title="日报与简报" icon={<Newspaper size={16} />} label="日报与简报"
        current={digestVisible && !managing} onClick={onDigests} />
    </div>
    <div className="rss-nav__foot">
      <ListRow className="rss-nav__item" aria-label="来源" title="来源" icon={<Rss size={16} />} label="来源" onClick={onSources} />
      <ListRow className="rss-nav__item" aria-label="筛子设置" title="筛子设置" icon={<SlidersHorizontal size={16} />} label="筛子设置"
        current={managing} onClick={() => onManage()} />
    </div>
  </nav>
  </>
}
