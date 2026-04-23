import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark liquid week view uses one solid base surface and keeps inner grid layers transparent', () => {
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
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-header,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-header-content,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__date-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__date,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__hour,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__time-grid-day \{[\s\S]*background:\s*transparent !important;/,
  )
  assert.match(
    scheduleCss,
    /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid::before \{[\s\S]*background:\s*var\(--sx-ready-week-solid-surface\) !important;/,
  )
})
