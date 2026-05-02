import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tool-error-metrics'
import { composeSystemReminder } from '../main/modules/agent-control/system-reminder-assembly'
import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminder-registry'

afterEach(() => {
  __setMetricSinkForTests(null)
})

test('compose returns null on empty registry', () => {
  const registry = createSystemReminderRegistry()

  assert.equal(registry.compose(), null)
  assert.equal(composeSystemReminder([]), null)
})

test('compose preserves single entry text', () => {
  const registry = createSystemReminderRegistry()

  registry.register({
    topic: 'budget',
    priority: 60,
    text: 'budget reminder',
  })

  assert.equal(registry.compose(), 'budget reminder')
})

test('compose orders entries by priority desc, then topic id asc', () => {
  const text = composeSystemReminder([
    { topic: 'typed-action-preferred', priority: 30, text: 'typed' },
    { topic: 'missing-input', priority: 60, text: 'missing' },
    { topic: 'budget', priority: 60, text: 'budget' },
    { topic: 'checkpoint', priority: 100, text: 'checkpoint' },
  ])

  assert.equal(text, 'checkpoint\nbudget\nmissing\ntyped')
})

test('compose drops entries listed in another entry conflictsWith with metric', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))

  const text = composeSystemReminder([
    {
      topic: 'budget',
      priority: 60,
      text: 'budget',
      conflictsWith: ['missing-input'],
    },
    {
      topic: 'missing-input',
      priority: 55,
      text: 'missing',
    },
  ])

  assert.equal(text, 'budget')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.metric, TOOL_ERROR_METRICS.systemReminderSuppressedByConflict)
  assert.equal(events[0]?.suppressingTopic, 'budget')
  assert.equal(events[0]?.suppressedTopic, 'missing-input')
})

test('compose applies default conflicts for child-owned suppressing typed-action-preferred', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))

  const text = composeSystemReminder([
    { topic: 'typed-action-preferred', priority: 30, text: 'typed' },
    { topic: 'child-owned', priority: 85, text: 'child' },
  ])

  assert.equal(text, 'child')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.metric, TOOL_ERROR_METRICS.systemReminderSuppressedByConflict)
  assert.equal(events[0]?.suppressingTopic, 'child-owned')
  assert.equal(events[0]?.suppressedTopic, 'typed-action-preferred')
})

test('register same topic twice uses the last registration', () => {
  const registry = createSystemReminderRegistry()

  registry.register({ topic: 'budget', priority: 60, text: 'old budget' })
  registry.register({ topic: 'budget', priority: 60, text: 'new budget' })

  assert.equal(registry.compose(), 'new budget')
})
