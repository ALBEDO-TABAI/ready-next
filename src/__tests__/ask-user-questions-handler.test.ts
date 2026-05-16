/**
 * Behavior tests for `executeAskUserQuestions`.
 *
 * Pure module — uses injected store / emitter / persistCardPending so no
 * electron / SQLite required. Covers:
 *   - happy path: emits event, awaits resolve, returns shaped tool output
 *   - schema rejection: 6 questions → input_validation
 *   - business rule: single_choice without options → input_validation
 *   - single-pending invariant: second call with same sessionId → overlapping_card
 *   - timeout: store rejects with errorKind=timeout
 *   - abort: AbortController triggers errorKind=aborted
 *   - persist failure: thrown error propagated as errorKind=persistence_failed
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  executeAskUserQuestions,
  type AskUserQuestionsArgs,
  type AskUserQuestionsCardEvent,
} from '../main/modules/tools/builtins/ask-user-questions'
import { AskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

function makeArgs(overrides: Partial<AskUserQuestionsArgs['questions'][number]>[] = []): AskUserQuestionsArgs {
  return {
    questions: overrides.length > 0
      ? overrides.map((o, i) => ({
          id: o.id ?? `q${i + 1}`,
          question: o.question ?? `Question ${i + 1}`,
          kind: o.kind ?? 'free_text',
          ...(o.options !== undefined ? { options: o.options } : {}),
          ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {}),
          ...(o.required !== undefined ? { required: o.required } : {}),
        }))
      : [{ id: 'q1', question: 'Single q', kind: 'free_text' }],
  }
}

test('happy path: emits push event, persists, awaits resolver, returns shaped output', async () => {
  const store = new AskUserQuestionsStore()
  let emitted: AskUserQuestionsCardEvent | null = null
  let persisted: { cardId: string; questions: unknown[] } | null = null

  const promise = executeAskUserQuestions(
    makeArgs([
      { id: 'q1', question: 'Pick one', kind: 'single_choice', options: ['A', 'B'] },
      { id: 'q2', question: 'Pick many', kind: 'multi_choice', options: ['X', 'Y', 'Z'] },
      { id: 'q3', question: 'Tell me', kind: 'free_text', placeholder: 'free text' },
    ]),
    {
      sessionId: 'session-X',
      conversationId: 'conv-X',
      store,
      emitAskUserQuestionsCard: (event) => { emitted = event },
      persistCardPending: (args) => {
        persisted = { cardId: args.cardId, questions: args.questions }
      },
    },
  )

  // After yielding to the microtask queue the emitter must have fired and the
  // store should hold the record waiting on its resolver.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const ev = emitted as AskUserQuestionsCardEvent | null
  assert.ok(ev, 'emitter was not called')
  assert.equal(ev?.sessionId, 'session-X')
  assert.equal(ev?.questions.length, 3)
  assert.ok(persisted, 'persistor was not called')
  assert.equal(store.size(), 1)
  const pendingCardId = ev!.cardId

  // Resolve via the store the same way the IPC submit handler would.
  store.resolve(pendingCardId, {
    answers: [
      { id: 'q1', answer: 'A' },
      { id: 'q2', answer: ['X', 'Y'] },
      { id: 'q3', answer: 'free text answer' },
    ],
    answeredAt: 7777,
  })

  const result = await promise
  assert.equal(result.shape, 'json')
  const data = result.data as Record<string, unknown>
  assert.equal(data.cardId, pendingCardId)
  assert.equal(data.answeredAt, 7777)
  const answers = data.answers as Array<{ id: string; question: string; kind: string; answer: unknown }>
  assert.equal(answers.length, 3)
  assert.equal(answers[0].kind, 'single_choice')
  assert.equal(answers[0].answer, 'A')
  assert.deepEqual(answers[1].answer, ['X', 'Y'])
  // Markdown summary must include question count + per-question lines.
  assert.match(result.text, /用户回答了 3\/3 个问题/)
  assert.match(result.text, /Pick one/)
})

test('schema rejection: 6 questions exceeds .max(5)', async () => {
  const store = new AskUserQuestionsStore()
  const args: AskUserQuestionsArgs = {
    questions: Array.from({ length: 6 }, (_, i) => ({
      id: `q${i + 1}`,
      question: `q ${i + 1}`,
      kind: 'free_text' as const,
    })),
  }
  await assert.rejects(
    executeAskUserQuestions(args, { store }),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'input_validation',
  )
})

test('business rule: single_choice without options is rejected as input_validation', async () => {
  const store = new AskUserQuestionsStore()
  await assert.rejects(
    executeAskUserQuestions(
      {
        questions: [
          { id: 'q1', question: 'choose', kind: 'single_choice' },
        ],
      },
      { store },
    ),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'input_validation',
  )
})

test('business rule: free_text with options is rejected as input_validation', async () => {
  const store = new AskUserQuestionsStore()
  await assert.rejects(
    executeAskUserQuestions(
      {
        questions: [
          { id: 'q1', question: 'free', kind: 'free_text', options: ['bad'] },
        ],
      },
      { store },
    ),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'input_validation',
  )
})

test('single-pending invariant: second call for same session returns overlapping_card', async () => {
  const store = new AskUserQuestionsStore()
  const first = executeAskUserQuestions(makeArgs(), {
    sessionId: 'sess-1',
    store,
    emitAskUserQuestionsCard: () => {},
    persistCardPending: () => {},
  })
  // Let the first one register before we fire the second.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await assert.rejects(
    executeAskUserQuestions(makeArgs(), {
      sessionId: 'sess-1',
      store,
      emitAskUserQuestionsCard: () => {},
      persistCardPending: () => {},
    }),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'overlapping_card',
  )
  // Drain the first one so the test doesn't leak a never-resolving Promise.
  const list = store.list()
  store.resolve(list[0].cardId, { answers: [], answeredAt: 0 })
  await first
})

test('timeout: handler rejects with errorKind=timeout when no answer arrives', async () => {
  const store = new AskUserQuestionsStore()
  await assert.rejects(
    executeAskUserQuestions(makeArgs(), {
      store,
      emitAskUserQuestionsCard: () => {},
      persistCardPending: () => {},
      timeoutMs: 5,
    }),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'timeout',
  )
})

test('abort: AbortController triggers errorKind=aborted', async () => {
  const store = new AskUserQuestionsStore()
  const ctrl = new AbortController()
  const promise = executeAskUserQuestions(makeArgs(), {
    store,
    signal: ctrl.signal,
    emitAskUserQuestionsCard: () => {},
    persistCardPending: () => {},
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  ctrl.abort()
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'aborted',
  )
})

test('persist failure surfaces as errorKind=persistence_failed without registering the record', async () => {
  const store = new AskUserQuestionsStore()
  let emitterFired = false
  await assert.rejects(
    executeAskUserQuestions(makeArgs(), {
      store,
      emitAskUserQuestionsCard: () => { emitterFired = true },
      persistCardPending: () => { throw new Error('disk full') },
    }),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'persistence_failed',
  )
  // Critical contract: if persist throws, the emitter must NOT have fired
  // and the store must NOT carry an orphan record.
  assert.equal(emitterFired, false, 'emitter must not fire when persist fails')
  assert.equal(store.size(), 0, 'store must not retain a record when persist fails')
})
