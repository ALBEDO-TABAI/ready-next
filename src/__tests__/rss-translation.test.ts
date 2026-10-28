import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import {
  batchRSSTranslationBlocks, keepsRSSBlockInvariants, parseRSSTranslationReply, RSSTranslationService,
  segmentRSSTranslationBlocks,
} from '../main/modules/rss-engine/translation-service'
import { defaultRSSTranslationTarget, rssTranslatedSegments, type RSSTranslationLanguage } from '../shared/rss-translation'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const BODY = [
  '# Shimano museum',
  'The museum opened with [a press tour](https://museum.test/tour) and `v2` of the archive.',
  '![Front hall](https://cdn.test/hall.jpg)',
  '```js\nconst gear = 11\n```',
  '- First floor\n- Second floor',
  '> A quote from the curator.',
  '| Year | Model |\n| - | - |\n| 1973 | Dura-Ace |',
].join('\n\n')

type Request = { system: string; user: string; signal: AbortSignal }
const blocksOf = (request: Request) => (JSON.parse(request.user) as { blocks: Array<{ id: number; markdown: string }> }).blocks
// A faithful fixture translation: markers, links and code stay, the words gain a marker.
const translate = (markdown: string) => markdown.split('\n').map((line) => (
  /^\|\s*-/.test(line) ? line : line.replace(/^(#{1,6} |- |> |\| )?/, '$1译：')
)).join('\n')
const reply = (request: Request, change: (id: number, markdown: string) => string = (_id, markdown) => translate(markdown)) => (
  JSON.stringify({ blocks: blocksOf(request).map(({ id, markdown }) => ({ id, markdown: change(id, markdown) })) })
)

function fixture(body = BODY) {
  const db = new DatabaseManager(true)
  const rss = db.rss
  const sourceId = rss.addRSSSource({ name: 'Fixture', url: 'https://museum.test/feed' })
  rss.upsertRSSItems([{ id: 'item', source_id: sourceId, guid: 'item', title: 'Museum', link: 'https://museum.test/a', summary: 'Museum summary' }])
  const save = (markdown: string) => {
    const claim = rss.content.beginLoad('item')!
    assert.ok(rss.content.finishLoad(claim, { status: 'ready', markdown, sourceUrl: 'https://museum.test/a' }))
  }
  save(body)
  const requests: Request[] = []
  const notified: string[] = []
  let respond: (request: Request) => Promise<string> = async (request) => reply(request)
  let modelReady = true
  const service = () => new RSSTranslationService({
    store: rss.translations,
    getArticle: (id) => rss.content.getArticle(id),
    assertModelReady: () => { if (!modelReady) throw new Error('请先在 Ready 中配置可用的模型，再翻译文章。') },
    complete: (request) => { requests.push(request); return respond(request) },
    notify: (itemId, lang) => { notified.push(`${itemId}:${lang}`) },
  })
  const settled = async (subject: RSSTranslationService, lang: RSSTranslationLanguage = 'zh-CN') => {
    for (let turn = 0; turn < 200 && subject.read('item', lang)?.status === 'running'; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    return subject.read('item', lang)!
  }
  return {
    db, rss, save, requests, notified, service, settled,
    respondWith(next: (request: Request) => Promise<string>) { respond = next },
    setModelReady(ready: boolean) { modelReady = ready },
  }
}

test('the body splits into translatable blocks; code, pictures and HTML stay as written', () => {
  const blocks = segmentRSSTranslationBlocks(`${BODY}\n\n<div>raw</div>\n\n---`)
  assert.deepEqual(blocks.map((block) => BODY.slice(block.start, block.end).split('\n')[0]), [
    '# Shimano museum', 'The museum opened with [a press tour](https://museum.test/tour) and `v2` of the archive.',
    '- First floor', '> A quote from the curator.', '| Year | Model |',
  ])
  const long = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${'words '.repeat(80)}`).join('\n\n')
  const batches = batchRSSTranslationBlocks(segmentRSSTranslationBlocks(long))
  assert.ok(batches.length >= 2 && batches.every((batch) => batch.length > 0))
  assert.deepEqual(batches.flat(), Array.from({ length: 12 }, (_, index) => index))
})

test('only the promised reply shape and a faithful block count as a translation', () => {
  assert.deepEqual([...parseRSSTranslationReply('```json\n{"blocks":[{"id":0,"markdown":"甲"},{"id":0,"markdown":"乙"},{"id":"1","markdown":"丙"}]}\n```')], [[0, '甲']])
  assert.equal(parseRSSTranslationReply('Sorry, I cannot help.').size, 0)
  const source = 'See [the tour](https://museum.test/tour) and `v2`.'
  assert.equal(keepsRSSBlockInvariants(source, '参观[导览](https://museum.test/tour)和 `v2`。'), true)
  assert.equal(keepsRSSBlockInvariants(source, '参观导览和 `v2`。'), false, 'a lost link')
  assert.equal(keepsRSSBlockInvariants(source, '参观[导览](https://museum.test/tour)和 v2。'), false, 'lost inline code')
  assert.equal(keepsRSSBlockInvariants('## Title', '标题'), false, 'a lost heading level')
  assert.equal(keepsRSSBlockInvariants('## Title', '## 标题'), true)
  assert.equal(defaultRSSTranslationTarget('The museum opened today.'), 'zh-CN')
  assert.equal(defaultRSSTranslationTarget('博物馆今天开放，展出 Dura-Ace 套件。'), 'en')
})

test('a translation covers every text block and the reader keeps code and pictures in place', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS translation')) return
  const { db, requests, notified, service, settled } = fixture()
  const translator = service()
  try {
    assert.equal(translator.translate({ itemId: 'item', targetLang: 'zh-CN' }).status, 'running')
    const done = await settled(translator)
    assert.equal(done.status, 'completed')
    assert.equal(done.done, 5)
    assert.equal(requests.length, 1)
    assert.match(requests[0].system, /Simplified Chinese/)
    assert.equal(blocksOf(requests[0]).some(({ markdown }) => /hall\.jpg|const gear/.test(markdown)), false, 'code and pictures are never sent')
    const translated = rssTranslatedSegments(BODY, done.blocks).map((segment) => segment.translation ?? segment.source).join('\n\n')
    assert.match(translated, /^# 译：Shimano museum/)
    assert.match(translated, /!\[Front hall\]\(https:\/\/cdn\.test\/hall\.jpg\)/)
    assert.match(translated, /```js\nconst gear = 11\n```/)
    assert.ok(notified.length >= 2)
    assert.equal(translator.translate({ itemId: 'item', targetLang: 'zh-CN' }).status, 'completed', 'a finished translation is not paid for twice')
    assert.equal(requests.length, 1)
  } finally { await translator.stop(); db.close() }
})

test('a block that loses its link keeps the source, and retrying sends only that block', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS translation retry')) return
  const { db, requests, service, settled, respondWith } = fixture()
  const translator = service()
  try {
    respondWith(async (request) => reply(request, (_id, markdown) => translate(markdown).replace(/\]\(https:\/\/museum\.test\/tour\)/, ']')))
    translator.translate({ itemId: 'item', targetLang: 'zh-CN' })
    const partial = await settled(translator)
    assert.equal(partial.status, 'partial')
    assert.deepEqual(partial.blocks.map((block) => block.state), ['translated', 'untranslated', 'translated', 'translated', 'translated'])
    assert.match(partial.error ?? '', /保留原文/)
    respondWith(async (request) => reply(request))
    translator.translate({ itemId: 'item', targetLang: 'zh-CN', retryUntranslated: true })
    const retried = await settled(translator)
    assert.equal(retried.status, 'completed')
    assert.deepEqual(blocksOf(requests.at(-1)!).map(({ markdown }) => markdown), [BODY.split('\n\n')[1]])
  } finally { await translator.stop(); db.close() }
})

test('stopping keeps finished batches, and translating again continues with the rest', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS translation cancel')) return
  const long = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${'words '.repeat(80)}`).join('\n\n')
  const { db, requests, service, settled, respondWith } = fixture(long)
  const translator = service()
  try {
    let calls = 0
    respondWith((request) => (calls++ === 0 ? Promise.resolve(reply(request)) : new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })))
    translator.translate({ itemId: 'item', targetLang: 'zh-CN' })
    for (let turn = 0; turn < 200 && !translator.read('item', 'zh-CN')!.blocks.some((block) => block.state === 'translated'); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    translator.cancel('item', 'zh-CN')
    const stopped = await settled(translator)
    assert.equal(stopped.status, 'cancelled')
    const kept = stopped.blocks.filter((block) => block.state === 'translated').length
    assert.ok(kept > 0 && kept < stopped.total)
    respondWith(async (request) => reply(request))
    const sentBefore = requests.length
    translator.translate({ itemId: 'item', targetLang: 'zh-CN' })
    const resumed = await settled(translator)
    assert.equal(resumed.status, 'completed')
    assert.equal(requests.slice(sentBefore).flatMap(blocksOf).length, stopped.total - kept, 'finished blocks are not sent again')
  } finally { await translator.stop(); db.close() }
})

test('a new body revision is translated afresh and nothing starts without a usable model', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS translation revision')) return
  const { db, rss, save, requests, service, settled, setModelReady } = fixture()
  const translator = service()
  try {
    translator.translate({ itemId: 'item', targetLang: 'en' })
    const first = await settled(translator, 'en')
    save(`${BODY}\n\nA closing paragraph added later.`)
    const revision = rss.content.getArticle('item')!.body.revision!
    assert.notEqual(first.bodyRevision, revision)
    translator.translate({ itemId: 'item', targetLang: 'en' })
    const second = await settled(translator, 'en')
    assert.equal(second.bodyRevision, revision)
    assert.equal(second.total, 6)
    assert.equal(requests.length, 2)

    setModelReady(false)
    assert.throws(() => translator.translate({ itemId: 'item', targetLang: 'ja' }), /配置可用的模型/)
    assert.equal(translator.read('item', 'ja'), null)
  } finally { await translator.stop(); db.close() }
})

test('an interrupted translation reads as stopped after restart, and leaves with its item', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS translation recovery')) return
  const { db, rss, service } = fixture()
  try {
    const article = rss.content.getArticle('item')!
    rss.translations.begin({ itemId: 'item', targetLang: 'zh-CN', bodyRevision: article.body.revision!, requestId: 'lost',
      blocks: segmentRSSTranslationBlocks(BODY) })
    const restarted = service()
    assert.equal(restarted.read('item', 'zh-CN')?.status, 'cancelled')
    assert.equal(rss.translations.progress('item', 'zh-CN', 'lost', []), false, 'the lost job cannot write any more')
    rss.deleteRSSItems(['item'])
    assert.equal(rss.translations.get('item', 'zh-CN'), null)
    await restarted.stop()
  } finally { db.close() }
})
