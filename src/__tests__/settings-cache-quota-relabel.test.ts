/**
 * Stage Y0.8 — Settings cache quota relabel behavior test (path-(b) per plan §11.0a).
 *
 * Sub-plan: docs/superpowers/plans/archive/2026-05-23-Y0-8-cache-quota-relabel-implementation.md
 *
 * Path-(b) (relabel) is the chosen disposition for Y0.8 — the Settings cache
 * quota row gets honest "configured but NOT enforced; manual cleanup required"
 * labeling instead of pretending to enforce a limit. Stage Z owns real
 * eviction. This test mounts `StorageSettingsPanel` in jsdom and asserts
 * the rendered DOM contains the honest relabel + the quota selector still
 * renders (so the configured value still carries forward into Stage Z).
 *
 * Mount strategy follows `browser-blank-page-contract.test.ts`: jsdom +
 * createRoot + flushSync; electronAPI stubbed to return safe `{ success: false }`
 * for the cache-stats / cache-quota IPC channels so the panel reaches its
 * "loaded, no data" steady state without throwing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

interface PreviousGlobals {
  window: Window | undefined
  document: Document | undefined
  HTMLElement: typeof HTMLElement | undefined
  Node: typeof Node | undefined
  Element: typeof Element | undefined
  requestAnimationFrame: typeof requestAnimationFrame | undefined
  cancelAnimationFrame: typeof cancelAnimationFrame | undefined
  getComputedStyle: typeof getComputedStyle | undefined
  navigator: Navigator | undefined
}

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  const previous: PreviousGlobals = {
    window: g.window as Window | undefined,
    document: g.document as Document | undefined,
    HTMLElement: g.HTMLElement as typeof HTMLElement | undefined,
    Node: g.Node as typeof Node | undefined,
    Element: g.Element as typeof Element | undefined,
    requestAnimationFrame: g.requestAnimationFrame as typeof requestAnimationFrame | undefined,
    cancelAnimationFrame: g.cancelAnimationFrame as typeof cancelAnimationFrame | undefined,
    getComputedStyle: g.getComputedStyle as typeof getComputedStyle | undefined,
    navigator: g.navigator as Navigator | undefined,
  }

  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('navigator', dom.window.navigator)
  // useTheme reads matchMedia at module init; jsdom does not implement it.
  const matchMediaStub = (_q: string) => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMediaStub, configurable: true, writable: true })
  setGlobal('matchMedia', matchMediaStub)

  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
        }
      }
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

interface ElectronAPIStubResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

function installElectronAPIStub(dom: JSDOM): { getExportCalls: () => number } {
  let exportCalls = 0
  const settings = {
    get: async (_key: string): Promise<ElectronAPIStubResult<string>> => ({ success: false }),
    set: async (_key: string, _value: unknown): Promise<ElectronAPIStubResult> => ({ success: true }),
  }
  const app = {
    getCacheStats: async (): Promise<ElectronAPIStubResult<{ codeCacheBytes: number; cacheBytes: number; puppeteerCacheBytes: number; sharedCacheBytes: number }>> => ({
      success: true,
      data: {
        codeCacheBytes: 0,
        cacheBytes: 0,
        puppeteerCacheBytes: 0,
        sharedCacheBytes: 0,
      },
    }),
    clearCache: async (): Promise<ElectronAPIStubResult> => ({ success: true }),
    exportDiagnosticPack: async (): Promise<ElectronAPIStubResult<{ path: string; fileName: string; bytes: number; includedLogs: string[]; skippedLogs: Array<{ name: string; reason: string }> }>> => {
      exportCalls += 1
      return {
        success: true,
        data: {
          path: '/tmp/Ready-diagnostics.zip',
          fileName: 'Ready-diagnostics.zip',
          bytes: 2048,
          includedLogs: ['ready-agent-sdk.log (100 bytes)'],
          skippedLogs: [],
        },
      }
    },
  }
  ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = { settings, app }
  return { getExportCalls: () => exportCalls }
}

test('Y0.8 — StorageSettingsPanel renders the honest "not enforced; manual cleanup" relabel', async () => {
  const handle = installDomGlobals()
  installElectronAPIStub(handle.dom)

  // Dynamic import AFTER DOM globals install so renderer modules see
  // a real window/document at evaluation time.
  const { StorageSettingsPanel } = await import('../renderer/pages/settings/StorageSettingsPanel')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(StorageSettingsPanel)) })
    // Let the mount-time async settings.get / getCacheStats resolve.
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => { /* drain post-resolve state updates */ })

    const text = handle.dom.window.document.body.textContent || ''

    // Honest "size limit" heading (not the old "配额" framing).
    assert.ok(
      text.includes('缓存大小上限'),
      `expected "缓存大小上限" heading in DOM; got: ${text.slice(0, 500)}`,
    )

    // Description must promote "未强制执行" + "需要手动清理" into the user-facing copy.
    assert.ok(
      text.includes('未强制执行'),
      `expected "未强制执行" in DOM; got: ${text.slice(0, 500)}`,
    )
    assert.ok(
      text.includes('需要手动清理'),
      `expected "需要手动清理" in DOM; got: ${text.slice(0, 500)}`,
    )

    // Old description must be gone.
    assert.ok(
      !text.includes('Chromium 当前不强制驱逐'),
      'old "Chromium 当前不强制驱逐" copy must be removed (no additive relabel)',
    )
  } finally {
    root.unmount()
    // Drain any in-flight promises from the panel's mount-effect IPC calls
    // BEFORE restoring globals; otherwise post-resolve setState handlers can
    // throw `window is not defined` after the jsdom window is closed.
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('StorageSettingsPanel exposes one-click diagnostic pack export', async () => {
  const handle = installDomGlobals()
  const stub = installElectronAPIStub(handle.dom)

  const { StorageSettingsPanel } = await import('../renderer/pages/settings/StorageSettingsPanel')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(StorageSettingsPanel)) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => { /* drain */ })

    const text = handle.dom.window.document.body.textContent || ''
    assert.ok(text.includes('报错信息包'), 'diagnostic pack row must render in storage panel')

    const exportButton = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('导出')) as HTMLButtonElement | undefined
    assert.ok(exportButton, 'diagnostic export button must render')

    exportButton.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => { /* drain export state */ })

    assert.equal(stub.getExportCalls(), 1)
    assert.match(handle.dom.window.document.body.textContent || '', /已导出：\/tmp\/Ready-diagnostics\.zip/)
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('Y0.8 — quota <select> still renders with all four CACHE_QUOTA_OPTIONS so user can still pick a value', async () => {
  const handle = installDomGlobals()
  installElectronAPIStub(handle.dom)

  const { StorageSettingsPanel } = await import('../renderer/pages/settings/StorageSettingsPanel')

  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => { root.render(createElement(StorageSettingsPanel)) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => { /* drain */ })

    const select = handle.dom.window.document.querySelector('select')
    assert.ok(select, 'quota <select> must render in the storage panel')

    const optionValues = Array.from(select?.querySelectorAll('option') ?? [])
      .map((opt) => (opt as HTMLOptionElement).value)

    assert.deepEqual(
      optionValues.sort(),
      ['1GB', '256MB', '5GB', 'unlimited'],
      'CACHE_QUOTA_OPTIONS must render all four user-facing values so the configured value still carries forward into Stage Z',
    )
  } finally {
    root.unmount()
    // Drain any in-flight promises from the panel's mount-effect IPC calls
    // BEFORE restoring globals; otherwise post-resolve setState handlers can
    // throw `window is not defined` after the jsdom window is closed.
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})
