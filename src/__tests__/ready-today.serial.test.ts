import { findCalendarOccurrence } from '../shared/calendar/commands'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { TodayService } from '../main/modules/today/service'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { CalendarLayersService } from '../main/modules/calendar-layers/service'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { RSSStore } from '../main/modules/database/rss-store'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { LibraryReadingRepository } from '../main/modules/library-engine/reading-repository'
import { sourceNoteContent } from '../main/modules/library-engine/source-note'
import { ReadyRefSchema } from '../shared/ready-ref'
import type { FileEmergenceSnapshot } from '../shared/file-emergence'

const now = new Date('2026-11-12T10:00:00+09:00').getTime()
const disk = (root: string): unknown => readdirSync(root, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? disk(join(root, entry.name)) : readFileSync(join(root, entry.name)).toString('base64')])
for (const populated of [false, true]) {
test(`Today ${populated ? 'populated' : 'empty'} vault reads existing owners without writes and first screen <150ms`, async t => {
  if (skipIfSqliteUnavailable(t, 'today read-only aggregation')) return
  const f = fixture(); t.after(() => f.close())
  const forbidden = async () => { throw new Error('Today must not write or index') }
  const pages = new DocumentPageService(f.registry, { index: forbidden })
  const database = new DocumentDatabaseService(f.root, f.registry, pages, { index: forbidden })
  const layers = new CalendarLayersService(f.root, f.registry, database, { index: forbidden }, pages)
  const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: forbidden })
  const cards = new FastCardRepository(f.db), calendar = new CalendarStore(() => f.db), rss = new RSSStore(() => f.db)
  const library = new LibraryEngine({ vault: () => ({ status: 'ready', root: f.root }), write: forbidden })
  const reading = new LibraryReadingRepository(f.db)
  let snapshot: FileEmergenceSnapshot | null = null
  if (populated) {
    for (let i = 0; i < 20; i++) {
      const path = join(f.root, `页面${i}.md`)
      writeFileSync(path, `---\nready_id: page-${i}\n---\n- [ ] 今天 ${i} 📅 2026-11-12\n- [ ] 过期 📅 2026-11-11\n- [ ] 未来 📅 2026-11-13\n- [x] 完成 📅 2026-11-12\n`); f.registry.register(path)
    }
    mkdirSync(join(f.root, '阅读')); writeFileSync(join(f.root, '阅读', 'book.txt'), '书正文')
    writeFileSync(join(f.root, '阅读', '书.md'), sourceNoteContent({ ready_id: 'book', 类型: '书', title: '书', 作者: '作者', 分类: 'unsorted', tags: [], 状态: '在读', 文件: 'book.txt', 加入: '2026-11-12', 来源: { kind: 'local' } }))
    reading.setPosition({ bookId: 'book', chapter: 2, offset: 30, pct: .4, updatedAt: now })
    writeFileSync(join(f.root, '阅读', 'paper.pdf'), '%PDF-1.7\nfixture')
    writeFileSync(join(f.root, '阅读', '论文.md'), sourceNoteContent({ ready_id: 'paper', 类型: '书', title: '论文', 作者: '作者', 分类: 'unsorted', tags: [], 状态: '在读', 文件: 'paper.pdf', 加入: '2026-11-12', 来源: { kind: 'local' } }))
    reading.setPosition({ bookId: 'paper', chapter: 3, offset: 20, pct: .5, updatedAt: now - 1 })
    drafts.create({ origin: 'new', vaultRoot: f.root, tabId: 'draft-tab', title: '未完成', content: '正文' })
    for (let i = 0; i < 5; i++) cards.add({ id: `card-${i}`, kind: 'image', imageUrl: 'https://must-not-download.test/a.png', title: `收集${i}`, createdAt: i })
    calendar.putCalendar({ id: 'local', name: '本地', color: '#123456', visible: true, primary: true, readOnly: false, order: 0 })
    calendar.savePreferences({ primaryTimeZone: 'Asia/Tokyo' })
    for (let i = 0; i < 5; i++) calendar.mutate({ type: 'create', event: { id: `event-${i}`, uid: `event-${i}`, status: 'confirmed', transparency: 'opaque', createdAt: now, updatedAt: now, calendarId: 'local', title: `日程${i}`, start: now + (i + 1) * 3600000, end: now + (i + 2) * 3600000, allDay: false } }, {})
    for (let i = 0; i < 3; i++) calendar.mutate({ type: 'create', event: { id: `ongoing-${i}`, uid: `ongoing-${i}`, calendarId: 'local', title: '进行中', status: 'confirmed', transparency: 'opaque', createdAt: now, updatedAt: now, start: now - (i + 1) * 3600000, end: now + 1800000, allDay: false } }, {})
    const id = f.registry.find(join(f.root, '页面0.md'))!.id
    snapshot = { enabled: true, workspaceRoots: [f.root], generatedAt: now, buckets: { future: [], past: [], distant: [], today: [{ id: 'project', bucket: 'today', title: '今天', rawLabels: [], anchorType: 'document', titleSource: 'rule_refined', score: 1, confidence: 'high', updatedAt: now, evidence: [], files: [{ fileKey: id, path: join(f.root, '页面0.md'), name: '页面0', kind: 'document', score: 1, reason: '今天编辑' }] }] } }
    const source = rss.addRSSSource({ name: '来源', url: 'https://example.test/feed' })
    for (let i = 0; i < 6; i++) {
      const id = `article-${i}`
      rss.upsertRSSItems([{ id, source_id: source, guid: id, title: `新消息${i}`, link: `https://example.test/${id}`, summary: '摘要', published_at: now / 1000 - i }])
      rss.organization.setManual({ itemId: id, expectedArticleRevision: rss.content.getArticle(id)!.revision, definitionId: 'curated', expectedRuleRevision: 1, decision: true })
    }
    const proposal = rss.learning.queue(now)!
    f.db.prepare("UPDATE rss_calibrations SET status='pending',text='关注新书',explanation='最近阅读' WHERE week=?").run(proposal.week)
  }
  const service = new TodayService({ calendar: () => calendar.snapshot(), todos: async () => layers.listTodos(), pages: () => pages.recentEdited(f.root),
    books: async () => { const state = await library.readOnly(); return state.status === 'ready' ? state.books.map(book => ({ book, position: reading.getPosition(book.id) })) : [] },
    drafts: () => drafts.list(f.root), cards: () => cards.list(), emergence: () => snapshot, sieveToday: () => rss.sieve.today(now, false), calibration: () => rss.learning.calibration(now),
  }, () => now)
  const beforeDB = f.db.serialize(), beforeDisk = disk(f.root)
  f.db.pragma('query_only = ON')
  const start = performance.now(), first = await service.firstScreen(), elapsed = performance.now() - start
  t.diagnostic(`first screen ${populated ? 'populated' : 'empty'}: ${elapsed.toFixed(2)}ms`)
  assert.ok(elapsed < 150, `${elapsed}ms exceeds 150ms`)
  const sieve = await service.sieve()
  assert.deepEqual(f.db.serialize(), beforeDB); assert.deepEqual(disk(f.root), beforeDisk)
  assert.equal(first.greeting.date, '2026-11-12')
  if (!populated) {
    assert.deepEqual(first.upcoming, { events: [], nextStart: null, todos: [] })
    assert.deepEqual(first.continue, { pages: [], books: [], drafts: [] })
    assert.deepEqual(first.collection, { items: [], total: 0 }); assert.deepEqual(first.emergence, [])
    assert.deepEqual(sieve, { articles: [], calibration: null })
  } else {
    for (const item of first.upcoming.events) {
      assert.equal(item.ref.kind, 'event')
      if (item.ref.kind === 'event') assert.ok(findCalendarOccurrence(calendar.snapshot().events, item.ref.occurrence === undefined ? item.ref.id : `${item.ref.id}|${item.ref.occurrence}`), 'today event opens the actual occurrence')
    }
    assert.equal(first.upcoming.events.length, 3); assert.equal(first.upcoming.nextStart, now + 3600000)
    assert.equal(first.upcoming.todos.length, 5); assert.ok(first.upcoming.todos.every(item => item.todo.date === '2026-11-11'))
    assert.equal(first.continue.pages.length, 3); assert.equal(first.continue.books[0].progress, .4);
    assert.deepEqual(first.continue.books[1].ref, { kind: 'book-location', book: 'paper', loc: 'c0:0+1' }, 'non-paragraph readers reopen through their supported file entry'); assert.equal(first.continue.drafts.length, 1)
    assert.deepEqual(first.collection.items.map(item => item.title), ['收集4', '收集3', '收集2']); assert.equal(first.collection.total, 5)
    assert.equal(first.emergence.length, 1)
    assert.equal(sieve.articles.length, 5); assert.ok(sieve.articles.every(item => item.reason.length > 0))
    assert.equal(sieve.calibration?.proposal.status, 'pending'); ReadyRefSchema.parse(sieve.calibration?.ref)
  }
  for (const item of [...first.upcoming.events, ...first.upcoming.todos, ...first.continue.pages, ...first.continue.books, ...first.continue.drafts, ...first.collection.items, ...first.emergence, ...sieve.articles]) ReadyRefSchema.parse(item.ref)
})

}
