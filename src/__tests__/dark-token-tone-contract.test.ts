import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('text uses the four ink levels directly; the shell text aliases are retired (W1 T6); dark inks follow vvf-2-1 (V6)', () => {
  const styles = readRendererStyles()
  const tokens = readWorkspaceFile('src/renderer/design/next/tokens.css')
  assert.doesNotMatch(styles, /--text-(?:title|body|secondary|muted|gray|light|placeholder)\s*:/)
  assert.doesNotMatch(styles, /var\(--text-(?:title|body|secondary|muted|gray|light|placeholder)\b/)
  const dark = tokens.match(/\[data-theme='dark'\] \{([^}]+)\}/)?.[1]
  assert.ok(dark)
  assert.match(dark, /--rn-ink: #f4f4f6;/)
  assert.match(dark, /--rn-ink-2: rgba\(244, 244, 246, \.66\);/)
  assert.match(dark, /--rn-ink-3: rgba\(244, 244, 246, \.52\);/)
  assert.match(dark, /--rn-ink-4: rgba\(244, 244, 246, \.2\);/)
})
