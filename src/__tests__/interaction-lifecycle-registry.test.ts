import assert from 'node:assert/strict'
import test from 'node:test'

import { InteractionLifecycleRegistry } from '../main/modules/agent-control/runtime-core/interaction-lifecycle-registry'

const RUN = { runId: 'run-1', agentId: 'butler', scopeId: 'scope-1' }

test('interaction lifecycle resumes only after the last blocker resolves', () => {
  const registry = new InteractionLifecycleRegistry()
  const phases: string[] = []
  registry.subscribe((event) => phases.push(`${event.phase}:${event.pendingCount}`))
  registry.register({ ...RUN, interactionId: 'ask-a', type: 'ask_user' })
  registry.register({ ...RUN, interactionId: 'ask-b', type: 'ask_user_questions' })
  registry.settle({ ...RUN, interactionId: 'ask-a', disposition: 'resume_with_result' })
  assert.equal(registry.hasPending(RUN), true)
  assert.deepEqual(phases, ['suspended:1', 'suspended:2'])
  registry.settle({ ...RUN, interactionId: 'ask-b', disposition: 'resume_with_result' })
  assert.equal(registry.hasPending(RUN), false)
  assert.deepEqual(phases, ['suspended:1', 'suspended:2', 'resumed:0'])
})

test('late or wrong-run answers have zero lifecycle effect', () => {
  const registry = new InteractionLifecycleRegistry()
  registry.register({ ...RUN, interactionId: 'ask-a', type: 'ask_user' })
  assert.equal(registry.settle({ ...RUN, runId: 'wrong-run', interactionId: 'ask-a', disposition: 'resume_with_result' }), false)
  assert.equal(registry.hasPending(RUN), true)
  assert.equal(registry.settle({ ...RUN, interactionId: 'ask-a', disposition: 'resume_with_result' }), true)
  assert.equal(registry.settle({ ...RUN, interactionId: 'ask-a', disposition: 'resume_with_result' }), false)
})

test('checkpoint or terminate settles the whole pending epoch immediately', () => {
  const registry = new InteractionLifecycleRegistry()
  const phases: string[] = []
  registry.subscribe((event) => phases.push(event.phase))
  registry.register({ ...RUN, interactionId: 'ask-a', type: 'ask_user' })
  registry.register({ ...RUN, interactionId: 'confirm-b', type: 'action_confirmation' })
  registry.settle({ ...RUN, interactionId: 'confirm-b', disposition: 'checkpoint' })
  assert.equal(registry.hasPending(RUN), false)
  assert.equal(phases.at(-1), 'checkpointed')
})

test('three consecutive mixed interaction rounds each suspend and resume exactly once', () => {
  const registry = new InteractionLifecycleRegistry()
  const phases: string[] = []
  registry.subscribe((event) => phases.push(`${event.type}:${event.phase}:${event.pendingCount}`))
  const types = ['ask_user_questions', 'action_confirmation', 'handoff'] as const
  for (const [index, type] of types.entries()) {
    const interactionId = `interaction-${index + 1}`
    assert.equal(registry.register({ ...RUN, interactionId, type }), true)
    assert.equal(registry.hasPending(RUN), true)
    assert.equal(registry.settle({ ...RUN, interactionId, disposition: 'resume_with_result' }), true)
    assert.equal(registry.hasPending(RUN), false)
  }
  assert.deepEqual(phases, [
    'ask_user_questions:suspended:1',
    'ask_user_questions:resumed:0',
    'action_confirmation:suspended:1',
    'action_confirmation:resumed:0',
    'handoff:suspended:1',
    'handoff:resumed:0',
  ])
})

test('a resolved page challenge resumes while an expired challenge checkpoints', async () => {
  const registry = new InteractionLifecycleRegistry()
  const phases: string[] = []
  registry.subscribe((event) => phases.push(`${event.interactionId}:${event.phase}`))
  registry.register({ ...RUN, interactionId: 'challenge-resolved', type: 'page_challenge' })
  registry.settle({ ...RUN, interactionId: 'challenge-resolved', disposition: 'resume_with_result' })
  registry.register({
    ...RUN,
    interactionId: 'challenge-expired',
    type: 'page_challenge',
    timeoutMs: 10,
    timeoutDisposition: 'checkpoint',
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(phases, [
    'challenge-resolved:suspended',
    'challenge-resolved:resumed',
    'challenge-expired:suspended',
    'challenge-expired:checkpointed',
  ])
  assert.equal(registry.hasPending(RUN), false)
})
