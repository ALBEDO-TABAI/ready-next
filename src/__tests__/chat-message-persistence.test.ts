import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

describe('chat message persistence', () => {
  it('updates duplicate message ids instead of failing final assistant snapshots', async (t) => {
    if (skipIfSqliteUnavailable(t, 'chat-message-persistence: duplicate id update')) return
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
      db.createConversation('conv-duplicate', 'butler', 'Duplicate message test')
      db.addChatMessage(
        'assistant-final',
        'conv-duplicate',
        'assistant',
        '处理中',
        '2026-03-07T09:00:01.000Z',
        { taskSnapshot: { phase: 'responding' } },
      )
      db.addChatMessage(
        'assistant-final',
        'conv-duplicate',
        'assistant',
        '已完成',
        '2026-03-07T09:00:02.000Z',
        { taskSnapshot: { phase: 'done' } },
      )

      const rows = db.getChatMessages('conv-duplicate')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].content, '已完成')
      assert.equal(rows[0].timestamp, '2026-03-07T09:00:02.000Z')
      const meta = JSON.parse(rows[0].meta_json || '{}')
      assert.equal(meta.taskSnapshot.phase, 'done')

      const rawDb = db.getRawDb()
      assert.ok(rawDb)
      const ftsRows = rawDb.prepare(
        'SELECT message_id, conversation_id, content FROM chat_messages_fts WHERE message_id = ?',
      ).all<{ message_id: string; conversation_id: string; content: string }>('assistant-final')
      assert.equal(ftsRows.length, 1)
      assert.equal(ftsRows[0].content, '已完成')
    } finally {
      db?.close()
    }
  })
})
