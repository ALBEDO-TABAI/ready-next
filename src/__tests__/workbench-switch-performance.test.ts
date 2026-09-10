import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { BrowserWindow } from 'electron'
import type { BrowserViewIntent } from '../shared/browser-view-intent'
import type { BrowserHostView, BrowserRect } from '../main/modules/browser-engine/host-types'
import { BrowserVisibilityRuntime } from '../main/modules/browser-engine/browser-visibility-runtime'
import { useBrowserTabs, flushBrowserTabsPersistence } from '../renderer/stores/useBrowserTabs'
import { useBrowserViewBounds } from '../renderer/modules/browser/useBrowserViewBounds'
import { PANEL_RESIZE_STATE_EVENT } from '../renderer/modules/browser/resize-events'

export const __breaksInvariants = ['browser-tab-store.reset-between-isolated-tests'] as const

// The layout tests supply native view/window objects and never call createHost.
const { BrowserHostLayoutService } = createRequire(import.meta.url)('../main/modules/browser-engine/host-layout-service.ts') as typeof import('../main/modules/browser-engine/host-layout-service')

test('actual browser store preserves unaffected rows through metadata, selection and group updates', () => {
  const initial = useBrowserTabs.getState()
  try {
    initial.setTabs(Array.from({ length: 80 }, (_, index) => ({
      id: `perf-${index}`, url: `https://example.test/${index}`, title: `Tab ${index}`,
      loading: false, canGoBack: false, canGoForward: false,
    })))
    initial.createTabGroupFromDrop('perf-1', 'perf-0')
    const before = useBrowserTabs.getState()
    before.updateTab('perf-40', { title: 'Changed title' })
    const updated = useBrowserTabs.getState()
    assert.equal(updated.tabs.filter((tab, index) => tab !== before.tabs[index]).length, 1)
    assert.equal(updated.tabGroups, before.tabGroups)

    updated.setActiveTabId('perf-40')
    const selected = useBrowserTabs.getState()
    assert.equal(selected.tabs, updated.tabs)
    assert.equal(selected.tabGroups, updated.tabGroups)
    selected.setSplitTabId('perf-41')
    assert.equal(useBrowserTabs.getState().tabs, selected.tabs)
    selected.setActiveTabId('perf-41')
    assert.equal(useBrowserTabs.getState().splitTabId, null)

    const groupId = selected.tabGroups[0].id
    selected.renameTabGroup(groupId, 'Renamed')
    const renamed = useBrowserTabs.getState()
    assert.equal(renamed.tabs, selected.tabs)
    assert.equal(renamed.tabGroups[0].name, 'Renamed')
    renamed.removeTab('perf-0')
    renamed.removeTab('perf-1')
    assert.deepEqual(useBrowserTabs.getState().tabGroups, [])
    assert.ok(useBrowserTabs.getState().tabs.every((tab) => tab.groupId === null))
  } finally {
    flushBrowserTabsPersistence()
    useBrowserTabs.setState(initial, true)
  }
})

test('already visible native hosts update in place and still recover after hiding or window replacement', () => {
  let adds = 0
  let removes = 0
  const applied: BrowserRect[] = []
  const mainWindow = { contentView: {
    addChildView: () => { adds += 1 },
    removeChildView: () => { removes += 1 },
  } } as unknown as BrowserWindow
  const view = { setBounds: (bounds: BrowserRect) => applied.push(bounds) } as unknown as BrowserHostView
  const service = new BrowserHostLayoutService(mainWindow)
  const bounds = { x: 100, y: 60, width: 700, height: 500 }
  service.showHost(view, bounds)
  service.showHost(view, bounds)
  service.showHost(view, { ...bounds, x: 120 })
  assert.equal(adds, 1)
  assert.equal(removes, 0)
  assert.deepEqual(applied, [bounds, { ...bounds, x: 120 }])
  service.hideHost(view)
  service.showHost(view, bounds)
  assert.equal(service.isHostVisible(view), true)
  assert.deepEqual(applied.at(-1), bounds)
  service.detachHost(view)
  service.showHost(view, bounds)
  assert.equal(adds, 3)
  service.setMainWindow(mainWindow)
  service.showHost(view, bounds)
  assert.equal(adds, 4)
})

test('primary bounds do not rescan all tab load states; visibility and split membership still reconcile', () => {
  let reconciles = 0
  let actions = 0
  let pointerClears = 0
  const runtime = new BrowserVisibilityRuntime({
    hideAllHosts: () => ({ success: true }), hideActiveHost: () => ({ success: true }),
    showActiveHost: () => ({ success: true }),
    applyIntent: () => { actions += 1; return { success: true } },
    clearAgentPointer: () => { pointerClears += 1 },
    reconcileLoadStates: () => { reconciles += 1 }, recordIntent: () => undefined,
    log: () => undefined,
  })
  for (let i = 0; i < 60; i += 1) {
    runtime.applyIntent({ kind: 'set-bounds', intentId: i + 1, tabId: 'a', bounds: { x: i, y: 60, w: 700, h: 500 } })
  }
  assert.equal(actions, 60)
  assert.equal(pointerClears, 60)
  assert.equal(reconciles, 0)
  runtime.applyIntent({ kind: 'hide-all', intentId: 61, reason: 'overlay-open' })
  runtime.applyIntent({ kind: 'show', intentId: 62, tabId: 'a', bounds: { x: 60, y: 60, w: 700, h: 500 }, reason: 'tab-activate' })
  runtime.applyIntent({ kind: 'secondary-set-bounds', intentId: 63, tabId: 'b', bounds: { x: 760, y: 60, w: 300, h: 500 } })
  assert.equal(reconciles, 3)
  runtime.applyIntent({ kind: 'hide-all', intentId: 60, reason: 'overlay-open' })
  assert.equal(reconciles, 3)
  assert.equal(runtime.shouldPresentHosts(), true)
})

test('side-panel click animation forwards ResizeObserver geometry before the next frame and deduplicates it', async () => {
  const dom = new JSDOM('<div id="root"></div><div id="surface"></div>', { url: 'http://localhost' })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const resizeCallbacks = new Set<() => void>()
  install('window', dom.window)
  install('document', dom.window.document)
  install('IS_REACT_ACT_ENVIRONMENT', true)
  install('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe() { resizeCallbacks.add(this.callback) }
    disconnect() { resizeCallbacks.delete(this.callback) }
  })
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = (id) => { frames.delete(id) }
  const intents: BrowserViewIntent[] = []
  Object.defineProperty(window, 'electronAPI', { value: { browser: {
    sendIntent: (intent: BrowserViewIntent) => { intents.push(intent); return { success: true } },
  } } })
  const surface = document.getElementById('surface') as HTMLDivElement
  let x = 100
  surface.getBoundingClientRect = () => ({ x, y: 60, left: x, top: 60, width: 700, height: 500, right: x + 700, bottom: 560, toJSON: () => ({}) })
  const contentRef = { current: surface }
  const hostVisibleRef = { current: true }
  function Harness({ active = true }: { active?: boolean }) {
    useBrowserViewBounds({
      isElectron: true, contentRef, activeTabId: 'a', isActive: active, layoutPhase: 'idle',
      hostVisibleRef, topInset: 0, sidebarVisible: true, sidePanelVariant: 'files',
      effectiveSidePanelWidth: 260, skillsSplitRatio: 50, chatPanelVisible: true,
      chatPanelWidth: 360, hasError: false,
    })
    return null
  }
  const root = createRoot(document.getElementById('root')!)
  const tick = async () => {
    await act(async () => {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(0))
    })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    for (let frame = 0; frame < 6; frame += 1) await tick()
    intents.length = 0
    window.dispatchEvent(new dom.window.CustomEvent(PANEL_RESIZE_STATE_EVENT, {
      detail: { resizing: true, reason: 'click-toggle' },
    }))
    x = 180
    resizeCallbacks.forEach((callback) => callback())
    assert.deepEqual(intents.filter((intent) => intent.kind === 'set-bounds').map((intent) => intent.bounds.x), [180])
    resizeCallbacks.forEach((callback) => callback())
    await tick()
    assert.equal(intents.filter((intent) => intent.kind === 'set-bounds').length, 1)
    await act(async () => root.render(createElement(Harness, { active: false })))
    intents.length = 0
    x = 220
    resizeCallbacks.forEach((callback) => callback())
    await tick()
    assert.equal(intents.length, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
