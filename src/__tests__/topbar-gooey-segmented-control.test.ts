import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar module switcher uses a dedicated gooey segmented control with svg goo filter and spring physics', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')

  assert.doesNotMatch(topBar, /import GooeySegmentedControl/)
  assert.match(topBar, /className="mode-tab-button relative flex h-\[24px\] w-\[34px\]/)
  assert.match(topBar, /role="tablist"/)
  assert.match(topBar, /aria-label="工作台模式"/)
  assert.match(topBar, /color-mix\(in srgb, var\(--color-green-light\) 58%, transparent\)/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
})
