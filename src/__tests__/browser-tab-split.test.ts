import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { BrowserTabShellService, type BrowserShellTabRecord } from '../main/modules/browser-engine/tab-shell-service'
import { useBrowserTabs, type BrowserTab } from '../renderer/stores/useBrowserTabs'
import type { BrowserRect } from '../main/modules/browser-engine/host-types'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function makeBrowserTab(id: string): BrowserTab {
  return {
    id,
    url: `https://${id}.example.com`,
    title: id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    domain: `${id}.example.com`,
    owner: 'manual',
    required: false,
    activity: 'idle',
  }
}

function makeView(id: string) {
  return {
    id,
    webContents: {
      loadURL: async () => undefined,
      reload: () => undefined,
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
      },
    },
  }
}

function makeShellTab(id: string): BrowserShellTabRecord {
  return {
    id,
    url: `https://${id}.example.com`,
    title: id,
    domain: `${id}.example.com`,
    favicon: null,
    owner: 'manual',
    required: false,
    activity: 'idle',
    lastAuditedAt: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    view: makeView(id) as BrowserShellTabRecord['view'],
  }
}

function viewId(view: unknown): string {
  return typeof view === 'object' && view !== null && 'id' in view
    ? String((view as { id?: unknown }).id || '')
    : ''
}

test('browser tabs keep a secondary split tab while switching the primary tab', () => {
  useBrowserTabs.setState({
    tabs: [makeBrowserTab('tab-a'), makeBrowserTab('tab-b'), makeBrowserTab('tab-c')],
    activeTabId: 'tab-a',
    splitTabId: null,
    browserSplitRatio: 50,
    urlInput: '',
  })

  useBrowserTabs.getState().setSplitTabId('tab-b')
  assert.equal(useBrowserTabs.getState().splitTabId, 'tab-b')

  useBrowserTabs.getState().setBrowserSplitRatio(90)
  assert.equal(useBrowserTabs.getState().browserSplitRatio, 80)

  useBrowserTabs.getState().setActiveTabId('tab-c')
  assert.equal(useBrowserTabs.getState().activeTabId, 'tab-c')
  assert.equal(useBrowserTabs.getState().splitTabId, 'tab-b')

  useBrowserTabs.getState().setActiveTabId('tab-b')
  assert.equal(useBrowserTabs.getState().activeTabId, 'tab-b')
  assert.equal(useBrowserTabs.getState().splitTabId, null)

  useBrowserTabs.getState().setSplitTabId('tab-b')
  useBrowserTabs.getState().removeTab('tab-b')
  assert.equal(useBrowserTabs.getState().splitTabId, null)
})

test('browser split divider fades within the rounded browser canvas and does not grow on hover', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const styles = readRendererStyles()

  assert.match(browserMode, /className="browser-split-resize-handle"/)
  assert.match(browserMode, /className="browser-split-resize-handle__grip"/)
  assert.match(browserMode, /style=\{\{ gap: 0 \}\}/)

  assert.match(styles, /\.browser-split-resize-handle\s*\{[\s\S]*width:\s*3px;/)
  assert.match(styles, /\.browser-split-resize-handle\s*\{[\s\S]*flex:\s*0 0 3px;/)
  assert.match(styles, /\.browser-split-resize-handle\s*\{[\s\S]*background:\s*transparent;/)
  assert.match(styles, /\.browser-split-resize-handle::before\s*\{[\s\S]*background:\s*linear-gradient\(/)
  assert.match(styles, /\.browser-split-resize-handle::before\s*\{[\s\S]*var\(--workbench-liquid-chrome-bg, var\(--surface-panel-bg\)\) var\(--workbench-canvas-radius\)/)
  assert.match(styles, /\.browser-split-resize-handle::before\s*\{[\s\S]*color-mix\(in srgb, var\(--workbench-liquid-chrome-bg, var\(--surface-panel-bg\)\) 74%, transparent\) 42%/)
  assert.match(styles, /\.browser-split-resize-handle::before\s*\{[\s\S]*transparent calc\(100% - var\(--workbench-canvas-radius\)\)/)
  assert.match(styles, /\.browser-split-resize-handle__grip\s*\{[\s\S]*display:\s*none;/)
  assert.match(styles, /body\.resizing \.browser-split-resize-handle__grip\s*\{[\s\S]*opacity:\s*0;/)
})

test('BrowserTabShellService shows primary and secondary hosts with separate bounds', () => {
  const primaryBounds: BrowserRect = { x: 0, y: 48, width: 500, height: 700 }
  const secondaryBounds: BrowserRect = { x: 512, y: 48, width: 488, height: 700 }
  const tabs = new Map<string, BrowserShellTabRecord>([
    ['tab-a', makeShellTab('tab-a')],
    ['tab-b', makeShellTab('tab-b')],
    ['tab-c', makeShellTab('tab-c')],
  ])
  let activeTabId: string | null = 'tab-a'
  let splitTabId: string | null = null
  let storedPrimaryBounds: BrowserRect = { x: 0, y: 0, width: 1, height: 1 }
  let storedSecondaryBounds: BrowserRect = { x: 0, y: 0, width: 1, height: 1 }
  const shown: Array<{ id: string; bounds: BrowserRect }> = []
  const applied: Array<{ id: string; bounds?: BrowserRect; syncMode?: string }> = []
  const detached: string[] = []
  let previewDetached = false

  const service = new BrowserTabShellService({
    tabs,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId },
    getSplitTabId: () => splitTabId,
    setSplitTabId: (tabId) => { splitTabId = tabId },
    getViewBounds: () => storedPrimaryBounds,
    setViewBounds: (bounds) => { storedPrimaryBounds = bounds },
    getSplitViewBounds: () => storedSecondaryBounds,
    setSplitViewBounds: (bounds) => { storedSecondaryBounds = bounds },
    shouldPresentHosts: () => true,
    isAllowedUrl: () => true,
    createTab: async () => ({ success: false, error: 'not used' }),
    detachHost: (view) => { detached.push(viewId(view)) },
    showHost: (view, bounds) => { shown.push({ id: viewId(view), bounds }) },
    applyBounds: (view, syncMode, bounds) => {
      applied.push({ id: viewId(view), syncMode, bounds })
    },
    hideHost: () => undefined,
    detachPreviewView: () => { previewDetached = true },
    restoreActiveTabHost: () => undefined,
  })

  service.updateViewBounds({
    ...primaryBounds,
    tabId: 'tab-a',
    secondaryTabId: 'tab-b',
    secondaryBounds,
    syncMode: 'settled',
  })

  assert.equal(splitTabId, 'tab-b')
  assert.deepEqual(storedPrimaryBounds, primaryBounds)
  assert.deepEqual(storedSecondaryBounds, secondaryBounds)
  assert.deepEqual(applied.map((entry) => [entry.id, entry.bounds]), [
    ['tab-a', primaryBounds],
    ['tab-b', secondaryBounds],
  ])

  service.showActiveHost()

  assert.equal(previewDetached, true)
  assert.deepEqual(detached, ['tab-c'])
  assert.deepEqual(shown.map((entry) => [entry.id, entry.bounds]), [
    ['tab-a', primaryBounds],
    ['tab-b', secondaryBounds],
  ])
})

test('BrowserTabShellService preserves split hosts on primary tab switch', () => {
  const tabs = new Map<string, BrowserShellTabRecord>([
    ['tab-a', makeShellTab('tab-a')],
    ['tab-b', makeShellTab('tab-b')],
    ['tab-c', makeShellTab('tab-c')],
  ])
  let activeTabId: string | null = 'tab-a'
  let splitTabId: string | null = 'tab-b'
  const detached: string[] = []
  const shown: string[] = []
  const applied: Array<{ id: string; bounds?: BrowserRect; syncMode?: string }> = []

  const service = new BrowserTabShellService({
    tabs,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId },
    getSplitTabId: () => splitTabId,
    setSplitTabId: (tabId) => { splitTabId = tabId },
    getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setViewBounds: () => undefined,
    getSplitViewBounds: () => ({ x: 0, y: 0, width: 400, height: 600 }),
    setSplitViewBounds: () => undefined,
    shouldPresentHosts: () => true,
    isAllowedUrl: () => true,
    createTab: async () => ({ success: false, error: 'not used' }),
    detachHost: (view) => { detached.push(viewId(view)) },
    showHost: (view) => { shown.push(viewId(view)) },
    applyBounds: (view, syncMode, bounds) => {
      applied.push({ id: viewId(view), syncMode, bounds })
    },
    hideHost: () => undefined,
    detachPreviewView: () => undefined,
    restoreActiveTabHost: () => undefined,
  })

  const result = service.switchTab('tab-c')

  assert.equal(result.success, true)
  assert.equal(activeTabId, 'tab-c')
  assert.equal(splitTabId, 'tab-b')
  assert.deepEqual(shown, ['tab-c', 'tab-b'])
  assert.deepEqual(detached, ['tab-a'])
  assert.deepEqual(applied, [
    { id: 'tab-c', syncMode: undefined, bounds: undefined },
    { id: 'tab-b', syncMode: 'settled', bounds: { x: 0, y: 0, width: 400, height: 600 } },
  ])
})
