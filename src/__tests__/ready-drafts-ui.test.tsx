import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createDraftFixture } from './helpers/ready-drafts-fixture'
import { contentHash } from '../renderer/modules/document/drafts/migration'

test('conflict UI shows both versions, uses checked overwrite, preserves disk and can save a new document', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://ready.local' })
  const replacements = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const f = createDraftFixture()
  let diskWrites = 0
  let disk = 'disk version'
  let checkedWrites = 0
  Object.assign(dom.window, { electronAPI: { documentDrafts: f.api, document: {
    readFile: async () => ({ success: true, content: disk }),
    writeFile: async () => { diskWrites++; return { success: true } },
    openFolder: async () => ({ success: true, path: '/vault' }),
  }, documentPages: { save: async (input: { path: string; content: string; expectedVersion: string }) => {
    checkedWrites++
    assert.equal(input.expectedVersion, await contentHash(disk))
    if (checkedWrites === 1) { disk = 'changed again'; return { ok: false, code: 'version_conflict', message: 'changed again' } }
    disk = input.content
    return { ok: true, value: { path: input.path, beforeVersion: input.expectedVersion, afterVersion: await contentHash(disk), committedAt: 1 } }
  } } } })
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { configureDrafts, useDraftUI } = await import('../renderer/modules/document/drafts/runtime')
  const { DraftControls } = await import('../renderer/modules/document/drafts/DraftControls')
  const { createRoot } = await import('react-dom/client')
  configureDrafts({ ...f.port, read: async path => path === '/vault/Test.md' && checkedWrites > 0 ? disk : f.port.read(path), tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
  }, () => {})
  const { drafts } = await import('../renderer/modules/document/drafts/runtime')
  const hash = await contentHash('draft version')
  f.drafts.set('conflict', { draftId: 'conflict', tabId: 'tab', revision: 2, content: 'draft version', contentHash: hash, origin: 'document', objectId: 'object', baseVersion: hash,
    vaultRoot: '/vault', title: 'Conflict', state: 'conflict', sourceCanvas: null, suggestedParent: null, attachments: [], finalize: null, createdAt: 0, updatedAt: 0 })
  f.drafts.set('older', { ...f.drafts.get('conflict')!, draftId: 'older', revision: 1, content: 'older', contentHash: await contentHash('older') })
  useDocTabs.setState({ tabs: [{ id: 'tab', path: '/vault/Test.md', title: 'Conflict', content: '', isDirty: false, draftId: 'conflict' }], activeTabId: 'tab', focusedPaneTabId: 'tab' })
  await drafts.restore()
  useDraftUI.setState({ boot: 'ready' })
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(() => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  })
  const button = (text: string) => {
    const element = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === text)
    assert.ok(element, text); return element
  }
  const click = async (text: string) => { await act(async () => { button(text).click(); await new Promise(resolve => setTimeout(resolve, 10)) }) }
  await act(() => root.render(<DraftControls />))
  await click('未保存的草稿（2）')
  assert.match(dom.window.document.querySelector('[data-testid="draft-recovery-older"]')?.textContent ?? '', /同一标签的较早版本/)
  await click('查看版本冲突')
  const bodies = [...dom.window.document.querySelectorAll('pre')].map(node => node.textContent)
  assert.deepEqual(bodies, ['disk version', 'draft version'])
  assert.equal(button('用草稿覆盖').disabled, false)
  assert.equal(diskWrites, 0, 'never claim version-checked overwrite through writeFile')
  await click('另存为新文档')
  const newTab = useDocTabs.getState().tabs.find(tab => tab.id === useDraftUI.getState().saveTabId)!
  assert.ok(newTab)
  assert.equal(newTab.path, null)
  assert.equal(newTab.content, 'draft version')
  await click('选择文件夹')
  await click('确认保存')
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === newTab.id)?.objectId, 'object')
  assert.equal(useDraftUI.getState().saveTabId, null)
  assert.equal(f.drafts.get('conflict')?.state, 'conflict', 'copy does not discard the original')
  await act(() => useDocTabs.getState().setActiveTab('tab'))
  await click('查看版本冲突')
  await click('用草稿覆盖')
  assert.equal(f.drafts.get('conflict')?.state, 'conflict')
  assert.equal(dom.window.document.querySelector('pre')?.textContent, 'changed again')
  assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? '', /重新比较/)
  await click('用草稿覆盖')
  assert.equal(f.drafts.get('conflict')?.state, 'discarded')
  assert.equal(useDocTabs.getState().tabs.find(tab => tab.id === 'tab')?.isDirty, false)
  assert.equal(disk, 'draft version')
  assert.equal(checkedWrites, 2)
  assert.equal(diskWrites, 0)
})
