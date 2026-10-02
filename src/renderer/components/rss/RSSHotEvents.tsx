import { useEffect, useState } from 'react'
import type { RSSEventSummary } from '../../../shared/rss-events'
import { rankHotEvents } from '../../modules/rss/hot-events'
import { toRSSItem } from '../../modules/rss/workspace-query'
import type { RSSItem } from './RSSFeed'

// 精选页顶部的“当前热点”：多源报道的近期事件。点击打开该事件的代表报道。
export default function RSSHotEvents({ active, onSelect }: { active: boolean; onSelect(item: RSSItem): void }) {
  const [events, setEvents] = useState<RSSEventSummary[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!active) return
    let live = true
    const read = async () => {
      const result = await window.electronAPI.rss.readEvents({ view: 'list', limit: 60 })
      if (!live) return
      if (!result.success || result.data?.view !== 'list') throw new Error(result.error || '热点读取失败')
      setEvents(rankHotEvents(result.data.events, Date.now()))
    }
    const refresh = () => { void read().catch(() => { /* silent-catch: the panel simply stays hidden when events cannot be read. */ if (live) setEvents([]) }) }
    refresh()
    const off = window.electronAPI.rss.onOrganizationChanged(refresh)
    return () => { live = false; off() }
  }, [active])
  if (!events.length) return null
  const open = async (event: RSSEventSummary) => {
    setError('')
    const result = await window.electronAPI.rss.readArticle({ itemId: event.representativeId, length: 1 })
    if (!result.success || !result.data) { setError('这篇报道已变化或删除，请稍后再试。'); return }
    onSelect(toRSSItem(result.data.article))
  }
  return <section className="rss-hot" aria-label="当前热点">
    <header><span className="rss-hot__mark" aria-hidden />当前热点<small>近 48 小时 · 多个来源报道</small></header>
    <ol>
      {events.map((event, index) => <li key={event.id}>
        <span className={`rss-hot__rank${index < 3 ? ' is-top' : ''}`}>{index + 1}</span>
        <button type="button" title={event.title} onClick={() => void open(event)}>{event.title}</button>
        <span className="rss-hot__meta">{event.unseenFactCount > 0 && <i className="rss-hot__new" title={`${event.unseenFactCount} 条新进展`} />}{event.sourceCount} 个来源 · {event.memberCount} 篇</span>
      </li>)}
    </ol>
    {error && <p className="rss-note rss-note--danger" role="alert">{error}</p>}
  </section>
}
