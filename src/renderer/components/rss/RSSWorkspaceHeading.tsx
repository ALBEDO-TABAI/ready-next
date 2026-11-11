import type { ReactNode } from 'react'
import { Archive, ArrowDownUp } from 'lucide-react'
import { openFloat } from '../ui/float/float-store'
import { MenuList } from '../ui/float/Menu'
import type { RSSDefinition } from '../../../shared/rss-organization'
import type { RSSQueryResult } from '../../../shared/rss-workspace'
import { useRSSSession } from '../../stores/useRSSSession'

function updatedAtLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return date.toDateString() === new Date().toDateString() ? `${time} 更新` : `${date.getMonth() + 1}月${date.getDate()}日 ${time} 更新`
}

// 内容框顶部：栏目标题与它的归类标准，右侧一行安静的数量与更新时间；下面一排分类胶囊。
export default function RSSWorkspaceHeading({ view, loading, definitions, status, filtersAside }: {
  view: RSSQueryResult | null
  loading: boolean
  definitions: RSSDefinition[]
  status?: ReactNode
  filtersAside?: ReactNode
}) {
  const query = useRSSSession((state) => state.query)
  const setQuery = useRSSSession((state) => state.setQuery)
  const collection = definitions.find((entry) => entry.id === (query.collectionId || (query.scope === 'library' ? 'history' : query.filter === 'all' ? 'all' : query.filter)))
  // 全部 / 未读 / 收藏 go by their kind's short name, as in the navigator (W5 §4).
  const title = collection?.kind === 'all' ? '全部' : collection?.kind === 'unread' ? '未读' : collection?.kind === 'starred' ? '收藏' : collection?.name || '资讯'
  const sortLabel = query.sort === 'relevance' ? '按相关度' : query.sort === 'oldest' ? '最早在前' : '最新在前'
  const chooseSort = (anchor: HTMLElement) => openFloat({
    anchor: anchor.getBoundingClientRect(), placement: 'bottom-end', offset: 6, role: 'menu', label: '资讯排序',
    render: close => <MenuList label="资讯排序" onDone={close} items={([['newest', '最新在前'], ['oldest', '最早在前'], ['relevance', '按相关度']] as const)
      .map(([sort, label]) => ({ id: sort, label, checked: query.sort === sort, onSelect: () => setQuery({ sort }) }))} />,
  })
  const description = collection && ['topic', 'curated'].includes(collection.kind) ? collection.description.trim() : ''
  const filters = definitions.filter((entry) => collection?.filterIds.includes(entry.id) || entry.id === query.categoryId)
  const groups = view?.cardTotal !== undefined && view.cardTotal !== view.total ? view.cardTotal : null
  return <header className="rss-workspace-heading">
    <div className="rss-heading-row">
      <div className="rss-heading-title">
        <h1>{title}</h1>
        {description && <p className="rss-heading-desc" title={description}>{description}</p>}
      </div>
      <div className="rss-heading-meta">
        <p role="status">
          {loading && !view ? '正在读取…' : view ? `${view.total} 条 · ${view.unreadTotal} 未读${groups !== null ? ` · ${groups} 组` : ''}` : '尚未读取'}
          {view?.lastFetchAt ? ` · ${updatedAtLabel(view.lastFetchAt)}` : ''}
        </p>
        {status}
      </div>
    </div>
    <div className="rss-heading-filters">
      {filters.length > 0
        ? <div className="rss-category-filters" role="toolbar" aria-label="分类筛选">
          <button type="button" aria-pressed={!query.categoryId} onClick={() => setQuery({ categoryId: undefined })}>全部</button>
          {filters.map((definition) => <button type="button" key={definition.id} title={definition.description} aria-pressed={query.categoryId === definition.id} onClick={() => setQuery({ categoryId: definition.id })}>{definition.name}</button>)}
        </div>
        : null}
      <div className="rss-heading-aside">
        {filtersAside}
        {/* 历史底稿 left the navigator (W5 §4): in 全部 it is this switch. */}
        {collection?.kind === 'all' && <button type="button" className="rss-quiet-select" aria-pressed={query.scope === 'library'}
          title="包含已移出收件箱、仍保留在历史底稿里的文章" onClick={() => setQuery({ scope: query.scope === 'library' ? 'inbox' : 'library' })}>
          <Archive size={13} strokeWidth={1.9} /><span>包含已移出的</span>
        </button>}
        <button type="button" className="rss-quiet-select" aria-label={`资讯排序：${sortLabel}`} aria-haspopup="menu"
          title="排序" onClick={event => chooseSort(event.currentTarget)}>
          <ArrowDownUp size={13} strokeWidth={1.9} /><span>{sortLabel}</span>
        </button>
      </div>
    </div>
  </header>
}
