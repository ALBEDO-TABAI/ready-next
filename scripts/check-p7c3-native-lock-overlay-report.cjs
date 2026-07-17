#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_REPORT = path.resolve(
  process.cwd(),
  'outputs/agent-audit/live/p7c3-native-lock-overlay-report.json',
)

function readReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'))
}

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validateReport(report) {
  const errors = []
  if (!report || typeof report !== 'object') {
    return { ok: false, errors: ['report must be an object'] }
  }
  if (report.scope !== 'P7c3-browserview-proof-native-lock-overlay') {
    errors.push(`scope must be P7c3-browserview-proof-native-lock-overlay, got ${JSON.stringify(report.scope)}`)
  }
  if (report.ok !== true) {
    errors.push('report.ok must be true')
  }
  if (!report.overlay || report.overlay.mechanism !== 'native-child-browser-window') {
    errors.push('overlay.mechanism must be native-child-browser-window')
  }
  if (report.overlay?.visible !== true) {
    errors.push('overlay.visible must be true')
  }
  if (!report.pointer || report.pointer.mechanism !== 'click-through-native-child-window') {
    errors.push('pointer.mechanism must be click-through-native-child-window')
  }
  if (!report.browserViewFixture?.activeTabId || !report.browserViewFixture?.fixtureUrl) {
    errors.push('browserViewFixture must include activeTabId and fixtureUrl')
  }
  const captures = report.captures || {}
  for (const key of ['osCompositedAttemptPath']) {
    if (!hasPath(captures[key])) errors.push(`captures.${key} must be a non-empty path`)
  }

  const assertions = report.assertions || {}
  for (const key of [
    'lockStateMatchesOverlay',
    'overlayWindowRendersProofMarker',
    'nativeOverlayBoundsIntersectBrowserView',
    'browserViewTargetRendersFixture',
    'overlayClearsAfterUnlock',
    'closeButtonDismissesOverlay',
    'pointerMatchesTrustedInput',
    'pointerClearsOnBrowserViewLifecycle',
    'pointerClearsAfterTerminal',
    'activeTabPreserved',
  ]) {
    if (assertions[key]?.ok !== true) {
      errors.push(`assertions.${key}.ok must be true`)
    }
  }
  const isolation = assertions.fullIsolationDeferred || {}
  if (isolation.ok !== true) {
    errors.push('assertions.fullIsolationDeferred.ok must be true')
  }
  if (isolation.separatePartitionImplemented !== false) {
    errors.push('assertions.fullIsolationDeferred.separatePartitionImplemented must be false')
  }
  const overlayRender = assertions.overlayWindowRendersProofMarker || {}
  if (overlayRender.source !== 'overlay-window-dom') {
    errors.push('overlayWindowRendersProofMarker.source must be overlay-window-dom')
  }
  const geometry = assertions.nativeOverlayBoundsIntersectBrowserView || {}
  if (geometry.source !== 'runtime-native-child-window-geometry') {
    errors.push('nativeOverlayBoundsIntersectBrowserView.source must be runtime-native-child-window-geometry')
  }
  const visible = assertions.browserViewTargetRendersFixture || {}
  if (visible.source !== 'browser-webcontents-runtime-eval') {
    errors.push('browserViewTargetRendersFixture.source must be browser-webcontents-runtime-eval')
  }
  const pointer = assertions.pointerMatchesTrustedInput || {}
  if (pointer.source !== 'trusted-cdp-input-and-native-pointer-geometry') {
    errors.push('pointerMatchesTrustedInput.source must be trusted-cdp-input-and-native-pointer-geometry')
  }
  const pointerLifecycle = assertions.pointerClearsOnBrowserViewLifecycle || {}
  if (pointerLifecycle.source !== 'native-browserview-hide-show-lifecycle') {
    errors.push('pointerClearsOnBrowserViewLifecycle.source must be native-browserview-hide-show-lifecycle')
  }
  const terminal = assertions.pointerClearsAfterTerminal || {}
  if (terminal.source !== 'agent-action-terminal-lifecycle') {
    errors.push('pointerClearsAfterTerminal.source must be agent-action-terminal-lifecycle')
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const reportPath = path.resolve(process.argv[2] || DEFAULT_REPORT)
  let report
  try {
    report = readReport(reportPath)
  } catch (error) {
    console.error(`[p7c3-lock-overlay] failed to read ${reportPath}: ${error.message}`)
    process.exit(1)
  }
  const result = validateReport(report)
  if (!result.ok) {
    console.error('[p7c3-lock-overlay] report rejected:')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[p7c3-lock-overlay] OK ${reportPath}`)
}

if (require.main === module) {
  main()
}

module.exports = { validateReport }
