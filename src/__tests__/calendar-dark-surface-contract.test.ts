import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid calendar shell reuses the rss surface tone and keeps a complete grid', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{[\s\S]*background:\s*var\(--calendar-canvas-bg\) !important;/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{[\s\S]*border-color:\s*var\(--calendar-canvas-border\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-liquid-neutral-bg:\s*color-mix\(in srgb,\s*var\(--workbench-module-surface-bg\)\s*85%,\s*rgba\(255,\s*255,\s*255,\s*0\.18\)\s*15%\);/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-grid-surface:\s*transparent;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-grid-chrome-surface:\s*var\(--sx-ready-week-solid-surface\);/,
  )
  assert.match(
    scheduleCss,
    /:root \{[\s\S]*--sx-ready-grid-surface:\s*var\(--bg-content\);[\s\S]*--sx-ready-grid-line-color:\s*color-mix\(in srgb,\s*var\(--text-gray\)\s*36%,\s*transparent\);/,
  )
  assert.match(
    scheduleCss,
    /html\[data-skin='liquid-glass'\] \{[\s\S]*--sx-ready-grid-surface:\s*var\(--sx-ready-liquid-neutral-bg\);/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__calendar-wrapper \{[\s\S]*background:\s*transparent !important;[\s\S]*backdrop-filter:\s*none !important;[\s\S]*-webkit-backdrop-filter:\s*none !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid__day--is-today \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid__time-axis,\s*\.sx__week-grid__hour,[\s\S]*\.sx__time-grid-day \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid__hour \{[\s\S]*border-top:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-time-grid-line-color\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-time-grid-line-color:\s*var\(--sx-ready-grid-line-color\);/,
  )
  assert.match(
    scheduleCss,
    /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-image:[\s\S]*linear-gradient\(to right,\s*var\(--sx-ready-time-grid-line-color\)/,
  )
  assert.doesNotMatch(scheduleCss, /linear-gradient\(to bottom,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.doesNotMatch(scheduleCss, /linear-gradient\(to left,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(
    scheduleCss,
    /\.sx__week-grid\s*\{[\s\S]*isolation:\s*isolate;/,
  )
  // Header/all-day vertical ::before lines were removed; vertical lines now come only from the
  // time-axis column gradient (asserted above), keeping a single consistent line color.
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date::before/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid-day::before/)
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date:last-child::after/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid-day:last-child::after/)
  assert.match(
    scheduleCss,
    /\.sx__week-header-border \{[\s\S]*display:\s*none !important;/,
  )
  assert.match(scheduleCss, /\.calendar-schedule-view-day \{[\s\S]*--sx-ready-visible-day-count:\s*1;/)
  assert.match(scheduleCss, /\.calendar-schedule-view-week \{[\s\S]*--sx-ready-visible-day-count:\s*7;/)
})
