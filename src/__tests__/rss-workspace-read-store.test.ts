import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { contentGroup } from '../main/modules/rss-engine/ipc/content-group'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { RSSContentService } from '../main/modules/rss-engine/content-service'
import { ReadabilityJsdomAdapter } from '../main/modules/clipping/readability-jsdom-adapter'
import type { IpcMain } from 'electron'

function fixture() {
  const db = new DatabaseManager(true)
  const rss = db.rss
  const sourceId = rss.addRSSSource({ name: 'Fixture', url: 'https://example.test/feed' })
  const put = (id: string, title = id) => rss.upsertRSSItems([{
    id, source_id: sourceId, guid: id, title, link: `https://example.test/${id}`, summary: `${title} source summary`,
  }])
  return { db, rss, sourceId, put, content: rss.content }
}

test('query scope, literal search and versioned pagination read the same durable items', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS workspace query')) return
  const { db, rss, content, put } = fixture()
  try {
    put('a', '设计 100%'); put('b', '设计'); put('c', '科技')
    rss.dismissRSSItemsFromInbox(['c'])
    assert.equal(content.query({}).total, 2)
    assert.equal(content.query({ scope: 'library' }).total, 3)
    assert.deepEqual(content.query({ search: '%' }).items.map((item) => item.id), ['a'])
    const first = content.query({ limit: 1 })
    const second = content.query({ limit: 1, cursor: first.nextCursor! })
    assert.notEqual(first.items[0].id, second.items[0].id)
    assert.equal(second.nextCursor, null)
    assert.throws(() => content.query({ scope: 'library', limit: 1, cursor: first.nextCursor! }), /cursor_query_mismatch/)
    rss.markRSSRead(first.items[0].id)
    assert.throws(() => content.query({ expectedRevision: first.revision }), /cursor_stale/)
    assert.throws(() => content.query({ limit: 1, cursor: first.nextCursor! }), /cursor_stale/)
    assert.equal(content.query({ filter: 'unread' }).total, 1)
  } finally { db.close() }
})

test('full body and excerpts preserve every character and reject obsolete article versions', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS full body')) return
  const { db, content, put } = fixture()
  try {
    put('long', '长文章')
    const before = content.getArticle('long')!
    assert.equal(before.body.status, 'missing')
    const claim = content.beginLoad('long')!
    const markdown = '# 长文章\n\n' + '完整正文😀。'.repeat(6000)
    assert.equal(content.finishLoad(claim, { status: 'ready', markdown, sourceUrl: before.link }), true)
    const current = content.getArticle('long')!
    assert.equal(current.body.markdown, markdown)
    let offset = 0, reconstructed = ''
    do {
      const read = content.readArticle({ itemId: 'long', expectedRevision: current.revision, offset, length: 12000 })
      reconstructed += read.text
      assert.doesNotMatch(read.text, /[\uD800-\uDBFF]$/)
      offset = read.nextOffset ?? -1
    } while (offset >= 0)
    assert.equal(reconstructed, markdown)
    const emojiOffset = markdown.indexOf('😀')
    assert.equal(content.readArticle({ itemId: 'long', offset: emojiOffset, length: 1 }).text, '😀')
    assert.throws(() => content.readArticle({ itemId: 'long', offset: emojiOffset + 1 }), /offset_inside_surrogate/)
    assert.equal(content.query({ search: '完整正文', searchIn: 'body' }).total, 1)
    put('long', '已更新的长文章')
    assert.throws(() => content.readArticle({ itemId: 'long', expectedRevision: current.revision }), /article_changed/)
    assert.equal(content.getArticle('long')?.body.status, 'stale')
    assert.equal(content.getArticle('long')?.body.markdown, null)
  } finally { db.close() }
})

test('a deleted and recreated item cannot consume a late body result', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS late content receipt')) return
  const { db, rss, content, put } = fixture()
  try {
    put('same')
    const claim = content.beginLoad('same')!
    rss.clearRSSDraftStore()
    put('same')
    assert.equal(content.finishLoad(claim, { status: 'ready', markdown: 'obsolete', sourceUrl: 'https://example.test/same' }), false)
    assert.equal(content.getArticle('same')?.body.status, 'missing')
    const live = content.beginLoad('same')!
    assert.equal(content.beginLoad('same'), null, 'one durable fetch per article version')
    content.recoverInterruptedLoads()
    assert.equal(content.getArticle('same')?.body.status, 'failed')
    assert.equal(content.finishLoad(live, { status: 'ready', markdown: 'late after restart', sourceUrl: 'https://example.test/same' }), false)
  } finally { db.close() }
})

test('refreshing unchanged material keeps its content version and actual fetch time stable', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS unchanged refresh')) return
  const { db, content, put, sourceId } = fixture()
  try {
    put('stable')
    db.getRawDb()!.prepare('UPDATE rss_sources SET last_fetched=? WHERE id=?').run(123456, sourceId)
    const before = content.query({})
    put('stable')
    const after = content.query({})
    assert.equal(after.revision, before.revision)
    assert.equal(after.items[0].revision, before.items[0].revision)
    assert.equal(after.items[0].collectedAt, before.items[0].collectedAt)
    content.getArticle('stable')
    assert.equal(content.query({}).lastFetchAt, 123456000)
  } finally { db.close() }
})

test('IPC and Agent readers return identical data without a mounted UI or network request', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS read consumers')) return
  const { db, content, put } = fixture()
  const handlers = new Map<string, (...args: unknown[]) => Promise<{ success: boolean; data?: unknown }>>()
  const ipc = { handle: (name: string, handler: never) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } as unknown as IpcMain
  const registered = contentGroup.register(ipc, {
    useMock: false, getContent: () => content,
    getLoader: () => { throw new Error('Reads must not start retrieval') },
  })
  try {
    put('visible', '共享资料')
    const ui = await handlers.get('rss:queryItems')!(null, { search: '共享' })
    const agent = JSON.parse(await executeRSSTool('rss_query_items', { search: '共享' }, { getContent: () => content }))
    assert.equal(ui.success, true)
    assert.deepEqual(agent.data, ui.data)
    const body = await handlers.get('rss:readArticle')!(null, { itemId: 'visible' })
    const agentBody = JSON.parse(await executeRSSTool('rss_read_article', { itemId: 'visible' }, { getContent: () => content }))
    assert.deepEqual(agentBody.data, body.data)
    assert.equal(agentBody.data.textKind, 'source_summary')
    assert.equal(agentBody.data.body.status, 'missing')
    const denied = JSON.parse(await executeRSSTool('rss_query_items', {}, { readAccessDenied: true, getContent: () => { throw new Error('Unauthorized storage access') } }))
    assert.equal(denied.error, 'rss_read_not_authorized')
    assert.equal(content.getArticle('visible')?.read, false)
  } finally { registered.dispose(); db.close() }
})

test('article retrieval is shared, preserves the canonical body and settles before service shutdown', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS retrieval lifecycle')) return
  const { db, content, put } = fixture()
  put('fetch')
  let fetches = 0
  let release!: (value: { html: string; finalUrl: string }) => void
  const service = new RSSContentService({
    content,
    fetchHtml: (_url, signal) => {
      fetches++
      return new Promise((resolve, reject) => {
        release = resolve
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    },
    extractor: { extract: async () => ({ title: 'Title', contentMarkdown: '正文'.repeat(8000), metadata: {}, structuredData: [], metaLookup: {}, diagnostics: { confidence: 0.85, extractionSource: 'readability', warnings: [] } }) },
  })
  try {
    const first = service.load('fetch')
    assert.equal(service.load('fetch'), first)
    release({ html: '<article>body</article>', finalUrl: 'https://example.test/fetch' })
    const loaded = await first
    assert.equal(fetches, 1)
    assert.equal(loaded.body.markdown?.length, 16000)
    assert.deepEqual(await service.load('fetch'), loaded)
    assert.equal(fetches, 1)
    const pending = service.load('fetch', true)
    await service.stop()
    assert.equal((await pending).body.status, 'failed')
    assert.equal(content.getArticle('fetch')?.body.status, 'failed')
    await assert.rejects(service.load('fetch'), /stopped/)
  } finally { await service.stop(); db.close() }
})

test('superseded article retrieval remains owned until shutdown has settled every request', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS superseded retrieval shutdown')) return
  const { db, content, put } = fixture()
  const signals: AbortSignal[] = []
  const service = new RSSContentService({
    content,
    fetchHtml: (_url, signal) => new Promise((_resolve, reject) => {
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }),
    extractor: { extract: async () => { throw new Error('Cancelled fetch must not extract') } },
  })
  try {
    put('updated', 'Original')
    let firstSettled = false
    const first = service.load('updated').catch((error) => { firstSettled = true; return error as Error })
    put('updated', 'New version')
    const second = service.load('updated')
    await service.stop()
    assert.equal(signals.length, 2)
    assert.ok(signals.every((signal) => signal.aborted))
    assert.equal(firstSettled, true)
    const firstResult = await first
    assert.ok(firstResult instanceof Error)
    assert.match(firstResult.message, /article_changed/)
    assert.equal((await second).body.status, 'failed')
  } finally { await service.stop(); db.close() }
})

test('an HTTP 200 login form is not stored or returned as article body', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS authentication wall')) return
  const { db, content, put } = fixture()
  put('login', 'Actual headline')
  const service = new RSSContentService({
    content,
    fetchHtml: async () => ({
      finalUrl: 'https://example.test/login',
      html: '<html><head><title>Sign in</title></head><body><nav>Home | Help</nav><form><h1>Sign in to continue</h1><input type="password"><button>Sign in</button></form></body></html>',
    }),
    extractor: new ReadabilityJsdomAdapter(),
  })
  try {
    const result = await service.load('login')
    assert.equal(result.body.status, 'login_required')
    assert.equal(result.body.markdown, null)
    const read = content.readArticle({ itemId: 'login' })
    assert.equal(read.textKind, 'source_summary')
    assert.equal(read.text, 'Actual headline source summary')
    assert.equal(content.query({ searchIn: 'body', search: 'Sign in' }).total, 0)
  } finally { await service.stop(); db.close() }
})

test('authentication follows the main content boundary, not document length or a sidebar form', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS primary authentication boundary')) return
  const { db, content, put } = fixture()
  const longLogin = `<main><h1>Sign in</h1>${'<p>You need an account to access this publication. Account information is required to continue reading.</p>'.repeat(10)}<form><input type="password"><button>Sign in</button></form></main>`
  const shortArticle = '<div class="news-content"><h1>真实新闻</h1><p>研究团队公布了新工具的测试结果，提供了测试材料、实验设置、使用说明和下载地址，读者可以按照文中步骤复现实验。</p></div><aside><form><input type="password"><button>Sign in</button></form></aside>'
  const commentLogin = `<main><article><h1>公开报道</h1>${'<p>研究团队发布了完整的测试材料，记录实验设置并提供复现步骤，所有读者都可以直接阅读全文。</p>'.repeat(5)}</article><section id="comments"><form>Sign in to comment<input type="password"></form></section></main>`
  const service = new RSSContentService({
    content,
    fetchHtml: async (url) => ({ finalUrl: url, html: `<html><body>${url.endsWith('/wall') ? longLogin : url.endsWith('/comments') ? commentLogin : shortArticle}</body></html>` }),
    extractor: new ReadabilityJsdomAdapter(),
  })
  try {
    put('wall'); put('public'); put('comments')
    assert.equal((await service.load('wall')).body.status, 'login_required')
    const article = await service.load('public')
    assert.ok(article.body.status === 'ready' || article.body.status === 'partial')
    assert.match(article.body.markdown!, /研究团队/)
    assert.equal((await service.load('comments')).body.status, 'ready')
    assert.match(content.getArticle('comments')?.body.markdown || '', /研究团队发布了完整的测试材料/)
    assert.equal(content.readArticle({ itemId: 'wall' }).textKind, 'source_summary')
  } finally { await service.stop(); db.close() }
})
