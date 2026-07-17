import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTabSuspensionService } from '../main/modules/browser-engine/browser-tab-suspension-service'
import type { BrowserTabLoadState } from '../main/modules/browser-engine/browser-tab-load-governor'

function tab(id: string, options: {
  state?: BrowserTabLoadState
  entries?: unknown[]
  index?: number
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  loading?: boolean
} = {}) {
  let closed = 0
  const record = {
    id,
    required: options.required ?? false,
    activity: options.activity ?? 'idle' as const,
    loading: options.loading ?? false,
    view: {
      webContents: {
        navigationHistory: {
          getAllEntries: () => (options.entries ?? [{ url: `https://${id}.example` }]),
          getActiveIndex: () => options.index ?? 0,
        },
        close: () => { closed += 1 },
      },
    },
    restoreSnapshot: null,
  }
  return { record, state: options.state ?? 'throttled' as BrowserTabLoadState, closed: () => closed }
}

test('cold pressure reclaim requires a complete history snapshot and preserves the tab record', () => {
  const cold = tab('cold')
  const incomplete = tab('incomplete', { entries: [] })
  const visible = tab('visible', { state: 'visible' })
  const records = [cold, incomplete, visible]
  const detached: string[] = []
  const disposed: string[] = []
  const service = new BrowserTabSuspensionService({
    getTabs: () => records.map((item) => item.record),
    getLoadState: (id) => records.find((item) => item.record.id === id)?.state ?? null,
    getLastInteractionAt: () => null,
    wasRecentlyInteracted: () => false,
    getMaxLiveViews: () => 2,
    isMemoryPressure: () => false,
    detachHost: (view) => {
      const owner = records.find((item) => item.record.view === view)
      if (owner) detached.push(owner.record.id)
    },
    disposeTabResources: (id) => disposed.push(id),
  })

  const reclaimed = service.reclaimIfNeeded()

  assert.deepEqual(reclaimed, ['cold'])
  assert.deepEqual(detached, ['cold'])
  assert.deepEqual(disposed, ['cold'])
  assert.equal(cold.closed(), 1)
  assert.equal(cold.record.view, undefined)
  assert.deepEqual(cold.record.restoreSnapshot, {
    entries: [{ url: 'https://cold.example' }],
    index: 0,
  })
  assert.ok(incomplete.record.view)
  assert.ok(visible.record.view)
})

test('protected, running, loading, recent, visible, and snapshotless tabs are never reclaimed', () => {
  const candidates = [
    tab('required', { required: true }),
    tab('running', { activity: 'running' }),
    tab('loading', { loading: true }),
    tab('recent'),
    tab('visible', { state: 'visible' }),
    tab('protected', { state: 'protected-background' }),
    tab('snapshotless', { entries: [] }),
  ]
  const service = new BrowserTabSuspensionService({
    getTabs: () => candidates.map((item) => item.record),
    getLoadState: (id) => candidates.find((item) => item.record.id === id)?.state ?? null,
    getLastInteractionAt: () => null,
    wasRecentlyInteracted: (id) => id === 'recent',
    getMaxLiveViews: () => 1,
    isMemoryPressure: () => true,
    detachHost: () => assert.fail('protected tab detached'),
    disposeTabResources: () => assert.fail('protected tab resources disposed'),
  })

  assert.deepEqual(service.reclaimIfNeeded(), [])
  assert.ok(candidates.every((item) => item.record.view))
})

test('over-budget recent tabs schedule one recheck for the end of the input floor', () => {
  const recent = tab('recent')
  const visible = tab('visible', { state: 'visible' })
  const now = 1_000_000
  const service = new BrowserTabSuspensionService({
    getTabs: () => [recent.record, visible.record],
    getLoadState: (id) => id === 'recent' ? 'throttled' : 'visible',
    getLastInteractionAt: (id) => id === 'recent' ? now - 1_000 : null,
    wasRecentlyInteracted: (id) => id === 'recent',
    getMaxLiveViews: () => 1,
    isMemoryPressure: () => false,
    detachHost: () => assert.fail('recent tab detached'),
    disposeTabResources: () => assert.fail('recent tab resources disposed'),
    recentInputFloorMs: 5_000,
    now: () => now,
  })

  assert.deepEqual(service.reclaimIfNeeded(), [])
  assert.equal(service.getNextRecheckDelayMs(), 4_000)
})

test('remaining cold candidates keep one low-frequency pressure recheck', () => {
  const cold = tab('cold')
  const service = new BrowserTabSuspensionService({
    getTabs: () => [cold.record],
    getLoadState: () => 'throttled',
    getLastInteractionAt: () => null,
    wasRecentlyInteracted: () => false,
    getMaxLiveViews: () => 4,
    isMemoryPressure: () => true,
    detachHost: () => undefined,
    disposeTabResources: () => undefined,
  })

  assert.equal(service.getNextRecheckDelayMs(), 30_000)
})

test('over-budget loading candidates keep a recheck alive until loading completes', () => {
  const loading = tab('loading', { loading: true })
  const visible = tab('visible', { state: 'visible' })
  const service = new BrowserTabSuspensionService({
    getTabs: () => [loading.record, visible.record],
    getLoadState: (id) => id === 'loading' ? 'throttled' : 'visible',
    getLastInteractionAt: () => null,
    wasRecentlyInteracted: () => false,
    getMaxLiveViews: () => 1,
    isMemoryPressure: () => false,
    detachHost: () => undefined,
    disposeTabResources: () => undefined,
  })

  assert.deepEqual(service.reclaimIfNeeded(), [])
  assert.equal(service.getNextRecheckDelayMs(), 30_000)
  loading.record.loading = false
  assert.deepEqual(service.reclaimIfNeeded(), ['loading'])
})

test('a cold background view keeps low-frequency memory-pressure sampling active within budget', () => {
  const cold = tab('cold')
  const visible = tab('visible', { state: 'visible' })
  const service = new BrowserTabSuspensionService({
    getTabs: () => [cold.record, visible.record],
    getLoadState: (id) => id === 'cold' ? 'throttled' : 'visible',
    getLastInteractionAt: () => null,
    wasRecentlyInteracted: () => false,
    getMaxLiveViews: () => 4,
    isMemoryPressure: () => false,
    detachHost: () => undefined,
    disposeTabResources: () => undefined,
  })

  assert.equal(service.getNextRecheckDelayMs(), 30_000)
})
