#!/usr/bin/env node
// Hidden real-window check of 资讯配图 (plan docs/superpowers/plans/2026-11-18-ready-next-rss-pictures-implementation.md):
// the 列表 / 图册 switch on 订阅更新, 为你筛过的 and 日报与简报, with pictures from a loopback feed.
// The window is never shown; HOME, TMPDIR and the profile live in a throwaway directory; no outside site is
// contacted: the feed and its articles are on loopback and the pictures (an https host that does not exist) are
// answered by the page's own request interception. Picks are made by hand through the app's IPC, so no model runs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-next-rss-pictures-')))
const evidence = path.join(temporary, 'evidence')
for (const dir of ['home', 'tmp', 'profile', 'evidence']) fs.mkdirSync(path.join(temporary, dir))
process.env.HOME = path.join(temporary, 'home')
process.env.TMPDIR = path.join(temporary, 'tmp')
for (const name of ['READY_REMOTE_DEBUGGING_PORT', 'READY_DB_PATH', 'ELECTRON_RUN_AS_NODE']) delete process.env[name]
const profile = path.join(temporary, 'profile')
const harness = require('./design-matrix/harness.cjs')
const SIZE = { width: 1600, height: 930 }
const PICTURES = 'https://pictures.ready.test'

// A PNG of one soft gradient, so every picture is its own colour and shape without any file on disk.
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]) }
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3, u = x / width, v = y / height
    rows[at] = Math.round(r * (1 - .35 * v) + 40 * u); rows[at + 1] = Math.round(g * (1 - .3 * u) + 30 * v); rows[at + 2] = Math.round(b * (1 - .25 * v * u) + 20)
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const SHAPES = { wide: [960, 540, [196, 132, 96]], photo: [900, 600, [92, 128, 168]], square: [800, 800, [128, 156, 110]], panorama: [1200, 400, [176, 148, 196]], small: [200, 120, [208, 176, 96]], tall: [600, 900, [112, 104, 148]] }

// The feed: what a day of mixed sources looks like. `picture` names a shape; without it the item has no cover.
const ITEMS = [
  { title: '端侧模型的新进展：一台笔记本能跑什么', picture: 'wide', summary: '实测了三款笔记本上的本地推理速度，给出了具体的数字和可复现的步骤。' },
  { title: '一个人的出版社：独立作者如何做发行', picture: 'photo', summary: '从选题、印制到渠道，一位独立作者把一年里的账目和教训都摊开了。' },
  { title: '为什么你的稍后读永远读不完', summary: '信息过载的时代，真正稀缺的不是内容，而是注意力。一个好的筛子应该先理解你在做什么。' },
  { title: 'Show HN: a board for collecting references', summary: 'Comments' },
  { title: '画板到成文：一套把灵感变成稿子的工作流', picture: 'square', summary: '把画板上的卡片排成提纲，再一段段写成文章，中间每一步都留了出处。' },
  { title: '城市天际线的四十年：一组全景照片', picture: 'panorama', summary: '摄影师每十年回到同一个机位，拍下同一条天际线。' },
  { title: '日本独立书店的陈列方法', picture: 'tall', summary: '书店主人讲了他们怎样用一张桌子讲一个主题。' },
  { title: '设计系统的令牌分层实践', picture: 'small', summary: '颜色、间距、圆角怎样分成三层，才能既统一又不僵。' },
  { title: 'RSS 没有死，只是换了读法', summary: '订阅仍然是掌握信息来源最直接的办法，变的是我们读它的方式。' },
  { title: '浏览器里的智能体：从截图到语义快照', picture: 'photo', summary: '语义快照让助手不必看图也能知道页面上有什么。', yesterday: true },
  { title: '本周值得读的三本书', summary: 'Comments', yesterday: true },
  { title: '封面设计的十二个决定', picture: 'wide', summary: '一张封面从第一稿到定稿，中间被推翻了十二次。', yesterday: true },
]
const PICKS = [0, 4, 5, 2, 9] // made 精选 by hand: three with a picture of different shapes, one without, one from yesterday

function startFeed() {
  const server = http.createServer((request, response) => {
    const port = server.address().port, base = new Date(); base.setHours(21, 5, 0, 0)
    if (request.url.startsWith('/feed')) {
      const entries = ITEMS.map((item, index) => {
        const at = new Date(base.getTime() - index * 47 * 60000 - (item.yesterday ? 86400000 : 0))
        const cover = item.picture ? `<enclosure url="${PICTURES}/${item.picture}-${index}.png" type="image/png" length="1000"/>` : ''
        return `<item><title>${item.title}</title><link>http://127.0.0.1:${port}/a/${index}</link><guid>pictures-${index}</guid><pubDate>${at.toUTCString()}</pubDate>${cover}<description><![CDATA[${item.summary}]]></description></item>`
      }).join('')
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>画报夹具</title><link>http://127.0.0.1:${port}/</link><description>rss pictures</description>${entries}</channel></rss>`)
      return
    }
    const index = Number(String(request.url).split('/').pop()) || 0
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${ITEMS[index % ITEMS.length].title}</title></head><body><h1>${ITEMS[index % ITEMS.length].title}</h1><p>${ITEMS[index % ITEMS.length].summary}</p></body></html>`)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })))
}

async function poll(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  for (;;) {
    let value; try { value = await check() } catch (error) { value = false; if (Date.now() > deadline) throw new Error(`${message}: ${error.message}`) }
    if (value) return value
    assert.ok(Date.now() < deadline, message)
    await harness.sleep(150)
  }
}

async function main() {
  const feed = await startFeed()
  let session
  const served = new Map()
  const prepare = async page => {
    await page.route(`${PICTURES}/**`, route => {
      const name = new URL(route.request().url()).pathname.slice(1).replace(/-\d+\.png$/, '')
      if (!served.has(name)) served.set(name, png(...SHAPES[name]))
      return route.fulfill({ status: 200, contentType: 'image/png', body: served.get(name) })
    })
    await harness.requestMode(page, 'rss')
    await page.locator('nav.rss-nav').waitFor({ timeout: 20000 })
  }
  const shot = async (page, name) => { await harness.sleep(350); await page.screenshot({ path: path.join(evidence, `${name}.png`) }); console.log(`PASS ${name}`) }
  const nav = (page, label) => page.locator('nav.rss-nav').getByLabel(label, { exact: true })
  const choose = (scope, label) => scope.locator(`.rss-layout-switch [role="radio"][aria-label="${label}"]`).click()
  // Pictures load lazily, so only those on screen are expected to have arrived.
  const loaded = locator => locator.evaluateAll(images => {
    const shown = images.filter(image => {
      const box = image.getBoundingClientRect(), frame = image.closest('.rss-pic')
      return box.width > 0 && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.rss-pic') === frame
    })
    return shown.length > 0 && shown.every(image => image.complete && image.naturalWidth > 0)
  })
  const fits = (page, selector) => page.locator(selector).first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)
  try {
    session = await harness.launch(profile, SIZE)
    session = await harness.ensureAppearance(profile, session, { theme: 'light', transparency: 'reduced' }, SIZE)
    let { page } = session
    await prepare(page)

    // The feed, then five picks made by hand (手工精选): no model is configured and none is called.
    const seeded = await page.evaluate(async ({ url, picks }) => {
      const api = window.electronAPI.rss
      const source = await api.addSource({ name: '画报夹具', url: `${url}/feed` })
      if (!source?.success && !source?.data && !source?.id) throw new Error(`source: ${JSON.stringify(source).slice(0, 200)}`)
      const sourceId = source?.data?.id ?? source?.id ?? source?.data?.source?.id
      await api.fetchAll(sourceId ? { sourceIds: [sourceId] } : undefined)
      const listed = await api.queryItems({ scope: 'inbox', filter: 'all', limit: 50 })
      if (!listed.success) throw new Error(listed.error)
      const definitions = await api.getDefinitions()
      const curated = definitions.data.find(entry => entry.kind === 'curated')
      const byTitle = new Map(listed.data.items.map(item => [item.title, item]))
      const made = []
      for (const title of picks) {
        const item = byTitle.get(title)
        if (!item) throw new Error(`item missing: ${title}`)
        const result = await api.setMembership({ itemId: item.id, expectedArticleRevision: item.revision, definitionId: curated.id, expectedRuleRevision: curated.ruleRevision, decision: true })
        if (!result.success) throw new Error(`pick ${title}: ${result.error}`)
        made.push(item.id)
      }
      return { total: listed.data.items.length, covers: listed.data.items.filter(item => item.coverImage).length, picks: made, curatedId: curated.id,
        bare: listed.data.items.find(item => !item.coverImage)?.id }
    }, { url: feed.url, picks: PICKS.map(index => ITEMS[index].title) })
    assert.equal(seeded.total, ITEMS.length); assert.equal(seeded.covers, ITEMS.filter(item => item.picture).length)
    console.log(`seeded: ${JSON.stringify({ total: seeded.total, covers: seeded.covers, picks: seeded.picks.length })}`)

    // P3: an item without a cover whose page is on this machine is not looked up, and nothing leaves the machine.
    const lookup = await page.evaluate(itemIds => window.electronAPI.rss.lookupPictures({ itemIds }), [seeded.bare, seeded.picks[0], 'no-such-item'])
    assert.equal(lookup.success, true, lookup.error)
    assert.deepEqual(lookup.data.pictures.map(picture => picture.state), ['skipped', 'feed', 'unknown'])
    assert.equal(lookup.data.pictures[0].coverImage, null); assert.match(lookup.data.pictures[1].coverImage, /^https:\/\/pictures\.ready\.test\//)

    // ---- 订阅更新 · 列表: a pick's picture large under its words, any other a small one at the end of the line ----
    await nav(page, '全部').click()
    const sheet = page.locator('.rss-feed-sheet')
    await sheet.locator('.rss-news-card').first().waitFor({ timeout: 20000 })
    await poll(() => loaded(sheet.locator('.rss-news-card .rss-pic img')), 'The list pictures did not load')
    const rowOf = title => sheet.locator('.rss-news-card', { hasText: title }).first()
    const pick = rowOf(ITEMS[0].title), plain = rowOf(ITEMS[1].title), bare = rowOf(ITEMS[2].title)
    const box = async locator => locator.boundingBox()
    const feature = await box(pick.locator('.rss-pic--feature')), pickTitle = await box(pick.locator('.rss-card-title'))
    assert.ok(feature.y >= pickTitle.y + pickTitle.height, 'the pick\'s picture stands under its words')
    assert.ok(Math.abs(feature.width / feature.height - 16 / 9) < .02 && feature.width <= 449, `feature ${feature.width}×${feature.height}`)
    assert.equal(await pick.locator('.rss-card-curated').innerText(), '精选')
    const thumb = await box(plain.locator('.rss-pic--thumb')), plainTitle = await box(plain.locator('.rss-card-title'))
    assert.deepEqual([Math.round(thumb.width), Math.round(thumb.height)], [120, 80])
    assert.ok(thumb.x >= plainTitle.x + plainTitle.width - 1, 'a small picture sits at the end of the line')
    assert.equal(await bare.locator('.rss-pic').count(), 0, 'an item without a picture is words only, no placeholder')
    assert.equal(await fits(page, '.rss-feed-sheet'), true)
    await page.mouse.move(1500, 880)
    await shot(page, '01-feed-list')

    // ---- 订阅更新 · 图册: a board of covers; an item without a picture uses its own words ----
    await choose(sheet, '图册')
    await sheet.locator('.rss-tile').first().waitFor()
    await poll(() => loaded(sheet.locator('.rss-tile .rss-pic img')), 'The covers did not load')
    const panel = await box(sheet.locator('.rss-feed-list'))
    const columns = Number(await sheet.locator('.rss-gallery__covers').first().evaluate(element => getComputedStyle(element).getPropertyValue('--rss-gallery-columns')))
    assert.equal(columns, panel.width < 560 ? 1 : panel.width < 880 ? 2 : panel.width < 1280 ? 3 : 4, `columns for a ${Math.round(panel.width)}px panel`)
    const cover = await box(sheet.locator('.rss-tile .rss-pic--tile').first())
    assert.ok(Math.abs(cover.width / cover.height - 1.5) < .02, `cover ${cover.width}×${cover.height}`)
    assert.ok(await sheet.locator('.rss-tile .rss-pic--words').count() >= 2)
    assert.equal(await sheet.locator('.rss-tile', { hasText: ITEMS[3].title }).locator('.rss-pic--words.is-site').innerText(), '127.0.0.1')
    assert.equal(await fits(page, '.rss-feed-sheet'), true)
    await shot(page, '02-feed-gallery')
    await sheet.locator('.rss-tile').nth(1).hover()
    await poll(() => sheet.locator('.rss-tile').nth(1).locator('.rss-tile__actions').evaluate(element => getComputedStyle(element).opacity === '1'), 'The cover actions did not show under the pointer')
    await shot(page, '02a-feed-gallery-hover')
    // Coming back from an article keeps the reader's place on the board (a hidden board loses its scroll position).
    const holder = sheet.locator('.rss-feed-list [data-liquid-scroll-root="rss-feed-list"]')
    const place = () => holder.evaluate(element => {
      const top = element.getBoundingClientRect().top
      const row = [...element.querySelectorAll('.rss-gallery__row')].find(candidate => candidate.getBoundingClientRect().bottom > top)
      return row ? { item: row.querySelector('[data-rss-item-id]').dataset.rssItemId, offset: Math.round(row.getBoundingClientRect().top - top) } : null
    })
    await holder.evaluate(element => { element.scrollTop = 330 })
    await harness.sleep(400)
    const before = await place()
    assert.ok(before && before.offset < 0, `the board did not scroll: ${JSON.stringify(before)}`)
    await sheet.locator('.rss-tile', { hasText: ITEMS[4].title }).locator('.rss-tile__title button').click()
    await page.locator('.rss-article-reader').waitFor({ timeout: 20000 })
    await page.getByRole('button', { name: '回到资讯列表', exact: true }).click()
    await sheet.locator('.rss-tile').first().waitFor()
    await poll(async () => { const now = await place(); return now && now.item === before.item && Math.abs(now.offset - before.offset) <= 2 }, 'Coming back from an article lost the place on the board')
    console.log('PASS 02b-feed-gallery-return: the same row at the same place')

    // ---- 为你筛过的 ----
    await nav(page, '为你筛过的').click()
    const sieve = page.locator('section.rss-sieve')
    await poll(async () => await sieve.locator('.rss-sieve__card').count() >= 3, 'The sieve shows fewer than three cards')
    assert.equal(await sieve.getAttribute('data-layout'), 'list', 'each surface keeps its own choice: the feed is 图册, this one still 列表')
    await poll(() => loaded(sieve.locator('.rss-pic img')), 'The sieve pictures did not load')
    assert.ok(await sieve.locator('.rss-pic--sieve-hero, .rss-pic--sieve-thumb').count() >= 2)
    assert.equal(await sieve.locator('.rss-sieve__card').first().locator('.rss-pic--sieve-thumb').count(), 0, 'the first card has no small picture: it opens with a large one or with words')
    assert.equal(await fits(page, 'section.rss-sieve'), true)
    await page.mouse.move(1500, 880)
    await shot(page, '03-sieve-list')
    await choose(sieve, '图册')
    await poll(async () => await sieve.getAttribute('data-layout') === 'gallery', 'The sieve did not switch to 图册')
    await poll(() => loaded(sieve.locator('.rss-pic--sieve-cover img')), 'The sieve covers did not load')
    const tops = await sieve.locator('.rss-sieve__card').evaluateAll(cards => cards.slice(0, 2).map(card => Math.round(card.getBoundingClientRect().top)))
    assert.equal(tops[0], tops[1], 'two covers share a row')
    await shot(page, '04-sieve-gallery')

    // ---- 日报与简报: a brief made from the picks (no model), read in both layouts ----
    const brief = await page.evaluate(async curatedId => {
      const api = window.electronAPI.rss
      const view = await api.queryItems({ scope: 'inbox', filter: 'all', collectionId: curatedId, limit: 50 })
      if (!view.success) throw new Error(view.error)
      const made = await api.generateDigest({ kind: 'range', query: { scope: 'inbox', filter: 'all', collectionId: curatedId, expectedRevision: view.data.revision } })
      if (!made.success) throw new Error(made.error)
      const entries = await api.readDigests({ view: 'entries', reportId: made.data.id })
      return { id: made.data.id, total: made.data.total, covers: entries.data.entries.map(entry => entry.coverImage ?? null) }
    }, seeded.curatedId)
    assert.equal(brief.total, PICKS.length)
    assert.equal(brief.covers.filter(Boolean).length, PICKS.filter(index => ITEMS[index].picture).length, 'P6: the app\'s own read gives every entry its picture')
    await nav(page, '日报与简报').click()
    const digest = page.locator('section.rss-digest-panel')
    await digest.getByRole('radio', { name: '简报', exact: true }).click()
    await digest.locator('.rss-digest-issue').first().click()
    await digest.locator('.rss-paper-lead').waitFor({ timeout: 20000 })
    const head = page.locator('.rss-feed-sheet .rss-topbar')
    assert.equal(await digest.locator('.rss-paper-grid').getAttribute('data-layout'), 'list')
    await poll(() => loaded(digest.locator('.rss-pic img')), 'The daily pictures did not load')
    assert.ok(await digest.locator('.rss-paper-strip li').count() >= 1)
    assert.ok(await digest.locator('.rss-paper-entry').count() >= 1)
    assert.equal(await digest.locator('.rss-paper-strip button figure').count(), 0)
    assert.equal(await fits(page, 'section.rss-digest-panel .rss-digest-main'), true)
    await page.mouse.move(1500, 880)
    await shot(page, '05-digest-list')
    await digest.locator('.rss-digest-main').evaluate(element => { element.scrollTop = 620 })
    await shot(page, '05a-digest-list-below')
    await choose(head, '图册')
    await poll(async () => await digest.locator('.rss-paper-grid').getAttribute('data-layout') === 'gallery', 'The daily did not switch to 图册')
    await poll(() => loaded(digest.locator('.rss-pic img')), 'The daily covers did not load')
    assert.ok(await digest.locator('.rss-paper-mosaic li').count() >= 1)
    assert.ok(await digest.locator('.rss-paper-card').count() >= 1)
    await digest.locator('.rss-digest-main').evaluate(element => { element.scrollTop = 0 })
    await shot(page, '06-digest-gallery')
    await digest.locator('.rss-digest-main').evaluate(element => { element.scrollTop = 640 })
    await shot(page, '06a-digest-gallery-below')

    // ---- P8: the choices survive a restart; the same surfaces in the dark theme ----
    session = await harness.ensureAppearance(profile, session, { theme: 'dark', transparency: 'reduced' }, SIZE)
    page = session.page
    await prepare(page)
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('ready-rss-layouts') || '{}'))
    assert.deepEqual(remembered, { feed: 'gallery', sieve: 'gallery', digest: 'gallery' })
    await nav(page, '全部').click()
    await page.locator('.rss-feed-sheet .rss-tile').first().waitFor({ timeout: 20000 })
    await poll(() => loaded(page.locator('.rss-feed-sheet .rss-tile .rss-pic img')), 'The covers did not load after the restart')
    await page.mouse.move(1500, 880)
    await shot(page, '07-feed-gallery-dark')
    await choose(page.locator('.rss-feed-sheet'), '列表')
    await page.locator('.rss-feed-sheet .rss-news-card').first().waitFor()
    await poll(() => loaded(page.locator('.rss-feed-sheet .rss-news-card .rss-pic img')), 'The list pictures did not load in the dark theme')
    await shot(page, '08-feed-list-dark')
    await nav(page, '日报与简报').click()
    await page.locator('section.rss-digest-panel').getByRole('radio', { name: '简报', exact: true }).click()
    await page.locator('section.rss-digest-panel .rss-digest-issue').first().click()
    await page.locator('section.rss-digest-panel .rss-paper-lead').waitFor({ timeout: 20000 })
    await poll(() => loaded(page.locator('section.rss-digest-panel .rss-pic img')), 'The daily covers did not load in the dark theme')
    await shot(page, '09-digest-gallery-dark')
    console.log(`PASS rss pictures window gate: ${evidence}`)
  } finally {
    if (session) await harness.close(session.app).catch(() => {})
    feed.server.close()
    for (const dir of ['home', 'tmp', 'profile']) fs.rmSync(path.join(temporary, dir), { recursive: true, force: true })
    console.log(`Evidence retained: ${temporary}`)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
