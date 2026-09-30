import RSSReferenceButton from './RSSReferenceButton'
import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useRSSSession } from '../../stores/useRSSSession'
import { RSS_SEARCH_MAX_LENGTH, type RSSQueryResult } from '../../../shared/rss-workspace'
import RSSExportButton from './RSSExportButton'

export default function RSSWorkspaceToolbar({ view, loading }: { view: RSSQueryResult | null; loading: boolean }) {
  const query = useRSSSession((state) => state.query)
  const setQuery = useRSSSession((state) => state.setQuery)
  const [search, setSearch] = useState(query.search)
  useEffect(() => setSearch(query.search), [query.search])
  const title = query.scope === 'library' ? '历史底稿' : query.filter === 'starred' ? '收藏' : query.filter === 'unread' ? '未读' : '全部动态'
  return <header className="rss-workspace-heading">
    <div className="rss-workspace-heading-title"><h1>{title}</h1><p role="status">{loading ? '正在读取…' : view ? `${view.total} 条 · ${view.unreadTotal} 条未读` : '尚未读取'}{view && view.items.length < view.total ? ` · 已显示 ${view.items.length} 条` : ''}{view?.lastFetchAt ? ` · 更新于 ${new Date(view.lastFetchAt).toLocaleTimeString()}` : ''}</p></div>
    <form className="rss-search-bar glass-surface-floating" onSubmit={(event) => { event.preventDefault(); setQuery({ search }) }}>
      <select aria-label="搜索范围" value={query.searchIn} onChange={(event) => setQuery({ searchIn: event.target.value as 'title_summary' | 'body', search })}>
        <option value="title_summary">标题与摘要</option><option value="body">已保存正文</option>
      </select>
      <input maxLength={RSS_SEARCH_MAX_LENGTH} aria-label="搜索资讯" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="关键词，回车搜索" />
      {search && <button type="button" aria-label="清除搜索" onClick={() => { setSearch(''); setQuery({ search: '' }) }}><X size={14} /></button>}
      <button type="submit" aria-label="执行搜索"><Search size={16} /></button>
    </form>
    <select className="rss-sort-select" aria-label="资讯排序" value={query.sort} onChange={(event) => setQuery({ sort: event.target.value as 'newest' | 'oldest' })}>
      <option value="newest">最新在前</option><option value="oldest">最早在前</option>
    </select>
    <RSSReferenceButton name="RSS 筛选结果" label="引用当前结果" disabled={loading} reference={view ? { kind: 'query', query: { ...view.query, expectedRevision: view.revision } } : null} />
    <RSSExportButton view={view} disabled={loading} />
  </header>
}
