import assert from 'node:assert/strict'
import test from 'node:test'

import { __getMigrationNamesForTests, __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'

type RecallColumn = { name: string }

interface RecallMetadataRow {
  conversation_id: string
  agent?: string | null
  channel_key: string
  updated_at: string
}

class FakeMigrationDb implements MigrationDatabase {
  readonly recallColumns: RecallColumn[] = [
    { name: 'conversation_id' },
    { name: 'lineage_root_id' },
    { name: 'resume_title' },
    { name: 'title' },
    { name: 'source_kind' },
    { name: 'source_id' },
    { name: 'thread_key' },
    { name: 'user_id' },
    { name: 'channel_key' },
    { name: 'preview_text' },
    { name: 'latest_task_title' },
    { name: 'latest_task_summary' },
    { name: 'attachment_names_json' },
    { name: 'updated_at' },
  ]
  readonly metadataRows: RecallMetadataRow[] = [
    { conversation_id: 'conv-alpha', channel_key: 'local:app', updated_at: '2026-06-20T00:00:00.000Z' },
    { conversation_id: 'conv-beta', channel_key: 'local:app', updated_at: '2026-06-20T00:00:00.000Z' },
    { conversation_id: 'conv-orphan', channel_key: 'local:app', updated_at: '2026-06-20T00:00:00.000Z' },
  ]
  readonly conversations = new Map([
    ['conv-alpha', 'alpha'],
    ['conv-beta', 'beta'],
  ])
  readonly indexes = new Set<string>()
  agentColumnAlterCount = 0

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'ALTER TABLE session_recall_metadata ADD COLUMN agent TEXT') {
      if (!this.recallColumns.some((column) => column.name === 'agent')) {
        this.recallColumns.push({ name: 'agent' })
        this.agentColumnAlterCount += 1
      }
      return
    }
    if (
      normalized.startsWith('UPDATE session_recall_metadata SET agent =')
      && normalized.includes('FROM chat_conversations')
    ) {
      for (const row of this.metadataRows) {
        if (row.agent !== null && row.agent !== undefined) continue
        if (!this.conversations.has(row.conversation_id)) continue
        row.agent = this.conversations.get(row.conversation_id) ?? null
      }
      return
    }
    if (
      normalized.startsWith('CREATE INDEX IF NOT EXISTS idx_session_recall_agent')
      && normalized.includes('ON session_recall_metadata(agent, channel_key, updated_at DESC)')
    ) {
      this.indexes.add('idx_session_recall_agent')
      return
    }
    throw new Error(`Unexpected migration SQL: ${normalized}`)
  }

  prepare(sql: string) {
    const recallColumns = this.recallColumns
    return {
      run(..._params: unknown[]): unknown {
        throw new Error(`Unexpected run SQL: ${sql}`)
      },
      all<T = unknown>(..._params: unknown[]): T[] {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized === 'PRAGMA table_info(session_recall_metadata)') {
          return recallColumns as T[]
        }
        throw new Error(`Unexpected all SQL: ${normalized}`)
      },
    }
  }
}

test('migration 063 registers after specialist content edit proposals', () => {
  const names = __getMigrationNamesForTests()

  assert.ok(names.includes('063_session_recall_agent_column'), '063 registered')
  assert.ok(
    names.indexOf('062_specialist_content_edit_proposals') < names.indexOf('063_session_recall_agent_column'),
    'session recall agent migration follows 062',
  )
})

test('migration 063 adds agent column, backfills from chat_conversations, and remains idempotent', () => {
  const db = new FakeMigrationDb()

  __runMigrationForTests('063_session_recall_agent_column', db)

  assert.ok(db.recallColumns.some((column) => column.name === 'agent'), 'agent column exists')
  assert.equal(db.agentColumnAlterCount, 1, 'agent column added once')
  assert.deepEqual(
    db.metadataRows.map((row) => ({ conversation_id: row.conversation_id, agent: row.agent ?? null })),
    [
      { conversation_id: 'conv-alpha', agent: 'alpha' },
      { conversation_id: 'conv-beta', agent: 'beta' },
      { conversation_id: 'conv-orphan', agent: null },
    ],
  )
  assert.ok(db.indexes.has('idx_session_recall_agent'), 'agent recall index created')

  __runMigrationForTests('063_session_recall_agent_column', db)

  assert.equal(db.agentColumnAlterCount, 1, 'second run does not add duplicate column')
  assert.deepEqual(
    db.metadataRows.map((row) => ({ conversation_id: row.conversation_id, agent: row.agent ?? null })),
    [
      { conversation_id: 'conv-alpha', agent: 'alpha' },
      { conversation_id: 'conv-beta', agent: 'beta' },
      { conversation_id: 'conv-orphan', agent: null },
    ],
  )
})
