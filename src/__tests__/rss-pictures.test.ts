import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { IpcMain } from 'electron'
import { setImmediate } from 'node:timers/promises'
import { DatabaseManager } from '../main/modules/database'
import { __getMigrationNamesForTests, __runMigrationForTests, runMigrations } from '../main/modules/migrations'
import { RSSReferenceSchema, rssReferencePath } from '../shared/rss-reference'
import { RSSPictureService, RSS_PICTURE_RETRY_AFTER_MS, RSS_PICTURE_URL_MAX } from '../main/modules/rss-engine/picture-service'
import { picturesGroup } from '../main/modules/rss-engine/ipc/pictures-group'
import { digestGroup } from '../main/modules/rss-engine/ipc/digest-group'
import { contentGroup } from '../main/modules/rss-engine/ipc/content-group'
import { sieveGroup } from '../main/modules/rss-engine/ipc/sieve-group'
import { WeiboScraper } from '../main/modules/rss-engine/scrapers/rsshub'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t: TestContext) {
  const db = new DatabaseManager(true), rss = db.rss
  let now = Date.now()
  rss.processing.configure({ enabled: true, dailyLimit: 100 })
  const source = rss.addRSSSource({ name: 'Publisher', url: 'https://feed.test/rss' })
  rss.setRSSSourceDraftSeeded(source, true)
  t.after(() => db.close())
  const put = (id: string, options: { link?: string; cover?: string; sourceId?: string; published?: number | null } = {}) => rss.upsertRSSItems([{
    id, source_id: options.sourceId ?? source, guid: id, title: id, summary: 'The release supports editing.',
    link: options.link ?? `https://${id}.test/article`, cover_image: options.cover, published_at: options.published === undefined ? now / 1000 : options.published,
  }])
  const makeService = (preview: (url: string) => Promise<{ imageUrl?: string }>, extra: Partial<ConstructorParameters<typeof RSSPictureService>[0]> = {}) => {
    const service = new RSSPictureService({ store: rss.pictures, preview, now: () => now, sleep: async ms => { now += ms }, ...extra })
    t.after(async () => { service.dispose(); await service.idle() })
    return service
  }
  return { db, rss, source, put, makeService, now: () => now, advance: (ms: number) => { now += ms } }
}

function ipcFixture() {
  const handlers = new Map<string, (_event: unknown, input: unknown) => unknown>()
  const ipc = {
    handle: (channel: string, handler: (_event: unknown, input: unknown) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain
  const invoke = async (channel: string, input: unknown) => {
    const handler = handlers.get(channel)
    assert.ok(handler, `${channel} is registered`)
    return await handler({}, input)
  }
  return { ipc, invoke, handlers }
}

test('migration 162 creates the picture table, runs once and cascades item deletion', t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), raw = f.db.getRawDb()!
  assert.equal(__getMigrationNamesForTests().at(-1), '162_rss_item_pictures')
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rss_item_pictures'").get())
  assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='rss_item_pictures'").all(), [])
  runMigrations(raw)
  f.put('one')
  f.rss.pictures.save({ itemId: 'one', link: 'https://one.test/article', outcome: 'page', pictureUrl: 'https://images.test/one', now: f.now() })
  raw.prepare('DELETE FROM rss_items WHERE id=?').run('one')
  assert.deepEqual(raw.prepare('SELECT * FROM rss_item_pictures').all(), [])
})

test('an upgrade preserves valid saved RSS references before the later picture migration runs', t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), raw = f.db.getRawDb()!
  f.put('one')
  const expectedRevision = f.rss.content.getArticle('one')!.revision
  const references = [
    RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'one', expectedRevision, offset: 0, length: 5 } }),
    RSSReferenceSchema.parse({ kind: 'excerpt', read: { format: 'reading-v1', itemId: 'one', expectedRevision, range: { start: { run: 0, offset: 0 }, end: { run: 0, offset: 5 } } } }),
    RSSReferenceSchema.parse({ kind: 'query', query: { expectedRevision: f.rss.content.query().revision } }),
  ]
  raw.exec("INSERT INTO chat_conversations(id,agent,title,created_at,updated_at,source_id) VALUES('old','ready','Old','now','now','old')")
  raw.prepare("INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,meta_json,message_visibility_epoch) VALUES('old-message','old','user','Saved reference','now',?,0)")
    .run(JSON.stringify({ attachments: references.map((reference, index) => ({ id: `rss-${index}`, name: 'RSS', source: 'rss-reference', path: `rss-reference://${encodeURIComponent(JSON.stringify(reference))}`, rssReference: reference })) }))
  raw.exec('DROP TABLE rss_item_pictures')
  __runMigrationForTests('145_chat_ready_refs', raw)
  const metadata = raw.prepare('SELECT meta_json FROM chat_messages WHERE id=?').get<{ meta_json: string }>('old-message')!
  assert.deepEqual(JSON.parse(metadata.meta_json).attachments.map((a: { path: string }) => a.path), references.map(rssReferencePath))
})

test('saving a page picture leaves the article, its body, the jobs and the workspace as they were; the stores\' reads do not change and the app\'s lists gain the cover', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), raw = f.db.getRawDb()!
  f.put('one')
  const claim = f.rss.content.beginLoad('one')!
  f.rss.content.finishLoad(claim, { status: 'ready', markdown: 'Saved article body.', sourceUrl: 'https://one.test/article' })
  const snapshot = () => ({
    item: raw.prepare('SELECT * FROM rss_items WHERE id=?').get('one'),
    body: raw.prepare('SELECT * FROM rss_article_content WHERE item_id=?').get('one'),
    jobs: raw.prepare('SELECT COUNT(*) AS n FROM rss_processing_jobs').get(),
    workspace: raw.prepare('SELECT revision FROM rss_workspace_state').get(),
  })
  const before = snapshot(), article = f.rss.content.getArticle('one')!
  assert.ok(f.rss.processing.list().total > 0)
  const picture = 'https://images.test/one.jpg'
  f.rss.pictures.save({ itemId: 'one', link: article.link, outcome: 'page', pictureUrl: picture, now: f.now() })
  assert.deepEqual(snapshot(), before)
  // The stores' own reads do not know the page picture: what the assistant's tools and the migrations read is as before.
  assert.deepEqual(f.rss.content.getArticle('one'), article)
  assert.equal(f.rss.content.query().items[0].coverImage, null)
  assert.equal(f.rss.content.cards().items[0].coverImage, null)
  assert.equal(f.rss.sieve.query({ threshold: 0 }, f.now()).remaining[0].coverImage, null)
  assert.equal(f.rss.pictures.covers(['one']).get('one'), picture)
  // The lists the app shows carry it (P5): feed items, feed cards and the sieve, through their IPC.
  const { ipc, invoke } = ipcFixture()
  const content = contentGroup.register(ipc, { useMock: false, getContent: () => f.rss.content, getPictures: () => f.rss.pictures,
    getLoader: () => { throw new Error('not used') }, getTranslator: () => { throw new Error('not used') } })
  const sieve = sieveGroup.register(ipc, { store: () => f.rss.sieve, pictures: () => f.rss.pictures, workContext: () => ({ text: '', entries: [] }), notify: () => {} })
  t.after(() => { content.dispose(); sieve.dispose() })
  const shown = async () => {
    const items = await invoke('rss:queryItems', {}) as { data: { items: Array<{ coverImage: string | null }> } }
    const cards = await invoke('rss:queryCards', {}) as { data: { items: Array<{ coverImage: string | null }> } }
    const ranked = await invoke('rss:sieveQuery', { threshold: 0 }) as { data: { items: Array<{ coverImage: string | null }>; remaining: Array<{ coverImage: string | null }> } }
    return [items.data.items[0].coverImage, cards.data.items[0].coverImage, ...ranked.data.items.map(item => item.coverImage)]
  }
  assert.deepEqual([...new Set(await shown())], [picture])
  f.put('one', { cover: 'https://feed.test/cover' })
  assert.deepEqual([...new Set(await shown())], ['https://feed.test/cover'], 'a feed cover wins over the page picture')
  for (const item of [f.rss.content.query().items[0], f.rss.content.cards().items[0], f.rss.content.getArticle('one')!]) assert.equal(item.coverImage, 'https://feed.test/cover')
  assert.equal(f.rss.pictures.covers(['one']).get('one'), 'https://feed.test/cover')
  f.put('one', { cover: undefined, link: 'https://one.test/changed' })
  assert.equal(f.rss.pictures.describe(['one'])[0].picture, null)
  assert.equal(f.rss.pictures.covers(['one']).get('one'), null)
  assert.deepEqual([...new Set(await shown())], [null], 'a picture kept for an older address no longer counts')
  f.rss.pictures.save({ itemId: 'one', link: 'https://one.test/changed', outcome: 'none', pictureUrl: null, now: f.now() })
  assert.equal(f.rss.pictures.describe(['one'])[0].picture?.attempts, 1)
})

test('store describes current sources and chooses only eligible items in newest order, including the retry boundary', t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t)
  for (const [index, id] of ['old', 'page', 'none', 'recent', 'exhausted', 'due', 'changed', 'new', 'feed'].entries()) f.put(id, { published: index + 1, ...(id === 'feed' ? { cover: 'https://feed.test/cover' } : {}) })
  for (const id of ['page', 'none', 'recent', 'exhausted', 'due', 'changed']) f.rss.pictures.save({
    itemId: id, link: `https://${id}.test/article`, outcome: id === 'page' ? 'page' : id === 'none' ? 'none' : 'failed',
    pictureUrl: id === 'page' ? 'https://images.test/page' : null, now: f.now() - RSS_PICTURE_RETRY_AFTER_MS,
  })
  f.rss.pictures.save({ itemId: 'recent', link: 'https://recent.test/article', outcome: 'failed', pictureUrl: null, now: f.now() - RSS_PICTURE_RETRY_AFTER_MS + 1 })
  f.rss.pictures.save({ itemId: 'exhausted', link: 'https://exhausted.test/article', outcome: 'failed', pictureUrl: null, now: f.now() - RSS_PICTURE_RETRY_AFTER_MS })
  f.put('changed', { link: 'https://changed.test/new', published: 7 })
  assert.deepEqual(f.rss.pictures.candidates(24, f.now()), ['new', 'changed', 'due', 'old'])
  assert.deepEqual(f.rss.pictures.candidates(2, f.now()), ['new', 'changed'])
  assert.deepEqual(f.rss.pictures.describe(['missing', 'old'])[0], { itemId: 'old', link: 'https://old.test/article', feedCover: null, source: { url: 'https://feed.test/rss', platform: 'rss' }, picture: null })
  assert.deepEqual(f.rss.pictures.describe([]), [])
  assert.deepEqual(f.rss.pictures.covers([]), new Map())
})

test('lookup returns all states in input order, preserves feed priority and skips session and unsafe pages without saving', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), calls: string[] = []
  f.put('feed', { cover: 'http://feed.test/image' })
  f.put('page'); f.put('none'); f.put('failed')
  const skipIds: string[] = []
  for (const [index, link] of ['file:///etc/passwd', '/relative', 'http://localhost/x', 'https://192.168.1.2/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://user:pass@site.test/x'].entries()) {
    const id = `unsafe-${index}`; skipIds.push(id); f.put(id, { link })
  }
  for (const [index, [url, platform]] of [
    ['https://space.bilibili.com/1', 'rss'], ['https://www.xiaohongshu.com/user/profile/1', 'rss'],
    ['https://weibo.com/u/1', 'rss'], ['https://www.douyin.com/user/1', 'rss'], ['https://feed.test/session', 'weibo'],
  ].entries()) {
    const id = `session-${index}`, sourceId = f.rss.addRSSSource({ name: id, url, platform })
    skipIds.push(id); f.put(id, { sourceId })
  }
  const service = f.makeService(async url => {
    calls.push(url)
    if (url.includes('failed.test')) throw new Error('preview unavailable')
    return url.includes('page.test') ? { imageUrl: 'http://images.test/page.jpg' } : {}
  })
  const ids = ['unknown', 'feed', ...skipIds, 'page', 'none', 'failed', 'page']
  const pictures = await service.lookup(ids)
  assert.deepEqual(pictures.map(p => p.itemId), ids)
  assert.deepEqual(pictures.map(p => p.state), ['unknown', 'feed', ...skipIds.map(() => 'skipped'), 'page', 'none', 'failed', 'page'])
  assert.equal(pictures[1].coverImage, 'http://feed.test/image')
  assert.equal(pictures.at(-1)?.coverImage, 'https://images.test/page.jpg')
  assert.strictEqual(pictures.at(-1), pictures.at(-4))
  assert.equal(f.db.getRawDb()!.prepare('SELECT COUNT(*) AS n FROM rss_item_pictures').get<{ n: number }>()!.n, 3)
  await service.lookup(ids)
  assert.equal(calls.length, 3, 'feed, stored outcomes, session sources and unsafe URLs never request a page')
  await service.idle()
})

test('only failed lookups retry, at six hours, once; a changed link starts a fresh lookup', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t); f.put('one'); let calls = 0
  const service = f.makeService(async () => { calls++; throw new Error('offline') })
  assert.equal((await service.lookup(['one']))[0].state, 'failed')
  f.advance(RSS_PICTURE_RETRY_AFTER_MS - 1)
  await service.lookup(['one']); assert.equal(calls, 1)
  f.advance(1)
  await service.lookup(['one']); assert.equal(calls, 2)
  assert.equal(f.rss.pictures.describe(['one'])[0].picture?.attempts, 2)
  f.advance(RSS_PICTURE_RETRY_AFTER_MS * 2)
  await service.lookup(['one']); assert.equal(calls, 2)
  f.put('one', { link: 'https://one.test/new' })
  await service.lookup(['one']); assert.equal(calls, 3)
  assert.equal(f.rss.pictures.describe(['one'])[0].picture?.attempts, 1)
})

test('only usable http(s) image addresses within 2000 characters become https pictures', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t)
  const images = [undefined, '', '/relative.jpg', 'data:image/png;base64,abc', 'ftp://image.test/a', 'https://[invalid', 'https://image.test/' + 'a'.repeat(RSS_PICTURE_URL_MAX), 'http://image.test/' + 'a'.repeat(RSS_PICTURE_URL_MAX - 18), 'http://image.test/good.jpg']
  const ids = images.map((_, index) => `image-${index}`)
  ids.forEach(id => f.put(id))
  const service = f.makeService(async url => ({ imageUrl: images[ids.indexOf(new URL(url).hostname.replace('.test', ''))] }))
  const results = await service.lookup(ids)
  assert.deepEqual(results.map(r => r.state), images.map((_, index) => index >= 7 ? 'page' : 'none'))
  assert.ok(results[7].coverImage?.startsWith('https:'))
  assert.equal(results[8].coverImage, 'https://image.test/good.jpg')
})

test('overlapping lookups join queued and in-flight items, keep two slots and wait for all conclusions', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), calls: string[] = [], gates = new Map<string, ReturnType<typeof deferred<{ imageUrl?: string }>>>()
  for (const id of ['a', 'b', 'c', 'd']) { f.put(id); gates.set(id, deferred()) }
  let active = 0, peak = 0, finished = false
  const service = f.makeService(async url => {
    const id = new URL(url).hostname.split('.')[0]; calls.push(id); active++; peak = Math.max(peak, active)
    try { return await gates.get(id)!.promise } finally { active-- }
  })
  const first = service.lookup(['c', 'a', 'b', 'c']).then(result => { finished = true; return result })
  const second = service.lookup(['b', 'd', 'a'])
  await setImmediate(); assert.equal(calls.length, 2); assert.equal(finished, false)
  gates.get('c')!.resolve({}); await setImmediate(); assert.equal(calls.length, 3)
  gates.get('a')!.resolve({ imageUrl: 'https://images.test/a' }); await setImmediate()
  assert.equal(finished, false)
  gates.get('b')!.resolve({}); gates.get('d')!.resolve({})
  const [one, two] = await Promise.all([first, second])
  assert.deepEqual(calls, ['c', 'a', 'b', 'd']); assert.equal(peak, 2)
  assert.deepEqual(one.map(r => r.itemId), ['c', 'a', 'b', 'c'])
  assert.deepEqual(two.map(r => r.itemId), ['b', 'd', 'a'])
  assert.strictEqual(one[0], one[3]); assert.strictEqual(one[1], two[2])
  await service.idle()
})

test('same hostname is serial across protocols and ports, spaced by start time, without blocking another host', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), gate = deferred<{ imageUrl?: string }>(), starts: Array<{ url: string; at: number }> = [], sleeps: number[] = []
  f.put('a', { link: 'http://same.test/a' }); f.put('b', { link: 'https://same.test:443/b' }); f.put('c')
  const service = f.makeService(async url => { starts.push({ url, at: f.now() }); return url.endsWith('/a') ? gate.promise : {} }, {
    sleep: async ms => { sleeps.push(ms); f.advance(ms) },
  })
  const read = service.lookup(['a', 'b', 'c'])
  await setImmediate(); assert.deepEqual(starts.map(s => s.url), ['http://same.test/a', 'https://c.test/article'])
  f.advance(400); gate.resolve({}); await read
  assert.deepEqual(sleeps, [600]); assert.equal(starts[2].at - starts[0].at, 1000)
})

test('warm runs take 24 newest items, share lookups and coalesce repeated schedules into one follow-up', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), gate = deferred<{ imageUrl?: string }>(), calls: string[] = []
  for (let i = 1; i <= 50; i++) f.put(`item-${i}`, { published: i })
  const service = f.makeService(async url => { const id = new URL(url).hostname.split('.')[0]; calls.push(id); return id === 'item-50' ? gate.promise : {} })
  service.scheduleWarm(); await setImmediate()
  const joined = service.lookup(['item-50'])
  service.scheduleWarm(); service.scheduleWarm(); service.scheduleWarm()
  gate.resolve({ imageUrl: 'https://images.test/50' })
  assert.equal((await joined)[0].state, 'page')
  await service.idle()
  assert.deepEqual(calls, Array.from({ length: 48 }, (_, index) => `item-${50 - index}`))
  assert.deepEqual(f.rss.pictures.candidates(24, f.now()), ['item-2', 'item-1'])
})

test('a warm run reads past items that are never looked up, so they cannot crowd out the ones that are due', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), base = Math.floor(f.now() / 1000)
  const session = f.rss.addRSSSource({ name: 'Session', url: 'https://space.bilibili.com/1' })
  f.db.getRawDb()!.prepare("UPDATE rss_sources SET platform='bilibili' WHERE id=?").run(session)
  // The 30 newest items come from a session source (never looked up, no record); three older ones are due.
  for (let index = 0; index < 30; index++) f.put(`session-${index}`, { sourceId: session, published: base - index })
  for (let index = 0; index < 3; index++) f.put(`due-${index}`, { published: base - 100 - index })
  const read: string[] = []
  const service = f.makeService(async url => { read.push(new URL(url).hostname); return { imageUrl: `https://images.test/${new URL(url).hostname}.jpg` } })
  service.scheduleWarm()
  await service.idle()
  assert.deepEqual(read.sort(), ['due-0.test', 'due-1.test', 'due-2.test'])
  assert.equal(f.rss.pictures.describe(['session-0'])[0].picture, null, 'a skipped item keeps no record')
  assert.equal(f.rss.pictures.covers(['due-1']).get('due-1'), 'https://images.test/due-1.test.jpg')
})

test('warm errors are owned and logged; idle waits for background work', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), warnings: unknown[][] = []
  const service = f.makeService(async () => ({}), { logger: { warn: (...args: unknown[]) => warnings.push(args) } })
  f.db.getRawDb()!.exec('DROP TABLE rss_item_pictures')
  assert.doesNotThrow(() => service.scheduleWarm())
  await service.idle()
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][1]), /rss_item_pictures/)
})

test('dispose resolves queued lookups without saving and allows already started pages to finish', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), gate = deferred<{ imageUrl?: string }>(), calls: string[] = []
  for (const id of ['a', 'b', 'c']) f.put(id, { link: `https://same.test/${id}` })
  const service = f.makeService(async url => { calls.push(url); return gate.promise })
  const active = service.lookup(['a']), queued = service.lookup(['b', 'c'])
  await setImmediate(); service.scheduleWarm(); service.dispose()
  assert.deepEqual((await queued).map(r => r.state), ['failed', 'failed'])
  assert.equal((await service.lookup(['a', 'unknown']))[1].state, 'failed')
  service.scheduleWarm(); gate.resolve({ imageUrl: 'https://images.test/a' })
  assert.equal((await active)[0].state, 'page')
  await service.idle()
  assert.equal(calls.length, 1)
  assert.equal(f.db.getRawDb()!.prepare('SELECT COUNT(*) AS n FROM rss_item_pictures').get<{ n: number }>()!.n, 1)
})

test('dispose also settles a lookup waiting for hostname spacing before the injected sleep ends', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), sleeping = deferred<void>(), entered = deferred<void>(); let calls = 0
  f.put('a', { link: 'https://same.test/a' }); f.put('b', { link: 'https://same.test/b' })
  const service = f.makeService(async () => { calls++; return {} }, { sleep: async () => { entered.resolve(); await sleeping.promise } })
  await service.lookup(['a'])
  const queued = service.lookup(['b']); await entered.promise
  service.dispose()
  assert.equal((await queued)[0].state, 'failed')
  sleeping.resolve(); await service.idle(); await setImmediate()
  assert.equal(calls, 1)
  assert.equal(f.rss.pictures.describe(['b'])[0].picture, null)
})

test('picture IPC validates 1–24 ids, returns service conclusions and unregisters', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), ipc = ipcFixture(); f.put('one'); let calls = 0
  const service = f.makeService(async () => { calls++; return { imageUrl: 'http://images.test/one' } })
  const handle = picturesGroup.register(ipc.ipc, { service: () => service })
  for (const itemIds of [[], Array.from({ length: 25 }, (_, i) => String(i))]) {
    const result = await ipc.invoke('rss:lookupPictures', { itemIds })
    assert.equal((result as { success: boolean }).success, false)
  }
  assert.equal(calls, 0)
  assert.deepEqual(await ipc.invoke('rss:lookupPictures', { itemIds: ['one'] }), { success: true, data: { pictures: [{ itemId: 'one', state: 'page', coverImage: 'https://images.test/one' }] } })
  handle.dispose(); assert.equal(ipc.handlers.size, 0)
})

test('daily IPC adds current covers while saved snapshots and the real assistant tool stay unchanged', async t => {
  if (skipIfSqliteUnavailable(t, 'RSS pictures')) return
  const f = fixture(t), ipc = ipcFixture()
  for (const id of ['page', 'feed', 'none']) {
    f.put(id, id === 'feed' ? { cover: 'https://feed.test/image' } : {})
    f.rss.organization.setManual({ itemId: id, definitionId: 'curated', expectedArticleRevision: f.rss.content.getArticle(id)!.revision, expectedRuleRevision: 1, decision: true })
  }
  const report = f.rss.digests.generate({ kind: 'daily', from: f.now() - 86400000, until: f.now() + 1000, timezone: 'UTC' }, f.now())
  assert.equal(report.total, 3)
  const input = { view: 'entries' as const, reportId: report.id }
  const before = f.rss.digests.read(input)
  f.rss.pictures.save({ itemId: 'page', link: 'https://page.test/article', outcome: 'page', pictureUrl: 'https://images.test/page', now: f.now() })
  digestGroup.register(ipc.ipc, {
    store: () => f.rss.digests, pictures: () => f.rss.pictures,
    service: () => { throw new Error('read must not start the scheduler') }, generate: () => { throw new Error('read must not generate') }, chooseDirectory: async () => null,
  })
  const result = await ipc.invoke('rss:readDigests', input) as { success: boolean; data: { entries: Array<{ source: { itemId: string }; coverImage: string | null }> } }
  assert.equal(result.success, true)
  assert.deepEqual(new Map(result.data.entries.map(e => [e.source.itemId, e.coverImage])), new Map([['page', 'https://images.test/page'], ['feed', 'https://feed.test/image'], ['none', null]]))
  const saved = f.rss.digests.read(input)
  assert.deepEqual(saved, before)
  assert.equal(saved.view, 'entries'); if (saved.view !== 'entries') throw new Error('wrong view')
  assert.ok(saved.entries.every(e => !('coverImage' in e) && !('coverImage' in e.source)))
  const { executeRSSTool } = await import('../main/modules/tools/rss-tools')
  const tool = JSON.parse(await executeRSSTool('rss_read_digests', input, { getDigests: () => f.rss.digests }))
  assert.equal(tool.ok, true); assert.deepEqual(tool.data, saved)
  assert.deepEqual(await ipc.invoke('rss:readDigests', {}), { success: true, data: f.rss.digests.read({}) })
})

class JSONScraper extends WeiboScraper {
  parse(payload: Parameters<JSONScraper['parseJSONFeed']>[0]) { return this.parseJSONFeed(payload, 'rsshub') }
}

test('RSSHub JSON uses image, image enclosure, raw description or content_html, and rejects nonabsolute/non-http covers', () => {
  const scraper = new JSONScraper(), image = 'https://images.test/cover', enclosure = 'http://images.test/enclosure', html = 'https://images.test/html'
  const items = [
    { image, enclosure_url: enclosure, enclosure_type: 'image/jpeg', description: `<img src="${html}">summary` },
    { image: '/relative', enclosure_url: enclosure, enclosure_type: 'image/png', description: `<img src="${html}">` },
    { enclosure_url: enclosure, enclosure_type: 'video/mp4', description: `<p>summary<img src='${html}'></p>` },
    { content_html: `<img src="${html}">` },
    { description: 'Plain summary', content_html: `<img src="${html}">` },
    { image: 'data:image/png,abc', enclosure_url: '/relative', enclosure_type: 'image/png', description: '<img src="//images.test/relative">' },
    { description: '<img data-src="https://images.test/lazy">' },
    { description: '<img src="https://[invalid">' },
    {},
  ]
  assert.deepEqual(scraper.parse({ items }).items.map(i => i.coverImage), [image, enclosure, html, html, html, null, null, null, null])
  assert.equal(scraper.parse({ items: [items[0]] }).items[0].description, 'summary')
})
