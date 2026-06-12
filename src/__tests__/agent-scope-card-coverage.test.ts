/**
 * EP4-K-mirror — agent-scope cards join the mirror / decay / maintenance
 * scans with the scope WRITTEN THROUGH: mirror rows carry
 * scope_id='agent:<id>'; backlinks resolve per scope bucket (same slug
 * across agents never cross-links); the root index.md stays GLOBAL-ONLY;
 * no agents/ dir means exact legacy behavior; staged agent cards stay out
 * of every injection surface.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { syncBeliefCards, type MirrorDb } from '../main/modules/agent-control/knowledge/belief-card-mirror'
import { buildKnowledgeGraphPlan } from '../main/modules/agent-control/knowledge/knowledge-index-builder'
import { collectBeliefDecaySignals } from '../main/modules/agent-control/maintenance/maintenance-llm-round'

const NOW = new Date('2026-06-13T12:00:00.000Z')

function card(title: string, body: string, status = 'active'): string {
  return ['---', `title: ${title}`, 'description: 一句话', 'confidence: H', 'tag: knowledge',
    'created: 2026-06-13', `status: ${status}`, '---', body].join('\n')
}

function makeRoot(withAgents = true): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-kmirror-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  writeFileSync(join(root, 'knowledge', 'global-a.md'), card('GLOBAL_A', '链 [[shared]]'), 'utf-8')
  writeFileSync(join(root, 'knowledge', 'shared.md'), card('GLOBAL_SHARED', '全局正文'), 'utf-8')
  if (withAgents) {
    for (const agent of ['collector', 'writer']) {
      mkdirSync(join(root, 'agents', agent, 'knowledge'), { recursive: true })
      // SAME slug in both agents + global — the cross-link trap
      writeFileSync(join(root, 'agents', agent, 'knowledge', 'shared.md'),
        card(`${agent.toUpperCase()}_SHARED`, `${agent} 的正文`), 'utf-8')
      writeFileSync(join(root, 'agents', agent, 'knowledge', `${agent}-linker.md`),
        card(`${agent.toUpperCase()}_LINKER`, '参考 [[shared]]'), 'utf-8')
    }
    // unsafe dir name must be skipped, never a path fragment
    mkdirSync(join(root, 'agents', '.hidden', 'knowledge'), { recursive: true })
    writeFileSync(join(root, 'agents', '.hidden', 'knowledge', 'evil.md'), card('EVIL', 'x'), 'utf-8')
  }
  return root
}

class FakeMirrorDb implements MirrorDb {
  rows = new Map<string, Record<string, unknown>>()
  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO agent_memory_metadata')) {
      return {
        run: (params: Record<string, unknown>) => { this.rows.set(String(params.id), { ...params }) },
        get: () => undefined, all: () => [],
      }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

test('mirror sync writes the scope THROUGH: agent rows scope_id=agent:<id>, global stays global', () => {
  const root = makeRoot()
  try {
    const db = new FakeMirrorDb()
    const store = new BeliefCardStore({ memoryRoot: root })
    const report = syncBeliefCards(db, store)
    assert.equal(report.synced, 6, '2 global + 2×2 agent cards (.hidden skipped)')

    const collectorRow = db.rows.get('belief:agents/collector/knowledge/shared.md')
    assert.ok(collectorRow, 'agent card mirrored')
    assert.equal(collectorRow!.scope_id, 'agent:collector', '04 §2 scope written through, never global')
    assert.equal(collectorRow!.file_path, 'agents/collector/knowledge/shared.md')
    assert.equal(db.rows.get('belief:knowledge/shared.md')!.scope_id, 'global')
    assert.ok(!db.rows.has('belief:agents/.hidden/knowledge/evil.md'), 'unsafe agent dir skipped')

    // invalid agent card keeps its scope too
    writeFileSync(join(root, 'agents', 'collector', 'knowledge', 'broken.md'), '---\ntitle: x\n没有合法 frontmatter', 'utf-8')
    const second = syncBeliefCards(db, store)
    assert.equal(second.invalid, 1)
    assert.equal(db.rows.get('belief:agents/collector/knowledge/broken.md')!.scope_id, 'agent:collector')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('backlinks resolve per scope: same slug across two agents and global never cross-links', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const plan = buildKnowledgeGraphPlan(store.listAllCardFilesAllScopes(), { now: NOW })

    // each scope's [[shared]] resolves to ITS OWN shared.md
    const collectorShared = plan.cardBodies.find((entry) => entry.relPath === 'agents/collector/knowledge/shared.md')
    assert.ok(collectorShared, 'collector shared gains a backlinks block')
    assert.ok(collectorShared!.body.includes('[[collector-linker]]'))
    assert.ok(!collectorShared!.body.includes('[[writer-linker]]'), '跨 agent 不互链')
    assert.ok(!collectorShared!.body.includes('[[global-a]]'), '全局边不漏进 agent 桶')
    const globalShared = plan.cardBodies.find((entry) => entry.relPath === 'knowledge/shared.md')
    assert.ok(globalShared!.body.includes('[[global-a]]'))
    assert.ok(!globalShared!.body.includes('linker'), 'agent 边不漏进全局桶')
    assert.equal(plan.orphanLinks.length, 0, '同名 slug 在各自桶内都可解析，无伪孤链')

    // decay in-degree counts per scope as well
    const signals = collectBeliefDecaySignals(store, () => ({ accessCount: 0, wasUsefulCount: 0 }), NOW)
    const byPath = new Map(signals.map((signal) => [signal.relPath, signal]))
    assert.equal(byPath.get('agents/collector/knowledge/shared.md')!.backlinksCount, 1)
    assert.equal(byPath.get('knowledge/shared.md')!.backlinksCount, 1, '不是 3——每个作用域各算各的')
    assert.ok(byPath.has('agents/writer/knowledge/writer-linker.md'), '衰减信号覆盖 agent 卡')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent cards never leak into root index.md; same-title across scopes is NOT a duplicate', () => {
  const root = makeRoot()
  try {
    // same TITLE in global and agent scope — must not be cross-marked
    writeFileSync(join(root, 'agents', 'collector', 'knowledge', 'dup-title.md'), card('GLOBAL_A', '同名标题'), 'utf-8')
    const store = new BeliefCardStore({ memoryRoot: root })
    const plan = buildKnowledgeGraphPlan(store.listAllCardFilesAllScopes(), { now: NOW })
    assert.ok(plan.indexMarkdown.includes('GLOBAL_A') && plan.indexMarkdown.includes('GLOBAL_SHARED'))
    for (const banned of ['COLLECTOR_', 'WRITER_', 'agents/']) {
      assert.ok(!plan.indexMarkdown.includes(banned), `root index.md 必须 global-only（发现 ${banned}）`)
    }
    assert.equal(plan.possibleDuplicates.length, 0, '跨作用域同名标题不是重复')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no agents/ dir → exact legacy behavior; legacy callers without scopeId unchanged', () => {
  const root = makeRoot(false)
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const scoped = store.listAllCardFilesAllScopes()
    const legacy = store.listAllCardFiles()
    assert.deepEqual(
      scoped.map(({ relPath, scopeId }) => ({ relPath, scopeId })),
      legacy.map(({ relPath }) => ({ relPath, scopeId: 'global' })),
      '无 agents 目录 = 现状 + global 标记',
    )
    // legacy plan input (no scopeId field) behaves identically to global bucket
    const planLegacy = buildKnowledgeGraphPlan(legacy, { now: NOW })
    const planScoped = buildKnowledgeGraphPlan(scoped, { now: NOW })
    assert.equal(planLegacy.indexMarkdown, planScoped.indexMarkdown)
    assert.deepEqual(planLegacy.cardBodies, planScoped.cardBodies)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staged agent cards stay quarantined from every injection surface (regression)', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, 'agents', 'collector', 'knowledge', 'staged.md'),
      card('STAGED_AGENT_CARD', '未确认', 'staged'), 'utf-8')
    const store = new BeliefCardStore({ memoryRoot: root })
    const index = store.renderKnowledgeIndex({ maxChars: 5000, ownerAgentId: 'collector' })
    assert.ok(!index.text.includes('STAGED_AGENT_CARD'), 'staged 禁令对 agent 作用域一样硬')
    // ...but the SCAN surfaces still see it (mirror records staged rows)
    const db = new FakeMirrorDb()
    syncBeliefCards(db, store)
    assert.equal(db.rows.get('belief:agents/collector/knowledge/staged.md')!.status, 'staged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
