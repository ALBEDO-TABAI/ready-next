import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useRSSSession } from '../../stores/useRSSSession'
import { RSS_SEARCH_MAX_LENGTH } from '../../../shared/rss-workspace'

// 顶栏里的凹陷搜索槽：回车执行；“正文”开关把范围扩展到已保存正文（不触发抓取）。
export default function RSSSearchField() {
  const query = useRSSSession((state) => state.query)
  const setQuery = useRSSSession((state) => state.setQuery)
  const [search, setSearch] = useState(query.search)
  useEffect(() => setSearch(query.search), [query.search])
  const searchBody = query.searchIn === 'body'
  return <form className="rss-search" role="search" onSubmit={(event) => { event.preventDefault(); setQuery({ search }) }}>
    <button type="submit" className="rss-search__submit" aria-label="执行搜索" title="搜索"><Search size={14} strokeWidth={2} /></button>
    <input maxLength={RSS_SEARCH_MAX_LENGTH} aria-label="搜索资讯" value={search} onChange={(event) => setSearch(event.target.value)}
      placeholder={searchBody ? '搜索标题、摘要与正文' : '搜索资讯'} />
    {search && <button type="button" className="rss-search__clear" aria-label="清除搜索" title="清除" onClick={() => { setSearch(''); setQuery({ search: '' }) }}><X size={13} strokeWidth={2} /></button>}
    <button type="button" className="rss-search__scope" aria-pressed={searchBody} aria-label="同时搜索已保存正文"
      title={searchBody ? '正在搜索标题、摘要与已保存正文；点击只搜标题与摘要' : '只搜标题与摘要；点击同时搜索已保存正文'}
      onClick={() => setQuery({ searchIn: searchBody ? 'title_summary' : 'body', search })}>正文</button>
  </form>
}
