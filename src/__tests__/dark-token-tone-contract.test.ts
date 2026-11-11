import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('shell text aliases use the shared ink levels with softer dark gray-white values', () => {
  const styles = readRendererStyles()
  const tokens = readWorkspaceFile('src/renderer/design/next/tokens.css')
  assert.match(styles, /--text-title:\s*var\(--rn-ink\);/)
  assert.match(styles, /--text-body:\s*var\(--rn-ink\);/)
  assert.match(styles, /--text-secondary:\s*var\(--rn-ink-2\);/)
  assert.match(styles, /--text-muted:\s*var\(--rn-ink-2\);/)
  assert.match(styles, /--text-gray:\s*var\(--rn-ink-3\);/)
  assert.match(styles, /--text-light:\s*var\(--rn-ink-3\);/)
  assert.match(styles, /--text-placeholder:\s*var\(--rn-ink-3\);/)
  const dark = tokens.match(/\[data-theme='dark'\] \{([^}]+)\}/)?.[1]
  assert.ok(dark)
  assert.match(dark, /--rn-ink: #f4f4f6;/)
  assert.match(dark, /--rn-ink-2: rgba\(244, 244, 246, \.68\);/)
  assert.match(dark, /--rn-ink-3: rgba\(244, 244, 246, \.46\);/)
  assert.match(dark, /--rn-ink-4: rgba\(244, 244, 246, \.22\);/)
})
