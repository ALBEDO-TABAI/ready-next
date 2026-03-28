import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('liquid workbench surfaces remove prominent borders and heavy highlights', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const statusBar = readWorkspaceFile('src/renderer/components/layout/StatusBar.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')

  assert.match(styles, /--lg-border-soft: rgba\(244, 249, 255, 0\.18\);/)
  assert.match(styles, /--lg-border-strong: rgba\(252, 254, 255, 0\.28\);/)
  assert.match(styles, /--lg-shadow-ambient: 0 8px 18px rgba\(42, 60, 102, 0\.08\);/)
  assert.match(styles, /--lg-shadow-contact: 0 4px 12px rgba\(64, 86, 136, 0\.06\);/)
  assert.match(styles, /opacity: 0\.3;/)
  assert.match(styles, /opacity: 0\.01[28];/)

  assert.match(topBar, /borderBottom: '1px solid transparent'/)
  assert.match(statusBar, /borderTop: '1px solid transparent'/)
  assert.match(calendarMode, /borderRight: '1px solid rgba\(255,255,255,0\.03\)'/)
})
