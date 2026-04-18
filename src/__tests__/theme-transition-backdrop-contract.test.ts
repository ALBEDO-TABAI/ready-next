import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('theme transition whitelist no longer animates backdrop-filter', () => {
  const indexCss = readWorkspaceFile('src/renderer/styles/index.css')

  const startMarker = "html[data-theme-transitioning='true'] body"
  const startIndex = indexCss.indexOf(startMarker)
  assert.ok(startIndex >= 0, 'theme-transitioning body selector must exist')

  const blockEnd = indexCss.indexOf('}', startIndex)
  assert.ok(blockEnd > startIndex, 'theme-transitioning block must be closed')

  const block = indexCss.slice(startIndex, blockEnd + 1)

  assert.match(block, /background-color 220ms/)
  assert.match(block, /color 220ms/)
  assert.match(block, /border-color 220ms/)
  assert.match(block, /box-shadow 220ms/)
  assert.doesNotMatch(block, /backdrop-filter/)
  assert.doesNotMatch(block, /-webkit-backdrop-filter/)
})
