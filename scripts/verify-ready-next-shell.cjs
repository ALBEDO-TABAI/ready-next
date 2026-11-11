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
    check('the brand dot opens 今日', await waitFor(page, () => Boolean(document.querySelector('.ink-doc-app .ink-sb-home-pill.is-active'))))

    // DL11a: the two bands are equally tall.
    const bands = await page.evaluate(() => ['top', 'bottom'].map(side => Math.round(document.querySelector(`[data-shell-band="${side}"]`)?.getBoundingClientRect().height ?? -1)))
    check('the top and bottom bands are equally tall (52px)', bands[0] === 52 && bands[1] === 52, bands.join('/'))
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
