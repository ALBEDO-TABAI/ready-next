import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { VaultState } from '../shared/vault'

test('vault banner loads Main state, shows failures, retries, picks folders and pins only confirmed results', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const replacements = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  let finishLoad!: (value: VaultState) => void
  let failLoad!: (error: Error) => void
  const suggestion = '/Users/test/ReadyNext/test-vault'
  const selected = '/Users/test/Documents/Selected'
  let pick: { success: boolean; path?: string; error?: string } = { success: false, error: 'cancelled' }
  let createCalls = 0
  let getCalls = 0
  let setCalls = 0
  let failCreate = true
  Object.assign(dom.window, { electronAPI: {
    vault: {
      get: () => { getCalls++; return new Promise<VaultState>((resolve, reject) => { finishLoad = resolve; failLoad = reject }) },
      set: async (path: string) => { setCalls++; return { status: 'ready', root: path, defaultSuggestion: suggestion } },
      createDefault: async () => { createCalls++; if (failCreate) throw new Error('无法创建资料库'); return { status: 'ready', root: suggestion, defaultSuggestion: suggestion } },
    },
    document: {
      openFolder: async () => pick,
      listFiles: async () => ({ success: true, items: [] }),
      watchDir: async () => ({ success: true }),
      unwatchDir: async () => ({ success: true }),
    },
  } })
  try {
    const { default: VaultSetupBanner } = await import('../renderer/components/layout/VaultSetupBanner')
    const { useVault } = await import('../renderer/stores/useVault')
    const { useWorkspace } = await import('../renderer/stores/useWorkspace')
    const { useMode } = await import('../renderer/stores/useMode')
    await act(async () => root.render(<VaultSetupBanner />))
    assert.equal(dom.window.document.querySelector('[aria-label="资料库设置"]'), null)
    await act(async () => useMode.getState().setWorkbenchMode('document'))
    const text = () => dom.window.document.body.textContent || ''
    const click = async (label: string) => {
      const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label)
      assert.ok(button, label)
      await act(async () => button.click())
    }
    assert.match(text(), /正在读取资料库/)
    await act(async () => { void useVault.getState().load() })
    assert.equal(getCalls, 1, 'duplicate loads share the pending operation')
    await act(async () => failLoad(new Error('读取失败')))
    assert.match(text(), /读取失败/)
    assert.equal(useWorkspace.getState().pinnedFolders.length, 0)
    await click('选择已有文件夹…')
    assert.match(text(), /读取失败/, 'cancelling after a failed load must retain a usable retry action')
    await click('重试')
    await act(async () => finishLoad({ status: 'unconfigured', defaultSuggestion: suggestion }))
    assert.match(text(), /设置资料库/)
    await click('选择已有文件夹…')
    assert.equal(setCalls, 0)
    assert.doesNotMatch(text(), /cancelled/)
    await click('新建默认位置')
    assert.match(text(), /无法创建资料库/)
    assert.equal(useWorkspace.getState().pinnedFolders.length, 0)
    failCreate = false
    await click('新建默认位置')
    assert.equal(createCalls, 2)
    assert.equal(dom.window.document.querySelector('[aria-label="资料库设置"]'), null)
    assert.deepEqual(useWorkspace.getState().pinnedFolders, [suggestion])
    let loading!: Promise<void>
    await act(async () => { loading = useVault.getState().load() })
    await act(async () => { finishLoad({ status: 'ready', root: suggestion, defaultSuggestion: suggestion }); await loading })
    assert.deepEqual(useWorkspace.getState().pinnedFolders, [suggestion])
    await act(async () => { loading = useVault.getState().load() })
    await act(async () => { finishLoad({ status: 'missing', root: suggestion, defaultSuggestion: suggestion }); await loading })
    assert.match(text(), /找不到资料库/)
    pick = { success: true, path: selected }
    await click('选择已有文件夹…')
    assert.equal(setCalls, 1)
    assert.deepEqual(useWorkspace.getState().pinnedFolders, [suggestion, selected])
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
