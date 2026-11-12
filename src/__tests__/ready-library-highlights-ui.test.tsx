import Database from 'better-sqlite3'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { LibrarySessions } from '../main/modules/calendar-layers/reading'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import type { ReadingBegin, ReadingEnd } from '../shared/calendar-layers'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { LibraryHighlightService } from '../main/modules/library-engine/highlight-service'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import type { LibraryAPI } from '../renderer/modules/library/access'

// Only geometry/GPU are supplied: real React, selection Range, flipbook, IPC-shaped API and disk writer run.
test('reader drag creates a durable mark; popover edits/copies/removes; N groups notes and source opens at its block', async t => {
  if (skipIfSqliteUnavailable(t, 'reader sessions and highlights')) return
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const directory = await mkdtemp(join(tmpdir(), 'ready-highlight-ui-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = join(directory, 'vault'); await mkdir(vault)
  const text = '第一章 开始\n一段真正的书籍内容。\n第二章 回家\n走过山海，回到家中。'
  const file = join(directory, '山海.txt'); await writeFile(file, text)
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root: vault, defaultSuggestion: vault }) })
  const record = (await engine.importFiles([file])).imported[0]
  const service = new LibraryHighlightService(engine, { write: input => applyDocumentOperation(input, { index: async () => {} }) })
  const registry = new ObjectRegistry(db); registry.register(record.notePath)
  const reading = new LibrarySessions(await realpath(vault), registry)
  const dom = new JSDOM('<div class="rn-library"><div id="root"></div></div>', { url: 'http://localhost', pretendToBeVisual: true })
  Object.assign(dom.window, { electronAPI: { calendarLayers: {
    beginReading: async (input: ReadingBegin) => { reading.begin(input); return { ok: true, value: undefined } },
    endReading: async (input: ReadingEnd) => { reading.end(input); return { ok: true, value: undefined } },
  } } })
  let width = 1100, copied = ''
  const observers = new Set<() => void>()
  class Observer { constructor(private cb: () => void) { observers.add(cb) } observe() {} disconnect() { observers.delete(this.cb) } }
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { get: () => width }, clientHeight: { get: () => 700 } })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => null })
  const replacements = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, navigator: Object.assign(dom.window.navigator, { clipboard: { writeText: async (value: string) => { copied = value } } }),
    DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, ResizeObserver: Observer, MutationObserver: dom.window.MutationObserver,
    getSelection: () => dom.window.getSelection(), matchMedia: () => ({ matches: true }), getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.requestAnimationFrame(() => callback(performance.now())), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    fetch: async () => new Response(text), IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(replacements).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  for (const [k, value] of Object.entries(replacements)) Object.defineProperty(globalThis, k, { value, configurable: true, writable: true })
  const savedPositions: Array<{ chapter: number; offset: number }> = []
  const api: LibraryAPI = {
    get: async () => ({ success: true, data: await engine.get() }), onChanged: () => () => {},
    importFiles: async () => ({ success: true, data: { imported: [], failed: [] } }), pickAndImport: async () => ({ success: true, data: { imported: [], failed: [] } }),
    updateBook: async () => ({ success: true, data: record }), getPosition: async () => ({ success: true, data: null }), setPosition: async p => { savedPositions.push(p); return { success: true, data: p } },
    listBookmarks: async () => ({ success: true, data: [] }), setBookmarks: async p => ({ success: true, data: p.bookmarks }),
    listHighlights: async input => ({ success: true, data: await service.list(input) }), createHighlight: async input => ({ success: true, data: await service.create(input) }),
    updateHighlight: async input => ({ success: true, data: await service.update(input) }), removeHighlight: async input => ({ success: true, data: await service.remove(input) }),
  }
  const { createRoot } = await import('react-dom/client')
  const { Reader } = await import('../renderer/modules/library/reader/Reader')
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const tabsBefore = useDocTabs.getState()
  const root = createRoot(dom.window.document.getElementById('root')!)
  const errors: string[] = [], d = dom.window.document
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) }) }
  const click = async (label: string) => {
    const button = [...d.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)
    assert.ok(button, label); assert.equal(button.disabled, false, label)
    await act(async () => button.click()); await flush()
  }
  const pointer = (el: Element, type: string, x: number) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 200, button: 0 })
    Object.defineProperty(e, 'pointerType', { value: 'mouse' }); el.dispatchEvent(e)
  }
  // The top bar's 笔记 button keeps its plain name; the number of highlights is a badge, absent at zero.
  const notesBadge = () => d.querySelector('.library-toolbar button[aria-label="笔记"] .library-badge')?.textContent ?? null
  const openMark = async () => {
    const mark = d.querySelector('mark.hl')!; assert.ok(mark)
    await act(async () => { pointer(mark, 'pointerdown', 100); pointer(mark, 'pointerup', 100) })
    assert.ok(d.querySelector('[role="dialog"][aria-label="划线"]'))
  }
  try {
    await act(async () => root.render(<Reader record={record} api={api} onBack={() => {}} onError={e => errors.push(e)} />)); await flush()
    const paragraph = [...d.querySelectorAll('.pg-flow p')].find(p => p.textContent === '一段真正的书籍内容。')!
    assert.ok(paragraph)
    const range = d.createRange(); range.setStart(paragraph.firstChild!, 1); range.setEnd(paragraph.firstChild!, 7)
    const dock = d.querySelector('.rd-dock')!.textContent
    await act(async () => {
      pointer(paragraph, 'pointerdown', 100)
      d.getSelection()!.removeAllRanges(); d.getSelection()!.addRange(range)
      pointer(paragraph, 'pointermove', 160); pointer(paragraph, 'pointerup', 160)
    })
    assert.equal(d.querySelector('.rd-dock')!.textContent, dock, 'drag must not turn the page')
    assert.equal(notesBadge(), null)
    await click('黄')
    assert.equal(d.querySelector('mark.hl')?.textContent, '段真正的书籍')
    assert.equal(notesBadge(), '1')
    assert.match(await readFile(record.notePath, 'utf8'), /> 段真正的书籍/)
    await openMark(); await click('蓝')
    assert.equal(d.querySelector('mark.hl')?.getAttribute('data-c'), 'blue')
    await openMark(); await click('批注')
    const area = d.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '想到这里停一下')
      area.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await click('保存批注')
    assert.match(await readFile(record.notePath, 'utf8'), /想到这里停一下/)
    await openMark(); await click('复制引用')
    const id = d.querySelector<HTMLElement>('mark.hl')!.dataset.hl!
    assert.equal(copied, `![[山海#^${id}]]`)
    await openMark(); await click('复制'); assert.match(copied, /段真正的书籍\n——.*《山海》/)
    const reader = d.querySelector('[aria-label="阅读器"]')!
    await act(async () => reader.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'n', bubbles: true }))); await flush()
    assert.match(d.querySelector('aside[aria-label="笔记"]')?.textContent ?? '', /第一章 开始[\s\S]*想到这里停一下/)
    await click('编辑划线 段真正的书籍'); await click('在来源页中打开')
    assert.equal(useDocTabs.getState().pendingReveal?.path, record.notePath)
    const line = useDocTabs.getState().pendingReveal!.lineStart!
    assert.match((await readFile(record.notePath, 'utf8')).split('\n')[line - 1], /^> \[!quote\|blue\]/)
    await click('关闭面板')
    await click('排版'); await click('单页')
    assert.equal(d.querySelector('[aria-label="阅读器"]')?.getAttribute('data-layout'), 'single')
    assert.equal(d.querySelector('mark.hl')?.textContent, '段真正的书籍')
    const size = d.querySelector<HTMLInputElement>('input[aria-label="字号"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(size, '24')
      size.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }); await flush()
    assert.equal(d.querySelector('mark.hl')?.textContent, '段真正的书籍')
    await click('关闭面板')
    await act(async () => root.render(<p>离开阅读器</p>))
    await act(async () => root.render(<Reader record={record} api={api} onBack={() => {}} onError={e => errors.push(e)} />)); await flush()
    assert.equal(d.querySelector('mark.hl')?.textContent, '段真正的书籍')
    width = 500; await act(async () => observers.forEach(cb => cb())); await flush()
    assert.equal(d.querySelector('mark.hl')?.textContent, '段真正的书籍')
    assert.equal(d.querySelectorAll('.rd-margin-notes button:not([hidden])').length, 0, 'no margin cards when the page has no spare desktop space')
    const savedSource = await readFile(record.notePath, 'utf8')
    await writeFile(record.notePath, savedSource.replace('> 段真正的书籍', '> 这段原文已经不在书中'))
    await act(async () => d.querySelector('[aria-label="阅读器"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'n', bubbles: true }))); await flush()
    assert.match(d.querySelector('aside[aria-label="笔记"]')?.textContent ?? '', /未定位[\s\S]*这段原文已经不在书中/)
    assert.equal(d.querySelector('mark.hl'), null, 'an unlocated quote stays in notes and never paints another passage')
    await writeFile(record.notePath, savedSource); await click('刷新标注'); await click('关闭面板')
    await openMark(); await click('删除划线')
    assert.equal(d.querySelector('mark.hl'), null)
    assert.equal(notesBadge(), null)
    assert.ok(!(await readFile(record.notePath, 'utf8')).includes(`^${id}`))
    // A plain click on body text still turns the page.
    const plain = d.querySelector('.pg-flow p')!, before = d.querySelector('.rd-dock')!.textContent
    await act(async () => { pointer(plain, 'pointerdown', 400); pointer(plain, 'pointerup', 400) }); await flush()
    assert.notEqual(d.querySelector('.rd-dock')!.textContent, before)
    // L4: open a URI range in the second chapter using the real paginator/flipbook.
    await act(async () => root.render(<p>重新按引用打开</p>))
    const target = { book: record.id, location: { chapter: 1, from: 5, to: 9 } }
    await act(async () => root.render(<Reader record={record} api={api} target={target} onBack={() => {}} onError={e => errors.push(e)} />)); await flush()
    const flashed = () => [...d.querySelectorAll('[data-book-location]')].map(el => el.textContent).join('')
    assert.ok(flashed().includes('走过山海'), flashed())
    assert.equal(savedPositions.at(-1)?.chapter, 1)
    assert.equal(savedPositions.at(-1)?.offset, 5)
    const { captureRegisteredNavigationRef } = await import('../renderer/modules/workbench/navigation-history')
    assert.deepEqual(captureRegisteredNavigationRef(), { kind: 'book-location', book: record.id, loc: 'c1:5+1' })
    await click('排版'); await click('单页')
    const targetSize = d.querySelector<HTMLInputElement>('input[aria-label="字号"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(targetSize, '28')
      targetSize.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }); await flush()
    assert.ok(flashed().includes('走过山海'), 'font and single-page changes preserve the target range')
    const visibleFolio = Number(d.querySelector('.rd-dock span')!.textContent!.split('/')[0].trim())
    assert.match(d.querySelector(`.rd-book .leaf .sheet[data-pi="${visibleFolio - 1}"] .pg-flow`)?.textContent ?? '', /走过山海/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3600)) })
    assert.equal(d.querySelector('[data-book-location]'), null, 'navigation highlight expires')
    assert.deepEqual(errors, [])
    await act(async () => root.render(<p>错误引用</p>))
    const sessionsBeforeInvalid = db.prepare('SELECT COUNT(*) AS count FROM library_reading_sessions').get<{ count: number }>()!.count
    await act(async () => root.render(<Reader record={record} api={api} target={{ book: record.id, location: { chapter: 99, from: 0, to: 1 } }} onBack={() => {}} onError={e => errors.push(e)} />)); await flush()
    assert.match(errors.at(-1) ?? '', /位置不存在/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM library_reading_sessions').get<{ count: number }>()!.count, sessionsBeforeInvalid, 'failed navigation is not a reading session')

  } finally {
    await act(async () => root.unmount())
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM library_reading_sessions WHERE ended_at IS NOT NULL').get<{ count: number }>()!.count > 0, 'reader lifecycle must close durable sessions'); useDocTabs.setState(tabsBefore, true)
    for (const [k, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else Reflect.deleteProperty(globalThis, k) }
    dom.window.close()
  }
})
export const __breaksInvariants = ['renderer.doc-tabs-restored-after-isolated-highlight-navigation-test'] as const
