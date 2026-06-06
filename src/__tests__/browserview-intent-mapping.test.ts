/**
 * Stage X4 PR-shell-1 — BrowserViewIntent → BrowserView API mapping.
 *
 * Per plan §9 line 643 + line 653, the renderer-side `BrowserViewIntent`
 * boundary funnels every visibility/bounds decision through
 * `BrowserTabShellService.applyIntent`. This test covers every `kind`
 * value of the discriminated union and asserts that the stubbed
 * BrowserView receives the right call with the right args.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTabShellService, type BrowserShellTabRecord } from '../main/modules/browser-engine/tab-shell-service'
import type { BrowserBoundsSyncMode } from '../shared/browser-view-layout'
import type { BrowserHostView, BrowserRect } from '../main/modules/browser-engine/host-types'
import type { BrowserViewIntent } from '../shared/browser-view-intent'

type ApplyArgs = { view: unknown; syncMode: BrowserBoundsSyncMode; bounds: BrowserRect | null }

interface HostCalls {
  shown: Array<{ view: unknown; bounds: BrowserRect }>
  hidden: Array<{ view: unknown }>
  applied: ApplyArgs[]
  detached: Array<{ view: unknown }>
  viewBounds: BrowserRect | null
  splitTabId: string | null
  splitViewBounds: BrowserRect | null
  previewDetached: number
  restored: number
}

function makeStubView(label: string): BrowserHostView {
  return { __label: label } as unknown as BrowserHostView
}

function makeShellService(opts: {
  tabs: BrowserShellTabRecord[]
  activeTabId: string | null
  shouldPresent?: boolean
  getFrozenBounds?: (tabId: string) => BrowserRect | null
}) {
  const tabsMap = new Map(opts.tabs.map((t) => [t.id, t]))
  const calls: HostCalls = {
    shown: [],
    hidden: [],
    applied: [],
    detached: [],
    viewBounds: null,
    splitTabId: null,
    splitViewBounds: null,
    previewDetached: 0,
    restored: 0,
  }
  let activeTabId = opts.activeTabId
  let splitTabId: string | null = null
  let viewBounds: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }
  let splitViewBounds: BrowserRect = { x: 0, y: 0, width: 0, height: 0 }
  const service = new BrowserTabShellService({
    tabs: tabsMap,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (id) => { activeTabId = id },
    getSplitTabId: () => splitTabId,
    setSplitTabId: (id) => {
      splitTabId = id
      calls.splitTabId = id
    },
    getViewBounds: () => viewBounds,
    setViewBounds: (b) => {
      viewBounds = b
      calls.viewBounds = b
    },
    getSplitViewBounds: () => splitViewBounds,
    setSplitViewBounds: (b) => {
      splitViewBounds = b
      calls.splitViewBounds = b
    },
    getFrozenBounds: opts.getFrozenBounds,
    shouldPresentHosts: () => opts.shouldPresent !== false,
    isAllowedUrl: () => true,
    createTab: async () => ({ success: true, tabId: 'created' }),
    detachHost: (v) => calls.detached.push({ view: v }),
    showHost: (v, b) => calls.shown.push({ view: v, bounds: b }),
    applyBounds: (v, syncMode, bounds) => calls.applied.push({ view: v, syncMode: syncMode ?? 'settled', bounds: bounds ?? null }),
    hideHost: (v) => calls.hidden.push({ view: v }),
    detachPreviewView: () => { calls.previewDetached += 1 },
    restoreActiveTabHost: () => { calls.restored += 1 },
  })
  return { service, calls, tabsMap }
}

function makeTab(id: string, view: BrowserHostView): BrowserShellTabRecord {
  return {
    id,
    url: 'https://example.com/' + id,
    title: id,
    domain: 'example.com',
    favicon: null,
    owner: 'manual',
    required: false,
    activity: 'idle',
    lastAuditedAt: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    view: view as unknown as BrowserShellTabRecord['view'],
  }
}

test('applyIntent kind=hide-all hides every attached tab view and detaches the preview', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = { kind: 'hide-all', intentId: 1, reason: 'mode-switch-prepare' }
  const result = service.applyIntent(intent)
  assert.equal(result.success, true)
  assert.equal(calls.hidden.length, 2)
  assert.deepEqual(new Set(calls.hidden.map((c) => c.view)), new Set([v1, v2]))
  assert.equal(calls.previewDetached, 1)
})

test('applyIntent kind=show shows the target tab when shouldPresentHosts is true', () => {
  const v1 = makeStubView('t1')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = {
    kind: 'show',
    intentId: 2,
    tabId: 't1',
    bounds: { x: 10, y: 20, w: 800, h: 600 },
    reason: 'mode-switch',
  }
  const result = service.applyIntent(intent)
  assert.equal(result.success, true)
  assert.equal(calls.shown.length, 1)
  assert.deepEqual(calls.shown[0].bounds, { x: 10, y: 20, width: 800, height: 600 })
  assert.equal(calls.shown[0].view, v1)
  // setViewBounds should reflect the show bounds even when present-hosts
  // gate is true (parity with showActiveHost legacy path).
  assert.deepEqual(calls.viewBounds, { x: 10, y: 20, width: 800, height: 600 })
})

test('applyIntent kind=show skips DOM-level show when shouldPresentHosts is false but still records bounds', () => {
  const v1 = makeStubView('t1')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
    shouldPresent: false,
  })
  const intent: BrowserViewIntent = {
    kind: 'show',
    intentId: 3,
    tabId: 't1',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    reason: 'tab-activate',
  }
  service.applyIntent(intent)
  assert.equal(calls.shown.length, 0)
  assert.deepEqual(calls.viewBounds, { x: 0, y: 0, width: 100, height: 100 })
})

test('applyIntent kind=hide hides a specific tab view only', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = { kind: 'hide', intentId: 4, tabId: 't2', reason: 'tab-deactivate' }
  service.applyIntent(intent)
  assert.equal(calls.hidden.length, 1)
  assert.equal(calls.hidden[0].view, v2)
})

test('applyIntent kind=hide with split-collapse detaches the secondary host and clears split state', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
  })

  service.applyIntent({
    kind: 'secondary-set-bounds',
    intentId: 5,
    tabId: 't2',
    bounds: { x: 400, y: 0, w: 400, h: 600 },
  })
  const result = service.applyIntent({
    kind: 'hide',
    intentId: 6,
    tabId: 't2',
    reason: 'split-collapse',
  })

  assert.equal(result.success, true)
  assert.deepEqual(calls.detached.map((entry) => entry.view), [v2])
  assert.equal(calls.splitTabId, null)
})

test('applyIntent kind=hide with split-collapse does not detach a promoted active tab', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
  })

  service.applyIntent({
    kind: 'secondary-set-bounds',
    intentId: 7,
    tabId: 't2',
    bounds: { x: 400, y: 0, w: 400, h: 600 },
  })
  service.switchTab('t2')
  const result = service.applyIntent({
    kind: 'hide',
    intentId: 8,
    tabId: 't2',
    reason: 'split-collapse',
  })

  assert.equal(result.success, true)
  assert.equal(calls.detached.filter((entry) => entry.view === v2).length, 0)
})

test('applyIntent kind=set-bounds applies primary bounds and records viewBounds', () => {
  const v1 = makeStubView('t1')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = {
    kind: 'set-bounds',
    intentId: 5,
    tabId: 't1',
    bounds: { x: 5, y: 10, w: 600, h: 400 },
    syncMode: 'transient',
  }
  service.applyIntent(intent)
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.applied[0].view, v1)
  assert.equal(calls.applied[0].syncMode, 'transient')
  assert.deepEqual(calls.applied[0].bounds, { x: 5, y: 10, width: 600, height: 400 })
  assert.deepEqual(calls.viewBounds, { x: 5, y: 10, width: 600, height: 400 })
})

test('applyIntent kind=set-bounds defaults syncMode to settled when omitted', () => {
  const v1 = makeStubView('t1')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = {
    kind: 'set-bounds',
    intentId: 6,
    tabId: 't1',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
  }
  service.applyIntent(intent)
  assert.equal(calls.applied[0].syncMode, 'settled')
})

test('applyIntent kind=set-bounds preserves frozen tab bounds during collection', () => {
  const v1 = makeStubView('t1')
  const frozen = { x: 8, y: 9, width: 640, height: 480 }
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
    getFrozenBounds: (tabId) => tabId === 't1' ? frozen : null,
  })
  service.applyIntent({
    kind: 'set-bounds',
    intentId: 7,
    tabId: 't1',
    bounds: { x: 100, y: 200, w: 320, h: 240 },
    syncMode: 'transient',
  })

  assert.deepEqual(calls.applied[0].bounds, frozen)
  assert.deepEqual(calls.viewBounds, { x: 100, y: 200, width: 320, height: 240 })
})

test('applyIntent kind=secondary-set-bounds applies bounds to the secondary tab and records split state', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = {
    kind: 'secondary-set-bounds',
    intentId: 7,
    tabId: 't2',
    bounds: { x: 400, y: 0, w: 400, h: 600 },
    syncMode: 'transient',
  }
  service.applyIntent(intent)
  assert.equal(calls.shown.length, 1)
  assert.equal(calls.shown[0].view, v2)
  assert.deepEqual(calls.shown[0].bounds, { x: 400, y: 0, width: 400, height: 600 })
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.applied[0].view, v2)
  assert.equal(calls.applied[0].syncMode, 'transient')
  assert.deepEqual(calls.applied[0].bounds, { x: 400, y: 0, width: 400, height: 600 })
  assert.equal(calls.splitTabId, 't2')
  assert.deepEqual(calls.splitViewBounds, { x: 400, y: 0, width: 400, height: 600 })
  // Primary `viewBounds` is NOT clobbered by a secondary intent.
  assert.equal(calls.viewBounds, null)
})

test('applyIntent kind=secondary-set-bounds preserves frozen split tab bounds during collection', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const frozen = { x: 420, y: 12, width: 580, height: 620 }
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2)],
    activeTabId: 't1',
    getFrozenBounds: (tabId) => tabId === 't2' ? frozen : null,
  })

  service.applyIntent({
    kind: 'secondary-set-bounds',
    intentId: 8,
    tabId: 't2',
    bounds: { x: 200, y: 0, w: 300, h: 600 },
    syncMode: 'transient',
  })

  assert.deepEqual(calls.shown[0].bounds, frozen)
  assert.deepEqual(calls.applied[0].bounds, frozen)
  assert.deepEqual(calls.splitViewBounds, { x: 200, y: 0, width: 300, height: 600 })
})

test('applyIntent kind=secondary-set-bounds detaches the previous secondary tab when replacing split state', () => {
  const v1 = makeStubView('t1')
  const v2 = makeStubView('t2')
  const v3 = makeStubView('t3')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1), makeTab('t2', v2), makeTab('t3', v3)],
    activeTabId: 't1',
  })

  service.applyIntent({
    kind: 'secondary-set-bounds',
    intentId: 8,
    tabId: 't2',
    bounds: { x: 400, y: 0, w: 400, h: 600 },
  })
  service.applyIntent({
    kind: 'secondary-set-bounds',
    intentId: 9,
    tabId: 't3',
    bounds: { x: 420, y: 0, w: 380, h: 600 },
  })

  assert.deepEqual(calls.detached.map((entry) => entry.view), [v2])
  assert.equal(calls.splitTabId, 't3')
  assert.equal(calls.shown.at(-1)?.view, v3)
})

test('applyIntent kind=secondary-set-bounds is a no-op for an unknown tab id', () => {
  const v1 = makeStubView('t1')
  const { service, calls } = makeShellService({
    tabs: [makeTab('t1', v1)],
    activeTabId: 't1',
  })
  const intent: BrowserViewIntent = {
    kind: 'secondary-set-bounds',
    intentId: 8,
    tabId: 'missing',
    bounds: { x: 0, y: 0, w: 100, h: 100 },
  }
  service.applyIntent(intent)
  assert.equal(calls.applied.length, 0)
  // splitTabId is still updated even when the view is missing — main
  // side wants to track the intended split target.
  assert.equal(calls.splitTabId, 'missing')
})
