import { describe, it } from 'node:test'
import assert from 'node:assert'

import { ReflectionService } from '../main/modules/agent-control/reflection-service'
import type { CasMergeReport, PictureObservation } from '../main/modules/agent-control/maintenance/cas-merge'

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
  it('routes conservative user preferences through CAS without resident/scope memory writes', async () => {
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

    assert.strictEqual(memoryRepository.created.length, 0)
    assert.strictEqual(casCalls.length, 1)
    assert.strictEqual(casCalls[0]?.userId, 'default-user')
    assert.strictEqual(casCalls[0]?.observations.length, 1)
    assert.strictEqual(result.memoryCapture ?? null, null)
    assert.deepStrictEqual(result.globalFacts, [])
    assert.strictEqual(result.sessionSummary, '整理了一版任务执行方案。')
  })

  it('lets CAS skip repeated automatic preferences without writing prompt-visible memory', async () => {
    const memoryRepository = createMemoryRepositoryStub()

    const service = new ReflectionService({
      memoryRepository: memoryRepository as never,
      pictureCasMerge: (): CasMergeReport => {
        return {
          decision: 'gate_skip',
          reason: 'all_duplicates',
          accepted: 1,
          rejected: 0,
          addedCount: 0,
          droppedCount: 0,
          mirrorSynced: false,
        }
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
    assert.strictEqual(result.memoryCapture ?? null, null)
  })
})
