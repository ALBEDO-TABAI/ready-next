#!/usr/bin/env node
// W2 shell contracts in a real window (docs/superpowers/plans/2026-11-11-ready-next-w2-shell-unification-implementation.md
// §6, T8). Started in batch B3 with what the skeleton can already prove; B6 adds S1, S5–S8.
// Build first (npx electron-vite build). Hidden window, throwaway profile and seeded vault only.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const harness = require('./design-matrix/harness.cjs')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const modeScene = mode => mode === 'document'
  ? '.ink-doc-app'
  : `[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`
const MODES = [['1', 'browser'], ['2', 'document'], ['3', 'rss'], ['4', 'calendar']]

// S1: the shell's one sidebar shows the current mode's navigator; no navigator is left inside a mode
// panel. S8: both bands stay 52px in every mode (a tall navigator once squeezed the top band).
async function shellFrame(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
    const sidebars = document.querySelectorAll('[data-shell-sidebar]')
    const shown = [...document.querySelectorAll('[data-shell-navigator]')].filter(node => !node.hidden).map(node => node.getAttribute('data-shell-navigator'))
    const inside = shown.length === 1 && Boolean(sidebars[0]?.querySelector(`[data-shell-navigator="${shown[0]}"]:not([hidden])`))
    const leftovers = document.querySelectorAll('[data-workbench-mode-panel] :is(.ink-sidebar, .rss-nav, .sidebar[data-testid="sidebar"], [data-browser-tab-list], .vertical-tab-rail)').length
    const bands = ['top', 'bottom'].map(side => Math.round(document.querySelector(`[data-shell-band="${side}"]`)?.getBoundingClientRect().height ?? -1))
    const railTop = Math.round(document.querySelector('[data-shell-region="rail"]')?.getBoundingClientRect().top ?? -1)
    // S5: one main entry each (counted by accessible name, visible elements only).
    const named = name => [...document.querySelectorAll('button, [role="button"], a')].filter(el => visible(el) && ((el.getAttribute('aria-label') || '').trim() === name || (el.getAttribute('aria-label') || '').startsWith(`${name} `)))
    return {
      sidebars: sidebars.length, shown, inside, leftovers, bands, railTop,
      search: named('搜索').filter(el => el.closest('[data-shell-region="rail"]')).length + document.querySelectorAll('.ink-sb-search').length,
      settings: named('设置').length,
      calendar: named('日历').length,
      browser: named('浏览器').length,
      backlinks: named('反向链接').length,
      modeTabs: document.querySelectorAll('[data-chat-mode-tabs-dock], .draggable-mode-tabs').length,
    }
  })
}

async function waitFor(page, predicate, arg, timeout = 15000) {
  return page.waitForFunction(predicate, arg, { timeout }).then(() => true, () => false)
}

// A native web view counts as visible when it sits inside the window with a real size; hidden
// views are parked off-screen (same rule as verify-ready-next-object-ui).
async function nativeViews(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap(win => (win.contentView.children || [])
    .filter(view => view.webContents)
    .map(view => view.getBounds())
    .filter(b => b.x >= 0 && b.y >= 0 && b.width > 1 && b.height > 1)))
}
async function waitNative(app, visible, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (((await nativeViews(app)).length > 0) === visible) return true
    await harness.sleep(200)
  }
  return false
}

async function railClick(page, label, modifiers = []) {
  await page.locator(`[data-shell-region="rail"] button[aria-label^="${label}"]`).first().click({ modifiers })
}

async function main() {
  for (const file of ['out/main/index.js', 'out/renderer/index.html']) {
    if (!fs.existsSync(path.join(harness.REPO, file))) throw new Error(`missing ${file}: run npx electron-vite build first`)
  }
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-shell-')))
  const profile = path.join(temp, 'profile')
  const fixture = await harness.startFixtureServer()
  let session = null
  try {
    await harness.seedVault({ profile, vault: path.join(temp, '测试资料库'), dataDir: temp, fixtureUrl: fixture.url, log: () => {} })
    session = await harness.launch(profile)
    const { app, page } = session

    // S2: the assistant holds no mode switcher; the rail switches modes, also with the assistant collapsed.
    const switcherInAssistant = await page.evaluate(() => document.querySelectorAll('[data-chat-panel-root] [data-chat-mode-tabs-dock], [data-chat-panel-root] .draggable-mode-tabs').length)
    check('S2 the assistant panel has no mode switcher', switcherInAssistant === 0)
    for (const [label, mode] of [['浏览器', 'browser'], ['资讯', 'rss'], ['日历', 'calendar'], ['文档', 'document']]) {
      await railClick(page, label)
      check(`rail switches to ${mode}`, await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene(mode)))
    }
    await page.keyboard.press('Tab')
    const collapsed = await waitFor(page, () => (document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect().width ?? 0) < 1)
    check('Tab collapses the assistant to zero width', collapsed)
    check('the rail shows the assistant button while it is collapsed', await page.locator('[data-shell-region="rail"] button[aria-label^="助手"]').count() === 1)
    await railClick(page, '资讯')
    check('S2 the rail switches modes with the assistant collapsed', await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('rss')))
    await railClick(page, '助手')
    check('the rail button brings the assistant back', await waitFor(page, () => (document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect().width ?? 0) > 300))

    // ⌘1–4 and ⌘B.
    for (const [key, mode] of [['1', 'browser'], ['2', 'document'], ['3', 'rss'], ['4', 'calendar']]) {
      await page.keyboard.press(`Meta+${key}`)
      check(`⌘${key} switches to ${mode}`, await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene(mode)))
    }
    const sidebarWidth = () => page.evaluate(() => document.querySelector('[data-shell-sidebar]')?.getBoundingClientRect().width ?? 0)
    // S1 / S5 / S8 in each of the four modes.
    for (const [key, mode] of MODES) {
      await page.keyboard.press(`Meta+${key}`)
      await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene(mode))
      await harness.sleep(600)
      const frame = await shellFrame(page)
      check(`S1 ${mode}: one sidebar showing the ${mode} navigator`, frame.sidebars === 1 && frame.shown.length === 1 && frame.shown[0] === mode && frame.inside, JSON.stringify({ sidebars: frame.sidebars, shown: frame.shown }))
      check(`S1 ${mode}: no navigator left inside a mode panel`, frame.leftovers === 0, String(frame.leftovers))
      check(`S8 ${mode}: both bands 52px and the rail starts under the top band`, frame.bands[0] === 52 && frame.bands[1] === 52 && frame.railTop === 52, `${frame.bands.join('/')} rail ${frame.railTop}`)
      check(`S5 ${mode}: one entry each for search, settings, calendar and mode switching; no backlinks entry`,
        frame.search === 1 && frame.settings === 1 && frame.calendar === 1 && frame.browser === 1 && frame.backlinks === 0 && frame.modeTabs === 0,
        JSON.stringify({ search: frame.search, settings: frame.settings, calendar: frame.calendar, browser: frame.browser, backlinks: frame.backlinks, modeTabs: frame.modeTabs }))
    }

    // S7: inside the calendar, ⌘, is global settings and ⌘\ is the theme, as everywhere else.
    await page.keyboard.press('Meta+4')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('calendar'))
    await page.locator('[data-testid="ready-calendar"]').click({ position: { x: 600, y: 400 } }).catch(() => {})
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme)
    await page.keyboard.press('Meta+Backslash')
    const themeFlipped = await waitFor(page, previous => document.documentElement.dataset.theme && document.documentElement.dataset.theme !== previous, themeBefore, 5000)
    await page.keyboard.press('Meta+Backslash')
    await waitFor(page, previous => document.documentElement.dataset.theme === previous, themeBefore, 5000)
    check('S7 ⌘\\ in the calendar switches the theme', themeFlipped)
    await page.keyboard.press('Meta+Comma')
    const settingsOpened = await waitFor(page, () => location.hash.startsWith('#/settings'), undefined, 5000)
    const calendarSettings = await page.locator('[data-testid="settings"]').count()
    check('S7 ⌘, in the calendar opens the global settings', settingsOpened && calendarSettings === 0)
    if (settingsOpened) {
      await page.evaluate(() => { location.hash = '#/workbench' })
      await waitFor(page, () => Boolean(document.querySelector('[data-workbench-shell]')), undefined, 20000)
      await harness.sleep(1500)
    }

    // The collapsed sidebar slides out from the window's left edge, and the header button pins it back.
    await page.keyboard.press('Meta+2')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('document'))
    await page.locator('[data-shell-navigator="document"] button[aria-label="收起侧栏"]').click()
    // Collapsed on a wide window the sidebar is a zero-width column; only a slide-out carries data-open.
    const collapsedByButton = await waitFor(page, () => (document.querySelector('[data-shell-sidebar]')?.getBoundingClientRect().width ?? 1) < 1)
    await page.mouse.move(56, 420)
    const peeked = await waitFor(page, () => document.querySelector('[data-shell-sidebar]')?.getAttribute('data-open') === 'true')
    await page.locator('[data-shell-navigator="document"] button[aria-label="固定侧栏"]').click()
    const pinned = await waitFor(page, () => { const el = document.querySelector('[data-shell-sidebar]'); return !el?.hasAttribute('data-open') && (el?.getBoundingClientRect().width ?? 0) > 100 })
    check('the header button collapses the sidebar, the left edge peeks it, the pin docks it', collapsedByButton && peeked && pinned, JSON.stringify({ collapsedByButton, peeked, pinned }))

    const before = await sidebarWidth()
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    const after = await sidebarWidth()
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    check('⌘B collapses and restores the sidebar', before > 100 && after < 1 && (await sidebarWidth()) > 100, `${before} → ${after}`)

    // ⌥-click opens a split; ⌥-click again closes it.
    await railClick(page, '文档')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('document'))
    await railClick(page, '日历', ['Alt'])
    check('⌥-click opens the mode beside the current one', await waitFor(page, () => Boolean(document.querySelector('[data-workbench-split-layout="true"]'))))
    await railClick(page, '日历', ['Alt'])
    check('⌥-click again closes the split', await waitFor(page, () => !document.querySelector('[data-workbench-split-layout="true"]')))

    // G1 / T2: the content column keeps at least 560px at four widths; narrow windows float the assistant first.
    await railClick(page, '浏览器')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('browser'))
    await page.evaluate(url => window.electronAPI.browser.createTab(url), `${fixture.url}/a/1`)
    for (const width of [1440, 1280, 1100, 980]) {
      await harness.setContentSize(app, page, width, 860)
      const state = await page.evaluate(() => {
        const shell = document.querySelector('[data-workbench-shell]')
        const content = document.querySelector('[data-shell-region="content"]')
        return { sidebar: shell?.getAttribute('data-shell-sidebar-dock'), assistant: shell?.getAttribute('data-shell-assistant-dock'), content: Math.round(content?.getBoundingClientRect().width ?? 0) }
      })
      check(`${width}px keeps the content at least 560px (${state.sidebar}/${state.assistant})`, state.content >= 560, `${state.content}px`)
    }

    // S4: at 980 the assistant is a drawer; opening it hides the native web view, closing restores it in place.
    await harness.setContentSize(app, page, 980, 860)
    check('the web page is visible before the drawer opens', await waitNative(app, true))
    await railClick(page, '助手')
    check('S4 the assistant drawer makes the web view step aside', await waitNative(app, false))
    // A click on the content closes the drawer (W2 §2.5); Tab inside the composer keeps moving focus.
    const content = await page.locator('[data-shell-region="content"]').boundingBox()
    await page.mouse.click(content.x + 40, content.y + 20)
    check('S4 closing the drawer brings the web view back', await waitNative(app, true))
    await harness.sleep(600)
    const placement = await page.evaluate(() => { const r = document.querySelector('[data-ready-native-surface="browser"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })
    const views = await nativeViews(app)
    const aligned = placement && views.some(b => Math.abs(b.x - placement.x) <= 2 && Math.abs(b.y - placement.y) <= 2 && Math.abs(b.width - placement.w) <= 2 && Math.abs(b.height - placement.h) <= 2)
    check('S4 the restored web view lines up with the content area', aligned, `${JSON.stringify(placement)} vs ${JSON.stringify(views)}`)

    // The brand dot in the top-right corner opens 今日 (document home).
    await harness.setContentSize(app, page, 1440, 900)
    const dot = await page.locator('[data-shell-band="top"] button[aria-label="今日"]').boundingBox()
    check('the brand dot sits in the top-right corner', dot && dot.x > 1440 - 140 && dot.y < 52, JSON.stringify(dot))
    await page.locator('[data-shell-band="top"] button[aria-label="今日"]').click()
    check('the brand dot opens 今日', await waitFor(page, () => (document.querySelector('.ink-home')?.getBoundingClientRect().width ?? 0) > 0))

    // DL11a: the two bands are equally tall.
    const bands = await page.evaluate(() => ['top', 'bottom'].map(side => Math.round(document.querySelector(`[data-shell-band="${side}"]`)?.getBoundingClientRect().height ?? -1)))
    check('the top and bottom bands are equally tall (52px)', bands[0] === 52 && bands[1] === 52, bands.join('/'))

    // S6: settings are honest — no sample data, the W2 §3.2 groups, the new sections render, and every
    // toggle reads back after a restart.
    const openSettings = async section => {
      await session.page.evaluate(id => { location.hash = `#/settings?section=${id}` }, section)
      await waitFor(session.page, () => Boolean(document.querySelector('.settings-page-shell')), undefined, 20000)
      await harness.sleep(900)
    }
    await openSettings('appearance')
    const settingsText = await session.page.evaluate(() => document.querySelector('.settings-page-shell')?.textContent ?? '')
    const groups = await session.page.evaluate(() => [...document.querySelectorAll('.sx-nav-group-label')].map(node => node.textContent?.trim()))
    check('S6 settings carry no sample account data and no unsaved general switches', !/Ready User|user@ready\.app|界面语言|推送通知|使用分析|崩溃报告/.test(settingsText))
    check('S6 settings are grouped as 通用 / 助手 / 内容 / 隐私与数据 / 关于', JSON.stringify(groups) === JSON.stringify(['通用', '助手', '内容', '隐私与数据', '关于']), JSON.stringify(groups))
    await openSettings('library')
    check('S6 设置 › 资料库 shows where the library lives', await waitFor(session.page, root => document.querySelector('.settings-page-shell')?.textContent?.includes(root), path.join(temp, '测试资料库'), 10000))
    await openSettings('calendar')
    check('S6 设置 › 日历 holds the calendar\'s own preference pages', await waitFor(session.page, () => Boolean(document.querySelector('[data-testid="calendar-settings"] [data-testid="set-nav-general"]')), undefined, 15000))
    await openSettings('privacy')
    const readToggles = () => session.page.evaluate(() => [...document.querySelectorAll('.settings-page-shell [role="switch"]')].map(node => node.getAttribute('aria-checked')))
    const toggleCount = (await readToggles()).length
    const original = await readToggles()
    const switches = session.page.locator('.settings-page-shell [role="switch"]')
    for (let index = 0; index < toggleCount; index++) { await switches.nth(index).click(); await harness.sleep(300) }
    const flipped = await readToggles()
    await harness.close(session.app)
    session = await harness.launch(profile)
    await openSettings('privacy')
    const reread = await readToggles()
    check('S6 every privacy switch reads back after a restart', toggleCount === 2 && JSON.stringify(reread) === JSON.stringify(flipped) && JSON.stringify(flipped) !== JSON.stringify(original), JSON.stringify({ original, flipped, reread }))
    const restore = session.page.locator('.settings-page-shell [role="switch"]')
    for (let index = 0; index < toggleCount; index++) { await restore.nth(index).click(); await harness.sleep(300) }
  } finally {
    if (session) await harness.close(session.app)
    fixture.server.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) process.exitCode = 1
}

main().catch(error => { console.error(error); process.exit(1) })
