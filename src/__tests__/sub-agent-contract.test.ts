import assert from 'node:assert/strict'
import test from 'node:test'

import { createSubAgentCleanupHandle } from '../main/modules/agent-control/sub-agent/sub-agent-cleanup'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import { createEchoSubAgent } from '../main/modules/agent-control/sub-agent/poc/echo-subagent'
import type {
  SubAgentCloseEvent,
  SubAgentEvent,
} from '../main/modules/agent-control/sub-agent/sub-agent-types'

async function collectRun(
  generator: AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>,
): Promise<{ events: SubAgentEvent[]; closeEvent: SubAgentCloseEvent }> {
  const events: SubAgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, closeEvent: next.value }
    events.push(next.value)
  }
}

function makeContext(overrides: Partial<Parameters<typeof runSubAgent>[1]> = {}): Parameters<typeof runSubAgent>[1] {
  return {
    abortSignal: new AbortController().signal,
    cleanup: createSubAgentCleanupHandle(`cleanup-${Math.random()}`),
    ...overrides,
  }
}

test('EchoSubAgent emits runner-framed lifecycle events around behavior progress', async () => {
  const subagent = createEchoSubAgent({
    messages: ['first', 'second'],
    artifactDir: '/tmp/ready-a1-artifacts',
  })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, makeContext()))

  assert.equal(events[0]?.type, 'started')
  assert.equal(events.at(-1)?.type, 'terminal')
  assert.deepEqual(
    events.filter((event) => event.type === 'progress').map((event) => event.message),
    ['first', 'second'],
  )
  assert.equal(closeEvent.state, 'completed')
  assert.equal(closeEvent.terminalReason, 'completed')
  assert.equal(closeEvent.lifecycleId, subagent.lifecycleId)
  assert.equal(closeEvent.artifactDir, '/tmp/ready-a1-artifacts')
  assert.equal((events.at(-1) as Extract<SubAgentEvent, { type: 'terminal' }>).closeEvent, closeEvent)
})

test('EchoSubAgent keeps lifecycle id independent from reusable artifact dir', async () => {
  const artifactDir = '/tmp/ready-a1-reused-artifacts'
  const first = createEchoSubAgent({ messages: [], artifactDir })
  const second = createEchoSubAgent({ messages: [], artifactDir })

  assert.notEqual(first.lifecycleId, second.lifecycleId)
  assert.equal(first.artifactDir, artifactDir)
  assert.equal(second.artifactDir, artifactDir)

  const firstRun = await collectRun(runSubAgent(first, makeContext()))
  const secondRun = await collectRun(runSubAgent(second, makeContext()))

  assert.equal(firstRun.closeEvent.artifactDir, artifactDir)
  assert.equal(secondRun.closeEvent.artifactDir, artifactDir)
  assert.notEqual(firstRun.closeEvent.lifecycleId, secondRun.closeEvent.lifecycleId)
})
