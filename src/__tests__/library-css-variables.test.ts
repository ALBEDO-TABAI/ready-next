// allow-source-grep: CSS custom-property names cross TS/JS and standalone SVG styles; this structural contract catches unmatched producers/consumers that types cannot check.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(process.cwd(), 'src/renderer/modules/library')
const files = readdirSync(root, { recursive: true }).map(String)
const source = (extensions: RegExp) => files.filter(file => extensions.test(file)).map(file => readFileSync(join(root, file), 'utf8')).join('\n')
const names = (source: string, pattern: RegExp) => new Set([...source.matchAll(pattern)].map(match => match[1]))

test('library CSS variables have matching producers and consumers; printed pages never depend on UI tokens', () => {
  const css = source(/\.css$/)
  const code = source(/\.(?:tsx?|js)$/)
  const reads = names(css, /var\(\s*(--[\w-]+)/g)
  const writes = names(code, /['"]?(--[a-z][\w-]*)['"]?(?:\s+as\s+string\])?\s*[:,]/g)
  const defaults = names(css + readFileSync('src/renderer/design/next/tokens.css', 'utf8'), /(--[\w-]+)\s*:/g)
  assert.deepEqual([...writes].filter(name => !reads.has(name)), [], 'TS/JS writes must be consumed by CSS')
  assert.deepEqual([...reads].filter(name => !writes.has(name) && !defaults.has(name)), [], 'CSS reads need a runtime writer or a CSS token/default declaration')
  const page = readFileSync(join(root, 'reader/page.css'), 'utf8')
  assert.deepEqual([...names(page, /var\(\s*(--rn-[\w-]+)/g)], [], 'SVG pages have no inherited Ready UI tokens')
})
