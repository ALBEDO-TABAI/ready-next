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

test('conversation reset cancels only pending interactions in the exact scope', () => {
  const registry = new InteractionLifecycleRegistry()
  const other = { runId: 'run-other', agentId: 'butler', scopeId: 'scope-other' }
  const phases: string[] = []
  registry.subscribe((event) => phases.push(`${event.scopeId}:${event.phase}:${event.pendingCount}`))
  registry.register({ ...RUN, interactionId: 'takeover-old', type: 'human_takeover' })
  registry.register({ ...RUN, interactionId: 'challenge-old', type: 'page_challenge', timeoutMs: 60_000 })
  registry.register({ ...other, interactionId: 'takeover-other', type: 'human_takeover' })

  assert.equal(registry.cancelScope(RUN.scopeId), 2)
  assert.equal(registry.hasPending(RUN), false)
  assert.equal(registry.hasPending(other), true)
  assert.ok(phases.includes('scope-1:terminated:0'))
  registry.clear()
})

test('settled and cancelled interaction history stays bounded without retaining live records', () => {
  const registry = new InteractionLifecycleRegistry()
  for (let index = 0; index < 10_000; index += 1) {
    const identity = {
      runId: `run-${index}`,
      agentId: 'butler',
      scopeId: `scope-${index}`,
      interactionId: `interaction-${index}`,
      type: 'ask_user' as const,
    }
    assert.equal(registry.register(identity), true)
    if (index % 3 === 0) {
      assert.equal(registry.cancelScope(identity.scopeId), 1)
    } else {
      assert.equal(registry.settle({ ...identity, disposition: index % 2 === 0 ? 'checkpoint' : 'resume_with_result' }), true)
    }
  }

  const state = registry as unknown as {
    records: Map<string, unknown>
    terminalInteractionIds: Set<string>
  }
  assert.equal(state.records.size, 0)
  assert.equal(state.terminalInteractionIds.size, 2_048)
  assert.equal(registry.register({ ...RUN, interactionId: 'interaction-9999', type: 'ask_user' }), false)
})

test('a throwing observer cannot interrupt registration, settlement, or healthy observers', () => {
  const registry = new InteractionLifecycleRegistry()
  const phases: string[] = []
  registry.subscribe(() => { throw new Error('observer failed') })
  registry.subscribe((event) => phases.push(event.phase))

  assert.equal(registry.register({ ...RUN, interactionId: 'observer-isolation', type: 'ask_user' }), true)
  assert.equal(registry.settle({ ...RUN, interactionId: 'observer-isolation', disposition: 'resume_with_result' }), true)
  assert.equal(registry.hasPending(RUN), false)
  assert.deepEqual(phases, ['suspended', 'resumed'])
})

test('a synchronous settlement observer cannot leave an orphan timeout behind', () => {
  const registry = new InteractionLifecycleRegistry()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let scheduled = 0
  let cleared = 0
  const fakeHandle = { unref() {} } as unknown as NodeJS.Timeout
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
    scheduled += 1
    return fakeHandle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    if (handle === fakeHandle) cleared += 1
  }) as typeof clearTimeout
  try {
    registry.subscribe((event) => {
      if (event.phase !== 'suspended') return
      registry.settle({
        ...RUN,
        interactionId: event.interactionId,
        disposition: 'resume_with_result',
      })
    })
    assert.equal(registry.register({
      ...RUN,
      interactionId: 'reentrant-timeout',
      type: 'ask_user',
      timeoutMs: 60_000,
    }), true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }

  assert.equal(scheduled, 1)
  assert.equal(cleared, 1)
  assert.equal(registry.hasPending(RUN), false)
})
