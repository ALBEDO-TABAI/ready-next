import { describe, it } from 'node:test'
import assert from 'node:assert'

import { ReflectionService } from '../main/modules/agent-control/reflection-service'

function createMemoryRepositoryStub() {
  const created: Array<Record<string, unknown>> = []
  const existingByCategory = new Map<string, Array<Record<string, unknown>>>()

  return {
    created,
    existingByCategory,
    async createMemory(entry: Record<string, unknown>) {
      const id = `mem-${created.length + 1}`
      const record = { id, ...entry }
      created.push(record)
      const key = `${entry.userId || 'global'}:${entry.category || 'unknown'}`
      const existing = existingByCategory.get(key) || []
      existing.push(record)
      existingByCategory.set(key, existing)
      return record
    },
    async queryMemories(filters: Record<string, unknown>) {
      const key = `${filters.userId || 'global'}:${filters.category || 'unknown'}`
      return existingByCategory.get(key) || []
    }
  }
}

describe('ReflectionService', () => {
  it('only stores conservative user preferences and summaries', async () => {
    const memoryRepository = createMemoryRepositoryStub()
    const knowledge = new Map<string, string>()
    const service = new ReflectionService({
      memoryRepository: memoryRepository as never,
      knowledgeRepository: {
        set: async (key: string, value: string) => {
          knowledge.set(key, value)
        },
        get: async (key: string) => knowledge.get(key) || null
      },
      llmProvider: async () =>
        JSON.stringify({
          globalFacts: [{ title: 'Project Stack', content: 'React 19 + Electron' }],
          userPreferences: [
            { title: 'Communication Style', content: 'User prefers concise answers' }
          ],
          sessionSummary: '整理了一版任务执行方案。'
        })
    })

    const result = await service.reflectOnConversation({
      scope: {
        id: 'scope-1',
        agent: 'butler',
        userId: 'default-user',
        title: '新对话',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'thread-1',
        meta: {},
        createdAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T10:00:00.000Z'
      },
      messages: [
        { role: 'user', content: '请之后都直接一点。' },
        { role: 'assistant', content: '好的。' }
      ],
      usedTools: ['browser.open'],
      success: true
    })

    assert.strictEqual(memoryRepository.created.length, 2)
    assert.deepStrictEqual(
      memoryRepository.created.map((item) => item.category),
      ['user_preference', 'summary']
    )
    assert.deepStrictEqual(
      memoryRepository.created.map((item) => item.sourceType),
      ['resident_user', 'scope_memory']
    )
    assert.strictEqual(result.memoryCapture?.items.length, 2)
    assert.ok(result.memoryCapture?.items.every((item) => item.category !== 'global_fact'))
    assert.deepStrictEqual(
      result.memoryCapture?.items.map((item) => item.sourceType),
      ['resident_user', 'scope_memory']
    )
  })

  it('deduplicates repeated automatic preferences for the same user', async () => {
    const memoryRepository = createMemoryRepositoryStub()
    const knowledge = new Map<string, string>()
    const existingKey = 'pref-existing'
    knowledge.set(existingKey, 'User prefers concise answers')
    memoryRepository.existingByCategory.set('default-user:user_preference', [
      {
        id: 'mem-existing',
        userId: 'default-user',
        category: 'user_preference',
        title: 'Communication Style',
        summary: 'User prefers concise answers',
        contentKey: existingKey
      }
    ])

    const service = new ReflectionService({
      memoryRepository: memoryRepository as never,
      knowledgeRepository: {
        set: async (key: string, value: string) => {
          knowledge.set(key, value)
        },
        get: async (key: string) => knowledge.get(key) || null
      },
      llmProvider: async () =>
        JSON.stringify({
          globalFacts: [],
          userPreferences: [
            { title: 'Communication Style', content: 'User prefers concise answers' }
          ],
          sessionSummary: ''
        })
    })

    const result = await service.reflectOnConversation({
      scope: {
        id: 'scope-1',
        agent: 'butler',
        userId: 'default-user',
        title: '新对话',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'thread-1',
        meta: {},
        createdAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T10:00:00.000Z'
      },
      messages: [
        { role: 'user', content: '请之后都直接一点。' },
        { role: 'assistant', content: '好的。' }
      ],
      usedTools: [],
      success: true
    })

    assert.strictEqual(memoryRepository.created.length, 0)
    assert.deepStrictEqual(result.memoryCapture?.items || [], [])
  })
})
