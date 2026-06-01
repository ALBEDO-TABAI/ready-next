import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ReadyAgentOrchestrator,
} from '../main/modules/agent-control/runtime-core/orchestrator'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

test('orchestrator resolves persona prompt when send has no explicit systemPrompt', async () => {
  let resolverAgent: string | null = null
  let capturedInstructions = ''
  const orchestrator = new ReadyAgentOrchestrator({
    agentSdkRuntimeDeps: {
      loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
      domainAdapters: [],
      skillContextOrchestrator: null,
      listToolDefinitions: () => [],
      runAgent: async ({ instructions }) => {
        capturedInstructions = instructions
        return { finalText: 'done' }
      },
    },
  })

  orchestrator.setPersonaResolver(async (agent) => {
    resolverAgent = agent
    return `resolved persona for ${agent}`
  })

  const result = await orchestrator.send('copywriter', 'hello', 'scope-1', 'run-1')

  assert.equal(result.success, true)
  assert.equal(resolverAgent, 'copywriter')
  assert.match(capturedInstructions, /resolved persona for copywriter/)
})

test('orchestrator keeps explicit systemPrompt ahead of persona resolver', async () => {
  let resolverCalls = 0
  let capturedInstructions = ''
  const orchestrator = new ReadyAgentOrchestrator({
    agentSdkRuntimeDeps: {
      loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
      domainAdapters: [],
      skillContextOrchestrator: null,
      listToolDefinitions: () => [],
      runAgent: async ({ instructions }) => {
        capturedInstructions = instructions
        return { finalText: 'done' }
      },
    },
  })

  orchestrator.setPersonaResolver(async () => {
    resolverCalls += 1
    return 'resolved persona'
  })

  const result = await orchestrator.send(
    'butler',
    'hello',
    'scope-2',
    'run-2',
    undefined,
    'explicit prompt',
  )

  assert.equal(result.success, true)
  assert.equal(resolverCalls, 0)
  assert.match(capturedInstructions, /explicit prompt/)
  assert.doesNotMatch(capturedInstructions, /resolved persona/)
})

test('orchestrator marks the session failed when persona resolver throws', async () => {
  const orchestrator = new ReadyAgentOrchestrator({
    agentSdkRuntimeDeps: {
      loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
      domainAdapters: [],
      skillContextOrchestrator: null,
      listToolDefinitions: () => [],
      runAgent: async () => ({ finalText: 'should not run' }),
    },
  })

  orchestrator.setPersonaResolver(async () => {
    throw new Error('resolver failed')
  })

  await assert.rejects(
    () => orchestrator.send('analyst', 'hello', 'scope-3', 'run-3'),
    /resolver failed/,
  )

  const session = orchestrator.listAllSessions().find((item) => item.sessionId === 'scope-3')
  assert.equal(session?.state, 'failed')
  assert.equal(session?.error, 'resolver failed')
})
