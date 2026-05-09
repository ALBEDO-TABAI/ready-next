/**
 * Stage R W1.6 — task-type-resolver routing smoke for research domain.
 *
 * Asserts that an IntentClassification with primaryDomain='research'
 * resolves to taskType='research' / executionChain='domain_executor' /
 * preferredExecutor='research'.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveTaskType } from '../main/modules/agent-control/task-type-resolver'

test('resolveTaskType routes primaryDomain="research" to research task type', () => {
  const result = resolveTaskType({
    intent: {
      primaryDomain: 'research',
      mentionedDomains: ['research'],
      excludedDomains: [],
      objectSignals: ['research-object'],
      actionSignals: ['research-action'],
      crossDomain: false,
      confidence: 'high',
    },
    envelope: {
      primaryInstruction: '研究一下 deer-flow 项目',
      pureUserText: '研究一下 deer-flow 项目',
      environmentHints: { hasAttachments: false } as never,
    } as never,
    capabilities: {
      environment: { browserHostAvailable: false, feishuConnected: false } as never,
    } as never,
  })

  assert.equal(result.taskType, 'research')
  assert.equal(result.executionChain, 'domain_executor')
  assert.equal(result.preferredExecutor, 'research')
  assert.equal(result.requiresPlanner, false)
})
