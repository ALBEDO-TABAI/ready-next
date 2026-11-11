import { calendarOccurrenceReadyRef } from '../../../shared/calendar-event-identity'
import type { TodayFirstScreen, TodayItem, TodaySieve } from '../../../shared/today'
import type { CalendarSnapshot } from '../../../shared/calendar/commands'
import { occurrences } from '../../../shared/calendar/model'
import { dayOf, toWall } from '../../../shared/calendar/tz'
import { isoDate } from '../../../shared/calendar/dates'
import type { TodoEntry } from '../../../shared/calendar-layers'
import type { LibraryBook, LibraryReadingPosition } from '../../../shared/library'
import type { DocumentDraft } from '../../../shared/document-drafts'
import type { FastCardItem } from '../../../shared/fastcard'
import type { FileEmergenceSnapshot } from '../../../shared/file-emergence'
import type { RSSCalibration, RSSSieveItem } from '../../../shared/rss-sieve'

/** Narrow read ports deliberately exclude mutation, refresh, model and media-download operations. */
export interface TodaySources {
  calendar(): CalendarSnapshot
  todos(): Promise<TodoEntry[]>
  pages(): Array<TodayItem & { editedAt: number }>
  books(): Promise<Array<{ book: LibraryBook; position: LibraryReadingPosition | null }>>
  drafts(): DocumentDraft[]
  cards(): FastCardItem[]
  emergence(): FileEmergenceSnapshot | null
  sieveToday(): RSSSieveItem[]
  calibration(): RSSCalibration | null
}
export class TodayService {
  constructor(private readonly sources: TodaySources, private readonly now = Date.now) {}
  async firstScreen(): Promise<TodayFirstScreen> {
    const now = this.now(), calendar = this.sources.calendar()
    const zone = typeof calendar.prefs?.primaryTimeZone === 'string' ? calendar.prefs.primaryTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
    const day = dayOf(now, zone), date = isoDate(day), hour = toWall(now, zone).h
    const visible = new Set(calendar.calendars.filter(item => item.visible).map(item => item.id))
    const remaining = occurrences(calendar.events.filter(event => visible.has(event.calendarId)), day, day + 1, zone)
      .filter(item => item.allDay || item.end > now).sort((a, b) => a.start - b.start)
    const events = remaining.slice(0, 3).map(item => ({ ref: calendarOccurrenceReadyRef(item), title: item.event.title, start: item.start, end: item.end, allDay: item.allDay }))
    const [todos, books] = await Promise.all([this.sources.todos(), this.sources.books()])
    const cards = this.sources.cards(), emergence = this.sources.emergence(), seen = new Set<string>()
    return {
      greeting: { date, period: hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening' },
      upcoming: { events, nextStart: remaining.find(event => !event.allDay && event.start >= now)?.start ?? null,
        todos: todos.filter(todo => todo.date && todo.date <= date).sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id)).slice(0, 5).map(todo => ({ ref: todo.page.ref, title: todo.title, todo })) },
      continue: { pages: this.sources.pages().slice(0, 3),
        books: books.filter(({ book }) => book.status === '在读').sort((a, b) => (b.position?.updatedAt ?? 0) - (a.position?.updatedAt ?? 0)).slice(0, 2)
          .map(({ book, position }) => ({ ref: { kind: 'book-location', book: book.id, loc: ['epub', 'txt', 'md'].includes(book.format) ? `c${position?.chapter ?? 0}:${position?.offset ?? 0}+1` : 'c0:0+1' }, title: book.title, progress: position?.pct ?? 0, updatedAt: position?.updatedAt ?? 0 })),
        drafts: this.sources.drafts().filter(draft => ['editing', 'conflict'].includes(draft.state)).sort((a, b) => b.updatedAt - a.updatedAt)
          .map(draft => ({ ref: { kind: 'draft', id: draft.draftId }, title: draft.title || '未保存的草稿', updatedAt: draft.updatedAt })) },
      collection: { total: cards.length, items: [...cards].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3).map(card => ({ ref: { kind: 'fastcard', id: card.id }, title: card.title || card.text?.slice(0, 60) || '收集' })) },
      emergence: emergence?.enabled ? emergence.buckets.today.flatMap(project => project.files).filter(file => {
        if (!file.fileKey || seen.has(file.fileKey) || emergence.suppressedFilePaths?.includes(file.path)) return false
        seen.add(file.fileKey); return true
      }).slice(0, 5).map(file => ({ ref: { kind: 'file', id: file.fileKey! }, title: file.name, reason: file.reason })) : [],
    }
  }
  async sieve(): Promise<TodaySieve> {
    const proposal = this.sources.calibration()
    return { articles: [...this.sources.sieveToday()].sort((a, b) => b.sieve.score - a.sieve.score).slice(0, 5)
      .map(item => ({ ref: { kind: 'rss-item', id: item.id }, title: item.title, reason: item.sieve.reason, score: item.sieve.score })),
    calibration: proposal?.status === 'pending' ? { ref: { kind: 'rss-calibration', id: proposal.week }, title: '筛子校准', proposal } : null }
  }
}
