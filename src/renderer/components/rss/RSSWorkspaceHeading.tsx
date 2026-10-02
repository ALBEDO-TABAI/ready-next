import type { ReactNode } from 'react'
import { ArrowDownUp } from 'lucide-react'
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
  const title = collection?.name || '资讯'
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
        <button type="button" className="rss-quiet-select" aria-label={`资讯排序：${query.sort === 'oldest' ? '最早在前' : '最新在前'}`}
          title="切换排序" onClick={() => setQuery({ sort: query.sort === 'oldest' ? 'newest' : 'oldest' })}>
          <ArrowDownUp size={13} strokeWidth={1.9} /><span>{query.sort === 'oldest' ? '最早在前' : '最新在前'}</span>
        </button>
      </div>
    </div>
  </header>
}
