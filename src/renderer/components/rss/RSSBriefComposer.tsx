import { useEffect, useMemo, useState } from 'react'
import type { RSSDefinition } from '../../../shared/rss-organization'
import type { RSSQueryInput } from '../../../shared/rss-workspace'

const DAY = 86_400_000
const WINDOWS = [
  { id: 'day', label: '近 24 小时', ms: DAY }, { id: 'three', label: '近 3 天', ms: 3 * DAY }, { id: 'week', label: '近 7 天', ms: 7 * DAY },
  { id: 'month', label: '近 30 天', ms: 30 * DAY }, { id: 'all', label: '不限', ms: null },
] as const
type RSSBriefWindow = typeof WINDOWS[number]['id']

/** The brief's query: a column, optional topic/source/keyword and a rolling time window ending now. */
export function rssBriefQuery(input: { collectionId: string; categoryId: string; sourceId: string; search: string; searchIn: RSSQueryInput['searchIn']; window: RSSBriefWindow }, now: number): RSSQueryInput {
  const ms = WINDOWS.find((entry) => entry.id === input.window)!.ms
  return {
    scope: 'inbox', filter: 'all', collectionId: input.collectionId, searchIn: input.searchIn,
    ...(input.categoryId ? { categoryId: input.categoryId } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.search.trim() ? { search: input.search.trim() } : {}), ...(ms ? { from: now - ms } : {}),
  }
}

// 新建简报：从资讯流当前看到的范围出发，可改栏目、分类、来源、时间与关键词，并实时显示命中篇数。
export default function RSSBriefComposer({ definitions, sources, initial, busy, error, onCancel, onGenerate }: {
  definitions: RSSDefinition[]; sources: Array<{ id: string; name: string }>; initial: RSSQueryInput | null; busy: boolean; error: string
  onCancel(): void; onGenerate(query: RSSQueryInput): void
}) {
  const columns = definitions.filter((definition) => definition.kind !== 'topic' || definition.visible)
  const topics = definitions.filter((definition) => definition.kind === 'topic')
  const fallback = definitions.find((definition) => definition.kind === 'all')?.id || columns[0]?.id || ''
  const [collectionId, setCollectionId] = useState(() => initial?.collectionId && definitions.some((d) => d.id === initial.collectionId) ? initial.collectionId : fallback)
  const [categoryId, setCategoryId] = useState(() => initial?.categoryId && topics.some((d) => d.id === initial.categoryId) ? initial.categoryId : '')
  const [sourceId, setSourceId] = useState(() => initial?.sourceId && sources.some((s) => s.id === initial.sourceId) ? initial.sourceId : '')
  const [search, setSearch] = useState(initial?.search || '')
  const [period, setPeriod] = useState<RSSBriefWindow>('all')
  const [count, setCount] = useState<{ total: number } | { error: string } | null>(null)
  const searchIn = initial?.searchIn || 'title_summary'
  const fields = useMemo(() => ({ collectionId, categoryId, sourceId, search, searchIn, window: period }), [collectionId, categoryId, sourceId, search, searchIn, period])
  useEffect(() => {
    let live = true
    setCount(null)
    const timer = setTimeout(() => {
      void window.electronAPI.rss.queryCards({ ...rssBriefQuery(fields, Date.now()), limit: 1 }).then((result) => {
        if (!live) return
        setCount(result.success && result.data ? { total: result.data.total } : { error: result.error || '无法读取这个范围' })
      }).catch((cause) => { if (live) setCount({ error: cause instanceof Error ? cause.message : String(cause) }) })
    }, 220)
    return () => { live = false; clearTimeout(timer) }
  }, [fields])
  const empty = count !== null && 'total' in count && count.total === 0
  return <form className="rss-brief" aria-label="新建简报" onSubmit={(event) => { event.preventDefault(); onGenerate(rssBriefQuery(fields, Date.now())) }}>
    <header>
      <h1>新建简报</h1>
      <p>选择要汇总的资讯范围。简报只整理已保存的资讯与原文摘句，不会调用模型。</p>
    </header>
    <div className="rss-brief__row">
      <label htmlFor="rss-brief-column">栏目</label>
      <select id="rss-brief-column" className="sx-select" value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
        {columns.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
      </select>
    </div>
    {topics.length > 0 && <div className="rss-brief__row">
      <span id="rss-brief-topic">分类</span>
      <div className="rss-brief__chips" role="radiogroup" aria-labelledby="rss-brief-topic">
        {[{ id: '', name: '不限' }, ...topics].map((topic) => <button type="button" role="radio" key={topic.id || 'any'} aria-checked={categoryId === topic.id} onClick={() => setCategoryId(topic.id)}>{topic.name}</button>)}
      </div>
    </div>}
    <div className="rss-brief__row">
      <label htmlFor="rss-brief-source">来源</label>
      <select id="rss-brief-source" className="sx-select" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
        <option value="">全部来源</option>
        {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select>
    </div>
    <div className="rss-brief__row">
      <span id="rss-brief-window">时间</span>
      <div className="sx-seg" role="radiogroup" aria-labelledby="rss-brief-window">
        {WINDOWS.map((entry) => <button type="button" role="radio" key={entry.id} className="sx-seg__item" aria-checked={period === entry.id} onClick={() => setPeriod(entry.id)}>{entry.label}</button>)}
      </div>
    </div>
    <div className="rss-brief__row">
      <label htmlFor="rss-brief-search">关键词</label>
      <input id="rss-brief-search" className="sx-input" value={search} maxLength={200} placeholder={searchIn === 'body' ? '标题、摘要与已保存正文' : '标题与摘要'} onChange={(event) => setSearch(event.target.value)} />
    </div>
    <footer>
      <p role="status">{count === null ? '正在统计…' : 'error' in count ? count.error : count.total ? `共 ${count.total} 篇资讯，按栏目分节汇总` : '这个范围里还没有资讯'}</p>
      <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="sx-btn sx-btn--primary sx-btn--sm" disabled={busy || count === null || 'error' in count || empty}>生成简报</button>
    </footer>
    {error && <p className="rss-note rss-note--danger" role="alert">{error}</p>}
  </form>
}
