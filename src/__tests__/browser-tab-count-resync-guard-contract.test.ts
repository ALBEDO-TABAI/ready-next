import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('BrowserMode skips hide-show host resync for ordinary non-empty tab count changes', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(browserMode, /const previousTabCountRef = useRef\(tabs\.length\)/)
  assert.match(browserMode, /const previousTabCount = previousTabCountRef\.current/)
  assert.match(browserMode, /previousTabCountRef\.current = tabs\.length/)
  assert.match(
    browserMode,
    /const tabCountChangedWhileHostAlreadyPresent = previousTabCount > 0 && tabs\.length > 0 && previousTabCount !== tabs\.length/,
  )
  assert.match(
    browserMode,
    /if \(tabCountChangedWhileHostAlreadyPresent\) \{\s*return\s*\}/,
  )
})
