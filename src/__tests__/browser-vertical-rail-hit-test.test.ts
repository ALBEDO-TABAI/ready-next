import assert from 'node:assert/strict'
import test from 'node:test'
import { isPointInsideVerticalRailOverlayRegion } from '../shared/browser-vertical-rail-overlay'

const rail = { x: 100, y: 80, width: 52, height: 600 }
const overlay = { x: 152, y: 80, width: 248, height: 420 }

test('vertical rail hit test treats the rail and child overlay as one interaction region', () => {
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 151, y: 200 }, rail, overlay), true)
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 152, y: 200 }, rail, overlay), true)
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 399, y: 200 }, rail, overlay), true)
})

test('vertical rail hit test closes only after the pointer leaves both windows', () => {
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 400, y: 200 }, rail, overlay), false)
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 200, y: 500 }, rail, overlay), false)
  assert.equal(isPointInsideVerticalRailOverlayRegion({ x: 120, y: 700 }, rail, overlay), false)
})
