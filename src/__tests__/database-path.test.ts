import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReadyDatabasePath } from '../main/modules/database-path'

test('acceptance runs prefer the explicit database over the daily profile', () => {
  assert.equal(
    resolveReadyDatabasePath('/daily-ready-profile', '/isolated/proof/run-1.db'),
    '/isolated/proof/run-1.db',
  )
})

test('normal runs keep ready.db inside the active userData directory', () => {
  assert.equal(
    resolveReadyDatabasePath('/isolated/user-data'),
    '/isolated/user-data/ready.db',
  )
})
