import type { TodayFirstScreen, TodaySieve } from '../../../shared/today'

// Words and times on 今日 (W6 §5.2). Pure functions: the page passes in "now", so the tests can too.

const GREETINGS: Record<TodayFirstScreen['greeting']['period'], string> = { morning: '早上好', afternoon: '下午好', evening: '晚上好' }
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export const greetingText = (period: TodayFirstScreen['greeting']['period']) => GREETINGS[period]

/** "11 月 12 日 星期四" from the calendar's own date (its time zone decided which day it is). */
export function dateLine(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${month} 月 ${day} 日 星期${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`
}

const clock = (at: number) => { const time = new Date(at); return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}` }

function untilText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes <= 1) return '马上开始'
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分后` : `${hours} 小时后`
}

/** The time column of an event: 全天, 进行中, the countdown for the next one, or its start. `now` marks the signal. */
export function eventTime(event: { start: number; end: number; allDay: boolean }, nextStart: number | null, now: number): { text: string; now: boolean } {
  if (event.allDay) return { text: '全天', now: false }
  if (event.start <= now && now < event.end) return { text: '进行中', now: true }
  if (event.start === nextStart) return { text: untilText(event.start - now), now: true }
  return { text: clock(event.start), now: false }
}

/** "11月10日" for a to-do whose date has passed; nothing for today's. */
export function overdueText(date: string | null, today: string): string {
  if (!date || date >= today) return ''
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`
}

/** "刚刚编辑", "3 小时前编辑", "昨天编辑", "11月3日编辑". */
export function editedText(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return '刚刚编辑'
  if (minutes < 60) return `${minutes} 分钟前编辑`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前编辑`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天编辑'
  if (days < 7) return `${days} 天前编辑`
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日编辑`
}

export const progressText = (progress: number) => `读到 ${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`

/** A file's name without its extension (a page's or board's title never has one). */
export const fileTitle = (name: string) => name.replace(/\.[^./\\\s]{1,8}$/, '') || name

export type TodayBlock = 'upcoming' | 'sieve' | 'continue' | 'collection' | 'emergence'

/** The blocks that have something to show (§5.2: an empty block shows neither its title nor its shell). The 资讯 block
 *  counts while it is still loading, so its placeholder holds the place; it leaves once it answers empty. */
export function visibleBlocks(first: TodayFirstScreen, sieve: TodaySieve | 'loading' | null): TodayBlock[] {
  const blocks: TodayBlock[] = []
  if (first.upcoming.events.length || first.upcoming.todos.length) blocks.push('upcoming')
  if (sieve === 'loading' || (sieve && (sieve.articles.length || sieve.calibration))) blocks.push('sieve')
  if (first.continue.pages.length || first.continue.books.length || first.continue.drafts.length) blocks.push('continue')
  if (first.collection.items.length) blocks.push('collection')
  if (first.emergence.length) blocks.push('emergence')
  return blocks
}
