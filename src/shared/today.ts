import type { ReadyRef } from './ready-ref'
import type { TodoEntry } from './calendar-layers'
import type { RSSCalibration } from './rss-sieve'

export interface TodayItem { ref: ReadyRef; title: string }
export interface TodayFirstScreen {
  greeting: { date: string; period: 'morning' | 'afternoon' | 'evening' }
  upcoming: { events: Array<TodayItem & { start: number; end: number; allDay: boolean }>; nextStart: number | null; todos: Array<TodayItem & { todo: TodoEntry }> }
  continue: { pages: Array<TodayItem & { editedAt: number }>; books: Array<TodayItem & { progress: number; updatedAt: number }>; drafts: Array<TodayItem & { updatedAt: number }> }
  collection: { items: TodayItem[]; total: number }
  emergence: Array<TodayItem & { reason: string }>
}
export interface TodaySieve {
  articles: Array<TodayItem & { reason: string; score: number }>
  calibration: (TodayItem & { proposal: RSSCalibration }) | null
}
export interface TodayAPI {
  firstScreen(): Promise<TodayFirstScreen>
  sieve(): Promise<TodaySieve>
}
