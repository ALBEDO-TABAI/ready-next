import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { writeEventTransfer } from '../renderer/modules/calendar/linkage/transfer'
import type { DaySummary } from '../shared/calendar-linkage'

test('M6-D C4 drop an occurrence into the real editor, render its capsule and undo once', async t => {
  const f = await editorFixture(t, '之前\n\n之后')
  const data = new Map<string, string>()
  writeEventTransfer({ setData: (k, v) => { data.set(k, v) } }, { kind: 'event', id: 'series', occurrence: '1793437200000' }, '开会')
  const event = new f.dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { getData: (k: string) => data.get(k) || '', types: [...data.keys()] } })
  await act(async () => f.rich('之后').dispatchEvent(event))
  // Inserted separators follow the document's line ending (the fixture file is CRLF), as other block insertions do.
  f.bytes('之前\n\n[开会](ready://calendar/event/series#occurrence=1793437200000)\r\n\r\n之后')
  assert.ok(document.querySelector('a[href="ready://calendar/event/series#occurrence=1793437200000"]'))
  assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('之后'), 'z', { ctrlKey: true })
  f.bytes('之前\n\n之后')
})

test('M6-D ThisDay opens every category through ReadyRef, rejects stale day responses, and event cards show live/deleted content', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const navigation = 'data:text/javascript,' + encodeURIComponent('export const opened=[];export async function openReadyRef(ref){opened.push(ref)}')
  const attachments = 'data:text/javascript,' + encodeURIComponent('export async function attachDay(){throw new Error("请先配置资料库")}')
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.includes('/calendar/linkage/') && specifier.endsWith('/workbench/open-ready-ref')) return { url: navigation, shortCircuit: true }
    if (context.parentURL?.includes('/calendar/linkage/ThisDay') && specifier === './attachments') return { url: attachments, shortCircuit: true }
    return next(specifier, context)
  } })
  const { createRoot } = await import('react-dom/client')
  const { ThisDay } = await import('../renderer/modules/calendar/linkage/ThisDay')
  const { EventCard } = await import('../renderer/modules/calendar/linkage/EventCard')
  const kinds = ['events', 'documents', 'tasks', 'reminders', 'footprints', 'activity'] as const
  const summary: DaySummary = { date: '2026-10-31', timeZone: 'UTC', items: kinds.map((kind, i) => ({ id: String(i), kind, title: kind, ref: { kind: 'page', id: String(i) } })) }
  let resolveOld: ((s: DaySummary) => void) | undefined, delay = false, changed: (() => void) | undefined
  Object.assign(dom.window, { electronAPI: { calendarLinkage: { day: async () => delay ? new Promise(resolve => { resolveOld = resolve; delay = false }) : summary },
    canvas: { onChanged: () => () => {} }, calendar: { onChanged: (cb: () => void) => { changed = cb; return () => {} } }, calendarLayers: { onChanged: () => () => {} }, dateMentions: { onChanged: () => () => {} }, vault: { get: async () => ({ status: 'ready', root: '/fixture' }), onChanged: () => () => {} } } })
  const root = createRoot(document.getElementById('root')!)
  t.after(async () => { await act(async () => root.unmount()); hooks.deregister(); dom.window.close(); for (const [key, value] of Object.entries(previous)) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } })
  await act(async () => root.render(<ThisDay date={summary.date} timeZone="UTC" />))
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-day-item]')) await act(async () => button.click())
  const { opened } = await import(navigation); assert.deepEqual(opened, summary.items.map(item => item.ref))
  await act(async () => document.querySelector<HTMLButtonElement>('header button')!.click())
  assert.match(document.querySelector('[role=alert]')?.textContent || '', /请先配置资料库/)
  delay = true; await act(async () => changed!())
  await act(async () => root.render(<ThisDay date="2026-11-01" timeZone="UTC" />))
  await act(async () => resolveOld!({ ...summary, items: [{ ...summary.items[0], title: '过期内容' }] }))
  assert.ok(!document.body.textContent?.includes('过期内容'))
  const event = { id: 'e', uid: 'e@local', calendarId: 'local', title: '更新标题', location: '会议室', start: Date.parse('2026-10-31T09:00:00Z'), end: Date.parse('2026-10-31T10:00:00Z'), allDay: false, status: 'confirmed' as const, transparency: 'opaque' as const, createdAt: 1, updatedAt: 1 }
  await act(async () => root.render(<EventCard reference={{ kind: 'event', id: 'e' }} snapshot={{ events: [event], calendars: [] }} />))
  assert.match(document.body.textContent!, /更新标题.*会议室/)
  await act(async () => root.render(<EventCard reference={{ kind: 'event', id: 'e' }} snapshot={{ events: [], calendars: [] }} />))
  assert.match(document.body.textContent!, /日程已失效/)
  const { attachDay, attachEvent } = await import('../renderer/modules/calendar/linkage/attachments')
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const agentBefore = useAgent.getState(), workspaceBefore = useWorkspace.getState()
  try {
    await attachDay(summary)
    await attachEvent({ kind: 'event', id: 'series', occurrence: '2026-11-01' }, '全天事件', true)
    const added = useAgent.getState().attachments.slice(-2)
    assert.equal(added[0].path, 'ready://calendar/day/2026-10-31')
    const { buildCodexIngressInputWithDiagnostics } = await import('../renderer/modules/agent/messageComposer')
    const input = await buildCodexIngressInputWithDiagnostics({ content: '整理这些资料', attachments: added })
    assert.equal(input.diagnostics.inputFailedCount, 0)
    assert.deepEqual(input.resources?.map(resource => resource.kind), ['calendar_day', 'calendar_event'])
    assert.equal(added[0].selection, undefined)
    assert.equal(added[0].libraryResource?.kind, 'calendar_day')
    assert.equal(added[1].eventId, `series#${Date.parse('2026-11-01') / 1000}`)
  } finally { useAgent.setState(agentBefore, true); useWorkspace.setState(workspaceBefore, true) }
})

test('a chip carries the event out only on Alt-drag; a plain drag stays the calendar move gesture', async () => {
  const { startChipTransfer } = await import('../renderer/modules/calendar/linkage/transfer')
  const data = new Map<string, string>()
  let prevented = 0
  const event = (altKey: boolean) => ({ altKey, preventDefault: () => { prevented++ }, dataTransfer: { setData: (k: string, v: string) => { data.set(k, v) } } })
  assert.equal(startChipTransfer(event(false), { kind: 'event', id: 'e1' }, '开会'), false)
  assert.equal(prevented, 1, 'the native drag is cancelled so pointer events reach the move gesture')
  assert.equal(data.size, 0)
  assert.equal(startChipTransfer(event(true), { kind: 'event', id: 'e1' }, '开会'), true)
  assert.equal(prevented, 1)
  assert.equal(JSON.parse(data.get('application/x-ready-ref')!).id, 'e1')
})
