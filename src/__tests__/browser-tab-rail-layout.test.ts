import assert from 'node:assert/strict'
import test from 'node:test'

import { getTabRailLayoutMetrics } from '../renderer/modules/browser/tab-rail-layout'

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
