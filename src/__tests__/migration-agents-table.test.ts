/**
 * EP3-A1 — migrations 055 (agents table, main-agent row ONLY) + 056
 * (task_projections.owner_agent_id) with the Q1-paradigm full chain, plus
 * the agent registry repository. Fake-DB paradigm: host node cannot load
 * the electron-ABI sqlite; the real pass is `npm run verify:native`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-agents-table declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-agents-table transitive sqlite load')
})

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

class MigrationDb {
  readonly tables = new Set<string>()
  readonly addedColumns: string[] = []
  readonly insertedAgents: unknown[][] = []
  readonly appliedMigrations: string[] = []

  constructor(readonly appliedNames: string[]) {}

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')
    ) return
    const createTable = normalized.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+) /i)
    if (createTable) { this.tables.add(createTable[1]); return }
    const alter = normalized.match(/^ALTER TABLE (task_projections|agents) ADD COLUMN ([a-z_]+) TEXT$/i)
    if (alter) {
      const column = `${alter[1]}.${alter[2]}`
      if (this.addedColumns.includes(column)) throw new Error(`duplicate column: ${column}`)
      this.addedColumns.push(column)
      return
    }
    if (/^INSERT (OR IGNORE )?INTO agents/i.test(normalized)) return // seed handled via prepare in some shapes
    throw new Error(`unexpected migration SQL: ${normalized}`)
  }

  prepare(sql: string): Statement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'SELECT name FROM migrations') {
      return { all: <R>() => this.appliedNames.map((name) => ({ name })) as R[], run: () => undefined, get: () => undefined }
    }
    if (normalized.startsWith('INSERT INTO migrations')) {
      return {
        run: (name: unknown) => { this.appliedNames.push(String(name)); this.appliedMigrations.push(String(name)) },
        all: () => [], get: () => undefined,
      }
    }
    if (normalized === 'PRAGMA table_info(agents)') {
      return {
        all: <R>() => [] as R[],
        run: () => undefined,
        get: () => undefined,
      }
    }
    if (/INSERT (OR IGNORE )?INTO agents/i.test(normalized)) {
      return { run: (...params: unknown[]) => { this.insertedAgents.push(params) }, all: () => [], get: () => undefined }
    }
    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

test('055 creates the agents table with ONLY the main-agent row; 056 adds owner_agent_id — each name-isolated and idempotent', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('055_agents_table'), '055 registered')
  assert.ok(names.includes('056_task_projection_owner_agent'), '056 registered')
  assert.ok(names.includes('058_agent_derivation_columns'), '058 registered')
  assert.ok(names.includes('059_agent_lifecycle_merged_target'), '059 registered')
  assert.ok(names.indexOf('055_agents_table') < names.indexOf('056_task_projection_owner_agent'), 'A1 order')
  assert.ok(names.indexOf('057_task_projection_packet_columns') < names.indexOf('058_agent_derivation_columns'), 'phase-4 migration follows 057')
  assert.ok(names.indexOf('058_agent_derivation_columns') < names.indexOf('059_agent_lifecycle_merged_target'), 'lifecycle migration follows derivation columns')

  // 055 isolated
  const db055 = new MigrationDb(names.filter((name) => name !== '055_agents_table'))
  runMigrations(db055 as unknown as Parameters<typeof runMigrations>[0])
  assert.ok(db055.tables.has('agents'))
  assert.equal(db055.insertedAgents.length, 1, '08/04 迁移口径：仅建主 agent 一行')
  runMigrations(db055 as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db055.insertedAgents.length, 1, 'second run is a ledger-tracked no-op')

  // 056 isolated
  const db056 = new MigrationDb(names.filter((name) => name !== '056_task_projection_owner_agent'))
  runMigrations(db056 as unknown as Parameters<typeof runMigrations>[0])
  assert.deepEqual(db056.addedColumns, ['task_projections.owner_agent_id'])

  // 058 isolated
  const db058 = new MigrationDb(names.filter((name) => name !== '058_agent_derivation_columns'))
  runMigrations(db058 as unknown as Parameters<typeof runMigrations>[0])
  assert.deepEqual(db058.addedColumns, ['agents.parent_agent_id', 'agents.derivation_reason'])

  // 059 isolated
  const db059 = new MigrationDb(names.filter((name) => name !== '059_agent_lifecycle_merged_target'))
  runMigrations(db059 as unknown as Parameters<typeof runMigrations>[0])
  assert.deepEqual(db059.addedColumns, ['agents.merged_into_agent_id'])
})

// ---------- agent registry repository ----------

function fakeAgentsDb() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('INSERT INTO agents')) {
        return {
          run: (...params: unknown[]) => {
            const [id, name, charter, personaRef, status, parentAgentId, derivationReason, mergedIntoAgentId, createdAt] = params
            rows.set(String(id), {
              id,
              name,
              charter,
              persona_ref: personaRef,
              status,
              parent_agent_id: parentAgentId,
              derivation_reason: derivationReason,
              merged_into_agent_id: mergedIntoAgentId,
              created_at: createdAt,
            })
          },
          all: () => [], get: () => undefined,
        }
      }
      if (normalized.startsWith('INSERT OR IGNORE INTO agent_personalities')) {
        return { run: () => undefined, all: () => [], get: () => undefined }
      }
      if (normalized.startsWith('SELECT') && normalized.includes('WHERE id = ?')) {
        return { get: <R>(id: unknown) => rows.get(String(id)) as R | undefined, run: () => undefined, all: () => [] }
      }
      if (normalized.startsWith('SELECT') && normalized.includes('FROM agents')) {
        return { all: <R>() => [...rows.values()] as R[], run: () => undefined, get: () => undefined }
      }
      if (normalized.startsWith('UPDATE agents SET')) {
        return {
          run: (status: unknown, mergedIntoAgentId: unknown, id: unknown) => {
            const row = rows.get(String(id))
            if (row) {
              row.status = status
              row.merged_into_agent_id = mergedIntoAgentId
            }
          },
          all: () => [],
          get: () => undefined,
        }
      }
      throw new Error(`unexpected agents SQL: ${normalized}`)
    },
  }
}

test('registry roundtrip: create → get/list; empty table degrades to [] (system = status quo)', async () => {
  const { AgentRegistryRepository } = await import('../main/modules/repositories/agent-registry-repository')
  const raw = fakeAgentsDb()
  const registry = new AgentRegistryRepository({ getRawDb: () => raw as never })

  assert.deepEqual(registry.list(), [], 'empty table → empty list, callers keep现状')
  assert.equal(registry.get('butler'), null)

  registry.create({
    id: 'writer',
    name: '文案专员',
    charter: '负责文案任务',
    personaRef: null,
    parentAgentId: 'butler',
    derivationReason: 'knowledge/candidate.md',
  })
  const fetched = registry.get('writer')
  assert.equal(fetched?.name, '文案专员')
  assert.equal(fetched?.status, 'active')
  assert.equal(fetched?.parentAgentId, 'butler')
  assert.equal(fetched?.derivationReason, 'knowledge/candidate.md')
  assert.equal(fetched?.mergedIntoAgentId, null)
  assert.equal(registry.list().length, 1)

  // a dead DB degrades to empty, never throws into callers
  const dead = new AgentRegistryRepository({ getRawDb: () => null })
  assert.deepEqual(dead.list(), [])
  assert.equal(dead.get('butler'), null)
})

// ---------- ownerAgentId Q1-paradigm chain ----------

test('ownerAgentId roundtrips through the projection repository; NULL-compatible for legacy rows', async () => {
  const { TaskProjectionRepository } = await import('../main/modules/repositories/task-projection-repository')
  const rows = new Map<string, Record<string, unknown>>()
  const raw = {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('INSERT INTO task_projections')) {
        const columns = normalized.slice(normalized.indexOf('(') + 1, normalized.indexOf(')')).split(',').map((column) => column.trim())
        return {
          run: (...params: unknown[]) => {
            const row: Record<string, unknown> = {}
            columns.forEach((column, index) => { row[column] = params[index] })
            rows.set(String(row.task_id), row)
          },
          all: () => [], get: () => undefined,
        }
      }
      if (normalized.startsWith('SELECT * FROM task_projections WHERE task_id = ?')) {
        return { get: <R>(taskId: unknown) => rows.get(String(taskId)) as R | undefined, run: () => undefined, all: () => [] }
      }
      if (normalized.startsWith('UPDATE task_projections SET')) {
        const setColumns = normalized.slice('UPDATE task_projections SET '.length, normalized.indexOf(' WHERE')).split(',').map((part) => part.trim().split(' ')[0])
        return {
          run: (...params: unknown[]) => {
            const row = rows.get(String(params[params.length - 1]))
            if (row) setColumns.forEach((column, index) => { row[column] = params[index] })
            return { changes: row ? 1 : 0 }
          },
          all: () => [], get: () => undefined,
        }
      }
      throw new Error(`unexpected SQL: ${normalized}`)
    },
  }
  const repository = new TaskProjectionRepository({ getRawDb: () => raw as never })
  repository.create({
    taskId: 'task-owner', taskOrigin: 'user_root', scopeId: 's1', messageVisibilityEpoch: 0, runId: 'r1', taskType: 'short_task', module: 'chat',
    status: 'running', interactionState: 'running', steps: [],
    ownerAgentId: 'writer',
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  } as never, { silent: true })
  assert.equal(repository.get('task-owner')?.ownerAgentId, 'writer')

  repository.update('task-owner', { ownerAgentId: 'butler' } as never, { silent: true })
  assert.equal(repository.get('task-owner')?.ownerAgentId, 'butler')

  // legacy row: column absent → null, never throws
  rows.set('task-legacy', { task_id: 'task-legacy', scope_id: 's1', run_id: 'r1', task_type: 'short_task', module: 'chat', status: 'running', interaction_state: 'running', steps_json: '[]', created_at: 'x', updated_at: 'x' })
  assert.equal(repository.get('task-legacy')?.ownerAgentId ?? null, null)
})
