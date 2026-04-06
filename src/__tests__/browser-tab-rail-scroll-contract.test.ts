import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab rail keeps a scrollable strip and stable per-tab width wrappers during active-tab swaps', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /browser-tab-rail-scroll flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden/)
  assert.match(source, /const activeSlotWidth = layoutMetrics\.activeCompactWidth \+ 36/)
  assert.match(source, /width: isActive \? activeSlotWidth : layoutMetrics\.inactiveWidth/)
  assert.match(source, /minWidth: isActive \? activeSlotWidth : layoutMetrics\.inactiveMinWidth/)
  assert.match(source, /className="relative flex min-w-0 flex-shrink-0 items-center"/)
  assert.match(source, /<MorphTabButton[\s\S]*className="group relative flex min-w-0 w-full cursor-pointer/)
})

test('browser tab rail keeps the new-tab button attached to the tab strip tail', () => {
  const source = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(source, /<MorphTabStrip[\s\S]*onClick=\{\(\) => void onNewTab\(\)\}[\s\S]*<\/MorphTabStrip>/)
  assert.doesNotMatch(source, /<\/MorphTabStrip>[\s\S]*onClick=\{\(\) => void onNewTab\(\)\}/)
})
