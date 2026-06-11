/**
 * EP2-K6 — truth-source boundary acceptance (sub-contract A1-A8, fake mirror
 * DB + real BeliefCardStore on a temp root + zero-debounce watcher).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  syncBeliefCardFile,
  KnowledgeWatcher,
  runStartupBeliefSync,
  isKnowledgeSystemEnabled,
} from '../main/modules/agent-control/knowledge/knowledge-truth-source'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const requireCjs = createRequire(import.meta.url)

function fakeMirrorDb() {
  const rows = new Map<string, Record<string, unknown>>()
  let writes = 0
  return {
    rows,
    get writes() { return writes },
    prepare(sql: string) {
      if (sql.includes('INSERT INTO agent_memory_metadata')) {
        return {
          run: (params: unknown) => {
            writes += 1
            const p = params as Record<string, unknown>
            rows.set(String(p.id), { category: 'belief', ...p })
          },
          get: () => undefined,
          all: () => [],
        }
      }
      if (sql.includes('SELECT') && sql.includes('file_path = ?')) {
        return {
          get: <R>(relPath: unknown) => {
            for (const row of rows.values()) {
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
}

function cardText(title: string, status = 'active'): string {
  return ['---', `title: ${title}`, 'description: 描述', 'confidence: M', 'tag: knowledge',
    'created: 2026-06-01', `status: ${status}`, '---', `${title} 正文`].join('\n')
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-k6-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

test('A1/A2: watcher sync is idempotent — hash matches the file, unchanged rescans write zero rows', () => {
  const root = makeRoot()
  try {
    const db = fakeMirrorDb()
    const store = new BeliefCardStore({ memoryRoot: root })
    writeFileSync(join(root, 'knowledge', 'a.md'), cardText('卡A'), 'utf-8')

    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/a.md'), 'synced')
    const writesAfterFirst = db.writes
    // edit twice, sync twice → still one row, hash = last content
    writeFileSync(join(root, 'knowledge', 'a.md'), cardText('卡A改'), 'utf-8')
    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/a.md'), 'synced')
    assert.equal(db.rows.size, 1)
    // unchanged rescan → zero writes (A2 short-circuit)
    const writesBefore = db.writes
    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/a.md'), 'skipped')
    assert.equal(db.writes, writesBefore, 'unchanged content must not touch the DB')
    assert.ok(writesAfterFirst >= 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A3: broken frontmatter → invalid row + file kept + audit; repair → recovered + audit', () => {
  const root = makeRoot()
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const db = fakeMirrorDb()
    const store = new BeliefCardStore({ memoryRoot: root })
    writeFileSync(join(root, 'knowledge', 'b.md'), '---\ntitle: 坏卡\n没有合法结构', 'utf-8')
    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/b.md'), 'invalid')
    assert.ok(statSync(join(root, 'knowledge', 'b.md')).isFile(), 'file kept')
    assert.ok(events.some((event) => event.metric === 'belief_card_invalid'))
    // second pass on the same broken file: no duplicate writes
    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/b.md'), 'skipped')
    // repair
    writeFileSync(join(root, 'knowledge', 'b.md'), cardText('修好了'), 'utf-8')
    assert.equal(syncBeliefCardFile(db as never, store, 'knowledge/b.md'), 'recovered')
    assert.ok(events.some((event) => event.metric === 'belief_card_recovered'))
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

const SCOPE: ConversationScope = {
  id: 'scope-k6', agent: 'butler', title: '测试', sourceKind: 'local', sourceId: 'app',
  threadKey: 'scope-k6', meta: {}, createdAt: '2026-06-12T09:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
}

test('A4/A5: invalid cards never reach the index; switch off removes injection with files untouched', async () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'knowledge', 'good.md'), cardText('GOOD_CARD'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'broken.md'), '---\ntitle: INVALID_CARD\n坏的', 'utf-8')
    writeFileSync(join(root, 'RULES.md'), 'RULES_MARKER', 'utf-8')

    const build = (enabled: boolean) => new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getBeliefCardStore: () => new BeliefCardStore({ memoryRoot: root }),
      isKnowledgeSystemEnabled: () => enabled,
    }).buildForScopedRun({ scope: SCOPE, message: '你好', coordinators: [] })

    const on = await build(true)
    const onText = [on.systemPrompt, ...on.bootstrapMessages].join('\n')
    assert.ok(onText.includes('GOOD_CARD'))
    assert.ok(!onText.includes('INVALID_CARD'), 'A4: invalid card absent from injection')
    assert.ok(onText.includes('RULES_MARKER'))

    const beforeMtime = statSync(join(root, 'knowledge', 'good.md')).mtimeMs
    const off = await build(false)
    const offText = [off.systemPrompt, ...off.bootstrapMessages].join('\n')
    assert.ok(!offText.includes('GOOD_CARD') && !offText.includes('## 知识索引'), 'A5: index gone')
    assert.ok(!offText.includes('RULES_MARKER') && !offText.includes('## 运行规则'), 'A5: rules gone')
    assert.equal(statSync(join(root, 'knowledge', 'good.md')).mtimeMs, beforeMtime, 'A5: files untouched')

    const back = await build(true)
    assert.ok(back.systemPrompt.includes('RULES_MARKER'), 'A5: re-enable restores')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A5: switch defaults on; explicit false turns it off (single read entry)', () => {
  assert.equal(isKnowledgeSystemEnabled(null), true)
  assert.equal(isKnowledgeSystemEnabled({ getSetting: () => undefined }), true)
  assert.equal(isKnowledgeSystemEnabled({ getSetting: () => 'false' }), false)
  assert.equal(isKnowledgeSystemEnabled({ getSetting: () => { throw new Error('db') } }), true)
})

test('A6: startup sync upserts new + marks broken, zero deletions of existing rows; disabled skips', () => {
  const root = makeRoot()
  try {
    const db = fakeMirrorDb()
    // pre-existing row with no corresponding file — must survive untouched
    db.rows.set('mirror-orphan', { category: 'belief', slug: 'orphan', status: 'active' })
    writeFileSync(join(root, 'knowledge', 'fresh.md'), cardText('新卡'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'bad.md'), '---\n坏', 'utf-8')
    const store = new BeliefCardStore({ memoryRoot: root })
    const result = runStartupBeliefSync(db as never, store, true)
    assert.deepEqual(result, { synced: 1, invalid: 1 })
    assert.ok(db.rows.has('mirror-orphan'), 'A6: orphan mirror row never deleted')
    assert.equal(runStartupBeliefSync(db as never, store, false), null, 'disabled → skipped')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A7: k/v export creates staged cards, reruns skip, source rows untouched', () => {
  const root = makeRoot()
  try {
    const { exportKvRowsToCards } = requireCjs('../../scripts/export-agent-knowledge-to-cards.cjs')
    const rows = [
      { agent_name: 'butler', key: 'fav_style', value: '简洁直接' },
      { agent_name: 'global', key: 'Site Rule', value: '低频访问' },
    ]
    const first = exportKvRowsToCards(rows, root, '2026-06-12')
    assert.equal(first.created.length, 2)
    const body = readFileSync(join(root, first.created[0]), 'utf-8')
    assert.ok(body.includes('status: staged'), 'A7: exported cards are staged')
    // rerun skips — hand edits never overwritten
    const second = exportKvRowsToCards(rows, root, '2026-06-13')
    assert.equal(second.created.length, 0)
    assert.equal(second.skipped.length, 2)
    assert.equal(rows.length, 2, 'source rows untouched (export never deletes)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('A8 + watcher: belief rows are outside L1/L2 time archiving; watcher debounce batches', async () => {
  // A8 boundary: the memory-lifecycle archive paths query L1/L2 source types,
  // never category='belief' rows — asserted structurally on the SQL the
  // repository issues is covered by verify:native; here we pin the watcher.
  const root = makeRoot()
  try {
    const db = fakeMirrorDb()
    const store = new BeliefCardStore({ memoryRoot: root })
    writeFileSync(join(root, 'knowledge', 'w1.md'), cardText('W1'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'w2.md'), cardText('W2'), 'utf-8')
    const flushes: string[][] = []
    const watcher = new KnowledgeWatcher({
      db: db as never, store, debounceMs: 0,
      onFlush: (results) => flushes.push([...results]),
    })
    watcher.enqueue('knowledge/w1.md')
    watcher.enqueue('knowledge/w2.md')
    watcher.enqueue('knowledge/w1.md') // dedupe inside the pending set
    watcher.flush()
    assert.equal(flushes.length, 1, 'one batched flush')
    assert.deepEqual(flushes[0].sort(), ['synced', 'synced'])
    assert.equal(db.rows.size, 2)
    watcher.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
