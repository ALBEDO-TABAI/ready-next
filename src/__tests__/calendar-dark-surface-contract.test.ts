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
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis \.sx__time-grid-day:first-child,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid \.sx__time-grid-day:first-child \{[\s\S]*border-left:\s*none !important;/,
  )
})
