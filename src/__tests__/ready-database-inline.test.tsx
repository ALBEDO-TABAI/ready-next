import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import ReactMarkdown from 'react-markdown'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InlineDatabase } from '../renderer/modules/document/database/InlineDatabase'
import { parseDatabaseLink, remarkDatabaseViews } from '../renderer/modules/document/database/inline-links'
import { mountDatabase, click, input } from './utils/database-view-fixture'
import { memoryAPI } from './utils/database-memory-fixture'

test('DB-B inline syntax is interactive, excludes code, and rejects missing/ambiguous/cyclic references', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  f.api.pages = async () => [{ id: 'db', title: '库', reference: '[[库]]' }]
  const render = (source: string) => ui.render(<ReactMarkdown remarkPlugins={[remarkDatabaseViews]} urlTransform={url => url} components={{ p: 'div', a: ({ href }) => { const ref = parseDatabaseLink(href ?? ''); return ref ? <InlineDatabase {...ref} api={f.api} /> : null } }}>{source}</ReactMarkdown>)
  await render('![[库#table]]\n\n`![[库#board]]`\n\n```text\n![[库#list]]\n```')
  assert.equal(ui.host.querySelectorAll('[data-database-id]').length, 1)
  assert.equal(ui.host.querySelectorAll('code').length, 2)
  await click(ui, '[data-row-id="row-0"] [data-field-id="text"]'); await input(ui, '[aria-label="字段值"]', '内联'); await click(ui, '[aria-label="保存单元格"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { text: '内联' })
  await ui.render(<InlineDatabase target="库" viewName="不存在" api={f.api} />)
  assert.match(ui.host.textContent ?? '', /missing view/)
  await ui.render(<InlineDatabase key="cycle" target="库" viewName="table" api={f.api} ancestors={[{ databaseId: 'db', viewId: 'table' }]} />)
  assert.match(ui.host.textContent ?? '', /inline cycle/)
  f.api.pages = async () => [{ id: 'one', title: '库', reference: '[[a/库]]' }, { id: 'two', title: '库', reference: '[[b/库]]' }]
  await ui.render(<InlineDatabase key="duplicate" target="库" viewName="table" api={f.api} />)
  assert.match(ui.host.textContent ?? '', /歧义/)
  await ui.render(<InlineDatabase key="missing" target="丢失" viewName="table" api={f.api} />)
  assert.match(ui.host.textContent ?? '', /不存在/)
})

test('DB-B actual NotePreview mounts inline view while code and ordinary Markdown remain unchanged', async t => {
  const f = memoryAPI(), ui = await mountDatabase(t)
  const directory = await mkdtemp(join(process.cwd(), 'node_modules/.cache/m5b-preview-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const globals = { localStorage: ui.dom.window.localStorage, MutationObserver: ui.dom.window.MutationObserver, getComputedStyle: ui.dom.window.getComputedStyle.bind(ui.dom.window), requestAnimationFrame: ui.dom.window.requestAnimationFrame.bind(ui.dom.window), cancelAnimationFrame: ui.dom.window.cancelAnimationFrame.bind(ui.dom.window) }
  const before = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true })
  t.after(() => { for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  Object.defineProperty(ui.dom.window, 'electronAPI', { value: {
    documentDatabase: f.api.request,
    vault: { get: async () => ({ status: 'ready', root: '/fixture' }) },
    documentPages: { tree: async () => ({ ok: true, value: { kind: 'vault', children: [{ kind: 'page', objectId: 'db', title: '库', path: '/fixture/库.md', children: [] }] } }) },
  }, configurable: true })
  const outfile = join(directory, 'NotePreview.mjs')
  await build({ entryPoints: ['src/renderer/components/document/NotePreview.tsx'], outfile, bundle: true, loader: { '.css': 'empty' }, platform: 'node', format: 'esm', packages: 'external', define: { __READY_FEATURE_CTFILE__: 'false' }, logLevel: 'silent' })
  const { default: NotePreview } = await import(pathToFileURL(outfile).href)
  await ui.render(<NotePreview content={'正文\n\n![[库#table]]\n\n`![[库#board]]`'} notePath="/fixture/笔记.md" />)
  assert.equal(ui.host.querySelectorAll('[data-database-id="db"]').length, 1, ui.host.textContent ?? '')
  assert.match(ui.host.textContent ?? '', /正文/)
  assert.equal(ui.host.querySelector('code')?.textContent, '![[库#board]]')
  assert.equal(ui.host.querySelector('p .ready-database'), null)
  await click(ui, '[data-row-id="row-0"] [data-field-id="text"]'); await input(ui, '[aria-label="字段值"]', '预览内修改'); await click(ui, '[aria-label="保存单元格"]')
  assert.deepEqual(f.calls.findLast(c => c.type === 'setFields')?.set, { text: '预览内修改' })
})
