'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const target = require('../check-sqlite-test-skip-pattern.cjs')
const { isDirectSqliteLoader, isDirectFromBetterSqlite3 } = target

test('isDirectSqliteLoader: catches require()', () => {
  assert.equal(isDirectSqliteLoader("const m = require('better-sqlite3')"), true)
})

test('isDirectSqliteLoader: catches await import()', () => {
  assert.equal(isDirectSqliteLoader("const m = await import('better-sqlite3')"), true)
})

test('isDirectSqliteLoader: catches side-effect import (T14 from plan-v5)', () => {
  assert.equal(isDirectSqliteLoader("import 'better-sqlite3'"), true)
  assert.equal(isDirectSqliteLoader('import "better-sqlite3";'), true)
})

test('isDirectSqliteLoader: catches plain `from` value import', () => {
  assert.equal(isDirectSqliteLoader("import S from 'better-sqlite3'"), true)
  assert.equal(isDirectSqliteLoader("import { Database } from 'better-sqlite3'"), true)
})

test('isDirectFromBetterSqlite3: rejects `import type` (round-2 issue 2 / round-3 patch B)', () => {
  assert.equal(isDirectFromBetterSqlite3("import type X from 'better-sqlite3'"), false)
  assert.equal(isDirectFromBetterSqlite3("  import type Database from 'better-sqlite3'"), false)
})

test('isDirectFromBetterSqlite3: rejects all-type-only named import', () => {
  assert.equal(isDirectFromBetterSqlite3("import { type X } from 'better-sqlite3'"), false)
  assert.equal(isDirectFromBetterSqlite3("import { type X, type Y } from 'better-sqlite3'"), false)
})

test('isDirectFromBetterSqlite3: catches mixed `{ type X, Y }` (Y is value)', () => {
  assert.equal(isDirectFromBetterSqlite3("import { type X, Y } from 'better-sqlite3'"), true)
})

test('isDirectSqliteLoader: regex literal in assertion is NOT caught (round-2 issue 2)', () => {
  // Mirrors database.test.ts:155 — `assert.match(src, /require\('better-sqlite3'\)/)`.
  // The literal sits inside a regex, not in a load form, so we must not flag it.
  const src = `assert.match(databaseSrc, /require\\('better-sqlite3'\\)/)`
  assert.equal(isDirectSqliteLoader(src), false)
})

test('isDirectSqliteLoader: comment mentioning better-sqlite3 not caught', () => {
  const src = `
    // a comment mentioning better-sqlite3 and that's all
    import { foo } from './unrelated'
  `
  assert.equal(isDirectSqliteLoader(src), false)
})

test('integration: live repo passes the sqlite skip-pattern gate', () => {
  const result = target.checkSqliteSkipPattern()
  assert.ok(
    result.ok,
    `live repo should be sqlite-skip-clean; got: ${JSON.stringify(result.violations, null, 2)}`
  )
  assert.ok(result.testedCount > 0, 'must scan at least one test file')
  assert.ok(result.nativeCount > 0, 'must classify at least one test as native-backed')
})

function writeHarnessTest(t, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sqlite-skip-gate-'))
  const testDir = path.join(root, 'src/__tests__')
  mkdirSync(testDir, { recursive: true })
  writeFileSync(path.join(testDir, 'mutant.test.ts'), source)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return target.checkSqliteSkipPattern({ root })
}

test('sqlite gate rejects a helper call that exists only in a comment', (t) => {
  const result = writeHarnessTest(
    t,
    `import Sqlite from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
// skipIfSqliteUnavailable(t, 'comment only')
test('loads sqlite', () => { new Sqlite(':memory:') })`
  )
  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result.violations), /missing_helper/)
})

test('sqlite gate rejects a helper call hidden in dead code outside a test', (t) => {
  const result = writeHarnessTest(
    t,
    `import Sqlite from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
function neverCalled(t: any) { skipIfSqliteUnavailable(t, 'dead') }
test('loads sqlite', () => { new Sqlite(':memory:') })`
  )
  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result.violations), /missing_helper/)
})

test('sqlite gate does not borrow a guard from the next test', (t) => {
  const result = writeHarnessTest(
    t,
    `import Sqlite from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
test('unguarded sqlite', () => { new Sqlite(':memory:') })
test('guarded dummy', (t) => {
  if (skipIfSqliteUnavailable(t, 'dummy')) return
})`
  )
  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result.violations), /unguarded_block/)
})

test('sqlite gate rejects a guard after an unconditional return', (t) => {
  const result = writeHarnessTest(
    t,
    `import Sqlite from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
test('dead guard', (t) => {
  return
  skipIfSqliteUnavailable(t, 'dead')
  new Sqlite(':memory:')
})`
  )
  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result.violations), /unguarded_block/)
})
