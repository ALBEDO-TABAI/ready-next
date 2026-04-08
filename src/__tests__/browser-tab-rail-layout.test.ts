import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getActiveTabSlotMetrics,
  getActiveTabSurfaceMetrics,
  getTabRailLayoutMetrics,
} from '../renderer/modules/browser/tab-rail-layout'

test('tab rail compresses inactive and active compact widths as the tab count grows', () => {
  const roomy = getTabRailLayoutMetrics(3)
  const crowded = getTabRailLayoutMetrics(8)

  assert.ok(crowded.inactiveWidth < roomy.inactiveWidth)
  assert.ok(crowded.inactiveMinWidth < roomy.inactiveMinWidth)
  assert.ok(crowded.activeCompactWidth < roomy.activeCompactWidth)
  assert.ok(crowded.activeCompactMinWidth < roomy.activeCompactMinWidth)
})

test('tab rail width compression keeps safe lower bounds so tabs remain usable', () => {
  const crowded = getTabRailLayoutMetrics(12)

  assert.ok(crowded.inactiveMinWidth >= 88)
  assert.ok(crowded.activeCompactMinWidth >= 132)
  assert.ok(crowded.activeCompactWidth >= crowded.activeCompactMinWidth)
  assert.ok(crowded.inactiveWidth >= crowded.inactiveMinWidth)
})

test('active tab slot expands its reserved width when the address bar opens so neighbors are pushed instead of overlapped', () => {
  const layout = getTabRailLayoutMetrics(5)

  const compactSurface = getActiveTabSurfaceMetrics(layout, 'compact')
  const expandedSurface = getActiveTabSurfaceMetrics(layout, 'expanded')
  const compactSlot = getActiveTabSlotMetrics(layout, 'compact', 'idle')
  const expandedSlot = getActiveTabSlotMetrics(layout, 'expanded', 'idle')

  assert.ok(expandedSurface.width > compactSurface.width)
  assert.ok(expandedSurface.minWidth > compactSurface.minWidth)
  assert.ok(expandedSlot.width > compactSlot.width)
  assert.ok(expandedSlot.minWidth > compactSlot.minWidth)
})

test('active tab slot also reserves extra width when the refresh dock reveals secondary controls', () => {
  const layout = getTabRailLayoutMetrics(4)

  const compactIdleSlot = getActiveTabSlotMetrics(layout, 'compact', 'idle')
  const compactRevealedSlot = getActiveTabSlotMetrics(layout, 'compact', 'revealed')

  assert.ok(compactRevealedSlot.width > compactIdleSlot.width)
  assert.ok(compactRevealedSlot.minWidth > compactIdleSlot.minWidth)
})
