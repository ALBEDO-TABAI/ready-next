import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid calendar shell reuses the rss surface tone and removes the leading grid divider', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{[\s\S]*border:\s*none !important;/,
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
    /\.sx__week-grid__time-axis \.sx__time-grid-day:first-child,\s*\.sx__week-grid__time-axis \.sx__time-grid-day:first-of-type,\s*\.sx__week-grid \.sx__time-grid-day:first-child,\s*\.sx__week-grid \.sx__time-grid-day:first-of-type \{[\s\S]*border-left:\s*none !important;/,
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
    /\.sx__week-grid__date,\s*\.sx__week-grid__time-axis,\s*\.sx__week-grid__hour,[\s\S]*\.sx__time-grid-day \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid__hour \{[\s\S]*border-top:\s*1px solid var\(--sx-ready-grid-line-color\) !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__time-grid-day \{[\s\S]*border-left:\s*1px solid var\(--sx-ready-grid-line-color\) !important;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid\s*\{[\s\S]*isolation:\s*isolate;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-grid::before \{[\s\S]*left:\s*var\(--sx-calendar-week-grid-padding-left\);[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;[\s\S]*z-index:\s*2;/,
  )
  assert.match(
    scheduleCss,
    /\.sx__week-header-border \{[\s\S]*display:\s*none !important;/,
  )
})
