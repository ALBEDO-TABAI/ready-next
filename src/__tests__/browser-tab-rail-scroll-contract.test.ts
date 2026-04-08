import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab rail keeps a scrollable strip and stable per-tab width wrappers during active-tab swaps', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /overflow-x-auto overflow-y-hidden/)
  assert.match(source, /className="browser-tab-rail-scroll flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"/)
  assert.match(source, /const activeSurfaceMetrics = getActiveTabSurfaceMetrics\(layoutMetrics, activeTabMode\)/)
  assert.match(source, /const activeSlotMetrics = getActiveTabSlotMetrics\(layoutMetrics, activeTabMode, refreshDockMode\)/)
  assert.match(source, /style=\{\{\s*width:\s*isActive \? activeSlotMetrics\.width : layoutMetrics\.inactiveWidth,/)
  assert.match(source, /minWidth:\s*isActive \? activeSlotMetrics\.minWidth : layoutMetrics\.inactiveMinWidth,/)
  assert.match(source, /<div[\s\S]*className="relative flex min-w-0 flex-shrink-0 items-center"/)
  assert.match(source, /<MorphTabButton[\s\S]*className="group relative flex min-w-0 w-full cursor-pointer/)
})
