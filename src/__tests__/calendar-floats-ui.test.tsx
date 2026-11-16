import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'

// B13 (W1-T5): the calendar's menus, its date box and its notices are the shared primitives in the app's one float
// layer, and its grid metrics come from Ready's own tokens rather than numbers measured from a reference product.
test('calendar menus, the date box and toasts open through the shared float layer and act on the calendar', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: (value: string) => Array.from(value, char => `\\${char.codePointAt(0)!.toString(16)} `).join('') },
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@shared/calendar') return next(new URL('../shared/calendar/index.ts', import.meta.url).href, context)
    if (specifier.startsWith('@shared/')) return next(new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, context)
    return next(specifier, context)
  } })
  const { createRoot } = await import('react-dom/client')
  const ui = await import('../renderer/components/ui')
  const { getToasts } = await import('../renderer/components/ui/toast-store')
  const store = await import('../renderer/modules/calendar/workbench/store')
  const { setLocale } = await import('../renderer/modules/calendar/workbench/i18n')
  const { openCalendarMenu } = await import('../renderer/modules/calendar/workbench/components/Menus')
  const { openGoto, isGotoOpen } = await import('../renderer/modules/calendar/workbench/components/Overlays')
  const { parseIsoDate } = await import('../shared/calendar/dates')
  setLocale('zh-CN')

  // Production IPC shape: preferences go through putPreferences and come back as a snapshot.
  const calendar = { id: 'work', name: '工作', color: '#5B8DEF', visible: true, primary: true, readOnly: false, accountId: 'local' }
  const start = Date.parse('2026-11-12T10:00:00Z')
  const event = { id: 'e1', uid: 'e1@test', calendarId: 'work', title: '选题会', start, end: start + 3600000, allDay: false, timeZone: 'UTC', status: 'confirmed', transparency: 'opaque', revision: 1, createdAt: start, updatedAt: start }
  let prefs: Record<string, unknown> = { ...store.defaultPrefs(), primaryTimeZone: 'UTC', locale: 'zh-CN', gridView: 'default', daysPerPeriod: 7 }
  const putCalls: Record<string, unknown>[] = []
  const snapshot = () => ({ success: true, data: { prefs, calendars: [calendar], events: [event], revision: 1 } })
  Object.assign(dom.window, { electronAPI: { calendar: {
    snapshot: async () => snapshot(), onChanged: () => () => {},
    putPreferences: async (patch: Record<string, unknown>) => { putCalls.push(patch); prefs = { ...prefs, ...patch }; return snapshot() },
  } } })
  await store.init()
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => { ui.closeAllFloats(); root.unmount() })
    hooks.deregister(); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  })
  await act(async () => root.render(<ui.FloatHost />))
  const doc = dom.window.document
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  // The view menu is the shared menu: named, checkable, and choosing writes the preference.
  await act(async () => openCalendarMenu('view', { x: 20, y: 20 }))
  const menu = doc.querySelector<HTMLElement>('[role="menu"]')!
  assert.equal(menu.getAttribute('aria-label'), '视图设置')
  assert.ok(menu.closest('[data-float-id]')?.classList.contains('rn-float'), 'the menu sits in the float material')
  const item = (name: string) => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(node => node.querySelector('.rn-menu__label')?.textContent === name)!
  assert.equal(item('周').getAttribute('aria-checked'), 'true')
  await act(async () => item('月').click())
  await settle()
  assert.equal(doc.querySelector('[role="menu"]'), null, 'choosing closes the menu')
  assert.deepEqual(putCalls.at(-1), { gridView: 'month' })
  assert.equal(store.getState().prefs.gridView, 'month')

  // The event's context menu: the calendar's colour row above the shared menu items.
  const key = store.getState().events.e1 && 'e1'
  await act(async () => openCalendarMenu('chip', { x: 40, y: 40 }, { key }))
  const colours = doc.querySelectorAll('[role="group"][aria-label="日程颜色"] button')
  assert.equal(colours.length, 17)
  assert.deepEqual([...doc.querySelectorAll('[role="menu"] .rn-menu__label')].map(node => node.textContent), ['剪切', '拷贝', '复制', '删除'])
  await act(async () => ui.closeAllFloats())

  // “.” opens one date box; a typed date moves the calendar there and closes it.
  await act(async () => openGoto())
  await act(async () => openGoto())
  assert.equal(doc.querySelectorAll('[data-testid="goto"]').length, 1)
  const input = doc.querySelector<HTMLInputElement>('[data-testid="goto"] input')!
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setValue.call(input, '2026-12-25'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  assert.match(doc.querySelector('.cal-goto-hit')!.textContent!, /十二月 25 日/)
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  assert.equal(store.getState().anchor, parseIsoDate('2026-12-25'))
  assert.equal(isGotoOpen(), false)

  // A calendar toast is the shared toast; an undo becomes its action.
  let undone = 0
  store.toast('日程已删除', () => { undone++ })
  const shown = getToasts().at(-1)!
  assert.equal(shown.message, '日程已删除')
  assert.deepEqual(shown.actions?.map(action => action.label), ['撤销'])
  shown.actions![0].onClick()
  assert.equal(undone, 1)
})

test('calendar grid metrics come from Ready design tokens (M8: no measured reference geometry)', async () => {
  const { G, CHIP, gutterWidth, allDayHeight } = await import('../renderer/modules/calendar/workbench/geometry')
  const tokens = readFileSync('src/renderer/design/next/tokens.css', 'utf8')
  const px = (name: string) => Number(tokens.match(new RegExp(`${name}:\\s*(\\d+)px`))![1])
  assert.equal(G.colHeader, px('--rn-row-h'))
  assert.equal(G.monthColHeader, px('--rn-row-h'))
  assert.equal(G.allDayBase, px('--rn-control-h'))
  assert.equal(allDayHeight(2), 52)
  assert.equal(G.defaultHour, px('--rn-s14'))
  assert.equal(G.defaultHour / 2, px('--rn-control-h'), 'half an hour is one control high')
  assert.equal(G.zoneColumn, px('--rn-s14'))
  assert.equal(gutterWidth(1), px('--rn-s2') + px('--rn-s14'))
  assert.equal(CHIP.barHeight, px('--rn-s5'))
  assert.equal(CHIP.barGap, px('--rn-s1'))
})
