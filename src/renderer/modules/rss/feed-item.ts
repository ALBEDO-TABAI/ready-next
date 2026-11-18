import type { DragEvent } from 'react'
import type { RSSItem } from '../../components/rss/RSSFeed'
import { endRssItemDragSession, setRssItemDragPayload } from '../../components/layout/fileTreeExternalDrop'

// What a feed item says about itself, shared by its two layouts (列表 rows and 图册 covers).

const WEEKDAYS = '日一二三四五六'

export function itemTimestamp(entry: RSSItem): number | null {
  return entry.eventGroup?.displayTime ?? entry.publishedAtMs ?? entry.collectedAt ?? null
}

export function dayKey(timestamp: number | null): string {
  return timestamp == null ? 'unknown' : new Date(timestamp).toDateString()
}

// 日期在前，“今天 / 昨天”与星期作补充，像报纸的日期栏。
export function dayHeading(timestamp: number | null): { main: string; detail: string } {
  if (timestamp == null) return { main: '时间未提供', detail: '' }
  const date = new Date(timestamp)
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const offset = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`
  const weekday = `星期${WEEKDAYS[date.getDay()]}`
  return { main: day, detail: offset === 0 ? `今天 · ${weekday}` : offset === 1 ? `昨天 · ${weekday}` : weekday }
}

export function cardTimeLabel(item: RSSItem): string {
  const format = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  if (item.publishedAtMs != null) return format(item.publishedAtMs)
  if (item.publishedAt) return item.publishedAt
  return item.collectedAt ? format(item.collectedAt) : ''
}

/** An item can be dragged out (to the assistant, a board, a page) from either layout. */
export function itemDragHandlers(item: RSSItem) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      setRssItemDragPayload(event, { id: item.id, title: item.title, link: item.link, summary: item.summary, source: item.source, publishedAt: item.publishedAt })
      event.stopPropagation()
    },
    onDragEnd: () => endRssItemDragSession(),
  }
}

/** Words that stand where a cover would be: the item's own summary, or the site it links to when it has none worth showing. */
export function coverWords(item: Pick<RSSItem, 'summary' | 'title' | 'link'>): { text: string; site: boolean } {
  const summary = item.summary.trim()
  if (summary.length >= 12 && summary !== item.title.trim()) return { text: summary, site: false }
  try { return { text: new URL(item.link).hostname.replace(/^www\./, ''), site: true } }
  catch {
    // silent-catch: an item without a usable address shows its title instead.
    return { text: item.title, site: false }
  }
}
