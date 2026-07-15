import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __getMigrationNamesForTests,
  __runMigrationForTests,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 078 fake contract declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-078 local conversation user binding fake contract')
})

interface ConversationRow {
  id: string
  source_kind: 'local' | 'channel'
  user_id: string | null
}

class FakeMigrationDb implements MigrationDatabase {
  readonly rows: ConversationRow[] = [
    { id: 'local-null', source_kind: 'local', user_id: null },
    { id: 'local-empty', source_kind: 'local', user_id: '' },
    { id: 'local-blank', source_kind: 'local', user_id: '   ' },
    { id: 'local-bound', source_kind: 'local', user_id: 'another-user' },
    { id: 'remote-null', source_kind: 'channel', user_id: null },
    { id: 'remote-empty', source_kind: 'channel', user_id: '' },
    { id: 'remote-bound', source_kind: 'channel', user_id: 'remote-user' },
  ]

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === "UPDATE chat_conversations SET user_id = 'default-user' WHERE source_kind = 'local' AND (user_id IS NULL OR trim(user_id) = '');"
    ) {
      for (const row of this.rows) {
        if (row.source_kind === 'local' && (!row.user_id || !row.user_id.trim())) row.user_id = 'default-user'
      }
      return
    }
    throw new Error(`Unexpected migration SQL: ${normalized}`)
  }

  prepare(sql: string) {
    return {
      run(..._params: unknown[]): unknown {
        throw new Error(`Unexpected run SQL: ${sql}`)
      },
      all<T = unknown>(..._params: unknown[]): T[] {
        throw new Error(`Unexpected all SQL: ${sql}`)
      },
    }
  }
}

test('migration 078 is registered immediately after the reserved 077 slot', () => {
  const names = __getMigrationNamesForTests()
  const index = names.indexOf('078_backfill_local_conversation_default_user')

  assert.ok(index > 0, '078 migration is registered')
  assert.match(names[index - 1] || '', /^077_/)
})

test('migration 078 backfills only empty local user bindings and is idempotent', () => {
  const db = new FakeMigrationDb()

  __runMigrationForTests('078_backfill_local_conversation_default_user', db)
  __runMigrationForTests('078_backfill_local_conversation_default_user', db)

  assert.deepEqual(db.rows, [
    { id: 'local-null', source_kind: 'local', user_id: 'default-user' },
    { id: 'local-empty', source_kind: 'local', user_id: 'default-user' },
    { id: 'local-blank', source_kind: 'local', user_id: 'default-user' },
    { id: 'local-bound', source_kind: 'local', user_id: 'another-user' },
    { id: 'remote-null', source_kind: 'channel', user_id: null },
    { id: 'remote-empty', source_kind: 'channel', user_id: '' },
    { id: 'remote-bound', source_kind: 'channel', user_id: 'remote-user' },
  ])
})
