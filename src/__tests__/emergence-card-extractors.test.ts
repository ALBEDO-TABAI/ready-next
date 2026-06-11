/**
 * EP2-E1 — emergence kernel v1: resume / follow_up / crystallize extractors
 * (10 篇 §3). Every card carries the full triplet: evidence chain +
 * confidence + action exit; cards without an exit never project. Feed caps:
 * global ≤8, per-type ≤3, confidence floor.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractResumeCards,
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

test('resume extractor: blocked task with continuation_ref yields a card with full triplet', () => {
  const cards = extractResumeCards([
    projection({ taskId: 'task-a', status: 'blocked', taskTitle: '采集主页', continuationRef: { blockerType: 'budget_exhausted' }, canResume: true }),
    projection({ taskId: 'task-b', status: 'completed' }), // terminal → no resume card
  ])
  assert.equal(cards.length, 1)
  const card = cards[0]
  assert.equal(card.type, 'resume')
  assert.ok(card.evidence.length >= 1 && card.evidence.every((item) => item.fact && item.ref))
  assert.ok(card.confidence > 0 && card.confidence <= 1)
  assert.equal(card.action.kind, 'resume_task')
  assert.equal(card.action.ref, 'task-a')
})

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

test('crystallize extractor: candidate and duplicate cards use observation wording and explicit-confirm exits', () => {
  const cards = extractCrystallizeCards([
    { relPath: 'knowledge/aspire-weekly.md', title: '每周整理周报', tag: 'aspire', status: 'staged', source: null },
    { relPath: 'knowledge/dup-b.md', title: '同主题重复', tag: 'knowledge', status: 'active', source: 'possible-duplicate-of [[topic-a]]' },
    { relPath: 'knowledge/normal.md', title: '普通卡', tag: 'knowledge', status: 'active', source: null },
  ])
  assert.equal(cards.length, 2)
  for (const card of cards) {
    assert.equal(card.type, 'crystallize')
    assert.equal(card.requiresExplicitConfirm, true, 'crystallize cards are never one-click')
    assert.ok(!/你是一个/.test(card.title), 'observation wording, not judgment wording')
  }
  const dup = cards.find((card) => card.action.kind === 'review_duplicate')
  assert.ok(dup && dup.evidence.some((item) => item.fact.includes('possible-duplicate-of')))
})

test('feed assembly: confidence floor, per-type ≤3, global ≤8, exit-less cards dropped', () => {
  const mk = (i: number, type: EmergenceCard['type'], confidence: number, action: EmergenceCard['action'] | null): EmergenceCard => ({
    id: `${type}-${i}`, type, title: `card ${i}`, confidence,
    evidence: [{ fact: 'f', ref: 'r' }],
    action: action as EmergenceCard['action'],
    requiresExplicitConfirm: type === 'crystallize',
  })
  const cards: EmergenceCard[] = [
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'resume', 0.9 - i * 0.01, { kind: 'resume_task', ref: `t${i}` })),
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'follow_up', 0.8, { kind: 'adjudicate_task', ref: `f${i}` })),
    ...Array.from({ length: 5 }, (_, i) => mk(i, 'crystallize', 0.7, { kind: 'adopt_candidate', ref: `c${i}` })),
    mk(99, 'resume', 0.2, { kind: 'resume_task', ref: 'low' }),   // below floor
    mk(98, 'resume', 0.95, null),                                  // no exit → dropped
  ]
  const feed = assembleEmergenceFeed(cards)
  assert.ok(feed.length <= 8, 'global cap')
  for (const type of ['resume', 'follow_up', 'crystallize'] as const) {
    assert.ok(feed.filter((card) => card.type === type).length <= 3, `per-type cap for ${type}`)
  }
  assert.ok(!feed.some((card) => card.id === 'resume-99'), 'below-floor card dropped')
  assert.ok(!feed.some((card) => card.id === 'resume-98'), 'exit-less card dropped')
  for (let i = 1; i < feed.length; i += 1) {
    assert.ok(feed[i - 1].confidence >= feed[i].confidence, 'sorted by confidence desc')
  }
})
