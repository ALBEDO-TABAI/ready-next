import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

describe('browser task persistence', () => {
  it('does not include undefined fields in browser task update SQL', async () => {
    const { DatabaseManager } = await import('../main/modules/database')
    let sql = ''
    let params: unknown[] = []
    const fakeManager = {
      db: {
        prepare: (source: string) => ({
          run: (...args: unknown[]) => {
            sql = source
            params = args
          },
        }),
      },
    }

    DatabaseManager.prototype.updateBrowserTask.call(fakeManager as never, 'browser-task-1', {
      status: 'cancelled',
      checkpoint_json: undefined,
      result_json: undefined,
      progress_completed: 3,
    })

    assert.match(sql, /status = \?/)
    assert.match(sql, /progress_completed = \?/)
    assert.doesNotMatch(sql, /checkpoint_json = \?/)
    assert.doesNotMatch(sql, /result_json = \?/)
    assert.equal(params[0], 'cancelled')
    assert.equal(params[1], 3)
    assert.equal(params[params.length - 1], 'browser-task-1')
  })

  it('preserves existing result and checkpoint when an update omits those fields', async (t) => {
    if (skipIfSqliteUnavailable(t, 'browser-task-persistence: preserve omitted fields')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null

    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }

    try {
      db.createBrowserTask({
        id: 'browser-task-preserve',
        kind: 'note_collect',
        status: 'running',
        payload_json: '{}',
        checkpoint_json: JSON.stringify({ stage: 'note_collect_round', cursor: '1' }),
        result_json: JSON.stringify({ collected: ['https://example.com/1'] }),
        progress_total: 2,
        progress_completed: 1,
        progress_failed: 0,
        current_label: 'note 1',
        error: null,
        created_at: '2026-06-05T00:00:00.000Z',
        started_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
        finished_at: null,
      })

      db.updateBrowserTask('browser-task-preserve', {
        status: 'cancelled',
        progress_completed: 1,
        current_label: null,
        finished_at: '2026-06-05T00:00:01.000Z',
      })

      const record = db.getBrowserTask('browser-task-preserve')
      assert.ok(record)
      assert.equal(record.status, 'cancelled')
      assert.equal(record.result_json, JSON.stringify({ collected: ['https://example.com/1'] }))
      assert.equal(record.checkpoint_json, JSON.stringify({ stage: 'note_collect_round', cursor: '1' }))
    } finally {
      db?.close()
    }
  })
})
