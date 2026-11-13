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
    // S5: one main entry each (counted by accessible name, visible elements only). Mode switching has the rail and,
    // while the assistant shows, the slot above its composer (V20, one state); the slot's tabs are counted apart.
    const named = name => [...document.querySelectorAll('button, [role="button"], a')].filter(el => visible(el) && !el.closest('.draggable-mode-tabs') && ((el.getAttribute('aria-label') || '').trim() === name || (el.getAttribute('aria-label') || '').startsWith(`${name} `)))
    return {
      sidebars: sidebars.length, shown, inside, leftovers, bands, railTop,
      search: named('搜索').filter(el => el.closest('[data-shell-region="rail"]')).length + document.querySelectorAll('.ink-sb-search').length,
      settings: named('设置').length,
      calendar: named('日历').length,
      browser: named('浏览器').length,
      backlinks: named('反向链接').length,
      modeTabs: [...document.querySelectorAll('.draggable-mode-tabs')].filter(visible).length,
      assistantShown: (document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect().width ?? 0) > 0,
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
// A plain click on the current mode's icon toggles the sidebar (V13), so switching clicks only when the mode is not current.
const currentScene = mode => `[data-workbench-mode-panel="${mode}"][data-mode-visual-state="current"]`
async function railSwitch(page, label, mode) {
  if (await page.evaluate(sel => Boolean(document.querySelector(sel)), currentScene(mode))) return
  await railClick(page, label)
}

// V15: the content box is the same in every mode (60px from the top and the bottom of the window), and the sidebar's,
// the panel's and the assistant's header rows lie on one line: each starts at y 60 and is 44px tall.
async function headLine(page) {
  return page.evaluate(() => {
    const shown = el => Boolean(el) && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden'
    const rect = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom) } }
    const nav = [...document.querySelectorAll('[data-shell-navigator]:not([hidden]) .shell-navigator__head')].find(shown)
    const chat = [...document.querySelectorAll('[data-shell-region="assistant"] .chat-header-row')].find(shown)
    const panel = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(shown)
    // The calendar keeps its own top bar as the panel's head: its 44px control row is the head line.
    const head = panel?.querySelector('.rn-panel__head, .topbar-row')
    return { H: window.innerHeight, nav: nav ? rect(nav) : null, chat: chat ? rect(chat) : null, panel: panel ? rect(panel) : null, head: shown(head) ? rect(head) : null }
  })
}

// V17: the assistant's corner button and the four header buttons that ride the path round it, as boxes; the buttons
// are remembered on window, so a later read can tell whether they are still the same elements.
async function assistantTools(page, remember = false) {
  return page.evaluate(keep => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) } }
    const corner = document.querySelector('[data-shell-assistant-tools] [data-assistant-toggle]')
    const beads = [1, 2, 3, 4].map(i => document.querySelector(`[data-shell-assistant-tools] .shell-assistant-tool[data-bead="${i}"]`))
    if (keep) window.__readyAssistantBeads = beads
    const kept = window.__readyAssistantBeads
    const strip = document.querySelector('[data-shell-region="assistant-strip"]')?.getBoundingClientRect()
    return {
      W: window.innerWidth,
      corner: corner ? { ...box(corner), label: corner.getAttribute('aria-label'), expanded: corner.getAttribute('aria-expanded') } : null,
      beads: beads.map(el => (el ? { ...box(el), label: el.getAttribute('aria-label') } : null)),
      same: Boolean(kept) && beads.every((el, i) => el && el === kept[i]),
      strip: strip ? Math.round(strip.width) : null,
      railAssistant: document.querySelectorAll('[data-shell-region="rail"] button[aria-label^="助手"]').length,
    }
  }, remember)
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

    // S2 (V20): modes switch from the rail and from the slot above the assistant composer, one state; the rail also
    // switches with the assistant collapsed. V21: the project chip, then the slot, two liquid-glass pills of one height
    // (40) from the left, 8px apart; the slot is four 44px cells (176px) and its clear lens is flush with it: the slot's
    // full height, touching its end at the first and the last cell, never outside it.
    const slotRow = await page.evaluate(() => {
      const box = sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null }
      const glass = sel => Boolean(document.querySelector(`[data-chat-panel-root] ${sel}`))
      return { slots: document.querySelectorAll('[data-chat-panel-root] .draggable-mode-tabs').length, row: box('[data-chat-panel-root] .ready-chat-composer-context-row'), chip: box('[data-chat-panel-root] .ready-chat-project-pill'), slot: box('[data-chat-panel-root] .draggable-mode-tabs'),
        liquid: glass('.draggable-mode-tabs__surface') && glass('.draggable-mode-tabs__thumb-lens') && (!document.querySelector('[data-chat-panel-root] .ready-chat-project-pill') || glass('.ready-chat-project-surface')) }
    })
    check('V21 the composer row is the project chip then the mode switch slot: liquid glass, one 40px line, 8px apart, inside the row; the slot is 176px',
      slotRow.slots === 1 && slotRow.liquid && slotRow.slot.h === 40 && slotRow.slot.w === 176 && slotRow.slot.right <= slotRow.row.right + 0.5
        && (!slotRow.chip || (slotRow.chip.h === 40 && slotRow.chip.top === slotRow.slot.top && Math.abs(slotRow.slot.left - slotRow.chip.right - 8) < 0.5)), JSON.stringify(slotRow))
    for (const [label, mode] of [['浏览器', 'browser'], ['资讯', 'rss'], ['日历', 'calendar'], ['文档', 'document']]) {
      await railSwitch(page, label, mode)
      check(`rail switches to ${mode}`, await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene(mode)))
      check(`V20 the slot shows ${mode} with the rail`, await waitFor(page, m => document.querySelector('[data-chat-panel-root] .draggable-mode-tabs__icon.is-active')?.getAttribute('data-mode') === m, mode))
    }
    for (const [label, mode] of [['浏览器', 'browser'], ['日历', 'calendar'], ['资讯', 'rss'], ['文档', 'document']]) {
      await page.locator(`[data-chat-panel-root] .draggable-mode-tabs__icon[data-mode="${mode}"]`).click()
      check(`V20 the slot switches to ${mode} and the rail follows`, await waitFor(page, ([sel, name]) => Boolean(document.querySelector(sel))
        && Boolean(document.querySelector(`[data-shell-region="rail"] button[aria-label="${name}"][aria-pressed="true"]`)), [modeScene(mode), label]))
      if (mode !== 'browser' && mode !== 'calendar') continue
      // At the first and the last cell the settled lens is the slot's height, inside it, and flush with that end.
      await harness.sleep(600)
      const fit = await page.evaluate(() => {
        const rect = sel => document.querySelector(`[data-chat-panel-root] ${sel}`)?.getBoundingClientRect()
        const slot = rect('.draggable-mode-tabs'), lens = rect('.draggable-mode-tabs__thumb')
        return slot && lens ? [lens.left - slot.left, slot.right - lens.right, lens.top - slot.top, slot.bottom - lens.bottom, lens.height - slot.height].map(n => Math.round(n * 10) / 10) : null
      })
      const flushEnd = fit && (mode === 'browser' ? fit[0] : fit[1])
      check(`V21 the lens on the ${mode} cell is the slot's height, inside it and flush with its end`,
        Boolean(fit) && fit.slice(0, 4).every(margin => margin >= 0) && Math.abs(fit[4]) <= 0.5 && flushEnd <= 1, JSON.stringify(fit))
    }
    // V17: the assistant's header buttons. Docked: the corner button is the right end of its head row and the four others
    // stand in that row to its left, on the head line (centre y 82). Collapsed: the shell keeps a strip as wide as the rail,
    // the corner button stays exactly where it was, and the same four buttons stand below it in a column on the rail's pitch.
    const pitch = 36
    const docked = await assistantTools(page, true)
    // V31 (experiment): docked and open, the assistant stands on one glass sheet: top and bottom on the central panel's,
    // 8px after it, the frame gap from the window's right edge; inside it the header row starts on its top, and the
    // composer keeps 12px from its left, right and bottom edges.
    // The last slot click may still be sliding its scene in: measure once the current panel has come to rest.
    await waitFor(page, () => {
      const panel = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden')
      const column = document.querySelector('[data-shell-region="content"]')
      return Boolean(panel && column) && Math.abs(panel.getBoundingClientRect().right - column.getBoundingClientRect().right) < 1
    })
    const glass = await page.evaluate(() => {
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
      // The current mode's panel: other modes stay mounted but hidden, with their own stale boxes.
      const panel = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden')
      const sheet = document.querySelector('[data-shell-region="assistant"] .assistant-sheet')
      return {
        W: window.innerWidth, sheet: rect(sheet), panel: rect(panel), radius: sheet ? getComputedStyle(sheet).borderTopLeftRadius : null,
        composer: rect(document.querySelector('[data-chat-composer-shell="true"]')), row: rect(document.querySelector('[data-shell-region="assistant"] .chat-header-row')),
      }
    })
    const g = glass.sheet, p = glass.panel, c = glass.composer
    check('V31 the docked assistant\'s glass sheet: the central panel\'s top and bottom, 8px after it, 8px from the window\'s right edge, radius 20',
      Boolean(g && p) && g.top === p.top && g.bottom === p.bottom && Math.abs(g.left - p.right - 8) <= 1 && g.right === glass.W - 8 && glass.radius === '20px', JSON.stringify(glass))
    check('V31 inside the sheet the header row starts on its top and the composer keeps 12px from its left, right and bottom',
      Boolean(g && c && glass.row) && glass.row.top === g.top && c.bottom === g.bottom - 12 && c.left === g.left + 12 && c.right === g.right - 12, JSON.stringify(glass))
    await page.keyboard.press('Tab')
    const collapsed = await waitFor(page, () => (document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect().width ?? 0) < 1)
    check('Tab collapses the assistant to zero width', collapsed)
    check('V31 collapsed, the glass sheet has left with the panel', await waitFor(page, () => !document.querySelector('[data-shell-region="assistant"] .assistant-sheet')))
    await harness.sleep(600)
    const strip = await assistantTools(page)
    const inRow = docked.beads.every((bead, i) => bead && bead.y === 82 && bead.x === docked.W - 26 - pitch * (i + 1) && bead.w === 32)
    // The beads move as one train: the row read left to right is the column read top to bottom (bead 4 first).
    const inColumn = strip.beads.every((bead, i) => bead && bead.x === strip.W - 26 && bead.y === 82 + pitch * (4 - i) && bead.w === 32)
    const cornerStill = Boolean(docked.corner && strip.corner) && docked.corner.x === strip.corner.x && docked.corner.y === strip.corner.y
      && docked.corner.x === docked.W - 26 && docked.corner.y === 82 && docked.corner.w === 32
    check('V17 collapsed, the shell keeps a 52px strip on the right and the rail has no assistant button', strip.strip === 52 && strip.railAssistant === 0 && docked.railAssistant === 0, JSON.stringify({ strip: strip.strip, rail: strip.railAssistant }))
    check('V17 the corner button keeps one place (centre at window − 26, y 82) and flips 收起助手 / 展开助手',
      cornerStill && docked.corner.label.startsWith('收起助手') && docked.corner.expanded === 'true' && strip.corner.label.startsWith('展开助手') && strip.corner.expanded === 'false',
      JSON.stringify({ docked: docked.corner, collapsed: strip.corner }))
    check('V17 the same four buttons stand in the head row when docked and in a column down the strip when collapsed',
      inRow && inColumn && strip.same, JSON.stringify({ row: docked.beads, column: strip.beads, same: strip.same }))
    await railSwitch(page, '资讯', 'rss')
    check('S2 the rail switches modes with the assistant collapsed', await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('rss')))
    // With the sidebar collapsed as well, the left and right sides mirror (V25): rail | panel | strip, the panel right at
    // both edges, so the icons on either side have equal room.
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    const mirror = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(el => el.getBoundingClientRect().width > 0)?.getBoundingClientRect()
      const rail = document.querySelector('[data-shell-region="rail"]')?.getBoundingClientRect()
      return panel && rail ? { left: Math.round(panel.left - rail.right), right: Math.round(window.innerWidth - 52 - panel.right) } : null
    })
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    check('V17, V25 with both sides collapsed the content panel starts at the rail\'s edge and ends at the strip\'s', mirror && mirror.left === 0 && mirror.right === 0, JSON.stringify(mirror))
    await page.locator('[data-shell-assistant-tools] [data-assistant-toggle]').click()
    check('the corner button brings the assistant back', await waitFor(page, () => (document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect().width ?? 0) > 300))
    await harness.sleep(600)
    const back = await assistantTools(page)
    check('V17 expanding brings the same buttons back into the head row', back.same && back.beads.every((bead, i) => bead && bead.y === 82 && bead.x === back.W - 26 - pitch * (i + 1)), JSON.stringify(back.beads))

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
      check(`S5 ${mode}: one entry each for search, settings and calendar; mode switching in the rail plus the composer's slot (V20); no backlinks entry`,
        frame.search === 1 && frame.settings === 1 && frame.calendar === 1 && frame.browser === 1 && frame.backlinks === 0 && frame.modeTabs === (frame.assistantShown ? 1 : 0),
        JSON.stringify({ search: frame.search, settings: frame.settings, calendar: frame.calendar, browser: frame.browser, backlinks: frame.backlinks, modeTabs: frame.modeTabs, assistantShown: frame.assistantShown }))
      const line = await headLine(page)
      const onLine = r => Boolean(r) && r.top === 60 && r.h === 44
      check(`V15 ${mode}: the panel box is 60px from both window edges; sidebar, panel and assistant heads share one 44px line at y 60`,
        line.panel && line.panel.top === 60 && line.H - line.panel.bottom === 60 && onLine(line.nav) && onLine(line.head) && onLine(line.chat), JSON.stringify(line))
      // V18, V25: the docked sidebar is a panel of the same glass: the content panel's top and bottom, 20px corners, right
      // at the rail's edge and 8px from the content panel.
      const side = await page.evaluate(() => {
        const slot = document.querySelector('[data-shell-sidebar] > .shell-sidebar__slot')
        const panel = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(el => el.getBoundingClientRect().width > 0)
        const rail = document.querySelector('[data-shell-region="rail"]')
        if (!slot || !panel || !rail) return null
        const r = slot.getBoundingClientRect(), p = panel.getBoundingClientRect(), cs = getComputedStyle(slot)
        return { H: window.innerHeight, panel: slot.classList.contains('rn-panel'), painted: cs.backgroundColor !== 'rgba(0, 0, 0, 0)', top: Math.round(r.top), bottom: Math.round(r.bottom),
          radius: cs.borderTopLeftRadius, fromRail: Math.round(r.left - rail.getBoundingClientRect().right), toContent: Math.round(p.left - r.right) }
      })
      check(`V18 ${mode}: the docked sidebar is a panel (y 60 to H − 60, radius 20, at the rail's edge, 8px from the content panel)`,
        side && side.panel && side.painted && side.top === 60 && side.H - side.bottom === 60 && side.radius === '20px' && side.fromRail === 0 && side.toContent === 8, JSON.stringify(side))
      // V22: nothing between a panel and the shell row clips its soft shadow (28px blur): every clipping ancestor of the
      // content panel and of the sidebar's panel is overflow: clip with at least that much margin, none contains paint.
      const clips = await page.evaluate(() => {
        const content = [...document.querySelectorAll('[data-shell-region="content"] .rn-panel')].find(el => el.getBoundingClientRect().width > 0)
        const side = document.querySelector('[data-shell-sidebar] > .shell-sidebar__slot')
        const cut = []
        for (const panel of [content, side]) {
          for (let el = panel?.parentElement; el && !el.matches('[data-workbench-shell]'); el = el.parentElement) {
            const cs = getComputedStyle(el)
            const clipped = cs.overflowX !== 'visible' || cs.overflowY !== 'visible'
            const roomy = cs.overflowX === 'clip' && cs.overflowY === 'clip' && parseFloat(cs.overflowClipMargin || '0') >= 28
            if ((clipped && !roomy) || /paint|strict|content/.test(cs.contain)) cut.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}{${cs.overflowX}/${cs.overflowClipMargin}/${cs.contain}}`)
          }
        }
        return cut
      })
      check(`V22 ${mode}: no ancestor of the content or sidebar panel cuts its shadow`, clips.length === 0, JSON.stringify(clips))
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

    // V23: no switch in the top band; the sidebar opens and closes from the current mode's rail icon and ⌘B. The
    // navigators carry no collapse button, and the window's left edge does not slide the sidebar out.
    await page.keyboard.press('Meta+2')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), currentScene('document'))
    await harness.sleep(400)
    const band = await page.evaluate(() => ({
      buttons: document.querySelectorAll('[data-shell-band="top"] .shell-band-lead button, [data-shell-band="top"] [data-shell-sidebar-control]').length,
      leftovers: document.querySelectorAll('[data-shell-navigator] button:is([aria-label^="收起侧栏"], [aria-label^="展开侧栏"], [aria-label="固定侧栏"]), .shell-edge-reveal').length,
    }))
    check('V23 the top band\'s lead holds no button and the navigators no collapse button', band.buttons === 0 && band.leftovers === 0, JSON.stringify(band))
    // The current mode's rail icon opens and closes the sidebar (as in VS Code); another mode switches and leaves it shown.
    await railClick(page, '文档')
    const collapsedByRail = await waitFor(page, () => (document.querySelector('[data-shell-sidebar]')?.getBoundingClientRect().width ?? 1) < 1)
    await page.mouse.move(56, 420)
    await harness.sleep(600)
    const noEdgePeek = await page.evaluate(() => { const el = document.querySelector('[data-shell-sidebar]'); return !el?.hasAttribute('data-open') && (el?.getBoundingClientRect().width ?? 1) < 1 })
    await railClick(page, '文档')
    const dockedByRail = await waitFor(page, () => (document.querySelector('[data-shell-sidebar]')?.getBoundingClientRect().width ?? 0) > 100)
    // V23: switching modes moves the navigators vertically and leaves exactly one shown once the content has settled.
    await railClick(page, '日历')
    const otherModeSwitched = await waitFor(page, sel => Boolean(document.querySelector(sel)), currentScene('calendar'))
    await harness.sleep(600)
    const stillShown = (await sidebarWidth()) > 100
    const settled = await page.evaluate(() => ({
      shown: [...document.querySelectorAll('[data-shell-navigator]')].filter(node => !node.hidden).map(node => node.getAttribute('data-shell-navigator')),
      moving: document.querySelectorAll('[data-shell-navigator][data-nav-motion]').length,
    }))
    check('V23 the current mode\'s rail icon closes and opens the sidebar; the left edge does not slide it out',
      collapsedByRail && noEdgePeek && dockedByRail, JSON.stringify({ collapsedByRail, noEdgePeek, dockedByRail }))
    check('V23 another mode switches and keeps the sidebar shown; afterwards exactly its navigator shows and none is mid-transition',
      otherModeSwitched && stillShown && settled.shown.length === 1 && settled.shown[0] === 'calendar' && settled.moving === 0, JSON.stringify({ otherModeSwitched, stillShown, settled }))

    const before = await sidebarWidth()
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    const after = await sidebarWidth()
    await page.keyboard.press('Meta+b')
    await harness.sleep(700)
    check('⌘B collapses and restores the sidebar', before > 100 && after < 1 && (await sidebarWidth()) > 100, `${before} → ${after}`)

    // ⌥-click opens a split; ⌥-click again closes it.
    await railSwitch(page, '文档', 'document')
    await waitFor(page, sel => Boolean(document.querySelector(sel)), modeScene('document'))
    await railClick(page, '日历', ['Alt'])
    check('⌥-click opens the mode beside the current one', await waitFor(page, () => Boolean(document.querySelector('[data-workbench-split-layout="true"]'))))
    await railClick(page, '日历', ['Alt'])
    check('⌥-click again closes the split', await waitFor(page, () => !document.querySelector('[data-workbench-split-layout="true"]')))

    // G1 / T2: the content column keeps at least 560px at four widths; narrow windows float the assistant first.
    await railSwitch(page, '浏览器', 'browser')
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
    await page.locator('[data-shell-assistant-tools] [data-assistant-toggle]').click()
    check('S4 the assistant drawer makes the web view step aside', await waitNative(app, false))
    // V17: the card opens beside the strip and never covers it; the corner button stays in the strip, in its place.
    await harness.sleep(400)
    const drawerSide = await page.evaluate(() => {
      const card = document.querySelector('[data-chat-panel-root]')?.getBoundingClientRect()
      const strip = document.querySelector('[data-shell-region="assistant-strip"]')?.getBoundingClientRect()
      const corner = document.querySelector('[data-shell-assistant-tools] [data-assistant-toggle]')?.getBoundingClientRect()
      // V31: the card is the glass here; the sheet inside it paints nothing.
      const sheet = document.querySelector('[data-shell-region="assistant"] .assistant-sheet')
      const sheetPainted = Boolean(sheet) && (getComputedStyle(sheet).position === 'absolute' || getComputedStyle(sheet).backgroundColor !== 'rgba(0, 0, 0, 0)')
      return card && strip && corner ? { cardRight: Math.round(card.right), cardTop: Math.round(card.top), stripLeft: Math.round(strip.left), stripWidth: Math.round(strip.width), corner: Math.round(corner.x + corner.width / 2), W: window.innerWidth, sheetPainted } : null
    })
    check('V17 the narrow-window assistant card opens beside the strip (8px from it) and the corner button stays in the strip; no second sheet inside (V31)',
      drawerSide && drawerSide.stripWidth === 52 && drawerSide.cardRight === drawerSide.stripLeft - 8 && drawerSide.cardTop === 60 && drawerSide.corner === drawerSide.W - 26 && !drawerSide.sheetPainted, JSON.stringify(drawerSide))
    // A click on the content closes the drawer (W2 §2.5); Tab inside the composer keeps moving focus.
    const content = await page.locator('[data-shell-region="content"]').boundingBox()
    await page.mouse.click(content.x + 40, content.y + 20)
    check('S4 closing the drawer brings the web view back', await waitNative(app, true))
    await harness.sleep(600)
    const placement = await page.evaluate(() => { const r = document.querySelector('[data-ready-native-surface="browser"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })
    const views = await nativeViews(app)
    const aligned = placement && views.some(b => Math.abs(b.x - placement.x) <= 2 && Math.abs(b.y - placement.y) <= 2 && Math.abs(b.width - placement.w) <= 2 && Math.abs(b.height - placement.h) <= 2)
    check('S4 the restored web view lines up with the content area', aligned, `${JSON.stringify(placement)} vs ${JSON.stringify(views)}`)

    // V14: too narrow to dock (under 920px) the sidebar is a float-glass card laid over the content like a panel: top and
    // bottom on the panel's, the frame gap from the rail, 20px corners. The current rail icon and ⌘B open it; Esc, a press
    // outside it and the rail icon close it; moving the pointer away does not (V23). The web view steps aside meanwhile.
    await harness.setContentSize(app, page, 820, 860)
    const card = () => page.evaluate(() => {
      const el = document.querySelector('[data-shell-sidebar]')
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        dock: document.querySelector('[data-workbench-shell]')?.getAttribute('data-shell-sidebar-dock'),
        open: el.getAttribute('data-open'), overlay: el.getAttribute('data-ready-native-overlay'), float: el.classList.contains('rn-float'),
        visibility: cs.visibility, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), H: window.innerHeight,
        radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      }
    })
    const cardIs = open => waitFor(page, value => document.querySelector('[data-shell-sidebar]')?.getAttribute('data-open') === value, String(open))
    const atStart = await card()
    await railClick(page, '浏览器')
    const openedByRail = await cardIs(true)
    await harness.sleep(500)
    const opened = await card()
    const webAside = await waitNative(app, false)
    await page.mouse.move(700, 600)
    await harness.sleep(500)
    const keptOnLeave = (await card()).open === 'true'
    await page.keyboard.press('Escape')
    const closedByEsc = await cardIs(false)
    await page.keyboard.press('Meta+b')
    const openedByKey = await cardIs(true)
    const contentBox = await page.locator('[data-shell-region="content"]').boundingBox()
    await page.mouse.click(contentBox.x + contentBox.width - 40, contentBox.y + contentBox.height / 2)
    const closedByOutside = await cardIs(false)
    await railClick(page, '浏览器')
    await cardIs(true)
    await railClick(page, '浏览器')
    const closedByRail = await cardIs(false)
    await page.keyboard.press('Meta+b')
    await cardIs(true)
    await page.keyboard.press('Meta+b')
    const closedByKey = await cardIs(false)
    const webBack = await waitNative(app, true)
    check('V14 the narrow-window sidebar is a float card aligned with the panel, inset from the rail, round on all four corners',
      atStart.dock === 'floating' && atStart.open === 'false' && atStart.visibility === 'hidden' && opened.float && opened.overlay === 'shell-sidebar'
        && opened.top === 60 && opened.H - opened.bottom === 60 && opened.left === 60 && opened.radii.every(radius => radius === '20px'),
      JSON.stringify({ atStart, opened }))
    check('V14 the current rail icon and ⌘B open the card; Esc, a press outside, the rail icon and ⌘B close it; leaving it does not',
      openedByRail && keptOnLeave && closedByEsc && openedByKey && closedByOutside && closedByRail && closedByKey,
      JSON.stringify({ openedByRail, keptOnLeave, closedByEsc, openedByKey, closedByOutside, closedByRail, closedByKey }))
    check('V14 the web view steps aside while the card is open and comes back after', webAside && webBack, JSON.stringify({ webAside, webBack }))

    // The brand dot in the top-right corner opens 今日 (the document mode's system tab, W6 §5).
    await harness.setContentSize(app, page, 1440, 900)
    const dot = await page.locator('[data-shell-band="top"] button[aria-label="今日"]').boundingBox()
    check('the brand dot sits in the top-right corner', dot && dot.x > 1440 - 140 && dot.y < 52, JSON.stringify(dot))
    await page.locator('[data-shell-band="top"] button[aria-label="今日"]').click()
    check('the brand dot opens 今日', await waitFor(page, () => (document.querySelector('section.today')?.getBoundingClientRect().width ?? 0) > 0))

    // V12, V24: the wordmark "Ready" is the first thing in the top band, as far after the traffic lights as they are from the window's edge (x 100), set in the
    // wordmark font (Instrument Serif) at 22px; its line box is centred in the band and raised 1.3px for its visual centre.
    const wordmark = await page.evaluate(async () => {
      const el = document.querySelector('[data-shell-band="top"] .shell-wordmark')
      if (!el) return null
      await document.fonts.ready
      const cs = getComputedStyle(el)
      const first = value => value.split(',')[0].replace(/['"]/g, '').trim()
      const family = first(cs.fontFamily)
      return {
        text: el.textContent, family, token: first(getComputedStyle(document.documentElement).getPropertyValue('--rn-font-wordmark')),
        loaded: document.fonts.check(`${cs.fontSize} "${family}"`), size: cs.fontSize, weight: cs.fontWeight,
        left: Math.round(el.getBoundingClientRect().left), centre: Math.round((el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) * 10 / 2) / 10,
        first: el.closest('.shell-band-lead')?.firstElementChild === el,
      }
    })
    check('V12, V24 the wordmark "Ready" leads the top band at x 100, in the wordmark font at 22px / 400, raised 1.3px off the band centre',
      Boolean(wordmark) && wordmark.text === 'Ready' && wordmark.family === wordmark.token && wordmark.loaded && wordmark.size === '22px' && wordmark.weight === '400'
        && wordmark.first && wordmark.left === 100 && Math.abs(wordmark.centre - (26 - 1.3)) <= 0.2,
      JSON.stringify(wordmark))

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
    // B13: the calendar's preference pages are a tab row inside the settings card, not a secondary sidebar.
    check('S6 设置 › 日历 holds the calendar\'s own preference pages', await waitFor(session.page, () => Boolean(document.querySelector('[data-testid="calendar-settings"] [role="tablist"][aria-label="日历设置"] [role="tab"]')), undefined, 15000))
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
