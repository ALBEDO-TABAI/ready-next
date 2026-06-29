import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveVerticalRailFlyoutContentHeight,
  resolveVerticalRailFlyoutHeight,
  resolveVerticalRailFlyoutScrollOffset,
  VERTICAL_RAIL_FLYOUT_MIN_HEIGHT,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
  VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
} from '../shared/vertical-rail-flyout-layout'

test('vertical rail flyout height fits tab rows and the new-tab row', () => {
  assert.equal(resolveVerticalRailFlyoutHeight(7, 900), 344)
  assert.equal(resolveVerticalRailFlyoutHeight(1, 900), 92)
  assert.equal(resolveVerticalRailFlyoutContentHeight(1), 92)
})

test('vertical rail flyout height stays bounded by the rail', () => {
  assert.equal(resolveVerticalRailFlyoutHeight(40, 360), 360)
  assert.equal(resolveVerticalRailFlyoutHeight(0, 900), VERTICAL_RAIL_FLYOUT_MIN_HEIGHT)
})

test('vertical rail flyout scroll offset mirrors the icon rail without over-scrolling', () => {
  assert.equal(resolveVerticalRailFlyoutScrollOffset(120, 30, 360), 120)
  assert.equal(resolveVerticalRailFlyoutScrollOffset(5000, 30, 360), resolveVerticalRailFlyoutContentHeight(30) - 360)
  assert.equal(resolveVerticalRailFlyoutScrollOffset(120, 1, 900), 0)
})

test('vertical rail flyout surface keeps labels near opaque without fading text', () => {
  assert.equal(VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND, 'var(--chat-menu-frost-bg, rgba(236, 239, 243, 0.92))')
  assert.equal(VERTICAL_RAIL_FLYOUT_SURFACE_BORDER, '0.5px solid var(--chat-menu-frost-border, rgba(255, 255, 255, 0.42))')
  assert.equal(VERTICAL_RAIL_FLYOUT_RADIUS, 14)
  assert.equal(VERTICAL_RAIL_FLYOUT_ROW_RADIUS, 10)
  assert.match(VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP, /blur/)
})
