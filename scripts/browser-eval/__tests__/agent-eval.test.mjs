// Unit tests for the task-layer runner's pure parts: spend caps, majority vote, aggregation and
// token metering from Codex rollouts. No model, no Electron, no network.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { costOf, createBudget, parsePrices, planEstimate } from '../agent-eval/budget.mjs'
import { aggregate, decide, needsAnotherAttempt, renderMarkdown, summarizeTask } from '../agent-eval/report.mjs'
import { tokensFromCodexHome, tokensFromRolloutText } from '../agent-eval/metrics.mjs'

const attempt = (
  pass,
  extra = {}
) => ({
  pass,
  status: 'completed',
  steps: 10,
  tokens: { total: 1000 },
  durationMs: 60_000,
  interventions: { total: 0 },
  ...extra
})

test('prices: both input and output are required, cached input defaults to input', () => {
  assert.equal(parsePrices({}), null)
  assert.equal(parsePrices({ input: '2' }), null)
  assert.deepEqual(parsePrices({ input: '2', output: '8' }), { input: 2, cachedInput: 2, output: 8 })
  assert.throws(() => parsePrices({ input: '-1', output: '1' }), /invalid price/)
})

test('cost counts cached input at its own price', () => {
  const prices = { input: 2, cachedInput: 0.5, output: 8 }
  assert.equal(
    costOf({ input: 1_000_000, cachedInput: 400_000, output: 100_000 }, prices),
    0.6 * 2 + 0.4 * 0.5 + 0.1 * 8
  )
  assert.equal(costOf({ input: 10 }, null), null)
})

test('budget stops on tokens, cost, attempts, and after an unmetered attempt', () => {
  const tokens = createBudget({ maxTokens: 1500, maxAttempts: 10 })
  assert.equal(tokens.blockReason(), null)
  tokens.record({ total: 1000, input: 900, output: 100 })
  assert.equal(tokens.blockReason(), null)
  tokens.record({ total: 600, input: 500, output: 100 })
  assert.match(tokens.blockReason(), /令牌上限/)

  const cost = createBudget({ maxCostUsd: 1, prices: { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 } })
  cost.record({ total: 2, input: 1, output: 1 })
  assert.match(cost.blockReason(), /费用上限/)

  const attempts = createBudget({ maxAttempts: 1 })
  attempts.record({ total: 1 })
  assert.match(attempts.blockReason(), /尝试上限/)

  const unmetered = createBudget()
  unmetered.record(null)
  assert.match(unmetered.blockReason(), /无法计量/)
  assert.throws(() => createBudget({ maxTokens: 0 }), /invalid budget/)
})

test('plan estimate is attempts × planning tokens', () => {
  assert.equal(planEstimate(4, null).tokens, 1_200_000)
  assert.equal(planEstimate(4, null).costUsd, null)
  assert.ok(planEstimate(4, { input: 1, cachedInput: 1, output: 1 }).costUsd > 0)
})

test('majority of three: decided after two equal results, otherwise needs the third', () => {
  assert.equal(decide([attempt(true), attempt(true)], 3), 'pass')
  assert.equal(decide([attempt(false), attempt(false)], 3), 'fail')
  assert.equal(decide([attempt(true), attempt(false)], 3), null)
  assert.equal(decide([attempt(true), attempt(false), attempt(true)], 3), 'pass')
  assert.equal(needsAnotherAttempt([attempt(true), attempt(true)], 3), false)
  assert.equal(needsAnotherAttempt([attempt(true), attempt(true)], 3, false), true)
  assert.equal(needsAnotherAttempt([attempt(true), attempt(false)], 3), true)
  assert.equal(needsAnotherAttempt([attempt(true), attempt(false), attempt(false)], 3), false)
})

test('task summary averages counted attempts and marks budget-cut tasks undecided', () => {
  const task = { id: 'A1', category: 'A', title: 't' }
  const summary = summarizeTask(task, [attempt(true, { steps: 10 }), attempt(true, { steps: 20 })], 3)
  assert.equal(summary.verdict, 'pass')
  assert.equal(summary.meanSteps, 15)
  assert.equal(summary.meanSeconds, 60)
  assert.equal(summarizeTask(task, [], 3).verdict, 'undecided')
})

test('aggregate reports category rates and the G9 thresholds', () => {
  const tasks = []
  for (const category of ['A', 'B', 'C', 'D']) {
    for (let index = 1; index <= 6; index += 1) {
      tasks.push({ id: `${category}${index}`, category, verdict: category === 'D' && index > 4 ? 'fail' : 'pass' })
    }
  }
  const result = aggregate(tasks)
  assert.equal(result.overall.passed, 22)
  assert.equal(result.categories.D.passed, 4)
  assert.equal(result.g9.overallAtLeast90, true)
  assert.equal(result.g9.everyCategoryAtLeast80, false)
})

test('markdown lists rates, tasks and failed checks', () => {
  const tasks = [
    {
      id: 'A1',
      category: 'A',
      title: 'S2',
      verdict: 'fail',
      passes: 0,
      attempts: 2,
      meanSteps: 3,
      meanTokens: 10,
      meanSeconds: 5,
      meanInterventions: 0
    }
  ]
  const markdown = renderMarkdown({
    date: '2026-11-11',
    config: {
      argv: ['--live'],
      gitHead: 'abc',
      gitDirty: false,
      model: 'p / m',
      window: 'hidden',
      authorizationMode: 'auto',
      repeats: 3,
      earlyStop: true
    },
    budget: {
      limits: { maxTokens: 1, maxTokensPerAttempt: 1, maxCostUsd: 1, maxAttempts: 1 },
      prices: null,
      spent: { attempts: 2, tokens: 20, costUsd: 0, estimatedAttempts: 0 }
    },
    stoppedReason: null,
    aggregate: aggregate(tasks),
    tasks,
    attempts: [{ taskId: 'A1', attempt: 1, pass: false, status: 'completed', checks: [{ id: 'price', pass: false }] }],
  })
  assert.match(markdown, /\| A1 S2 \| fail \| 0\/2 \|/)
  assert.match(markdown, /A1 第 1 次（completed）：price/)
})

test('rollout metering takes the last running total per thread and sums threads', () => {
  const line = (total, input, cached, output) => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: total
        }
      }
    },
  })
  const text = [line(100, 80, 10, 20), '{"type":"response_item"}', line(300, 240, 50, 60), '{"partial": '].join('\n')
  assert.deepEqual(tokensFromRolloutText(text), { input: 240, cachedInput: 50, output: 60, total: 300 })
  assert.equal(tokensFromRolloutText('{"type":"session_meta"}'), null)

  const home = mkdtempSync(join(tmpdir(), 'ready-eval-rollout-'))
  try {
    const day = join(home, 'sessions', '2026', '11', '11')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), `${line(300, 240, 50, 60)}\n`)
    writeFileSync(join(day, 'rollout-b.jsonl'), `${line(50, 40, 0, 10)}\n`)
    writeFileSync(join(day, 'notes.txt'), line(999, 999, 0, 0))
    assert.deepEqual(
      tokensFromCodexHome(home),
      { input: 280, cachedInput: 50, output: 70, total: 350, threads: 2, method: 'codex_rollout' }
    )
    assert.equal(tokensFromCodexHome(join(home, 'missing')), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
