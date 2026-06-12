/**
 * EP3-C5 — emergence candidate maintenance: two similar requests mint an
 * aspire candidate card with explainable dated evidence; <3 evidence never
 * projects to the intent feed; prune cards SUGGEST only (no execution
 * path); observation wording throughout; routing fixes are self/H cards.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maintainAgentCandidates, type SimilarRequestSignal } from '../main/modules/agent-control/emergence/candidate-maintenance'
import { extractAgentCandidateCards, extractCrystallizeCards } from '../main/modules/agent-control/emergence/emergence-cards'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'

const NOW = new Date('2026-06-12T12:00:00.000Z')

function makeStore(): { store: BeliefCardStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ready-c5-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return { store: new BeliefCardStore({ memoryRoot: root }), root }
}

const req = (date: string, request: string, stableIO = true): SimilarRequestSignal =>
  ({ domain: '小红书行情采集', request, date, stableIO })

test('two similar requests → hint card with dated, explainable evidence; third stable one upgrades to candidate', () => {
  const { store, root } = makeStore()
  try {
    const first = maintainAgentCandidates({
      store, now: NOW,
      signals: [req('2026-06-10', '帮我采集小红书穿搭行情'), req('2026-06-11', '再采一轮小红书行情')],
    })
    assert.equal(first.candidateCards.length, 1)
    assert.equal(first.candidateCards[0].stage, 'hint', '两次相似请求先立 hint')
    const relPath = first.candidateCards[0].relPath
    const card = store.readCard(relPath, { includeStaged: true })!
    assert.equal(card.frontmatter.status, 'staged', '维护写卡强制 staged')
    assert.equal(card.frontmatter.tag, 'aspire')
    assert.equal(card.frontmatter.stage, 'hint')
    assert.ok(card.body.includes('- 2026-06-10') && card.body.includes('- 2026-06-11'), '证据带日期可解释')
    assert.ok(card.body.includes('升') && card.body.includes('降'), '升降置信度条件写进卡')

    // third stable occurrence upgrades the SAME card and dedups evidence
    const second = maintainAgentCandidates({
      store, now: NOW,
      signals: [req('2026-06-11', '再采一轮小红书行情'), req('2026-06-12', '小红书行情再来一次')],
    })
    assert.equal(second.candidateCards[0].stage, 'candidate', '证据满 3 条且稳定 → candidate')
    assert.equal(second.candidateCards[0].evidenceCount, 3, '重复证据不重复计数')
    const upgraded = store.readCard(relPath, { includeStaged: true })!
    assert.equal(upgraded.frontmatter.stage, 'candidate')
    assert.ok(upgraded.body.includes('[stable]'), '稳定性按证据条目持久化进卡身')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('historically varied evidence never backs an upgrade — stability is counted per persisted entry', () => {
  const { store, root } = makeStore()
  try {
    // round 1: two varied observations
    maintainAgentCandidates({
      store, now: NOW,
      signals: [req('2026-06-08', '随手查个东西 A', false), req('2026-06-09', '随手查个东西 B', false)],
    })
    // round 2: ONE stable observation — this round alone is all-stable,
    // but accumulated stable evidence is 1 < 3 → must stay hint
    const report = maintainAgentCandidates({
      store, now: NOW,
      signals: [req('2026-06-12', '随手查个东西 C', true)],
    })
    assert.equal(report.candidateCards[0].evidenceCount, 3)
    assert.equal(report.candidateCards[0].stage, 'hint', '历史 varied 证据不为升级背书')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('feed projection: candidate + evidence ≥3 only; explicit confirm always required', () => {
  const base = { relPath: 'knowledge/agent-candidate-a.md', title: '小红书行情采集' }
  const threeDates = ['2026-06-10', '2026-06-11', '2026-06-12']
  assert.equal(
    extractAgentCandidateCards([{ ...base, stage: 'candidate', evidenceDates: threeDates.slice(0, 2) }]).length,
    0, '证据 <3 不投影',
  )
  assert.equal(
    extractAgentCandidateCards([{ ...base, stage: 'hint', evidenceDates: threeDates }]).length,
    0, 'hint 阶段不投影',
  )
  const projected = extractAgentCandidateCards([{ ...base, stage: 'candidate', evidenceDates: threeDates }])
  assert.equal(projected.length, 1)
  assert.equal(projected[0].type, 'crystallize', '复用 crystallize 显式确认类型')
  assert.equal(projected[0].requiresExplicitConfirm, true)
  assert.ok(projected[0].evidence.some((entry) => entry.fact.includes('派生流程属阶段四')), '占位出口声明')
  assert.match(projected[0].title, /最近/, '观察句措辞')
  assert.ok(!projected[0].title.includes('你是'), '不用定性措辞')

  // the LEGACY aspire path must not leak stage-carrying candidates around
  // the strict gate (hint / under-evidenced would otherwise project)
  const legacy = extractCrystallizeCards([
    { relPath: base.relPath, title: base.title, tag: 'aspire', status: 'staged', source: null, stage: 'hint' },
    { relPath: 'knowledge/plain-aspire.md', title: '普通开放问题', tag: 'aspire', status: 'staged', source: null },
  ])
  assert.equal(legacy.length, 1, 'stage-carrying cards excluded from the legacy path')
  assert.ok(legacy[0].id.includes('plain-aspire'))
})

test('prune cards SUGGEST only — wording observational, no execution side effects beyond the card file', () => {
  const { store, root } = makeStore()
  try {
    const report = maintainAgentCandidates({
      store, now: NOW, signals: [],
      traffic: [
        { agentId: 'collector', agentName: '采集手', runsLast30Days: 0 },
        { agentId: 'writer', agentName: '写作手', runsLast30Days: 9, overlapsWithAgentId: 'editor' },
        { agentId: 'busy', agentName: '忙碌手', runsLast30Days: 20 },
      ],
    })
    assert.deepEqual(report.pruneCards, ['knowledge/agent-prune-collector.md', 'knowledge/agent-prune-writer.md'])
    const card = store.readCard('knowledge/agent-prune-collector.md', { includeStaged: true })!
    assert.equal(card.frontmatter.status, 'staged')
    assert.match(card.frontmatter.title, /^观察：/, '观察句措辞')
    assert.ok(card.body.includes('只建议不执行'))
    assert.ok(store.listCards({ includeStaged: true }).every((entry) => entry.frontmatter.status === 'staged'),
      '修剪轮不触碰任何已有卡状态，只新增建议卡')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('routing fix cards: self/H, dated misses, hostile agent ids rejected', () => {
  const { store, root } = makeStore()
  try {
    const report = maintainAgentCandidates({
      store, now: NOW, signals: [],
      routingMisses: [
        { agentId: 'collector', agentName: '采集手', requestSummary: '采集小红书行情', date: '2026-06-12' },
        { agentId: '../escape', agentName: '坏人', requestSummary: 'x', date: '2026-06-12' },
      ],
    })
    assert.deepEqual(report.routingCards, ['knowledge/routing-collector.md'])
    assert.equal(report.rejected, 1, 'traversal-shaped agent id rejected')
    const card = store.readCard('knowledge/routing-collector.md', { includeStaged: true })!
    assert.equal(card.frontmatter.tag, 'self')
    assert.equal(card.frontmatter.confidence, 'H')
    assert.ok(card.body.includes('- 2026-06-12 采集小红书行情'))
    assert.ok(card.body.includes('[[collector]]'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('malformed signals are counted, never crash; bad stage values are rejected by the store', () => {
  const { store, root } = makeStore()
  try {
    const report = maintainAgentCandidates({
      store, now: NOW,
      signals: [
        { domain: '', request: 'x', date: '2026-06-12', stableIO: true },
        { domain: 'd', request: 'x', date: 'not-a-date', stableIO: true },
      ],
    })
    assert.equal(report.candidateCards.length, 0)
    assert.equal(report.rejected, 2)
    const bad = store.writeCard({
      relPath: 'knowledge/bad-stage.md',
      frontmatter: {
        title: 't', description: 'd', confidence: 'M', tag: 'aspire',
        created: '2026-06-12', status: 'staged', stage: 'superstar' as never,
      },
      body: 'x',
    })
    assert.equal(bad.ok, false, 'stage union is closed at the store')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
