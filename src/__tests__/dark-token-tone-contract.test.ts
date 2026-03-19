import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('dark theme text tokens use softer gray-white defaults for regular text and icons', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-title:\s*#D9DBE1;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-body:\s*#C4C7CF;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-secondary:\s*#B3B7C2;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-muted:\s*#8F96A3;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-gray:\s*#7E8796;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-light:\s*#6E7787;/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*--text-placeholder:\s*#6A7382;/)
})
