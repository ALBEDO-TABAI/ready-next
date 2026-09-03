import assert from 'node:assert/strict'
import test from 'node:test'

import { PetActivityProjectionService } from '../main/modules/pet/pet-activity-projection-service'
import type { PetActivitySnapshot } from '../shared/pet'

const CUTOVER = '2026-08-21T01:00:00.000Z'

function projection(input: {
  taskId: string
  scopeId: string
  status: string
  interactionState?: string
  updatedAt: string
}) {
  return {
    ...input,
    runId: `run-${input.taskId}`,
    interactionState: input.interactionState || 'running',
    taskSummary: input.taskId,
  }
}

function database(input?: {
  seenAt?: Record<string, string | null>
  messages?: Record<string, string | null>
  cutoverAt?: string | null
}) {
  return {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => {
        const scopeId = String(params[0] || '')
        if (sql.includes('WHERE key = ?')) {
          const cutoverAt = input?.cutoverAt === undefined ? CUTOVER : input.cutoverAt
          return cutoverAt ? { value: cutoverAt } : undefined
        }
        if (sql.includes('pet_last_seen_at AS seenAt')) {
          return { messageId: null, seenAt: input?.seenAt?.[scopeId] || null }
        }
        if (sql.includes('FROM chat_messages message')) {
          const messageId = input?.messages?.[scopeId]
          return messageId === null ? undefined : { id: messageId || `assistant-${scopeId}` }
        }
        return undefined
      },
    }),
  } as never
}

function manager(snapshots: PetActivitySnapshot[]) {
  return {
    setActivityRefresh: () => undefined,
    updateActivity: (snapshot: PetActivitySnapshot) => snapshots.push(snapshot),
  } as never
}

test('pet activity projection chooses needs-input before blocked, ready and running across scopes', () => {
  const snapshots: PetActivitySnapshot[] = []
  const rows = [
    projection({ taskId: 'running', scopeId: 'scope-running', status: 'running', updatedAt: '2026-08-21T01:04:00.000Z' }),
    projection({ taskId: 'ready', scopeId: 'scope-ready', status: 'completed', updatedAt: '2026-08-21T01:03:00.000Z' }),
    projection({ taskId: 'blocked', scopeId: 'scope-blocked', status: 'blocked', updatedAt: '2026-08-21T01:02:00.000Z' }),
    projection({ taskId: 'question', scopeId: 'scope-question', status: 'running', interactionState: 'awaiting_confirmation', updatedAt: '2026-08-21T01:01:00.000Z' }),
  ]
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => rows } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'needs_input')
  assert.equal(snapshots[0]?.scopeId, 'scope-question')
  assert.equal(snapshots[0]?.runId, 'run-question')
})

test('pet activity projection suppresses a completed activity at the scope read high-water mark', () => {
  const snapshots: PetActivitySnapshot[] = []
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => [
      projection({ taskId: 'ready', scopeId: 'scope-ready', status: 'completed', updatedAt: '2026-08-21T01:03:00.000Z' }),
    ] } as never,
    database({ seenAt: { 'scope-ready': '2026-08-21T01:03:00.000Z' } }),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'idle')
  assert.equal(snapshots[0]?.busy, false)
})

test('pet activity projection does not surface terminal failures from before the activity cutover', () => {
  const snapshots: PetActivitySnapshot[] = []
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => [
      projection({ taskId: 'legacy-failure', scopeId: 'scope-old', status: 'failed', updatedAt: '2026-08-20T23:59:00.000Z' }),
      projection({ taskId: 'new-result', scopeId: 'scope-new', status: 'completed', updatedAt: '2026-08-21T01:04:00.000Z' }),
    ] } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'ready')
  assert.equal(snapshots[0]?.taskId, 'new-result')
})

test('an unread terminal failure after cutover outranks a ready activity until it is seen', () => {
  const snapshots: PetActivitySnapshot[] = []
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => [
      projection({ taskId: 'failure', scopeId: 'scope-failure', status: 'failed', updatedAt: '2026-08-21T01:02:00.000Z' }),
      projection({ taskId: 'result', scopeId: 'scope-result', status: 'completed', updatedAt: '2026-08-21T01:03:00.000Z' }),
    ] } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'blocked')
  assert.equal(snapshots[0]?.taskId, 'failure')
})

test('an open blocked task remains visible even after its scope read marker advances', () => {
  const snapshots: PetActivitySnapshot[] = []
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => [
      projection({ taskId: 'blocked', scopeId: 'scope-blocked', status: 'blocked', updatedAt: '2026-08-21T01:02:00.000Z' }),
    ] } as never,
    database({ seenAt: { 'scope-blocked': '2026-08-21T02:00:00.000Z' } }),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'blocked')
  assert.equal(snapshots[0]?.taskId, 'blocked')
})

test('an open blocked task from before cutover does not revive retired history', () => {
  const snapshots: PetActivitySnapshot[] = []
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => [
      projection({ taskId: 'legacy-paused', scopeId: 'scope-old', status: 'recoverable_paused', updatedAt: '2026-07-30T01:00:00.000Z' }),
      projection({ taskId: 'result', scopeId: 'scope-result', status: 'completed', updatedAt: '2026-08-21T01:03:00.000Z' }),
    ] } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()

  assert.equal(snapshots[0]?.kind, 'ready')
  assert.equal(snapshots[0]?.taskId, 'result')
})

test('exact live narration updates a running pet and survives later generic tool activity', () => {
  const snapshots: PetActivitySnapshot[] = []
  const rows = [
    projection({ taskId: 'browser', scopeId: 'scope-browser', status: 'running', updatedAt: '2026-08-21T01:02:00.000Z' }),
  ]
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => rows } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()
  service.observeScopeRunEvent({
    type: 'updated', scopeId: 'scope-browser', agent: 'ready',
    taskId: 'browser', runId: 'run-browser', phase: 'planning',
    activityNarration: {
      itemId: 'commentary-1', source: 'commentary',
      text: '我正在核对当前页面的最后一部分。', status: 'completed',
    },
    timestamp: '2026-08-21T01:02:01.000Z',
  })
  service.observeScopeRunEvent({
    type: 'updated', scopeId: 'scope-browser', agent: 'ready',
    taskId: 'browser', runId: 'run-browser', phase: 'tool_running',
    toolEvent: {
      id: 'tool-1', kind: 'result', text: '网页操作完成',
      timestamp: '2026-08-21T01:02:02.000Z',
    },
    timestamp: '2026-08-21T01:02:02.000Z',
  })

  assert.equal(snapshots.at(-1)?.summary, '我正在核对当前页面的最后一部分。')
})

test('live narration from another run cannot overwrite the current pet activity', () => {
  const snapshots: PetActivitySnapshot[] = []
  const rows = [
    projection({ taskId: 'browser', scopeId: 'scope-browser', status: 'running', updatedAt: '2026-08-21T01:02:00.000Z' }),
  ]
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => rows } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()
  service.observeScopeRunEvent({
    type: 'updated', scopeId: 'scope-browser', agent: 'ready',
    taskId: 'browser', runId: 'run-other', phase: 'planning',
    activityNarration: {
      itemId: 'commentary-old', source: 'commentary',
      text: '旧任务旁白', status: 'completed',
    },
    timestamp: '2026-08-21T01:02:01.000Z',
  })

  assert.equal(snapshots.at(-1)?.summary, 'browser')
})

test('a committed terminal event refreshes canonical projection truth without a repository change event', () => {
  const snapshots: PetActivitySnapshot[] = []
  let rows = [
    projection({ taskId: 'browser', scopeId: 'scope-browser', status: 'running', updatedAt: '2026-08-21T01:02:00.000Z' }),
  ]
  const service = new PetActivityProjectionService(
    { listRecentTasks: () => rows } as never,
    database(),
    manager(snapshots),
  )
  service.refresh()
  rows = [
    projection({ taskId: 'browser', scopeId: 'scope-browser', status: 'failed', updatedAt: '2026-08-21T01:03:00.000Z' }),
  ]
  service.observeScopeRunEvent({
    type: 'finished', scopeId: 'scope-browser', agent: 'ready',
    taskId: 'browser', runId: 'run-browser', phase: 'error',
    timestamp: '2026-08-21T01:03:00.000Z',
  })

  assert.equal(snapshots.at(-1)?.kind, 'blocked')
  assert.equal(snapshots.at(-1)?.state, 'failed')
})
