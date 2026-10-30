import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mountDatabase } from './utils/database-view-fixture'

test('M5-D actual NotePreview renders readonly synced content, refreshes on page changes and keeps code literal', async t => {
  const ui = await mountDatabase(t), directory = await mkdtemp(join(process.cwd(), 'node_modules/.cache/m5d-preview-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const globals = { localStorage: ui.dom.window.localStorage, MutationObserver: ui.dom.window.MutationObserver,
    getComputedStyle: ui.dom.window.getComputedStyle.bind(ui.dom.window), requestAnimationFrame: ui.dom.window.requestAnimationFrame.bind(ui.dom.window), cancelAnimationFrame: ui.dom.window.cancelAnimationFrame.bind(ui.dom.window) }
  const before = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true })
  t.after(() => { for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const listeners = new Set<() => void>(), calls: string[] = []; let content = '源块正文', missing = false
  Object.defineProperty(ui.dom.window, 'electronAPI', { configurable: true, value: {
    documentPages: { onChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
    documentAnnotations: { synced: async (request: {raw: string}) => {
      calls.push(request.raw)
      return missing ? { ok: false, message: '原块已删除' } : { ok: true, value: { objectId: 'source', path: '/fixture/source.md', blockId: 'id', content, version: 'v1' } }
    } },
  } })
  const outfile = join(directory, 'NotePreview.mjs')
  await build({ entryPoints: ['src/renderer/components/document/NotePreview.tsx'], outfile, bundle: true, loader: { '.css': 'empty' }, platform: 'node', format: 'esm', packages: 'external', define: { __READY_FEATURE_CTFILE__: 'false' }, logLevel: 'silent' })
  const { default: NotePreview } = await import(pathToFileURL(outfile).href)
  await ui.render(<NotePreview content={'![[#^id]]\n\n`![[source#^id]]`'} notePath="/fixture/source.md" />)
  assert.match(ui.host.textContent!, /源块正文/)
  assert.equal(ui.host.querySelector('code')?.textContent, '![[source#^id]]')
  assert.deepEqual(calls, ['![[#^id]]'])
  assert.equal(ui.host.querySelector('[contenteditable]'), null)
  assert.match(ui.host.textContent!, /回到原处编辑/)
  content = '修改后的源块'
  await act(async () => { for (const listener of listeners) listener() })
  assert.match(ui.host.textContent!, /修改后的源块/)
  assert.ok(!ui.host.textContent!.includes('源块正文'))
  missing = true
  await act(async () => { for (const listener of listeners) listener() })
  assert.match(ui.host.querySelector('[role="alert"]')?.textContent ?? '', /原块已删除/)
  assert.ok(!ui.host.textContent!.includes('修改后的源块'))
})
