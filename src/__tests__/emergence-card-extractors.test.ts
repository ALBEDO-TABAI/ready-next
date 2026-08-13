/**
 * EP2-E1 — emergence kernel v1: follow_up / crystallize extractors
 * (10 篇 §3). Every card carries the full triplet: evidence chain +
 * confidence + action exit; cards without an exit never project. Feed caps:
 * global ≤8, per-type ≤3, confidence floor.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractFollowUpCards,
  extractCrystallizeCards,
  assembleEmergenceFeed,
  type EmergenceCard,
} from '../main/modules/agent-control/emergence/emergence-cards'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function projection(over: Record<string, unknown>): TaskProjectionRecord {
  return {
    taskId: 't1', scopeId: 's1', runId: 'r1', taskType: 'multi_step_task', module: 'browser',
    status: 'running', interactionState: 'running', steps: [],
    createdAt: '2026-06-12T08:00:00.000Z', updatedAt: '2026-06-12T09:00:00.000Z',
    ...over,
  } as unknown as TaskProjectionRecord
}

test('follow_up extractor: check_in_pending and user_input_missing both yield cards', () => {
  const cards = extractFollowUpCards([
    projection({ taskId: 'task-c', status: 'completed', interactionState: 'check_in_pending', taskTitle: '研究报告' }),
    projection({ taskId: 'task-d', status: 'blocked', blockedReason: '等待补充', continuationRef: { blockerType: 'user_input_missing' } }),
    projection({ taskId: 'task-e', status: 'running' }), // nothing waiting on the user
  ])
  assert.equal(cards.length, 2)
  const adjudicate = cards.find((card) => card.action.ref === 'task-c')
  assert.equal(adjudicate?.action.kind, 'adjudicate_task')
  const supply = cards.find((card) => card.action.ref === 'task-d')
  assert.equal(supply?.action.kind, 'supply_input')
})

test('crystallize extractor: retired aspire candidates stay hidden while duplicates remain review-only', () => {
  const cards = extractCrystallizeCards([
    { relPath: 'knowledge/aspire-weekly.md', title: '每周整理周报', tag: 'aspire', status: 'staged', source: null },
    { relPath: 'knowledge/dup-b.md', title: '同主题重复', tag: 'knowledge', status: 'active', source: 'possible-duplicate-of [[topic-a]]' },
    { relPath: 'knowledge/normal.md', title: '普通卡', tag: 'knowledge', status: 'active', source: null },
  ])
  assert.equal(cards.length, 1)
  for (const card of cards) {
    assert.equal(card.type, 'crystallize')
    assert.equal(card.requiresExplicitConfirm, true, 'crystallize cards are never one-click')
    assert.ok(!/你是一个/.test(card.title), 'observation wording, not judgment wording')
  }
  const dup = cards.find((card) => card.action.kind === 'review_duplicate')
  assert.ok(dup && dup.evidence.some((item) => item.fact.includes('possible-duplicate-of')))
})

test('crystallize extractor: staged 站点卡学习产物投影为待确认卡，其他 staged 卡不投影（D10-b）', () => {
  const cards = extractCrystallizeCards([
    // 三种站点卡学习 source 前缀 → 投影
    { relPath: 'knowledge/sites/xiaohongshu.com.md', title: 'xiaohongshu.com 站点经验', tag: 'knowledge', status: 'staged', source: 'failure-learning: selector_missing 写长文' },
    { relPath: 'knowledge/sites/bilibili.com.md', title: 'bilibili.com 站点经验修正', tag: 'knowledge', status: 'staged', source: 'possible-update-of: [[sites/bilibili.com]]' },
    { relPath: 'knowledge/sites/taobao.com.md', title: 'taobao.com 风险建议', tag: 'knowledge', status: 'staged', source: 'possible-risk-update-of: [[sites/taobao.com]]' },
    // 普通 staged 信念卡（无站点学习 source）→ 不投影，避免 feed 炸锅
    { relPath: 'knowledge/pref.md', title: '偏好观察', tag: 'knowledge', status: 'staged', source: null },
    // active 站点卡 → 不投影（无需确认）
    { relPath: 'knowledge/sites/zhihu.com.md', title: 'zhihu.com 站点经验', tag: 'knowledge', status: 'active', source: 'failure-learning: old' },
  ])
  assert.equal(cards.length, 3)
  for (const card of cards) {
    assert.equal(card.type, 'crystallize')
    assert.equal(card.action.kind, 'review_duplicate', '历史学习卡只能进入人工复核')
    assert.equal(card.requiresExplicitConfirm, true, 'staged 站点卡永不一键采纳')
  }
  const risky = cards.find((card) => card.id.includes('taobao'))
  assert.ok(risky && /风险提示/.test(risky.title))
  const learned = cards.find((card) => card.id.includes('xiaohongshu'))
  assert.ok(learned && /确认后下次生效/.test(learned.title))
})

test('feed assembly: confidence floor, per-type ≤3, global ≤8, exit-less cards dropped', () => {
  const mk = (i: number, type: EmergenceCard['type'], confidence: number, action: EmergenceCard['action'] | null): EmergenceCard => ({
    id: `${type}-${i}`, type, title: `card ${i}`, confidence,
    evidence: [{ fact: 'f', ref: 'r' }],
    action: action as EmergenceCard['action'],
    requiresExplicitConfirm: type === 'crystallize',
  })
  const cards: EmergenceCard[] = [
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'follow_up', 0.9 - i * 0.01, { kind: 'adjudicate_task', ref: `f${i}` })),
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'crystallize', 0.7, { kind: 'review_duplicate', ref: `c${i}` })),
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'prepare', 0.6, { kind: 'open_project', ref: `p${i}` })),
    mk(99, 'follow_up', 0.2, { kind: 'adjudicate_task', ref: 'low' }), // below floor
    mk(98, 'follow_up', 0.95, null),                                  // no exit → dropped
  ]
  const feed = assembleEmergenceFeed(cards)
  assert.ok(feed.length <= 8, 'global cap')
  for (const type of ['follow_up', 'crystallize', 'prepare'] as const) {
    assert.ok(feed.filter((card) => card.type === type).length <= 3, `per-type cap for ${type}`)
  }
  assert.ok(!feed.some((card) => card.id === 'follow_up-99'), 'below-floor card dropped')
  assert.ok(!feed.some((card) => card.id === 'follow_up-98'), 'exit-less card dropped')
  for (let i = 1; i < feed.length; i += 1) {
    assert.ok(feed[i - 1].confidence >= feed[i].confidence, 'sorted by confidence desc')
  }
})
