import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { JSDOM } from 'jsdom'

test('calendar leaves global settings/theme keys alone and requests shell actions without changing calendar preferences', async t => {
  const dom = new JSDOM('', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@shared/calendar') return next(new URL('../shared/calendar/index.ts', import.meta.url).href, context)
    if (specifier.startsWith('@shared/')) return next(new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, context)
    return next(specifier, context)
  } })
  t.after(() => { hooks.deregister(); dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const { handleKey, runCommand, registerCalendarCommands } = await import('../renderer/modules/calendar/workbench/commands')
  const store = await import('../renderer/modules/calendar/workbench/store')
  const { listCommands } = await import('../renderer/modules/workbench/commands/registry')
  const off = registerCalendarCommands()
  t.after(off)
  const calendar = listCommands({ mode: 'calendar' })
  for (const id of ['create', 'import', 'export', 'goto', 'today', 'day', 'week', 'month', 'weekends']) assert.ok(calendar.some(command => command.id === `calendar.${id}`), id)
  assert.equal(listCommands({ mode: 'browser' }).some(command => command.id.startsWith('calendar.')), false)
  const before = store.getState()
  t.after(() => store.setState(before))
  for (const key of [',', '\\']) {
    assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key, metaKey: true })), false, key)
    assert.equal(store.getState().overlay, null)
  }
  const actions: string[] = []
  dom.window.addEventListener('ready:shell-action', event => actions.push((event as CustomEvent<{ action: string }>).detail.action))
  assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key: '\\' })), true)
  assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key: 'L', metaKey: true, shiftKey: true })), true)
  assert.deepEqual(actions, ['toggle-sidebar', 'toggle-theme'])
  assert.deepEqual(store.getState().prefs, before.prefs)
  // The g-chords are gone (⌘, opens settings; t and . remain): g is not consumed and opens nothing.
  assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key: 'g' })), false)
  assert.equal(store.getState().overlay, null)
  let prefs = before.prefs
  Object.assign(dom.window, { electronAPI: { calendar: { snapshot: async () => ({ success: true, data: { prefs, events: [], calendars: [], revision: 1 } }), putPreferences: async (patch: Partial<typeof prefs>) => { prefs = { ...prefs, ...patch }; return { success: true, data: { prefs, events: [], calendars: [], revision: 1 } } } } } })
  assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key: '«', code: 'Backslash', metaKey: true, altKey: true })), true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.getState().prefs.contextPanel, !before.prefs.contextPanel)
  assert.equal(store.getState().prefs.sidebar, before.prefs.sidebar)
  await calendar.find(command => command.id === 'calendar.weekends')!.run()
  assert.equal(store.getState().prefs.showWeekends, !before.prefs.showWeekends)
  assert.equal(store.getState().error, null)
  // Go to date opens the calendar's date box in the app's float layer (W1 §5), from ⌘K and from its own command.
  const { isGotoOpen, closeGoto } = await import('../renderer/modules/calendar/workbench/components/Overlays')
  await calendar.find(command => command.id === 'calendar.goto')!.run()
  assert.equal(isGotoOpen(), true)
  closeGoto()
  assert.equal(isGotoOpen(), false)
  assert.equal(runCommand('goto'), true)
  assert.equal(isGotoOpen(), true)
  assert.equal(handleKey(new dom.window.KeyboardEvent('keydown', { key: '.' })), true, 'a second . keeps the one box')
  closeGoto()
  assert.equal(store.getState().overlay, null)
})
