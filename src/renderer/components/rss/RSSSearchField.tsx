import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useRSSSession } from '../../stores/useRSSSession'
import { RSS_SEARCH_MAX_LENGTH } from '../../../shared/rss-workspace'
import { IconButton } from '../ui/Button'
import { Input } from '../ui/Field'
import { Chip } from '../ui/Display'

// 顶栏里的搜索：共享输入框（W1 §5），回车执行；“正文”开关把范围扩展到已保存正文（不触发抓取）。
export default function RSSSearchField() {
  const query = useRSSSession((state) => state.query)
  const setQuery = useRSSSession((state) => state.setQuery)
  const [search, setSearch] = useState(query.search)
  useEffect(() => setSearch(query.search), [query.search])
  const searchBody = query.searchIn === 'body'
  return <form className="rss-search" role="search" onSubmit={(event) => { event.preventDefault(); setQuery({ search }) }}>
    <Input className="rss-search__input" maxLength={RSS_SEARCH_MAX_LENGTH} aria-label="搜索资讯" value={search} onChange={(event) => setSearch(event.target.value)}
      placeholder={searchBody ? '搜索标题、摘要与正文' : '搜索资讯'} />
    <IconButton type="submit" size="sm" className="rss-search__submit" title="执行搜索" icon={<Search />} />
    <span className="rss-search__end">
      {search && <IconButton size="sm" title="清除搜索" icon={<X />} onClick={() => { setSearch(''); setQuery({ search: '' }) }} />}
      <Chip aria-pressed={searchBody} aria-label="同时搜索已保存正文"
        title={searchBody ? '正在搜索标题、摘要与已保存正文；点击只搜标题与摘要' : '只搜标题与摘要；点击同时搜索已保存正文'}
        onClick={() => setQuery({ searchIn: searchBody ? 'title_summary' : 'body', search })}>正文</Chip>
    </span>
  </form>
}
