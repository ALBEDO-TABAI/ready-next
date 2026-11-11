import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { registerHooks } from 'node:module'
import { importWithoutStyles } from './utils/import-without-styles'
import type { TodayFirstScreen, TodaySieve } from '../shared/today'
import type { RSSCalibration } from '../shared/rss-sieve'

// W6 T8 (§5): 今日 with data, with an empty library, while 资讯 is still on its way; ticking a to-do in place; the
// 筛子校准 card's place; rows that act like every reference capsule. Real page, stores and capsule; Main answers with
// fixed data through electronAPI.
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
// The calendar store reads the system theme when it loads.
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const globals = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent, localStorage: dom.window.localStorage,
  // jsdom has no layout observer.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
}
// The to-do action lives in the calendar module, whose sources import @shared/* (a Vite alias).
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@shared/calendar') return next(new URL('../shared/calendar/index.ts', import.meta.url).href, context)
  if (specifier.startsWith('@shared/')) return next(new URL(`../shared/${specifier.slice(8)}.ts`, import.meta.url).href, context)
  return next(specifier, context)
} })
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })

const NOW = Date.now(), MIN = 60_000
const pad = (n: number) => String(n).padStart(2, '0')
const clock = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`
const todo = (id: string, title: string, date: string) => ({ ref: { kind: 'page' as const, id: 'week' }, title,
  todo: { id, title, heading: null, version: `v-${id}`, page: { objectId: 'week', title: '本周待办', ref: { kind: 'page' as const, id: 'week' } }, date, dateSource: 'obsidian' as const } })
const filled = (): TodayFirstScreen => ({
  greeting: { date: '2026-11-12', period: 'morning' },
  upcoming: {
    events: [
      { ref: { kind: 'event', id: 'call' }, title: '正在进行的通话', start: NOW - 5 * MIN, end: NOW + 25 * MIN, allDay: false },
      { ref: { kind: 'event', id: 'review' }, title: '稍后的评审', start: NOW + 40 * MIN, end: NOW + 70 * MIN, allDay: false },
      { ref: { kind: 'event', id: 'meeting' }, title: '选题会', start: NOW + 200 * MIN, end: NOW + 260 * MIN, allDay: false },
    ],
    nextStart: NOW + 40 * MIN,
    todos: [todo('task:week:3', '确认印厂排期', '2026-11-12'), todo('task:week:4', '封面三稿确认', '2026-11-10')],
  },
  continue: {
    pages: [{ ref: { kind: 'page', id: 'launch' }, title: '新书发布', editedAt: NOW - 3 * 60 * MIN }],
    books: [{ ref: { kind: 'book-location', book: 'walker', loc: 'c1:0+1' }, title: '城市漫游者', progress: 0.21, updatedAt: NOW }],
    drafts: [{ ref: { kind: 'draft', id: 'loose' }, title: '还没想好的一段话', updatedAt: NOW }],
  },
  collection: { items: [{ ref: { kind: 'fastcard', id: 'card' }, title: '筛子的一句话' }], total: 4 },
  emergence: [{ ref: { kind: 'file', id: 'channels' }, title: '发行渠道调研.md', reason: '最近打开' }],
})
const empty = (): TodayFirstScreen => ({ greeting: { date: '2026-11-12', period: 'evening' }, upcoming: { events: [], nextStart: null, todos: [] },
  continue: { pages: [], books: [], drafts: [] }, collection: { items: [], total: 0 }, emergence: [] })
const proposal: RSSCalibration = { week: '2026-11-09', baseVersion: 3, status: 'pending', text: '多看独立出版与发行', explanation: '这周你读完了三篇发行相关的文章', stale: false }
const picked = (): TodaySieve => ({ articles: [{ ref: { kind: 'rss-item', id: 'rss-alive' }, title: 'RSS 没有死，只是换了读法', reason: '因为你在写《RSS 的筛子理论》', score: 91 }],
  calibration: { ref: { kind: 'rss-calibration', id: proposal.week }, title: '筛子校准', proposal } })

// Each request answers from the next queued value, or waits until the test resolves it.
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
const defer = <T,>(): Deferred<T> => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; return { promise: new Promise<T>((a, b) => { resolve = a; reject = b }), resolve, reject } }
const answers = { first: [] as Array<TodayFirstScreen | Deferred<TodayFirstScreen> | Error>, sieve: [] as Array<TodaySieve | Deferred<TodaySieve>> }
const answer = <T,>(queue: Array<T | Deferred<T> | Error>, fallback: () => T): Promise<T> => {
  const next = queue.length > 1 ? queue.shift()! : queue[0]
  if (next === undefined) return Promise.resolve(fallback())
  if (next instanceof Error) return Promise.reject(next)
  return next && typeof next === 'object' && 'promise' in next ? next.promise : Promise.resolve(structuredClone(next) as T)
}
const toggles: unknown[] = [], revealed: string[] = [], lookups: unknown[] = []
const todoListeners = new Set<() => void>()
Object.defineProperty(dom.window, 'electronAPI', { value: {
  today: { firstScreen: () => answer(answers.first, filled), sieve: () => answer(answers.sieve, picked) },
  calendarLayers: { toggleTodo: async (input: unknown) => { toggles.push(input); queueMicrotask(() => todoListeners.forEach(listener => listener())); return { ok: true, value: { state: 'saved' } } },
    onChanged: (listener: () => void) => { todoListeners.add(listener); return () => todoListeners.delete(listener) } },
  rss: { sieveCalibration: async () => ({ success: true, data: proposal }), onOrganizationChanged: () => () => {} },
  navigationHistory: memoryNavigationAPI(),
  calendar: { revealEvent: async (id: string) => { revealed.push(id); return { success: true } }, snapshot: async () => ({ success: true, data: { events: [{ id: 'review', title: '稍后的评审' }], calendars: [] } }) },
  browser: { listFastCardItems: async () => ({ success: true, data: [] }) },
} })
dom.window.addEventListener('ready:workbench-mode-change-request', event => useMode.setState({ workbenchMode: (event as CustomEvent).detail.mode }))
dom.window.addEventListener('ready:open-quick-look', event => lookups.push((event as CustomEvent).detail.ref))

const { TodayPage } = await importWithoutStyles(() => import('../renderer/modules/today/TodayPage'))
const format = await import('../renderer/modules/today/today-format')
const startup = await import('../renderer/modules/today/startup')
const { useMode } = await import('../renderer/stores/useMode')
const { useRSSSession } = await import('../renderer/stores/useRSSSession')
const { useInkLayout } = await import('../renderer/modules/document/ink/layout-state')
const restore = [useMode, useRSSSession, useInkLayout].map(store => { const state = store.getState(); return () => store.setState(state, true) })
const { createRoot } = await import('react-dom/client')
const root = createRoot(dom.window.document.getElementById('root')!)
test.after(async () => {
  await act(async () => root.unmount())
  restore.forEach(fn => fn())
  dom.window.close()
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
})

const body = dom.window.document.body
const all = (selector: string, within: ParentNode = body) => [...within.querySelectorAll<HTMLElement>(selector)]
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
async function show(first: Array<TodayFirstScreen | Deferred<TodayFirstScreen> | Error>, sieve: Array<TodaySieve | Deferred<TodaySieve>>) {
  answers.first = first; answers.sieve = sieve
  await act(async () => root.render(<></>))
  await act(async () => root.render(<TodayPage visible />))
  await settle()
}
const blocks = () => all('[data-today-block]').map(node => node.dataset.todayBlock)

test('with data: the greeting, then each block with its rows; 资讯 arrives after the first screen without holding it', async () => {
  const sieve = defer<TodaySieve>()
  await show([filled()], [sieve])
  const page = body.querySelector<HTMLElement>('section.today')!
  assert.equal(page.dataset.todayPage, 'ready')
  assert.ok(Number(page.dataset.firstScreenMs) >= 0, 'the first-screen time is recorded on the page')
  assert.equal(body.querySelector('.today-hello h1')?.textContent, '早上好')
  assert.equal(body.querySelector('.today-hello p')?.textContent, '11 月 12 日 星期四')
  assert.deepEqual(blocks(), ['upcoming', 'continue', 'sieve', 'collection', 'emergence'])
  assert.equal(body.querySelector('[data-today-block="sieve"] [aria-busy="true"]')?.getAttribute('aria-label'), '正在读取资讯', '资讯 holds its place while it loads')

  const upcoming = body.querySelector('[data-today-block="upcoming"]')!
  assert.deepEqual(all('.today-time', upcoming).map(node => [node.textContent, node.classList.contains('is-now')]),
    [['进行中', true], ['40 分钟后', true], [clock(NOW + 200 * MIN), false]], 'under way and the countdown to the next carry the signal')
  assert.deepEqual(all('.today-row', upcoming).slice(3).map(row => row.querySelector('.today-row__meta')?.textContent), ['本周待办', '11月10日 · 本周待办'])
  // Every row is a reference capsule: type and title as its name, draggable, opening and quick-looking like any other.
  assert.deepEqual(all('.today-row a[data-ready-ref-capsule]').map(link => link.getAttribute('aria-label')), [
    '日程 正在进行的通话', '日程 稍后的评审', '日程 选题会', '页面 确认印厂排期', '页面 封面三稿确认',
    '页面 新书发布', '书 城市漫游者', '页面 还没想好的一段话', '收集 筛子的一句话', '文件 发行渠道调研'])
  assert.ok(all('.today-row a[data-ready-ref-capsule]').every(link => link.getAttribute('draggable') === 'true'))
  assert.deepEqual(all('[data-today-block="continue"] .today-row__meta').map(node => node.textContent), ['3 小时前编辑', '读到 21%', '未保存'])
  assert.match(body.querySelector('[data-today-block="collection"] .today-label')!.textContent!, /共 4 条/)
  assert.ok(all('[data-today-block="collection"] button').some(button => button.textContent === '整理到画板'))

  await act(async () => { sieve.resolve(picked()); await new Promise(resolve => setTimeout(resolve, 20)) })
  const block = body.querySelector('[data-today-block="sieve"]')!
  // 筛子校准 is the block's first entry, above the picks (§5.2).
  const children = [...block.children].map(node => node.matches('aside[aria-label="筛子校准"]') ? 'calibration' : node.matches('ul') ? 'picks' : node.className)
  assert.deepEqual(children, ['today-label', 'calibration', 'picks'])
  assert.match(block.querySelector('aside')!.textContent!, /多看独立出版与发行/)
  assert.deepEqual(all('.today-row', block).map(row => [row.querySelector('a')?.getAttribute('aria-label'), row.querySelector('.today-row__meta')?.textContent]),
    [['资讯 RSS 没有死，只是换了读法', '因为你在写《RSS 的筛子理论》']])
})

test('rows open and quick-look as capsules; a to-do ticks in place through the to-do service and stays ticked', async () => {
  const link = (name: string) => body.querySelector<HTMLAnchorElement>(`.today-row a[aria-label="${name}"]`)!
  await act(async () => { link('日程 稍后的评审').click(); await new Promise(resolve => setTimeout(resolve, 30)) })
  assert.deepEqual(revealed, ['review'])
  assert.equal(useMode.getState().workbenchMode, 'calendar')
  await act(async () => { link('书 城市漫游者').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })) })
  assert.deepEqual(lookups, [{ kind: 'book-location', book: 'walker', loc: 'c1:0+1' }], '⌥-click quick-looks without leaving')

  // The ticked to-do is gone from the next answer; 今日 keeps it, ticked, until it is opened again.
  answers.first = [{ ...filled(), upcoming: { ...filled().upcoming, todos: [filled().upcoming.todos[1]] } }]
  const box = body.querySelector<HTMLButtonElement>('[data-todo-id="task:week:3"] [role="checkbox"]')!
  assert.equal(box.getAttribute('aria-label'), '勾掉：确认印厂排期')
  await act(async () => { box.click(); await new Promise(resolve => setTimeout(resolve, 30)) })
  assert.deepEqual(toggles, [{ id: 'task:week:3', expectedVersion: 'v-task:week:3', checked: true }])
  const row = body.querySelector('[data-todo-id="task:week:3"]')!
  assert.equal(row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked'), 'true')
  assert.ok(row.classList.contains('is-done'))
  assert.equal(all('[data-today-block="upcoming"] [role="checkbox"]').length, 2, 'the other to-do is still there')
  assert.equal(useMode.getState().workbenchMode, 'calendar', 'ticking never opens the page')
})

test('an empty library shows no block and no shell, only the guide; 资讯 still loading is not empty yet', async () => {
  const sieve = defer<TodaySieve>()
  await show([empty()], [sieve])
  assert.deepEqual(blocks(), ['sieve'], 'only the 资讯 placeholder while it loads')
  assert.equal(body.querySelector('section[aria-label="从这里开始"]'), null)
  await act(async () => { sieve.resolve({ articles: [], calibration: null }); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.deepEqual(blocks(), [])
  assert.equal(all('.today-label').length, 0, 'no titles of empty blocks')
  assert.equal(body.querySelector('.today-hello h1')?.textContent, '晚上好')
  const guide = body.querySelector('section[aria-label="从这里开始"]')!
  assert.deepEqual(all('button', guide).map(button => button.textContent), ['添加订阅源', '新建第一页', '导入一本书'])
  await act(async () => { all('button', guide)[0].click() })
  assert.equal(useRSSSession.getState().addSourceRequested, true, '添加订阅源 asks 资讯 for its dialog')
  assert.equal(useMode.getState().workbenchMode, 'rss')
})

test('only the blocks with something in them show; a failed first screen says so and can be retried', async () => {
  await show([{ ...empty(), collection: { items: [{ ref: { kind: 'fastcard', id: 'card' }, title: '筛子的一句话' }], total: 1 } }], [{ articles: [], calibration: null }])
  assert.deepEqual(blocks(), ['collection'])
  assert.equal(body.querySelector('section[aria-label="从这里开始"]'), null)
  await show([new Error('数据库暂时不可用'), filled()], [picked()])
  assert.match(body.querySelector('[role="alert"]')!.textContent!, /数据库暂时不可用/)
  await act(async () => { body.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.deepEqual(blocks(), ['upcoming', 'continue', 'sieve', 'collection', 'emergence'])
})

test('words and times: dates, countdowns, edits, progress; which blocks show', () => {
  assert.equal(format.dateLine('2026-11-15'), '11 月 15 日 星期日')
  assert.deepEqual(format.eventTime({ start: NOW + 90 * MIN, end: NOW + 120 * MIN, allDay: false }, NOW + 90 * MIN, NOW), { text: '1 小时 30 分后', now: true })
  assert.deepEqual(format.eventTime({ start: NOW + 60 * MIN, end: NOW + 120 * MIN, allDay: false }, NOW + 60 * MIN, NOW), { text: '1 小时后', now: true })
  assert.deepEqual(format.eventTime({ start: NOW + 30_000, end: NOW + 60 * MIN, allDay: false }, NOW + 30_000, NOW), { text: '马上开始', now: true })
  assert.deepEqual(format.eventTime({ start: NOW, end: NOW + MIN, allDay: true }, null, NOW), { text: '全天', now: false })
  assert.equal(format.overdueText('2026-11-12', '2026-11-12'), '')
  assert.equal(format.editedText(NOW - 30_000, NOW), '刚刚编辑')
  assert.equal(format.editedText(NOW - 26 * 60 * MIN, NOW), '昨天编辑')
  assert.equal(format.progressText(0.999), '读到 100%')
  assert.equal(format.fileTitle('v1.2 计划.pdf'), 'v1.2 计划')
  assert.deepEqual(format.visibleBlocks(empty(), null), [])
  assert.deepEqual(format.visibleBlocks(empty(), 'loading'), ['sieve'])
  assert.deepEqual(format.visibleBlocks(empty(), { articles: [], calibration: picked().calibration }), ['sieve'], 'a pending calibration alone keeps 为你筛过的')
})

test('设置 › 启动: 今日 by default, or the place the window was left; the place is remembered as it changes', () => {
  assert.equal(startup.parseStartupView(null), 'today')
  assert.equal(startup.parseStartupView('last'), 'last')
  assert.deepEqual(startup.startupPlace('today', { mode: 'rss', today: false }), { mode: 'document', today: true })
  assert.deepEqual(startup.startupPlace('last', { mode: 'rss', today: false }), { mode: 'rss', today: false })
  assert.deepEqual(startup.startupPlace('last', { mode: 'elsewhere' as never }), { mode: 'browser', today: false })
  localStorage.setItem('ready-last-place', JSON.stringify({ mode: 'calendar', today: true }))
  startup.applyStartupPlace('last')
  assert.equal(useMode.getState().workbenchMode, 'calendar')
  assert.equal(useInkLayout.getState().home, true)
  useMode.getState().setWorkbenchMode('rss')
  assert.deepEqual(JSON.parse(localStorage.getItem('ready-last-place')!), { mode: 'rss', today: true })
})

export const __breaksInvariants = ['renderer stores and DOM restored after the isolated 今日 tests'] as const
