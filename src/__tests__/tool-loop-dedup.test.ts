import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  countToolRepetitions,
  computeBudgetWarningThreshold,
  shouldInjectBudgetWarning,
} from '../main/modules/agent-control/turn-engine'

// skill-resume plan C1 + C3 — pure helpers extracted from the tool loop:
//
//  - countToolRepetitions(ring): for the LAST entry in the ring buffer,
//    counts how many identical (name, argsHash) entries appear. Caller fires
//    intervention when count >= threshold (default 3).
//
//  - computeBudgetWarningThreshold(maxIter): returns iteration count at which
//    a "70% used, please summarize" warning should fire once.

describe('countToolRepetitions (C1 dedup)', () => {
  it('empty ring → 0', () => {
    assert.equal(countToolRepetitions([]), 0)
  })

  it('single entry → 1 (matches itself)', () => {
    assert.equal(countToolRepetitions([{ name: 'skill_rss_list', argsHash: 'h1' }]), 1)
  })

  it('three identical entries (RSS-loop simulation) → 3 (triggers threshold)', () => {
    const ring = [
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
    ]
    assert.equal(countToolRepetitions(ring), 3)
  })

  it('three same-name DIFFERENT args → 1 (legit exploration, no trigger)', () => {
    const ring = [
      { name: 'file_search', argsHash: 'h1' },
      { name: 'file_search', argsHash: 'h2' },
      { name: 'file_search', argsHash: 'h3' },
    ]
    assert.equal(countToolRepetitions(ring), 1, 'last entry only matches itself')
  })

  it('mixed: 2 same + 1 other, last is the same → 2 (sub-threshold)', () => {
    const ring = [
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'memory_search', argsHash: 'm1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
    ]
    assert.equal(countToolRepetitions(ring), 2)
  })

  it('full 5-buffer with 4 identical → 4 (well over threshold)', () => {
    const ring = [
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'memory_search', argsHash: 'm1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
      { name: 'skill_rss_list', argsHash: 'h1' },
    ]
    assert.equal(countToolRepetitions(ring), 4)
  })
})

describe('computeBudgetWarningThreshold (C3 70% warning)', () => {
  it('multi_step_task budget (40) → 28', () => {
    assert.equal(computeBudgetWarningThreshold(40), 28)
  })

  it('short_task budget (24) → 16 (floor of 16.8)', () => {
    assert.equal(computeBudgetWarningThreshold(24), 16)
  })

  it('media_task budget (60) → 42', () => {
    assert.equal(computeBudgetWarningThreshold(60), 42)
  })

  it('direct_answer budget (8) → 5 (floor of 5.6)', () => {
    assert.equal(computeBudgetWarningThreshold(8), 5)
  })

  it('tiny budget (1) → 1 (min-1 floor; warning fires same iter as cap)', () => {
    assert.equal(computeBudgetWarningThreshold(1), 1)
  })

  it('zero/negative budget → 1 (defensive floor)', () => {
    assert.equal(computeBudgetWarningThreshold(0), 1)
    assert.equal(computeBudgetWarningThreshold(-5), 1)
  })
})

describe('shouldInjectBudgetWarning', () => {
  it('suppresses the 70% warning for the first model request after a long typed skill action returns', () => {
    assert.equal(shouldInjectBudgetWarning({
      warned: false,
      iteration: 29,
      warningThreshold: 28,
      lastLongTypedSkillActionIteration: 28,
    }), false)
  })

  it('allows the 70% warning after the post-action grace request has passed', () => {
    assert.equal(shouldInjectBudgetWarning({
      warned: false,
      iteration: 30,
      warningThreshold: 28,
      lastLongTypedSkillActionIteration: 28,
    }), true)
  })
})

describe('long skill action detection', () => {
  it('is based on tool timeout metadata instead of a specific skill/action name', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: turn-engine long-action helper wiring currently lacks an isolated behavior harness
    const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'), 'utf8')
    const start = source.indexOf('function isLongTypedSkillActionName')
    const end = source.indexOf('function hasLongTypedSkillAction', start)
    const helperSource = source.slice(start, end)

    assert.match(helperSource, /executionTimeoutMs/)
    assert.doesNotMatch(helperSource, /video_expert/)
    assert.doesNotMatch(helperSource, /video-expert-analyzer/)
  })
})
