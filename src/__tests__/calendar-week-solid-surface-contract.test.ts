import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid week view uses one solid visual surface and keeps header/grid tones aligned', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--sx-ready-week-solid-surface:\s*var\(--bg-editor\);/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-wrapper \{[\s\S]*background:\s*var\(--sx-ready-week-solid-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-header,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-header-content,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__date-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__date \{[\s\S]*background:\s*var\(--sx-ready-grid-chrome-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__hour,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__time-grid-day \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-image:[\s\S]*linear-gradient\(to right,\s*var\(--sx-ready-time-grid-line-color\)[\s\S]*linear-gradient\(to bottom,\s*var\(--sx-ready-time-grid-line-color\)/,
  )
  assert.doesNotMatch(scheduleCss, /linear-gradient\(to left,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(
    scheduleCss,
    /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-size:[\s\S]*calc\(100% \/ var\(--sx-ready-visible-day-count,\s*7\)\) 100%,[\s\S]*100% var\(--sx-week-grid-hour-height\) !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-position:[\s\S]*0 0,[\s\S]*0 var\(--sx-week-grid-hour-height\) !important;/,
  )
})
