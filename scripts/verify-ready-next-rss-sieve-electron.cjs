#!/usr/bin/env node
// W5 T3/T4 real-window check (hidden; throwaway profile and vault; no model, no external site):
//  V8  资讯 opens on 为你筛过的 and says why it is empty (no model configured).
//  V6  the first-time question lists the titles that would be sent; nothing is decided before it is answered.
//  V2  少看这类 › 这个来源 on a card lowers that source's other articles, and the change survives a restart.
//  §4  the navigator has the new shape; 筛子设置 opens; 全部 offers 包含已移出的; sorting offers 按相关度.
// Build first (npx electron-vite build). Usage: node scripts/verify-ready-next-rss-sieve-electron.cjs [--shots <dir>]
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const harness = require('./design-matrix/harness.cjs')

const shotsArg = process.argv.indexOf('--shots')
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null
let passed = 0, failed = 0
const ok = (name, pass, detail = '') => { if (pass) passed++; else failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${!pass && detail ? ` — ${detail}` : ''}`) }
const shot = async (page, name) => { if (!shots) return; await harness.sleep(300); await page.screenshot({ path: path.join(shots, `${name}.png`) }) }
const sieve = page => page.evaluate(async () => { const r = await window.electronAPI.rss.sieveQuery({}); if (!r.success) throw new Error(r.error); return r.data })
const sourceScores = (result, sourceId) => Object.fromEntries([...result.items, ...result.remaining].filter(item => item.sourceId === sourceId).map(item => [item.id, item.sieve.score]))

async function openRSS(page) {
  await harness.requestMode(page, 'rss')
  await page.locator('[data-workbench-mode-panel="rss"][data-mode-visual-state="current"]').waitFor({ timeout: 30000 }).catch(() => {})
  await page.locator('nav[aria-label="资讯导航"]').waitFor({ timeout: 30000 })
}

async function main() {
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-rss-sieve-check-')))
  const profile = path.join(temp, 'profile'), vault = path.join(temp, '测试资料库')
  const fixture = await harness.startFixtureServer()
  let session = null
  try {
    await harness.seedVault({ profile, vault, dataDir: temp, fixtureUrl: fixture.url, log: () => {} })
    session = await harness.launch(profile)
    let { app, page } = session
    await harness.setContentSize(app, page, 1440, 900)
    await openRSS(page)

    // V8: the default view, and why it is empty without a model.
    const view = page.locator('section[aria-label="为你筛过的"]')
    await view.waitFor({ timeout: 30000 })
    ok('V8 资讯 opens on 为你筛过的', await view.isVisible() && await page.locator('nav[aria-label="资讯导航"] [aria-label="为你筛过的"]').getAttribute('aria-current') === 'page')
    await page.locator('.rss-sieve__empty').waitFor({ timeout: 20000 })
    ok('V8 the empty list says the model is missing', /还没有配置可用的模型/.test(await page.locator('.rss-sieve__empty').textContent()))
    const navLabels = await page.locator('nav[aria-label="资讯导航"] .rss-nav__item').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
    ok('§4 the navigator has the new shape', ['为你筛过的', '全部', '未读', '收藏', '新建主题', '日报与简报', '来源', '筛子设置'].every(label => navLabels.includes(label))
      && !navLabels.some(label => ['精选', '历史底稿', '管理栏目'].includes(label)), navLabels.join(' / '))

    // V6: the first-time question shows exactly the titles that would be sent and leaves the answer open.
    const consent = page.locator('aside[aria-label="让筛子参考你正在做的事"]')
    await consent.waitFor({ timeout: 20000 })
    const listed = await consent.locator('[aria-label="将会发送的清单"] li').allTextContents()
    const preview = await page.evaluate(async () => (await window.electronAPI.rss.sieveWorkContext()).data.entries.map(entry => entry.title))
    const privacy = await page.evaluate(async () => (await window.electronAPI.rss.sievePrivacy()).data)
    ok('V6 the question lists the titles that would be sent, verbatim', listed.length > 0 && JSON.stringify(listed) === JSON.stringify(preview), JSON.stringify({ listed, preview }))
    ok('V6 nothing is decided before the answer', privacy.answer === 'unanswered' && privacy.enabled === false)
    await shot(page, 'rss-01-sieve-empty-consent')

    // A manual 属于基础标准 pins an article into 为你筛过的 (B2), which gives the check a real card without a model.
    const pinned = await page.evaluate(async () => {
      const api = window.electronAPI.rss
      const definitions = (await api.getDefinitions()).data
      const curated = (Array.isArray(definitions) ? definitions : definitions.definitions).find(entry => entry.kind === 'curated')
      const cards = (await api.queryCards({ limit: 20 })).data.items
      const article = cards[0]
      const result = await api.setMembership({ itemId: article.id, expectedArticleRevision: article.revision, definitionId: curated.id, expectedRuleRevision: curated.ruleRevision, decision: true })
      if (!result.success) throw new Error(result.error)
      return { id: article.id, sourceId: article.sourceId, title: article.title }
    })
    await page.locator('nav[aria-label="资讯导航"] [aria-label="全部"]').click()
    await page.locator('nav[aria-label="资讯导航"] [aria-label="为你筛过的"]').click()
    const card = page.locator(`[data-sieve-item="${pinned.id}"]`)
    await card.waitFor({ timeout: 20000 })
    ok('a pinned article shows as a card with one reason', (await card.locator('.rss-sieve__reason').textContent()).trim().length > 0)

    // V2: 少看这类 › 这个来源 lowers the source's other articles and is read back after a restart.
    const before = sourceScores(await sieve(page), pinned.sourceId)
    delete before[pinned.id]
    await card.hover()
    await card.locator('[aria-label="少看这类"]').click()
    const reason = page.getByRole('menuitem', { name: /^这个来源：/ })
    await reason.waitFor({ timeout: 10000 })
    await shot(page, 'rss-02-less-reasons')
    await reason.click()
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    await harness.sleep(800)
    const after = sourceScores(await sieve(page), pinned.sourceId)
    const ids = Object.keys(before).filter(id => id in after)
    ok('V2 the source’s other articles score lower right away', ids.length > 0 && ids.every(id => after[id] < before[id]), JSON.stringify({ before, after }))
    await harness.close(app)
    session = await harness.launch(profile)
    ;({ app, page } = session)
    await harness.setContentSize(app, page, 1440, 900)
    await openRSS(page)
    const reread = sourceScores(await sieve(page), pinned.sourceId)
    ok('V2 the lower scores are read back after a restart', ids.every(id => reread[id] !== undefined && reread[id] < before[id]), JSON.stringify({ before, reread }))
    await shot(page, 'rss-03-sieve-after-restart')

    // §4: 全部 offers 包含已移出的 and the three sorts; 筛子设置 opens.
    await page.locator('nav[aria-label="资讯导航"] [aria-label="全部"]').click()
    const archived = page.getByRole('button', { name: '包含已移出的' })
    await archived.waitFor({ timeout: 15000 })
    await archived.click()
    ok('§4 全部 can include articles moved out of the inbox', await page.evaluate(() => JSON.parse(localStorage.getItem('ready-rss-workspace') || '{}').query?.scope === 'library'))
    await page.locator('[aria-label^="资讯排序："]').first().click()
    const sorts = await page.getByRole('menuitemradio').or(page.getByRole('menuitemcheckbox')).or(page.getByRole('menuitem')).allTextContents()
    ok('§4 sorting offers 按相关度', sorts.some(text => text.includes('按相关度')), sorts.join(' / '))
    await page.keyboard.press('Escape')
    await shot(page, 'rss-04-all-with-archive')
    await page.locator('nav[aria-label="资讯导航"] [aria-label="筛子设置"]').click()
    const settings = page.locator('section[aria-label="筛子设置"]')
    await settings.waitFor({ timeout: 15000 })
    ok('§4 筛子设置 opens with its sections', await settings.locator('section[aria-label="我的关注"]').isVisible() && await settings.locator('section[aria-label="额度"]').isVisible())
    await shot(page, 'rss-05-settings')
  } finally {
    if (session) await harness.close(session.app).catch(() => {})
    await fixture.close?.()
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (error) { console.warn('cleanup left files behind:', error.code) }
  }
  console.log(`${passed}/${passed + failed} passed`)
  if (failed) process.exitCode = 1
}

main().catch(error => { console.error(error); process.exitCode = 1 })
