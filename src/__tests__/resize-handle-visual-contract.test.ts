import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench resize handle stays hidden by default and only reveals a short recessed dark groove on hover', () => {
  const styles = readRendererStyles()

  assert.match(styles, /\.resize-handle\s*\{[\s\S]*width:\s*6px;/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*top:\s*24%;/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*bottom:\s*24%;/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*left:\s*50%;/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*transform:\s*translateX\(-50%\);/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*width:\s*3px;/)
  // B13: a hairline groove at rest (hidden), an ink-4 groove on hover — --rn-* only (W1 DS1).
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*background:\s*var\(--rn-hair-2\);/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*opacity:\s*0;/)
  assert.match(styles, /\.resize-handle:hover::before,\s*\.resize-handle.active::before\s*\{[\s\S]*background:\s*var\(--rn-ink-4\);/)
  assert.match(styles, /\.resize-handle:hover::before,\s*\.resize-handle.active::before\s*\{[\s\S]*opacity:\s*0\.94;/)
  assert.match(styles, /html:root \.resize-handle:hover,\s*html:root \.resize-handle.active\s*\{[\s\S]*box-shadow:\s*none;/)
})
