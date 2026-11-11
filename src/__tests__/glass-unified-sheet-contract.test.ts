import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('liquid workbench surfaces remove prominent borders and heavy highlights', () => {
  const styles = readRendererStyles()
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const statusBar = readWorkspaceFile('src/renderer/components/layout/StatusBar.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')

  assert.match(styles, /--lg-border-soft: rgba\(244, 249, 255, 0\.18\);/)
  assert.match(styles, /--lg-border-strong: rgba\(252, 254, 255, 0\.28\);/)
  assert.match(styles, /--lg-shadow-ambient: 0 8px 18px rgba\(42, 60, 102, 0\.08\);/)
  assert.match(styles, /--lg-shadow-contact: 0 4px 12px rgba\(64, 86, 136, 0\.06\);/)
  assert.match(styles, /html:root \.browser-header-surface,[\s\S]*\.rss-preview-surface \{/)
  assert.match(styles, /\.rss-mode-shell \.rss-feed-sheet \{[\s\S]*background:\s*var\(--workbench-module-surface-bg\) !important;/)
  assert.match(styles, /backdrop-filter: blur\(24px\) saturate\(0%\) !important;/)
  assert.match(styles, /box-shadow: none !important;/)

  assert.match(topBar, /borderBottom: '1px solid transparent'/)
  assert.doesNotMatch(statusBar, /borderTop:/)
  assert.match(calendarShell, /background:'transparent',boxShadow:'none'/)
})
