import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('system prefers-color-scheme change applies new theme without the 220ms transition', () => {
  const source = readWorkspaceFile('src/renderer/stores/useTheme.ts')

  const marker = 'const handleSystemChange = ()'
  const start = source.indexOf(marker)
  assert.ok(start >= 0, 'handleSystemChange must be defined in useTheme.ts')

  const end = source.indexOf('}', start + marker.length)
  const blockEnd = source.indexOf('}', end + 1)
  assert.ok(blockEnd > start, 'handleSystemChange body must be parseable')

  const block = source.slice(start, blockEnd + 1)
  assert.match(
    block,
    /applyColorTheme\([^)]*,\s*'system'\s*,[^)]*\{\s*animate:\s*false\s*\}\)/,
    'handleSystemChange must opt out of the animated theme transition',
  )
})
