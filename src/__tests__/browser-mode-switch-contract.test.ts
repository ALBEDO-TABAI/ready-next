import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode passes stable edit callbacks into the browser header to avoid switch-time render loops', () => {
  const source = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(source, /const handleBrowserEditStart = useCallback\(\(\) => \{[\s\S]*setAddressEditing\(true\)/)
  assert.match(source, /const handleBrowserEditEnd = useCallback\(\(\) => \{[\s\S]*setAddressEditing\(false\)/)
  assert.match(source, /onEditStart=\{handleBrowserEditStart\}/)
  assert.match(source, /onEditEnd=\{handleBrowserEditEnd\}/)
  assert.doesNotMatch(source, /onEditStart=\{\(\) => setAddressEditing\(true\)\}/)
  assert.doesNotMatch(source, /onEditEnd=\{\(\) => setAddressEditing\(false\)\}/)
})
