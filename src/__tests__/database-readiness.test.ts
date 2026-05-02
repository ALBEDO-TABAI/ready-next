import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDatabaseConnectionReady,
  assertPrimaryDatabaseReady,
  DatabaseUnavailableError,
  type DatabaseConnection,
} from '../main/modules/database'

function createFakeSettingsDb(calls: string[]): DatabaseConnection {
  return {
    exec: (sql: string) => { calls.push(`exec:${sql}`) },
    close: () => {},
    prepare: (sql: string) => {
      calls.push(sql)
      return {
        run: (...params: unknown[]) => ({ changes: params.length }),
        all: () => [],
        get: (...params: unknown[]) => {
          calls.push(`params:${params.join(',')}`)
          return undefined
        },
      }
    },
  }
}

test('database readiness rejects a missing primary connection', () => {
  assert.throws(
    () => assertDatabaseConnectionReady(null, 'primary database'),
    (error) => error instanceof DatabaseUnavailableError && /primary database/i.test(error.message),
  )
})

test('primary database readiness checks native sqlite before probing settings table', () => {
  const calls: string[] = []
  let nativeChecked = false

  assert.doesNotThrow(() => {
    assertPrimaryDatabaseReady({
      checkNative: () => { nativeChecked = true },
      getDatabaseInstance: () => ({
        getRawDb: () => createFakeSettingsDb(calls),
      }),
    })
  })

  assert.equal(nativeChecked, true)
  assert.ok(calls.some((call) => /FROM settings/i.test(call)))
})

test('primary database readiness fails before normal boot when db is unavailable', () => {
  assert.throws(
    () => assertPrimaryDatabaseReady({
      checkNative: () => {},
      getDatabaseInstance: () => ({ getRawDb: () => null }),
    }),
    DatabaseUnavailableError,
  )
})
