/**
 * EP3-PK1 — migration 057 (context_refs_json + packet_role on
 * task_projections, 09 §2) with the Q1-paradigm chain and the two-level
 * nesting hard validation (三层嵌套被拒). Fake-DB paradigm; the real pass
 * is verify:native.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-packet-columns declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-packet-columns transitive sqlite load')
})

class MigrationDb {
  readonly addedColumns: string[] = []
  constructor(readonly appliedNames: string[]) {}
  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')) return
    const alter = normalized.match(/^ALTER TABLE task_projections ADD COLUMN ([a-z_]+) TEXT$/i)
    if (alter) {
      if (this.addedColumns.includes(alter[1])) throw new Error(`duplicate column: ${alter[1]}`)
      this.addedColumns.push(alter[1])
      return
    }
    throw new Error(`unexpected migration SQL: ${normalized}`)
  }
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'SELECT name FROM migrations') {
      return { all: <R>() => this.appliedNames.map((name) => ({ name })) as R[], run: () => undefined, get: () => undefined }
    }
    if (normalized.startsWith('INSERT INTO migrations')) {
      return { run: (name: unknown) => { this.appliedNames.push(String(name)) }, all: () => [], get: () => undefined }
    }
    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

test('057 adds context_refs_json + packet_role, name-isolated and idempotent, AFTER A1 numbers', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('057_task_projection_packet_columns'), '057 registered')
  assert.ok(
    names.indexOf('056_task_projection_owner_agent') < names.indexOf('057_task_projection_packet_columns'),
    'PK1 numbering sits after A1 (single-executor order + sequential gate)',
  )
  const db = new MigrationDb(names.filter((name) => name !== '057_task_projection_packet_columns'))
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.deepEqual([...db.addedColumns].sort(), ['context_refs_json', 'packet_role'])
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db.addedColumns.length, 2)
})

test('packet validation: roles closed to parent|child|NULL; nesting capped at two levels', async () => {
  const { validatePacketFields, assertPacketDepth } = await import('../main/modules/agent-control/quality/packet-fields')

  // closed role union
  assert.doesNotThrow(() => validatePacketFields({ packetRole: 'parent' }))
  assert.doesNotThrow(() => validatePacketFields({ packetRole: 'child' }))
  assert.doesNotThrow(() => validatePacketFields({ packetRole: null }))
  assert.throws(() => validatePacketFields({ packetRole: 'grandparent' as never }), /packet_role/)

  // contextRefs must be an array of reference strings — no prose payloads
  assert.doesNotThrow(() => validatePacketFields({ contextRefs: ['docs/a.md', 'card:topic-a', 'packet:task-1'] }))
  assert.throws(() => validatePacketFields({ contextRefs: 'a long retelling of the task' as never }), /contextRefs/)

  // two-level cap: parent → child legal; a child may never parent another packet
  const rows = new Map([
    ['root', { taskId: 'root', packetRole: 'parent', parentTaskId: null }],
    ['kid', { taskId: 'kid', packetRole: 'child', parentTaskId: 'root' }],
  ])
  const lookup = (taskId: string) => rows.get(taskId) ?? null
  assert.doesNotThrow(() => assertPacketDepth({ taskId: 'kid2', packetRole: 'child', parentTaskId: 'root' }, lookup))
  assert.throws(
    () => assertPacketDepth({ taskId: 'grandkid', packetRole: 'child', parentTaskId: 'kid' }, lookup),
    /两层|depth/,
    '三层嵌套被拒',
  )
  // a parent under another packet is equally illegal
  assert.throws(
    () => assertPacketDepth({ taskId: 'midparent', packetRole: 'parent', parentTaskId: 'root' }, lookup),
    /两层|depth|parent/,
  )
})

test('repository roundtrips packetRole/contextRefs; legacy rows read back NULL/[]', async () => {
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
      if (normalized.startsWith('SELECT * FROM task_projections WHERE parent_task_id = ?')) {
        return {
          all: <R>(parentId: unknown) => [...rows.values()].filter((row) => row.parent_task_id === String(parentId)) as R[],
          get: () => undefined, run: () => undefined,
        }
      }
      if (normalized.startsWith('UPDATE task_projections SET')) {
        const setColumns = normalized.slice('UPDATE task_projections SET '.length, normalized.indexOf(' WHERE')).split(',').map((part) => part.trim().split(' ')[0])
        return {
          run: (...params: unknown[]) => {
            const row = rows.get(String(params[params.length - 1]))
            if (row) setColumns.forEach((column, index) => { row[column] = params[index] })
          },
          all: () => [], get: () => undefined,
        }
      }
      throw new Error(`unexpected SQL: ${normalized}`)
    },
  }
  const repository = new TaskProjectionRepository({ getRawDb: () => raw as never })
  repository.create({
    taskId: 'packet-1', taskOrigin: 'system_background', scopeId: 's1', runId: 'r1', taskType: 'multi_step_task', module: 'system',
    status: 'running', interactionState: 'running', steps: [],
    packetRole: 'parent', contextRefs: ['docs/spec.md', 'card:routing-a'],
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  } as never, { silent: true })
  const fetched = repository.get('packet-1')
  assert.equal(fetched?.packetRole, 'parent')
  assert.deepEqual(fetched?.contextRefs, ['docs/spec.md', 'card:routing-a'])

  repository.update('packet-1', { packetRole: null, contextRefs: [] } as never, { silent: true })
  assert.equal(repository.get('packet-1')?.packetRole ?? null, null)

  // malformed cell degrades, never throws
  rows.get('packet-1')!.context_refs_json = '{not json'
  assert.deepEqual(repository.get('packet-1')?.contextRefs, [])

  // writer passing garbage is rejected loudly (Q1 范式)
  assert.throws(() => repository.update('packet-1', { packetRole: 'boss' } as never, { silent: true }), /packet_role/)

  // depth is enforced AT THE WRITE SIDE — the repository is the funnel,
  // not just a free validation function callers may forget (两层硬上限).
  const base = {
    taskOrigin: 'system_background', scopeId: 's1', runId: 'r1', taskType: 'multi_step_task', module: 'system',
    status: 'running', interactionState: 'running', steps: [],
    createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
  }
  repository.create({ ...base, taskId: 'root', packetRole: 'parent' } as never, { silent: true })
  repository.create({ ...base, taskId: 'kid', packetRole: 'child', parentTaskId: 'root' } as never, { silent: true })
  assert.throws(
    () => repository.create({ ...base, taskId: 'grandkid', packetRole: 'child', parentTaskId: 'kid' } as never, { silent: true }),
    /两层|depth|parent/,
    'create: child-under-child rejected at the funnel',
  )
  repository.create({ ...base, taskId: 'kid2', packetRole: 'child', parentTaskId: 'root' } as never, { silent: true })
  assert.throws(
    () => repository.update('kid2', { parentTaskId: 'kid' } as never, { silent: true }),
    /两层|depth|parent/,
    'update: re-parenting under a child rejected on the EFFECTIVE row',
  )
  assert.throws(
    () => repository.update('kid', { packetRole: 'parent' } as never, { silent: true }),
    /两层|depth|parent/,
    'update: promoting a nested child to parent rejected',
  )
  assert.throws(
    () => repository.update('root', { packetRole: null } as never, { silent: true }),
    /demote parent packet/,
    'update: demoting a parent with live child packets rejected',
  )
})
