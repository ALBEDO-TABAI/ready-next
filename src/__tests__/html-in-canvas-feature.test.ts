import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BROWSER_AUTOPLAY_POLICY,
  HTML_IN_CANVAS_BLINK_FEATURE,
  withHtmlInCanvasWebPreferences,
} from '../main/modules/app-control/html-in-canvas-feature'

test('Ready scopes HTML-in-Canvas support to browser webPreferences', () => {
  const preferences = withHtmlInCanvasWebPreferences({
    partition: 'persist:browser',
    contextIsolation: true,
  })

  assert.equal(preferences.partition, 'persist:browser')
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.enableBlinkFeatures, HTML_IN_CANVAS_BLINK_FEATURE)
  assert.equal(preferences.autoplayPolicy, BROWSER_AUTOPLAY_POLICY)
})

test('Ready preserves existing enabled Blink features when adding HTML-in-Canvas', () => {
  const preferences = withHtmlInCanvasWebPreferences({
    enableBlinkFeatures: 'ExistingFeature, CanvasDrawElement',
  })

  assert.equal(preferences.enableBlinkFeatures, 'ExistingFeature,CanvasDrawElement')
})
