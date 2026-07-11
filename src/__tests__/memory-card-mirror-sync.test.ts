import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeMemoryTool } from '../main/modules/tools/memory-tools'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { getBeliefCardMirrorByRelPath, type MirrorDb } from '../main/modules/agent-control/knowledge/belief-card-mirror'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import type { ToolContext } from '../main/modules/tools/tool-executor'

test('memory-card-mirror-sync declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'memory-card-mirror-sync transitive sqlite load')
})

type FakeMirrorDb = MirrorDb & {
  rows: Map<string, Record<string, unknown>>
  writes: number
  failUpsert: boolean
}

function makeFakeMirrorDb(): FakeMirrorDb {
  const db: FakeMirrorDb = {
    rows: new Map<string, Record<string, unknown>>(),
    writes: 0,
    failUpsert: false,
    prepare(sql: string) {
      if (sql.includes('INSERT INTO agent_memory_metadata')) {
        return {
          run: (params: unknown) => {
            if (db.failUpsert) throw new Error('injected mirror upsert failure')
            db.writes += 1
            const p = params as Record<string, unknown>
            db.rows.set(String(p.id), { category: 'belief', ...p })
          },
          get: () => undefined,
          all: () => [],
        }
      }
      if (sql.includes('SELECT') && sql.includes('file_path = ?')) {
        return {
          get: <R>(relPath: unknown) => {
            for (const row of db.rows.values()) {
              if (row.category === 'belief' && row.file_path === relPath) return row as R
            }
            return undefined as R
          },
          run: () => undefined,
          all: () => [],
        }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
  return db
}

function makeContext(memoryRoot: string, db: FakeMirrorDb): ToolContext {
  const store = new BeliefCardStore({ memoryRoot })
  return {
    executionProfile: {
      knowledgeWriteOwnerAgentId: 'butler',
      allowedKnowledgeRefs: ['knowledge/mirror.md'],
    } as never,
    runtime: {
      getBeliefCardStore: () => store,
      getMemoryRepository: () => ({}),
      getPromptAssembly: () => ({}),
      getBeliefCardMirrorDb: () => db,
    } as unknown as ToolContext['runtime'],
    invoker: 'model',
  }
}

function args(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    rel_path: 'knowledge/mirror.md',
    title: '镜像',
    description: '镜像同步',
    confidence: 'M',
    tag: 'knowledge',
    body: '正文',
    ...overrides,
  }
}

test('memory_write_card immediately syncs the belief mirror and returns a success receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-mirror-'))
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const db = makeFakeMirrorDb()
    const ctx = makeContext(dir, db)
    const writeRes = JSON.parse(await executeMemoryTool('memory_write_card', args(), ctx))

    assert.equal(writeRes.success, true)
    assert.equal(writeRes.mirrorSynced, true)
    assert.equal(writeRes.mirrorSyncErrorKind, undefined)
    assert.equal(metrics.filter((event) => event.metric === 'belief_card_mirror_sync_failed').length, 0)

    const row = getBeliefCardMirrorByRelPath(db, 'knowledge/mirror.md')
    assert.ok(row)
    assert.equal(row.status, 'staged')
    assert.equal(row.file_path, 'knowledge/mirror.md')
    assert.equal(row.title, '镜像')
  } finally {
    __setMetricSinkForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unchanged rewrite reports mirror success without duplicate DB writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-mirror-'))
  try {
    const db = makeFakeMirrorDb()
    const ctx = makeContext(dir, db)
    const first = JSON.parse(await executeMemoryTool('memory_write_card', args(), ctx))
    assert.equal(first.success, true)
    assert.equal(first.mirrorSynced, true)
    const writesAfterFirst = db.writes

    const second = JSON.parse(await executeMemoryTool('memory_write_card', args(), ctx))
    assert.equal(second.success, true)
    assert.equal(second.mirrorSynced, true)
    assert.equal(db.rows.size, 1)
    assert.equal(db.writes, writesAfterFirst)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mirror sync failure is observable but does not fail the card write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-card-mirror-'))
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const db = makeFakeMirrorDb()
    db.failUpsert = true
    const ctx = makeContext(dir, db)
    const writeRes = JSON.parse(await executeMemoryTool('memory_write_card', args(), ctx))

    assert.equal(writeRes.success, true)
    assert.equal(writeRes.mirrorSynced, false)
    assert.equal(typeof writeRes.mirrorSyncErrorKind, 'string')
    assert.notEqual(writeRes.mirrorSyncErrorKind.length, 0)

    const failures = metrics.filter((event) => event.metric === 'belief_card_mirror_sync_failed')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].relPath, 'knowledge/mirror.md')

    const read = JSON.parse(
      await executeMemoryTool('memory_read_card', { rel_path: 'knowledge/mirror.md', include_staged: true }, { ...ctx, invoker: 'host' }),
    )
    assert.equal(read.success, true)
    assert.equal(read.frontmatter.status, 'staged')
  } finally {
    __setMetricSinkForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
