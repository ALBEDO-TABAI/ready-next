import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'
import type { CalendarLayersAPI, LayerEntry, LayerMove, LayerReply } from '../shared/calendar-layers'

test('C8 switches render the same entries, footprints cannot drag, moves wait for receipts and stale responses cannot replace current range', async t => {
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
  const { LayerDay, LayerSwitches } = await import('../renderer/modules/calendar/workbench/layers/LayerDays')
  const { useLayerEntries } = await import('../renderer/modules/calendar/workbench/layers/use-layer-entries')
  const store = await import('../renderer/modules/calendar/workbench/store')
  const { parseIsoDate } = await import('../shared/calendar/dates')
  let entries: LayerEntry[] = [
    { id: 'diary:a', layer: 'documents', title: '日期文档', date: '2026-10-31', lastDate: '2026-10-31', ref: { kind: 'page', id: 'a' }, version: 'version-1', edit: { kind: 'diary' } },
    { id: 'reading:a', layer: 'footprints', title: '阅读记录', date: '2026-10-31', lastDate: '2026-10-31', ref: { kind: 'file', id: 'a' } },
  ]
  let vaultListener: (() => void) | undefined
  let listener: (() => void) | undefined, stale: ((result: LayerReply<LayerEntry[]>) => void) | undefined, delay = false
  const moves: LayerMove[] = []
  const api: CalendarLayersAPI = {
    listTodos: async () => ({ ok: true, value: [] }),
    toggleTodo: async () => ({ ok: true, value: { state: 'saved' } }),
    scheduleTodo: async () => ({ ok: true, value: { state: 'saved' } }),
    query: async () => { if (delay) { delay = false; return new Promise(resolve => { stale = resolve }) } return { ok: true, value: entries } },
    move: async input => { moves.push(input); return { ok: false, message: 'version_conflict' } },
    beginReading: async () => ({ ok: true, value: undefined }), endReading: async () => ({ ok: true, value: undefined }),
    onChanged: callback => { listener = callback; return () => { listener = undefined } },
  }
  let prefs = store.defaultPrefs()
  const snapshot = () => ({ success: true, data: { prefs, calendars: [], events: [], revision: 1 } })
  Object.assign(dom.window, { electronAPI: { dateMentions: { takeOpen: async () => null, onOpen: () => () => {}, list: async () => [], onChanged: () => () => {} }, calendarLayers: api, vault: { onChanged: (callback: () => void) => { vaultListener = callback; return () => { vaultListener = undefined } } }, calendar: {
    snapshot: async () => snapshot(), putPreferences: async (patch: Partial<typeof prefs>) => { prefs = { ...prefs, ...patch }; return snapshot() },
  } } })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  function Harness() {
    const enabled = store.useStore(s => s.prefs.layers), data = useLayerEntries(parseIsoDate('2026-10-31'), parseIsoDate('2026-11-02'), 'UTC', true)
    return <><LayerSwitches /><LayerDay date="2026-10-31" entries={data.entries} enabled={enabled} move={data.move} /><LayerDay date="2026-11-01" entries={data.entries} enabled={enabled} move={data.move} />{data.error && <p role="alert">{data.error}</p>}</>
  }
  await act(async () => root.render(<Harness />))
  const doc = dom.window.document
  assert.equal(doc.querySelectorAll('input[type=checkbox]').length, 4)
  assert.equal(doc.querySelector('[data-layer="documents"]')?.getAttribute('draggable'), 'true')
  assert.equal(doc.querySelector('[data-layer="footprints"]')?.getAttribute('draggable'), 'false')
  await act(async () => doc.querySelector<HTMLInputElement>('[aria-label="文档日期"]')!.click())
  assert.equal(doc.querySelector('[data-layer="documents"]'), null)
  await act(async () => doc.querySelector<HTMLInputElement>('[aria-label="文档日期"]')!.click())
  assert.ok(doc.querySelector('[data-layer="documents"]'))
  await act(async () => doc.querySelector<HTMLButtonElement>('[data-layer="footprints"]')!.click())
  const { opened } = await import(navigation); assert.deepEqual(opened, [{ kind: 'file', id: 'a' }])
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'diary:a' } })
  await act(async () => doc.querySelector('[data-layer-day="2026-11-01"]')!.dispatchEvent(drop))
  assert.equal(moves[0].date, '2026-11-01'); assert.equal(moves[0].expectedVersion, 'version-1')
  assert.ok(doc.querySelector('[data-layer-day="2026-10-31"] [data-layer="documents"]'))
  assert.match(doc.querySelector('[role=alert]')!.textContent!, /version_conflict/)
  delay = true; await act(async () => listener!())
  entries = [{ ...entries[0], title: '最新日期' }]; await act(async () => listener!())
  await act(async () => stale!({ ok: true, value: [{ ...entries[0], title: '过期响应' }] }))
  assert.ok(doc.body.textContent?.includes('最新日期')); assert.ok(!doc.body.textContent?.includes('过期响应'))
  delay = true; await act(async () => listener!())
  const oldVaultResponse = stale!
  delay = true; await act(async () => vaultListener!())
  assert.equal(doc.querySelector('[data-layer=documents]'), null)
  await act(async () => oldVaultResponse({ ok: true, value: entries }))
  assert.equal(doc.querySelector('[data-layer=documents]'), null)
  entries = [{ ...entries[0], id: 'diary:b', title: '新资料库日记' }]
  await act(async () => stale!({ ok: true, value: entries }))
  assert.ok(doc.body.textContent?.includes('新资料库日记'))
  api.move = async input => { moves.push(input); entries = entries.map(e => ({ ...e, date: input.date, lastDate: input.date })); return { ok: true, value: { state: 'saved' } } }
  const diaryDrop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(diaryDrop, 'dataTransfer', { value: { getData: () => 'diary:b' } })
  await act(async () => doc.querySelector('[data-layer-day="2026-11-01"]')!.dispatchEvent(diaryDrop))
  assert.equal(doc.querySelector('[data-layer-day="2026-10-31"] [data-layer=documents]'), null)
  assert.ok(doc.querySelector('[data-layer-day="2026-11-01"] [data-layer=documents]'))
})
