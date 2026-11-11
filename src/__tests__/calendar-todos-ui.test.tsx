import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'
import type { CalendarLayersAPI, LayerEntry, ScheduleTodo, ToggleTodo, TodoEntry } from '../shared/calendar-layers'

// W4 §5 / MS5 (renderer side): the calendar sidebar lists open to-dos in three groups; ticking and dropping on a
// day go through Main's to-do service with the version read; an Obsidian date asks once before it is rewritten.
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
const navigation = 'data:text/javascript,' + encodeURIComponent('export const opened=[];export async function openReadyRef(ref){opened.push(ref)}')
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@shared/calendar') return next(new URL('../shared/calendar/index.ts', import.meta.url).href, context)
  if (specifier.startsWith('@shared/')) return next(new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, context)
  if (specifier.endsWith('/workbench/open-ready-ref')) return { url: navigation, shortCircuit: true }
  return next(specifier, context)
} })

const toggles: ToggleTodo[] = [], schedules: ScheduleTodo[] = []
let todos: TodoEntry[] = [], consentRequired = false, changed: (() => void) | undefined
const api = {
  listTodos: async () => ({ ok: true as const, value: todos }),
  toggleTodo: async (input: ToggleTodo) => { toggles.push(input); return { ok: true as const, value: { state: 'saved' as const } } },
  scheduleTodo: async (input: ScheduleTodo) => {
    schedules.push(input)
    if (consentRequired && !input.rewriteObsidianDate) return { ok: false as const, message: 'Rewriting an Obsidian date requires consent', code: 'obsidian_date_needs_consent' }
    return { ok: true as const, value: { state: 'saved' as const } }
  },
  onChanged: (callback: () => void) => { changed = callback; return () => { changed = undefined } },
} as unknown as CalendarLayersAPI
// The calendar's own preference store: Main merges the keys and answers with a snapshot.
let savedPrefs: Record<string, unknown> = {}
const calendar = { putPreferences: async (prefs: Record<string, unknown>) => { savedPrefs = { ...savedPrefs, ...prefs }; return { success: true, data: { calendars: [], events: [], prefs: savedPrefs } } } }
Object.assign(dom.window, { electronAPI: { calendarLayers: api, calendar } })

const { createRoot } = await import('react-dom/client')
const store = await import('../renderer/modules/calendar/workbench/store')
const { parseIsoDate } = await import('../shared/calendar/dates')
const { TodoSection } = await import('../renderer/modules/calendar/workbench/layers/TodoSection')
const { LayerDay } = await import('../renderer/modules/calendar/workbench/layers/LayerDays')
const actions = await import('../renderer/modules/calendar/workbench/layers/todo-actions')

const page = (id: string, title: string) => ({ objectId: id, title, ref: { kind: 'page' as const, id } })
const todo = (id: string, title: string, date: string | null, dateSource: TodoEntry['dateSource'] = date ? 'ready' : null): TodoEntry =>
  ({ id, title, heading: null, version: `v-${id}`, page: page(`page-${id}`, '周计划'), date, dateSource })
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

test('the sidebar groups open to-dos into 今天, 已过期 and 未安排, and ticking writes with the read version', async () => {
  store.setState({ today: parseIsoDate('2026-11-12') })
  todos = [todo('a', '交周报', '2026-11-12'), todo('b', '回邮件', '2026-11-09'), todo('c', '读完第三章', null), todo('d', '下周的事', '2026-11-20')]
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<TodoSection />)); await settle()
  const groups = [...document.querySelectorAll<HTMLElement>('[data-todo-group]')].map(group => [group.dataset.todoGroup, [...group.querySelectorAll('.todo-title .lbl')].map(item => item.textContent)])
  assert.deepEqual(groups, [['today', ['交周报']], ['overdue', ['回邮件']], ['unscheduled', ['读完第三章']]], 'a future-dated to-do waits on its day, not in the list')
  assert.match(document.querySelector('[data-todo-group="overdue"] .todo-meta')!.textContent!, /^11月9日 · 周计划$/)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="勾掉：回邮件"]')!.click()); await settle()
  assert.deepEqual(toggles.at(-1), { id: 'b', expectedVersion: 'v-b', checked: true })
  todos = []; await act(async () => changed?.()); await settle()
  assert.match(document.querySelector('[aria-label="待办"]')!.textContent!, /没有要做的/)
  await act(async () => root.unmount())
})

test('a to-do dropped on a day is scheduled there; a task on its day ticks off and back', async () => {
  const root = createRoot(document.getElementById('root')!)
  const task: LayerEntry = { id: 'task:p:4', layer: 'tasks', title: '☑ 交周报', checked: true, date: '2026-11-13', lastDate: '2026-11-13', ref: { kind: 'page', id: 'p' }, version: 'v-task', edit: { kind: 'task', start: 0, end: 1, text: 'x' } }
  const enabled = { events: true, documents: true, tasks: true, footprints: true }
  await act(async () => root.render(<LayerDay date="2026-11-13" entries={[task]} enabled={enabled} move={async () => {}} />))
  const day = document.querySelector<HTMLElement>('[data-layer-day="2026-11-13"]')!
  const data = new Map<string, string>([[actions.TODO_MIME, JSON.stringify({ id: 'c', version: 'v-c', title: '读完第三章', obsidian: false })]])
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { types: [...data.keys()], getData: (type: string) => data.get(type) ?? '' } })
  await act(async () => { day.dispatchEvent(drop) }); await settle()
  assert.deepEqual(schedules.at(-1), { id: 'c', expectedVersion: 'v-c', date: '2026-11-13' })
  const check = day.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  assert.equal(check.getAttribute('aria-checked'), 'true')
  assert.equal(day.querySelector('.layer-task-title')!.textContent, '交周报', 'the layer shows the title without the ☑ text')
  await act(async () => check.click()); await settle()
  assert.deepEqual(toggles.at(-1), { id: 'task:p:4', expectedVersion: 'v-task', checked: false })
  await act(async () => root.unmount())
})

test('an Obsidian date asks once: declining writes nothing, "always" is remembered and skips the question next time', async () => {
  consentRequired = true
  const handle = { id: 'o', version: 'v-o', title: '体检', obsidian: true }
  const asked: string[] = []
  schedules.length = 0
  assert.equal(await actions.scheduleTodo(handle, '2026-11-14', async title => { asked.push(title); return null }), null)
  assert.deepEqual(schedules.map(input => input.rewriteObsidianDate ?? false), [false], 'declined: only the first, refused attempt')
  assert.equal(await actions.scheduleTodo(handle, '2026-11-14', async title => { asked.push(title); return 'always' }), 'saved')
  await settle()
  assert.equal(savedPrefs.rewriteObsidianDates, true, 'the choice is saved with the calendar preferences')
  assert.equal(store.getState().prefs.rewriteObsidianDates, true)
  assert.equal(await actions.scheduleTodo(handle, '2026-11-15', async title => { asked.push(title); return null }), 'saved')
  assert.deepEqual(asked, ['体检', '体检'], 'the remembered choice does not ask again')
  assert.equal(schedules.at(-1)!.rewriteObsidianDate, true)
})
