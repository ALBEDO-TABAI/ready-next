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
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--text-gray\) 28%, transparent\);/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*box-shadow:[\s\S]*inset 1px 0 0/)
  assert.match(styles, /\.resize-handle::before\s*\{[\s\S]*opacity:\s*0;/)
  assert.match(styles, /\.resize-handle:hover::before,\s*\.resize-handle.active::before\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--text-gray\) 38%, transparent\);/)
  assert.match(styles, /\.resize-handle:hover::before,\s*\.resize-handle.active::before\s*\{[\s\S]*opacity:\s*0\.94;/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.resize-handle:hover,\s*html\[data-skin='liquid-glass'\] \.resize-handle.active\s*\{[\s\S]*box-shadow:\s*none;/)
})
