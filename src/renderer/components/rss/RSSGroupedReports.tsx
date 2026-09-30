import { useEffect, useRef, useState } from 'react'
import type { RSSArticleSummary, RSSQueryInput, RSSQueryResult } from '../../../shared/rss-workspace'
import { toRSSItem } from '../../modules/rss/workspace-query'
import type { RSSItem } from './RSSFeed'

export default function RSSGroupedReports({ group, query, revision, active, onSelect }: {
  group: NonNullable<RSSArticleSummary['eventGroup']>; query: RSSQueryInput; revision: number; active: boolean; onSelect(item: RSSItem): void
}) {
  const [open, setOpen] = useState(false), [result, setResult] = useState<RSSQueryResult | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const key = JSON.stringify([group.id, query, revision]), identity = useRef(key), generation = useRef(0)
  identity.current = key
  const load = async (more = false) => {
    const ticket = ++generation.current, currentKey = key
    setLoading(true); setError('')
    try {
      const response = await window.electronAPI.rss.queryItems({ ...query, eventId: group.id, limit: 20, cursor: more ? result?.nextCursor || undefined : undefined, expectedRevision: revision })
      if (identity.current !== currentKey || ticket !== generation.current) return
      if (!response.success || !response.data) throw new Error(response.error || '关联报道读取失败')
      const data = response.data
      setResult((previous) => ({ ...data, items: more && previous ? [...previous.items, ...data.items] : data.items }))
    } catch (reason) { if (identity.current === currentKey && ticket === generation.current) setError(reason instanceof Error && /cursor/.test(reason.message) ? '范围已变化，请重新读取资讯列表。' : '关联报道读取失败，请重试。') }
    finally { if (identity.current === currentKey && ticket === generation.current) setLoading(false) }
  }
  useEffect(() => {
    setResult(null); setError('')
    if (open && active) void load()
    return () => { ++generation.current }
  }, [key, open, active])
  return <div className="rss-grouped-reports" onClick={(event) => event.stopPropagation()}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>同一事件 · 本范围 {group.matchingCount} 篇 / 全事件 {group.memberCount} 篇 · {group.sourceCount} 个信源 · {group.factCount} 个事实与进展 · {group.matchingUnread} 篇未读{group.matchingStarred ? ` · ${group.matchingStarred} 篇收藏` : ''} {open ? '收起' : '展开'}</button>
    {group.staleCount > 0 && <small>部分关联依据已变化，详情中会标明。</small>}
    {group.unseenFactCount > 0 && <strong>有 {group.unseenFactCount} 个新整理的事实或进展待查看</strong>}
    {open && <ul>{result?.items.map((item) => <li key={item.id}>
      <button type="button" onClick={() => onSelect(toRSSItem(item))}>{item.title}</button>
      <small>{item.source} · {item.read ? '已读' : '未读'}{item.event?.relation === 'progress' ? ' · 后续进展' : ''}{item.event?.relation === 'duplicate' ? ' · 同事实报道' : ''}</small>
    </li>)}</ul>}
    {open && error && <p role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
    {open && loading && <small>正在读取…</small>}
    {open && result?.nextCursor && <button type="button" disabled={loading} onClick={() => void load(true)}>更多关联报道</button>}
  </div>
}
