import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  countToolRepetitions,
  computeBudgetWarningThreshold,
  isLongTypedSkillActionName,
  shouldInjectBudgetWarning,
} from '../main/modules/agent-control/turn-engine'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

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
    const restoreLongGenericSkill = installSkillToolDefinitionForTest('skill_generic_long_action', {
      executionTimeoutMs: 30 * 60 * 1000,
    })
    const restoreShortVideoSkill = installSkillToolDefinitionForTest('skill_video_expert_pipeline', {
      executionTimeoutMs: 60 * 1000,
    })
    try {
      assert.equal(isLongTypedSkillActionName('skill_generic_long_action'), true)
      assert.equal(isLongTypedSkillActionName('skill_video_expert_pipeline'), false)
    } finally {
      restoreShortVideoSkill()
      restoreLongGenericSkill()
    }
  })
})

function installSkillToolDefinitionForTest(
  toolName: string,
  overrides: Partial<ToolDefinition>,
): () => void {
  const registry = defaultToolRegistry as unknown as {
    getToolDefinitionForExecution: (name: string) => ToolDefinition | null
  }
  const original = registry.getToolDefinitionForExecution.bind(defaultToolRegistry)
  registry.getToolDefinitionForExecution = (name: string): ToolDefinition | null => {
    const base = original(name)
    if (name !== toolName) return base
    return {
      ...(base || createSkillToolDefinition(toolName)),
      ...overrides,
    }
  }
  return () => {
    registry.getToolDefinitionForExecution = original
  }
}

function createSkillToolDefinition(name: string): ToolDefinition {
  return {
    name,
    groupId: 'skills',
    domain: 'skill',
    kind: 'interactive',
    concurrency: 'serialized',
    interruptBehavior: 'host_managed',
    timeoutProfile: 'skill',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: name,
    schema: null,
    executionVisibility: 'model',
    resultShape: 'projection_patch',
  }
}
