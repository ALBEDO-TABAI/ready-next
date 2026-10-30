import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createDraftFixture } from './helpers/ready-drafts-fixture'
import type { VaultState } from '../shared/vault'

test('without a vault the document area asks for one; drafts start by themselves once it is ready', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://ready.local' })
  const replacements = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const f = createDraftFixture()
  let configured = false
  const listeners = new Set<(state: VaultState) => void>()
  const ready: VaultState = { status: 'ready', root: '/vault', defaultSuggestion: '/vault' }
  // Main refuses draft calls until a vault exists, exactly like documentDrafts:* with no vault.
  const api = { ...f.api, list: async (tabId?: string) => configured ? f.api.list(tabId) : { ok: false as const, code: 'no_vault', message: '请先配置可用的资料库' } }
  Object.assign(dom.window, { electronAPI: { documentDrafts: api, vault: {
    get: async () => configured ? ready : { status: 'unconfigured', defaultSuggestion: '/vault' },
    createDefault: async () => { configured = true; for (const listener of listeners) listener(ready); return ready },
    set: async () => ready,
    onChanged: (listener: (state: VaultState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }, document: { openFolder: async () => ({ success: false, error: 'cancelled' }) } } })
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { configureDrafts, initializeDrafts, watchDraftVault, useDraftUI } = await import('../renderer/modules/document/drafts/runtime')
  const { DraftBootNotice } = await import('../renderer/modules/document/drafts/DraftControls')
  const { createRoot } = await import('react-dom/client')
  configureDrafts({ ...f.port, api: () => api, tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })) })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const stopWatching = watchDraftVault()
  t.after(async () => {
    stopWatching()
    await act(() => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  })
  await initializeDrafts()
  assert.equal(useDraftUI.getState().boot, 'no_vault', 'a missing vault is a setup step, not a failed recovery')
  await act(async () => root.render(<DraftBootNotice />))
  const text = () => dom.window.document.body.textContent ?? ''
  assert.match(text(), /先选一个资料库/)
  assert.doesNotMatch(text(), /重试恢复/)
  const create = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === '新建默认资料库')!
  await act(async () => { create.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(useDraftUI.getState().boot, 'ready', 'drafts restore as soon as the vault is ready')
})
