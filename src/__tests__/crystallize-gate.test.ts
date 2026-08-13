/**
 * EP2-C2 — deterministic crystallize gate + v1 round runner (03 §3.2/§6).
 * The gate is pure code (no LLM); skip is legal and leaves an auditable
 * breadcrumb. The v1 round applies ONLY the C1 deterministic plan.
 */

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideCrystallizeRun,
  runCrystallizeRound,
  createCrystallizeEffectors,
  CrystallizeScheduler,
  type CrystallizeSignals,
} from '../main/modules/agent-control/maintenance/crystallize-gate'
import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')

function signals(overrides: Partial<CrystallizeSignals> = {}): CrystallizeSignals {
  return {
    lastRunAt: '2026-06-12T11:00:00.000Z', // 1h ago — inside the 6h interval
    newCheckInsWithLearning: 0,
    newConversationTurns: 0,
    cardWritesSinceLast: 0,
    memoryFileMtimeChanged: false,
    forced: false,
    ...overrides,
  }
}

test('gate matrix: quiet round inside the interval skips; any signal runs', () => {
  assert.equal(decideCrystallizeRun(signals(), NOW).decision, 'skip')
  assert.equal(decideCrystallizeRun(signals({ forced: true }), NOW).decision, 'run')
  assert.equal(decideCrystallizeRun(signals({ lastRunAt: null }), NOW).decision, 'run', 'never ran → run')
  assert.equal(decideCrystallizeRun(signals({ lastRunAt: '2026-06-12T05:00:00.000Z' }), NOW).decision, 'run', 'interval elapsed → run')
  assert.equal(decideCrystallizeRun(signals({ newCheckInsWithLearning: 1 }), NOW).decision, 'run')
  assert.equal(decideCrystallizeRun(signals({ cardWritesSinceLast: 1 }), NOW).decision, 'run')
  assert.equal(decideCrystallizeRun(signals({ memoryFileMtimeChanged: true }), NOW).decision, 'run')
  assert.equal(decideCrystallizeRun(signals({ newConversationTurns: 50 }), NOW).decision, 'run', 'turn threshold reached → run')
  assert.equal(decideCrystallizeRun(signals({ newConversationTurns: 3 }), NOW).decision, 'skip', 'few turns alone stay below threshold')
})

test('skip leaves a single auditable breadcrumb and touches nothing', async () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const result = await runCrystallizeRound({
      signals: signals(),
      now: NOW,
      store: null as never, // skip path must not touch the store at all
      effectors: null as never,
    })
    assert.equal(result.decision, 'skip')
    const breadcrumbs = events.filter((event) => event.metric === 'maintenance_audit')
    assert.equal(breadcrumbs.length, 1)
    assert.equal((breadcrumbs[0] as unknown as { decision: string }).decision, 'skip')
    assert.ok((breadcrumbs[0] as unknown as { reason: string }).reason)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('scheduler cancels the old startup round and start stays idempotent', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let calls = 0
  const scheduler = new CrystallizeScheduler(async () => { calls += 1 })
  try {
    scheduler.start({ startupDelayMs: 90_000 })
    scheduler.stop()
    mock.timers.tick(90_000)
    await Promise.resolve()
    assert.equal(calls, 0)

    scheduler.start({ startupDelayMs: 90_000 })
    scheduler.start({ startupDelayMs: 90_000 })
    mock.timers.tick(90_000)
    await Promise.resolve()
    assert.equal(calls, 1)
  } finally {
    scheduler.stop()
    mock.timers.reset()
  }
})

test('scheduler contains a rejected startup round', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const errors: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  const scheduler = new CrystallizeScheduler(async () => {
    throw new Error('startup_round_rejected')
  })
  try {
    scheduler.start({ startupDelayMs: 1 })
    mock.timers.tick(1)
    await Promise.resolve()
    await Promise.resolve()
    assert.match(errors.join('\n'), /startup round failed.*startup_round_rejected/)
  } finally {
    scheduler.stop()
    console.error = originalConsoleError
    mock.timers.reset()
  }
})

function cardText(title: string, status: string, created: string, body: string): string {
  return ['---', `title: ${title}`, 'description: 描述', 'confidence: M', 'tag: knowledge',
    `created: ${created}`, `status: ${status}`, '---', body].join('\n')
}

test('run round applies the deterministic C1 plan: backlinks, index, staged expiry, duplicate marks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-c2-'))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
    writeFileSync(join(root, 'knowledge', 'a.md'), cardText('卡A', 'active', '2026-06-01', '关联 [[b]]'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'b.md'), cardText('卡B', 'active', '2026-06-01', '正文'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'old-staged.md'), cardText('过期', 'staged', '2026-05-20', '正文'), 'utf-8')
    writeFileSync(join(root, 'knowledge', 'dup.md'), cardText('卡A', 'active', '2026-06-10', '重复'), 'utf-8')

    const store = new BeliefCardStore({ memoryRoot: root })
    const result = await runCrystallizeRound({
      signals: signals({ forced: true }),
      now: NOW,
      store,
      effectors: createCrystallizeEffectors(store),
    })
    assert.equal(result.decision, 'run')

    assert.ok(readFileSync(join(root, 'knowledge', 'b.md'), 'utf-8').includes('[[a]]'), 'backlinks rewritten')
    assert.ok(existsSync(join(root, 'index.md')), 'index.md written at memory root')
    assert.ok(!existsSync(join(root, 'knowledge', 'old-staged.md')), 'expired staged card deleted')
    const dup = readFileSync(join(root, 'knowledge', 'dup.md'), 'utf-8')
    assert.ok(dup.includes('possible-duplicate-of [[a]]'), 'duplicate marked, not deleted')

    const breadcrumb = events.find((event) => event.metric === 'maintenance_audit') as unknown as {
      decision: string
      report: { backlinksRewritten: number; expiredStagedDeleted: number; duplicatesMarked: number }
    }
    assert.equal(breadcrumb.decision, 'run')
    assert.equal(breadcrumb.report.expiredStagedDeleted, 1)
    assert.equal(breadcrumb.report.duplicatesMarked, 1)
    assert.ok(breadcrumb.report.backlinksRewritten >= 1)

    // second forced round is a no-op apart from the breadcrumb (idempotence)
    const second = await runCrystallizeRound({
      signals: signals({ forced: true }),
      now: NOW,
      store,
      effectors: createCrystallizeEffectors(store),
    })
    assert.equal(second.decision, 'run')
    assert.equal(second.report?.backlinksRewritten, 0)
    assert.equal(second.report?.expiredStagedDeleted, 0)
    assert.equal(second.report?.duplicatesMarked, 0)
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})
