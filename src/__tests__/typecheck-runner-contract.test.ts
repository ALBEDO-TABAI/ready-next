import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { summarizeTypecheckResults } = require('../../scripts/run-typecheck.cjs') as {
  summarizeTypecheckResults: (results: Array<{ code: number; signal: string | null; error: Error | null }>) => number
}

test('typecheck runner fails when either parallel typecheck leg fails', () => {
  assert.equal(summarizeTypecheckResults([
    { code: 1, signal: null, error: null },
    { code: 0, signal: null, error: null },
  ]), 1)
  assert.equal(summarizeTypecheckResults([
    { code: 0, signal: null, error: null },
    { code: 1, signal: null, error: null },
  ]), 1)
  assert.equal(summarizeTypecheckResults([
    { code: 0, signal: null, error: null },
    { code: 0, signal: null, error: null },
  ]), 0)
})

test('package typecheck script uses the checked runner instead of shell wait', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(pkg.scripts.typecheck, 'node scripts/run-typecheck.cjs')
})
