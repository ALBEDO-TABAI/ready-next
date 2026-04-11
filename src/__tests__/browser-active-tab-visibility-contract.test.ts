import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('active tab visibility recalculates when the active surface expands or the refresh dock widens', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /const activeSurfaceMetrics = getActiveTabSurfaceMetrics\(layoutMetrics, activeTabMode\)/)
  assert.match(source, /const activeSlotMetrics = getActiveTabSlotMetrics\(layoutMetrics, activeTabMode, refreshDockMode\)/)
  assert.match(source, /\[activeTabId, checkOverflow, isActive, keepTabSlotVisible, activeTabMode, refreshDockMode, displayTabs\.length\]/)
})
