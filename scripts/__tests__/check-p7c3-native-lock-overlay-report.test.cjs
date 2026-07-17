const assert = require('node:assert/strict')
const test = require('node:test')

const { validateReport } = require('../check-p7c3-native-lock-overlay-report.cjs')

function validReport() {
  return {
    ok: true,
    scope: 'P7c3-browserview-proof-native-lock-overlay',
    generatedAt: '2026-06-20T00:00:00.000Z',
    overlay: {
      mechanism: 'native-child-browser-window',
      visible: true,
      bounds: { x: 100, y: 100, width: 304, height: 58 },
      route: '/browser-lock-overlay',
    },
    pointer: {
      mechanism: 'click-through-native-child-window',
      route: '/browser-agent-pointer',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    },
    browserViewFixture: {
      activeTabId: 'tab-1',
      fixtureUrl: 'http://127.0.0.1:12345/',
    },
    captures: {
      browserViewCdpPath: null,
      osCompositedAttemptPath: 'outputs/agent-audit/live/p7c3-composited.png',
    },
    assertions: {
      lockStateMatchesOverlay: { ok: true },
      overlayWindowRendersProofMarker: { ok: true, source: 'overlay-window-dom' },
      nativeOverlayBoundsIntersectBrowserView: { ok: true, source: 'runtime-native-child-window-geometry' },
      browserViewTargetRendersFixture: { ok: true, source: 'browser-webcontents-runtime-eval' },
      overlayClearsAfterUnlock: { ok: true },
      closeButtonDismissesOverlay: { ok: true, source: 'native-overlay-close-button' },
      pointerMatchesTrustedInput: { ok: true, source: 'trusted-cdp-input-and-native-pointer-geometry' },
      pointerClearsOnBrowserViewLifecycle: { ok: true, source: 'native-browserview-hide-show-lifecycle' },
      pointerClearsAfterTerminal: { ok: true, source: 'agent-action-terminal-lifecycle' },
      activeTabPreserved: { ok: true },
      fullIsolationDeferred: { ok: true, separatePartitionImplemented: false },
    },
  }
}

test('accepts a native BrowserWindow lock overlay report with runtime geometry proof', () => {
  assert.equal(validateReport(validReport()).ok, true)
})

test('rejects reports that only prove a DOM or self-overlay screenshot', () => {
  const report = validReport()
  report.overlay.mechanism = 'dom-z-index'
  report.assertions.nativeOverlayBoundsIntersectBrowserView.source = 'overlay-window-only-screenshot'

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /native-child-browser-window/)
  assert.match(result.errors.join('\n'), /runtime-native-child-window-geometry/)
})

test('rejects reports that claim full browser isolation', () => {
  const report = validReport()
  report.assertions.fullIsolationDeferred.separatePartitionImplemented = true

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /separatePartitionImplemented/)
})

test('rejects reports without trusted pointer and terminal lifecycle proof', () => {
  const report = validReport()
  report.pointer.mechanism = 'renderer-dom'
  report.assertions.pointerMatchesTrustedInput.ok = false
  report.assertions.pointerClearsOnBrowserViewLifecycle.source = 'timer-assumption'
  report.assertions.pointerClearsAfterTerminal.source = 'timer-assumption'

  const result = validateReport(report)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /click-through-native-child-window/)
  assert.match(result.errors.join('\n'), /pointerMatchesTrustedInput/)
  assert.match(result.errors.join('\n'), /native-browserview-hide-show-lifecycle/)
  assert.match(result.errors.join('\n'), /agent-action-terminal-lifecycle/)
})
