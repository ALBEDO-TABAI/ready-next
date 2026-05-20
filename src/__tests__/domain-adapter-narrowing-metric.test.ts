import assert from 'node:assert/strict'
import test from 'node:test'

import { logPrefixNarrowing } from '../main/modules/agent-control/domain-adapters/domain-adapter'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

// Audit found `[domain_adapter_prefix_narrowing] domain=skill inputCount=17
// outputCount=10 droppedSample=file_search,file_locate` in directchat.log but
// no observability metric — dashboards had no signal of how often narrowing
// drops tools. These tests pin the contract:
//   1. When narrowing drops at least one tool → emit
//      `domain_tool_narrowing_applied` with { domain, droppedCount, droppedSample }
//      AFTER the existing host.log line (still preserved).
//   2. When narrowing drops nothing (all tools kept, or no input) → no metric;
//      only the existing log line.

const SKILL_TOOL_PREFIXES = ['skill_', 'memory_', 'session_']

test('logPrefixNarrowing emits domain_tool_narrowing_applied when tools were dropped', () => {
  const lines: string[] = []
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { events.push(e) })
  try {
    const input = [
      'skill_get_state',
      'memory_save',
      'document_open_tab',
      'browser_click',
      'rss_list',
      'file_search',
    ]
    const narrowed = ['skill_get_state', 'memory_save']
    logPrefixNarrowing(
      (m) => lines.push(m),
      'skill',
      input,
      narrowed,
      SKILL_TOOL_PREFIXES,
    )
    // host.log line still emitted exactly once.
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\[domain_adapter_prefix_narrowing\]/)
    // Metric emitted exactly once with the expected name + payload.
    const narrowingEvents = events.filter((e) => e.metric === TOOL_ERROR_METRICS.domainToolNarrowingApplied)
    assert.equal(narrowingEvents.length, 1)
    const payload = narrowingEvents[0]
    assert.equal(payload.metric, 'domain_tool_narrowing_applied')
    assert.equal(payload.domain, 'skill')
    assert.equal(payload.droppedCount, 4)
    assert.deepEqual(payload.droppedSample, ['document_open_tab', 'browser_click', 'rss_list'])
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('logPrefixNarrowing does NOT emit metric when every input tool was kept', () => {
  const lines: string[] = []
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { events.push(e) })
  try {
    const input = ['skill_get_state', 'memory_save', 'session_recall']
    const narrowed = [...input]
    logPrefixNarrowing(
      (m) => lines.push(m),
      'skill',
      input,
      narrowed,
      SKILL_TOOL_PREFIXES,
    )
    // Only the existing log call — no metric emit.
    assert.equal(lines.length, 1)
    const narrowingEvents = events.filter((e) => e.metric === TOOL_ERROR_METRICS.domainToolNarrowingApplied)
    assert.equal(narrowingEvents.length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('logPrefixNarrowing does NOT emit metric when input is null/empty (pass-through)', () => {
  const lines: string[] = []
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => { events.push(e) })
  try {
    logPrefixNarrowing(
      (m) => lines.push(m),
      'skill',
      null,
      null,
      SKILL_TOOL_PREFIXES,
    )
    assert.equal(lines.length, 1)
    const narrowingEvents = events.filter((e) => e.metric === TOOL_ERROR_METRICS.domainToolNarrowingApplied)
    assert.equal(narrowingEvents.length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})
