import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'

test('C9 document layer lists pending and delivered reminders, opens the source, and clears old-vault responses', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const navigation = 'data:text/javascript,' + encodeURIComponent('export const opened=[];export async function openReadyRef(ref){opened.push(ref)}')
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@shared/calendar') return next(new URL('../shared/calendar/index.ts', import.meta.url).href, context)
    if (specifier.startsWith('@shared/')) return next(new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, context)
    if (specifier.endsWith('/workbench/open-ready-ref') && context.parentURL?.includes('/layers/')) return { url: navigation, shortCircuit: true }
    return next(specifier, context)
  } })
  const { createRoot } = await import('react-dom/client')
  const { LayerDay } = await import('../renderer/modules/calendar/workbench/layers/LayerDays')
  const { useLayerEntries } = await import('../renderer/modules/calendar/workbench/layers/use-layer-entries')
  const { parseIsoDate } = await import('../shared/calendar/dates')
  type Reminder = import('../shared/calendar/date-mentions').DateMentionReminder
  let rows: Reminder[] = [{ id: 'date-mention:one', objectId: 'doc', title: '交稿', date: '2026-10-31', timeZone: 'UTC',
    start: 0, end: 20, text: '', startTime: Date.parse('2026-10-31T12:00Z') / 1000, offsetMinutes: 0, revision: 1, deliveredAt: null }]
  let changed = () => {}, vaultChanged = () => {}, delay = false
  let stale: ((rows: Reminder[]) => void) | undefined
  Object.assign(dom.window, { electronAPI: {
    calendarLayers: { query: async () => ({ ok: true, value: [] }), onChanged: () => () => {} },
    dateMentions: { takeOpen: async () => null, onOpen: () => () => {}, list: async () => { if (delay) { delay = false; return new Promise<Reminder[]>(resolve => { stale = resolve }) } return rows },
      onChanged: (handler: () => void) => { changed = handler; return () => {} } },
    vault: { onChanged: (handler: () => void) => { vaultChanged = handler; return () => {} } },
  } })
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  function Harness() {
    const data = useLayerEntries(parseIsoDate('2026-10-31'), parseIsoDate('2026-11-01'), 'UTC', true)
    return <LayerDay date="2026-10-31" entries={data.entries} enabled={{ events: true, documents: true, tasks: true, footprints: true }} move={data.move} />
  }
  await act(async () => root.render(<Harness />))
  assert.match(document.body.textContent!, /待提醒 · 交稿/)
  assert.equal(document.querySelector('button')!.draggable, false)
  await act(async () => document.querySelector('button')!.click())
  const { opened } = await import(navigation)
  assert.deepEqual(opened, [{ kind: 'file', id: 'doc', anchor: 'date-mention:one' }])
  rows = [{ ...rows[0], deliveredAt: rows[0].startTime }]; await act(async () => changed())
  assert.match(document.body.textContent!, /已提醒 · 交稿/)
  delay = true; await act(async () => changed())
  const old = stale!
  const oldRows = rows
  rows = []; await act(async () => vaultChanged())
  await act(async () => old(oldRows))
  assert.equal(document.querySelector('button'), null)
})
