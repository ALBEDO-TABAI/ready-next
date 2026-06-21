import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HANDOFF_ADOPT_OPTION,
  HANDOFF_NEW_SESSION_OPTION,
  HANDOFF_QUESTION_ID,
  HANDOFF_REJECT_OPTION,
  runHandoffProposal,
} from '../main/modules/agent-control/agents/handoff-proposal'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'

const VERBATIM = '  请把这个视觉调研任务交给采集专项 agent，明早继续。  '
const CONTEXT_REFS = ['task:visual-1', 'card:xhs-brief']

function activeAgent() {
  return {
    id: 'collector',
    name: '采集手',
    charter: '负责小红书与微博采集',
    personaRef: null,
    status: 'active',
    createdAt: '2026-06-12',
  } as const
}

test('handoff proposal hides the unwired new-session option from the production card', async () => {
  const store = new AskUserQuestionsStore()
  let emittedOptions: string[] | null = null

  const outcomePromise = runHandoffProposal(
    { targetAgentId: 'collector', reason: '采集专项更对口', userRequestVerbatim: VERBATIM, contextRefs: CONTEXT_REFS },
    {
      getAgent: () => activeAgent(),
      updateTaskOwner: () => undefined,
      sessionId: 'sess-p5b',
      askUserStore: store,
      timeoutMs: 10_000,
      emitCard: (event) => {
        emittedOptions = event.questions[0]?.options ? [...event.questions[0].options] : []
        queueMicrotask(() => store.resolve(event.cardId, {
          answers: [{ id: HANDOFF_QUESTION_ID, answer: HANDOFF_REJECT_OPTION }],
          answeredAt: Date.now(),
        }))
      },
    },
  )

  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'rejected_by_user')
  assert.deepEqual(emittedOptions, [HANDOFF_ADOPT_OPTION, HANDOFF_REJECT_OPTION])
  assert.ok(!emittedOptions?.includes(HANDOFF_NEW_SESSION_OPTION))
})

test('handoff new-session branch remains as a retained asset and preserves verbatim payloads', async () => {
  const store = new AskUserQuestionsStore()
  const outcome = await runHandoffProposal(
    { targetAgentId: 'collector', reason: '采集专项更对口', userRequestVerbatim: VERBATIM, contextRefs: CONTEXT_REFS, taskId: 'task-p5b' },
    {
      getAgent: () => activeAgent(),
      updateTaskOwner: () => { throw new Error('new-session asset branch must not write current owner') },
      sessionId: 'sess-p5b-asset',
      askUserStore: store,
      timeoutMs: 10_000,
      emitCard: (event) => {
        queueMicrotask(() => store.resolve(event.cardId, {
          answers: [{ id: HANDOFF_QUESTION_ID, answer: HANDOFF_NEW_SESSION_OPTION }],
          answeredAt: Date.now(),
        }))
      },
    },
  )

  assert.equal(outcome.kind, 'adopted_new_session')
  if (outcome.kind === 'adopted_new_session') {
    assert.equal(outcome.prefillVerbatim, VERBATIM)
    assert.deepEqual(outcome.contextRefs, CONTEXT_REFS)
    assert.equal(outcome.taskId, 'task-p5b')
  }
})
