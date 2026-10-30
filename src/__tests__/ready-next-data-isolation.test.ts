import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertReadyNextDataIsolation, ReadyNextDataIsolationError } from '../main/ready-next-data-isolation'
import { resolveReadyDatabasePath } from '../main/modules/database-path'

// C15: all filesystem fixtures live under a temporary home, never the user's profile.
test('C15 rejects daily data and realpath aliases, while allowing independent profiles', () => {
  const home = mkdtempSync(join(tmpdir(), 'ready-next-c15-'))
  const daily = join(home, 'Library/Application Support/Ready')
  const next = join(home, 'Library/Application Support/Ready Next')
  const check = (userData: string, dbOverride?: string) =>
    assertReadyNextDataIsolation(userData, resolveReadyDatabasePath(userData, dbOverride), home)
  try {
    // The protected directory need not exist yet.
    assert.doesNotThrow(() => check(next))
    assert.throws(() => check(daily), ReadyNextDataIsolationError)
    mkdirSync(daily, { recursive: true })
    writeFileSync(join(daily, 'ready.db'), 'fixture, not a database')
    assert.throws(() => check(daily), {
      name: 'ReadyNextDataIsolationError', code: 'READY_NEXT_DAILY_DATA_FORBIDDEN',
    })
    const dbAlias = join(home, 'alias.db')
    symlinkSync(join(daily, 'ready.db'), dbAlias)
    assert.throws(() => check(next, dbAlias), ReadyNextDataIsolationError)
    const dirAlias = join(home, 'alias')
    symlinkSync(daily, dirAlias)
    assert.throws(() => check(join(dirAlias, 'not-created')), ReadyNextDataIsolationError)
    assert.throws(() => check(next, join(dirAlias, 'not-created/db.sqlite')), ReadyNextDataIsolationError)
    assert.doesNotThrow(() => check(join(home, 'custom'), join(home, 'custom-db/data.db')))
    assert.doesNotThrow(() => check(next))
    // Extra protected folders add to the daily one and can never remove it.
    const extra = join(home, 'extra-protected')
    const resolveAt = (userData: string) => resolveReadyDatabasePath(userData, undefined)
    assert.throws(() => assertReadyNextDataIsolation(join(extra, 'nested'), resolveAt(join(extra, 'nested')), home, [extra]),
      ReadyNextDataIsolationError)
    assert.throws(() => assertReadyNextDataIsolation(daily, resolveAt(daily), home, [extra]), ReadyNextDataIsolationError)
    assert.doesNotThrow(() => assertReadyNextDataIsolation(next, resolveAt(next), home, [extra]))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
