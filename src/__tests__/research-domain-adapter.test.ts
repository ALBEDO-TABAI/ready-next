/**
 * Stage R W1.6 — ResearchDomainAdapter behavior smoke test.
 *
 * Asserts shouldHandle correctly identifies research-routed turns and
 * rejects non-research routes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ResearchDomainAdapter } from '../main/modules/agent-control/research-domain-adapter'

test('ResearchDomainAdapter.shouldHandle returns true for taskType research', () => {
  const adapter = new ResearchDomainAdapter()
  const ctx = {
    route: {
      taskType: 'research',
      chain: 'domain_executor',
      executor: 'research',
    },
    userText: '研究一下 deer-flow',
    hasTools: true,
    executionIntentContext: {},
  } as never
  assert.equal(adapter.shouldHandle(ctx), true)
})

test('ResearchDomainAdapter.shouldHandle returns false for non-research route', () => {
  const adapter = new ResearchDomainAdapter()
  const ctx = {
    route: { taskType: 'short_task', chain: 'tool_loop', executor: 'browser' },
    userText: 'open google.com',
    hasTools: true,
    executionIntentContext: {},
  } as never
  assert.equal(adapter.shouldHandle(ctx), false)
})

test('ResearchDomainAdapter id is stable literal "research"', () => {
  const adapter = new ResearchDomainAdapter()
  assert.equal(adapter.id, 'research')
})
