import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar module switcher uses a dedicated gooey segmented control with svg goo filter and spring physics', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const gooeyControl = readWorkspaceFile('src/renderer/components/motion/GooeySegmentedControl.tsx')

  assert.match(topBar, /import GooeySegmentedControl/)
  assert.doesNotMatch(topBar, /import MorphSegmentedControl/)
  assert.match(topBar, /<GooeySegmentedControl/)

  assert.match(gooeyControl, /<svg[^>]*width="0"[^>]*height="0"/)
  assert.match(gooeyControl, /<feGaussianBlur/)
  assert.match(gooeyControl, /<feColorMatrix/)
  assert.match(gooeyControl, /values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 [0-9.]+ -[0-9.]+"/)
  assert.match(gooeyControl, /type:\s*'spring'/)
  assert.match(gooeyControl, /mass:\s*[0-9.]+/)
  assert.match(gooeyControl, /stiffness:\s*[0-9.]+/)
  assert.match(gooeyControl, /damping:\s*[0-9.]+/)
  assert.match(gooeyControl, /data-gooey-segmented-control=/)
})
