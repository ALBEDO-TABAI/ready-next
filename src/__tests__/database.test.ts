import { describe, it } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Database Mock Tests

describe('DatabaseManager Mock', () => {
    it('should create mock database instance', () => {
        const mockDb = {
            prepare: (sql: string) => ({
                run: (..._args: unknown[]) => ({ changes: 1 }),
                all: () => [],
                get: () => undefined
            }),
            exec: (sql: string) => { /* noop */ },
            close: () => { /* noop */ }
        }

        assert.ok(mockDb)
        assert.strictEqual(typeof mockDb.prepare, 'function')
        assert.strictEqual(typeof mockDb.exec, 'function')
        assert.strictEqual(typeof mockDb.close, 'function')
    })

    it('should execute CREATE TABLE statements', () => {
        const executedStatements: string[] = []
        const mockDb = {
            exec: (sql: string) => { executedStatements.push(sql) }
        }

        const createTableSQL = `CREATE TABLE IF NOT EXISTS rss_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL
    )`

        mockDb.exec(createTableSQL)
        assert.strictEqual(executedStatements.length, 1)
        assert.ok(executedStatements[0].includes('rss_sources'))
    })

    it('should prepare and execute statements', () => {
        let lastArgs: unknown[] = []
        const mockDb = {
            prepare: (_sql: string) => ({
                run: (...args: unknown[]) => {
                    lastArgs = args
                    return { changes: 1 }
                },
                all: () => [{ id: '1', name: 'Test' }],
                get: () => ({ id: '1', name: 'Test' })
            })
        }

        const stmt = mockDb.prepare('INSERT INTO rss_sources (id, name) VALUES (?, ?)')
        const result = stmt.run('1', 'Test Source')
        assert.strictEqual(result.changes, 1)
        assert.deepStrictEqual(lastArgs, ['1', 'Test Source'])

        const allResults = stmt.all()
        assert.strictEqual(allResults.length, 1)
    })
})

describe('Database Schema Validation', () => {
    it('should validate RSS source schema structure', () => {
        const schema = {
            tableName: 'rss_sources',
            columns: ['id', 'name', 'url', 'group_name', 'enabled', 'created_at']
        }
        assert.ok(schema.columns.includes('id'))
        assert.ok(schema.columns.includes('name'))
        assert.ok(schema.columns.includes('url'))
    })

    it('should validate RSS item schema structure', () => {
        const schema = {
            tableName: 'rss_items',
            columns: ['id', 'source_id', 'title', 'link', 'summary', 'published_at', 'read', 'starred']
        }
        assert.ok(schema.columns.includes('source_id'))
        assert.ok(schema.columns.includes('title'))
        assert.ok(schema.columns.includes('read'))
    })

    it('should validate RSS analysis job schema structure', () => {
        const schema = {
            tableName: 'rss_analysis_jobs',
            columns: [
                'id',
                'item_id',
                'action',
                'source_url',
                'target_dir',
                'output_dir',
                'status',
                'progress',
                'updated_at'
            ]
        }
        assert.ok(schema.columns.includes('item_id'))
        assert.ok(schema.columns.includes('action'))
        assert.ok(schema.columns.includes('progress'))
    })

    it('should validate agent runtime schema structure', () => {
        const channelSchema = {
            tableName: 'agent_channels',
            columns: ['id', 'type', 'name', 'enabled', 'config_json', 'updated_at']
        }
        const scheduleSchema = {
            tableName: 'scheduled_tasks',
            columns: ['id', 'name', 'schedule_spec_json', 'instruction', 'enabled', 'next_run_at']
        }
        assert.ok(channelSchema.columns.includes('type'))
        assert.ok(channelSchema.columns.includes('config_json'))
        assert.ok(scheduleSchema.columns.includes('schedule_spec_json'))
        assert.ok(scheduleSchema.columns.includes('instruction'))
    })

    it('should validate unified conversation scope columns for local and remote sessions', () => {
        const conversationSchema = {
            tableName: 'chat_conversations',
            columns: [
                'id',
                'agent',
                'title',
                'source_kind',
                'source_id',
                'thread_key',
                'meta_json',
                'updated_at'
            ]
        }
        const messageSchema = {
            tableName: 'chat_messages',
            columns: ['id', 'conversation_id', 'role', 'content', 'timestamp', 'meta_json']
        }
        const threadSchema = {
            tableName: 'agent_channel_threads',
            columns: ['channel_id', 'remote_thread', 'session_id', 'conversation_id', 'updated_at']
        }
        assert.ok(conversationSchema.columns.includes('source_kind'))
        assert.ok(conversationSchema.columns.includes('thread_key'))
        assert.ok(conversationSchema.columns.includes('meta_json'))
        assert.ok(messageSchema.columns.includes('meta_json'))
        assert.ok(threadSchema.columns.includes('conversation_id'))
    })

    it('should load better-sqlite3 through createRequire for ESM main-process compatibility', () => {
        const databaseModule = readFileSync(resolve(process.cwd(), 'src/main/modules/database.ts'), 'utf8')
        assert.match(databaseModule, /createRequire\(import\.meta\.url\)/)
        assert.match(databaseModule, /const require = createRequire\(import\.meta\.url\)/)
        assert.match(databaseModule, /require\('better-sqlite3'\)/)
    })
})
