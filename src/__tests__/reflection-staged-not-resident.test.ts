import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { ReflectionService } from '../main/modules/agent-control/reflection-service'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import type { CasMergeReport, PictureObservation } from '../main/modules/agent-control/maintenance/cas-merge'

function createMemoryRepositoryStub() {
  const created: Array<Record<string, unknown>> = []
  return {
    created,
    async createMemory(entry: Record<string, unknown>) {
      const record = { id: `mem-${created.length + 1}`, ...entry }
      created.push(record)
      return record
    },
    async queryMemories() {
      return []
    },
  }
}

function scope() {
  return {
    id: 'scope-reflection',
    agent: 'butler',
    userId: 'default-user',
    title: '新对话',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: 'thread-1',
    meta: {},
    createdAt: '2026-06-20T08:00:00.000Z',
    updatedAt: '2026-06-20T08:00:00.000Z',
  }
}

afterEach(() => {
  __setMetricSinkForTests(null)
})

describe('ReflectionService staged/CAS discipline', () => {
  it('routes user preferences through CAS and never writes resident or scope memories', async () => {
    const events: AgentMetricEvent[] = []
    __setMetricSinkForTests((event) => events.push(event))
    const memoryRepository = createMemoryRepositoryStub()
    const casCalls: Array<{ userId: string; observations: PictureObservation[] }> = []
    const service = new ReflectionService({
      memoryRepository: memoryRepository as never,
      pictureCasMerge: ({ userId, observations }): CasMergeReport => {
        casCalls.push({ userId, observations })
        return {
          decision: 'merged',
          reason: 'cas_ok',
          accepted: observations.length,
          rejected: 0,
          addedCount: 1,
          droppedCount: 0,
          mirrorSynced: false,
        }
      },
      llmProvider: async () =>
        JSON.stringify({
          globalFacts: [{ title: 'Stack', content: 'Project-only fact' }],
          userPreferences: [
            { title: 'Communication Style', content: 'User prefers concise answers' },
          ],
          sessionSummary: '整理了一版任务执行方案。',
        }),
    })

    const result = await service.reflectOnConversation({
      scope: scope(),
      messages: [
        { role: 'user', content: '请之后都直接一点。' },
        { role: 'assistant', content: '好的。' },
      ],
      usedTools: ['browser.open'],
      success: true,
    })

    assert.equal(memoryRepository.created.length, 0, 'reflection must not create resident_user/scope_memory rows')
    assert.equal(casCalls.length, 1)
    assert.equal(casCalls[0]?.userId, 'default-user')
    assert.equal(casCalls[0]?.observations[0]?.kind, 'communication_style')
    assert.match(casCalls[0]?.observations[0]?.text || '', /concise/)
    assert.equal(result.memoryCapture ?? null, null, 'old memoryCapture UI contract must not be emitted for CAS reflection')
    assert.equal(result.sessionSummary, '整理了一版任务执行方案。')
    const outcome = events.filter((event) => event.metric === 'reflection_outcome')
    assert.equal(outcome.length, 1)
    assert.equal(outcome[0]?.decision, 'cas_merged')
    assert.equal(outcome[0]?.scopeId, 'scope-reflection')
    assert.equal(outcome[0]?.agent, 'butler')
  })

  it('records provider failures as reflection_outcome without throwing or writing memory', async () => {
    const events: AgentMetricEvent[] = []
    __setMetricSinkForTests((event) => events.push(event))
    const memoryRepository = createMemoryRepositoryStub()
    const service = new ReflectionService({
      memoryRepository: memoryRepository as never,
      llmProvider: async () => {
        throw new Error('provider timeout')
      },
    })

    const result = await service.reflectOnConversation({
      scope: scope(),
      messages: [
        { role: 'user', content: '请之后都直接一点。' },
        { role: 'assistant', content: '好的。' },
      ],
      usedTools: [],
      success: true,
    })

    assert.equal(memoryRepository.created.length, 0)
    assert.equal(result.memoryCapture ?? null, null)
    const outcome = events.filter((event) => event.metric === 'reflection_outcome')
    assert.equal(outcome.length, 1)
    assert.equal(outcome[0]?.decision, 'error')
    assert.match(String(outcome[0]?.reason || ''), /provider timeout/)
  })

  it('records short conversations as a skip outcome', async () => {
    const events: AgentMetricEvent[] = []
    __setMetricSinkForTests((event) => events.push(event))
    const service = new ReflectionService({
      memoryRepository: createMemoryRepositoryStub() as never,
    })

    const result = await service.reflectOnConversation({
      scope: scope(),
      messages: [{ role: 'user', content: '短句' }],
      usedTools: [],
      success: true,
    })

    assert.equal(result.memoryCapture ?? null, null)
    const outcome = events.filter((event) => event.metric === 'reflection_outcome')
    assert.equal(outcome.length, 1)
    assert.equal(outcome[0]?.decision, 'skip')
    assert.equal(outcome[0]?.reason, 'too_short')
  })
})
