/**
 * EP3-C3 — LLM maintenance round through the PINNED runSubAgent container:
 * gate skip = zero LLM calls; fixed signal set → expected card ops (forced
 * staged); bad ops rejected by format validation; empty round exits clean;
 * decay runs on REAL signals (mirror access + authored backlinks).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runMaintenanceLlmRound,
  parseMaintenanceOps,
  collectBeliefDecaySignals,
  renderMaintenanceSignals,
} from '../main/modules/agent-control/maintenance/maintenance-llm-round'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import type { CrystallizeSignals } from '../main/modules/agent-control/maintenance/crystallize-gate'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')

function gateSignals(over: Partial<CrystallizeSignals> = {}): CrystallizeSignals {
  return {
    lastRunAt: '2026-06-12T11:00:00.000Z',
    newCheckInsWithLearning: 0, newConversationTurns: 0, cardWritesSinceLast: 0,
    memoryFileMtimeChanged: false, forced: false,
    ...over,
  }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-c3-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

const EMPTY_SIGNALS = { learningSummaries: [], checkinSummaries: [], stagedCards: [] }

test('gate skip → ZERO llm calls, breadcrumb only', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    let called = 0
    const report = await runMaintenanceLlmRound({
      signals: gateSignals(), now: NOW,
      store: null as never,
      collect: () => EMPTY_SIGNALS,
      llm: async () => { called += 1; return '[]' },
    })
    assert.equal(report.decision, 'skip')
    assert.equal(report.llmCalls, 0)
    assert.equal(called, 0, 'gate skip must not start the LLM')
    assert.ok(events.some((event) => event.metric === 'maintenance_audit'))
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('fixed signal set → expected staged card ops; bad ops rejected; active cannot be minted', async () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const report = await runMaintenanceLlmRound({
      signals: gateSignals({ forced: true }), now: NOW,
      store,
      collect: () => ({
        learningSummaries: ['小红书脚本检测严格，逐张点开更稳'],
        checkinSummaries: ['采集任务 degraded：判据未满足'],
        stagedCards: [],
      }),
      llm: async (prompt) => {
        assert.ok(prompt.includes('小红书脚本检测严格'), 'signals reach the prompt as summaries')
        return JSON.stringify([
          { relPath: 'knowledge/xhs-script-detection.md', title: '小红书脚本检测', description: '逐张点开更稳', confidence: 'M', tag: 'knowledge', body: '小红书风控严格，参考 [[browser-discipline]]。' },
          { relPath: '../escape.md', title: '越权', description: 'x', confidence: 'M', tag: 'knowledge', body: 'x' },     // path guard → rejected
          { relPath: 'knowledge/bad-conf.md', title: 'x', description: 'x', confidence: 'ULTRA', tag: 'knowledge', body: 'x' }, // bad confidence → rejected
        ])
      },
    })
    assert.equal(report.decision, 'run')
    assert.equal(report.llmCalls, 1)
    assert.equal(report.applied, 1)
    assert.equal(report.rejected, 2)
    assert.equal(report.terminal, 'completed')
    const written = readFileSync(join(root, 'knowledge', 'xhs-script-detection.md'), 'utf-8')
    assert.ok(written.includes('status: staged'), 'LLM cards are FORCED staged')
    assert.ok(!existsSync(join(root, '..', 'escape.md')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('empty round exits clean: [] from the LLM applies nothing and reports zero', async () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const report = await runMaintenanceLlmRound({
      signals: gateSignals({ forced: true }), now: NOW, store,
      collect: () => EMPTY_SIGNALS,
      llm: async () => '[]',
    })
    assert.equal(report.applied, 0)
    assert.equal(report.rejected, 0)
    assert.equal(report.terminal, 'completed')
    // prose instead of JSON is a rejected op, never a crash
    assert.deepEqual(parseMaintenanceOps('我觉得没什么可写的'), { ops: [], rejected: 1 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decay runs on REAL signals: mirror access counts + authored backlinks', async () => {
  const root = makeRoot()
  try {
    const card = (title: string, created: string, body: string) =>
      ['---', `title: ${title}`, 'description: 描述', 'confidence: M', 'tag: knowledge',
        `created: ${created}`, 'status: active', '---', body].join('\n')
    // stale + no backlinks + zero access → demote; linked one stays
    writeFileSync(join(root, 'knowledge', 'stale.md'), card('陈旧卡', '2026-01-01', '没人链我'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'linked.md'), card('被链卡', '2026-01-01', '正文'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'linker.md'), card('链接者', '2026-06-01', '参考 [[linked]]'), 'utf-8')

    const store = new BeliefCardStore({ memoryRoot: root })
    const signals = collectBeliefDecaySignals(store, () => ({ accessCount: 0, wasUsefulCount: 0 }), NOW)
    const stale = signals.find((item) => item.relPath === 'knowledge/stale.md')
    const linked = signals.find((item) => item.relPath === 'knowledge/linked.md')
    assert.equal(stale?.backlinksCount, 0)
    assert.equal(linked?.backlinksCount, 1, 'authored [[linked]] counts as a real backlink')

    const ops: string[] = []
    const report = await runMaintenanceLlmRound({
      signals: gateSignals({ forced: true }), now: NOW, store,
      collect: () => EMPTY_SIGNALS,
      llm: async () => '[]',
      collectDecaySignals: () => signals,
      decayEffectors: {
        setConfidence: (relPath, confidence) => ops.push(`set:${relPath}:${confidence}`),
        markDecayed: (relPath) => ops.push(`mark:${relPath}`),
        deleteCard: (relPath) => ops.push(`delete:${relPath}`),
      },
    })
    assert.equal(report.decay?.demoted, 1, 'stale unlinked card demotes')
    assert.deepEqual(ops, ['set:knowledge/stale.md:L'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancellation flows through the pinned runner abort channel', async () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const controller = new AbortController()
    controller.abort()
    const report = await runMaintenanceLlmRound({
      signals: gateSignals({ forced: true }), now: NOW, store,
      collect: () => EMPTY_SIGNALS,
      llm: async () => '[]',
      abortSignal: controller.signal,
    })
    assert.equal(report.decision, 'run')
    assert.equal(report.terminal, 'cancelled', 'pre-aborted signal closes through the runner, not an exception')
    assert.equal(report.llmCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('signal rendering truncates to summaries — never full text', () => {
  const text = renderMaintenanceSignals({
    learningSummaries: ['长'.repeat(500)],
    checkinSummaries: [],
    stagedCards: [],
  })
  assert.ok(text.length < 500, 'summaries are clipped (摘要不全文)')
})
