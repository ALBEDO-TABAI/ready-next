/**
 * EP2 P0-2 — per-scope live message cache: in-flight assistant segments
 * survive scope switches (no DB-only overwrite), merge back on loadScope,
 * and are superseded by their persisted twins (dedupe, then prune).
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

const DB: Record<string, Array<{ id: string; role: string; content: string; timestamp: string; meta?: Record<string, unknown> }>> = {}

function installApi(): void {
  ;(globalThis as any).electronAPI = {
    agent: {
      getConversationScopeMessages: async (scopeId: string) => ({ success: true, data: DB[scopeId] || [] }),
    },
  }
  ;(window as any).electronAPI = (globalThis as any).electronAPI
}

beforeEach(() => {
  installApi()
  DB['scope-a'] = [
    { id: 'persisted-1', role: 'user', content: '帮我研究一下', timestamp: '2026-06-12T10:00:00.000Z' },
  ]
  DB['scope-b'] = []
  useAgent.setState({
    messages: [],
    currentScopeId: 'scope-a',
    currentScope: null,
    scopes: [],
    scopeLiveMessages: {},
    sessions: {},
  } as never)
})

test('streamed segments cached per scope survive a switch away and merge back on return', async () => {
  const store = useAgent.getState()
  // run streams two segments on scope-a (write-through, as runtimeDriver does)
  store.appendScopeLiveMessage('scope-a', {
    id: 'seg-1', agent: 'butler', content: '第一段', type: 'agent',
    timestamp: new Date('2026-06-12T10:01:00.000Z'), meta: { transient: true },
  } as never)
  useAgent.getState().appendToScopeLiveMessage('scope-a', 'seg-1', '继续写')

  // switch to scope-b: DB-only there, scope-a cache untouched
  await useAgent.getState().loadScope('scope-b')
  assert.equal(useAgent.getState().currentScopeId === 'scope-b' || useAgent.getState().conversationId === 'scope-b', true)
  assert.equal((useAgent.getState().scopeLiveMessages['scope-a'] || []).length, 1, 'background cache intact')

  // background run streams ANOTHER segment while scope-b is foreground
  useAgent.getState().appendScopeLiveMessage('scope-a', {
    id: 'seg-2', agent: 'butler', content: '第二段', type: 'agent',
    timestamp: new Date('2026-06-12T10:02:00.000Z'), meta: { transient: true },
  } as never)

  // switch back: persisted + BOTH live segments visible, ordered
  await useAgent.getState().loadScope('scope-a')
  const ids = useAgent.getState().messages.map((message) => message.id)
  assert.deepEqual(ids, ['persisted-1', 'seg-1', 'seg-2'], 'live segments merged after the persisted row')
  const seg1 = useAgent.getState().messages.find((message) => message.id === 'seg-1')
  assert.equal(seg1?.content, '第一段继续写', 'chunk appends reached the cached segment')
})

test('a persisted twin supersedes the cached segment: merge dedupes and prune clears it', async () => {
  useAgent.getState().appendScopeLiveMessage('scope-a', {
    id: 'seg-x', agent: 'butler', content: '运行中文本', type: 'agent',
    timestamp: new Date('2026-06-12T10:03:00.000Z'), meta: { transient: true },
  } as never)
  // the run completes and persists the same message id
  DB['scope-a'].push({ id: 'seg-x', role: 'assistant', content: '运行中文本（终稿）', timestamp: '2026-06-12T10:03:30.000Z' })

  await useAgent.getState().loadScope('scope-a')
  const matches = useAgent.getState().messages.filter((message) => message.id === 'seg-x')
  assert.equal(matches.length, 1, 'no duplicate')
  assert.equal(matches[0].content, '运行中文本（终稿）', 'persisted version wins')
  assert.equal((useAgent.getState().scopeLiveMessages['scope-a'] || []).length, 0, 'cache pruned after persistence')
})

test('cache isolation: scopes never see each other\'s live segments', async () => {
  useAgent.getState().appendScopeLiveMessage('scope-a', {
    id: 'seg-a', agent: 'butler', content: 'A 的内容', type: 'agent',
    timestamp: new Date(), meta: { transient: true },
  } as never)
  await useAgent.getState().loadScope('scope-b')
  const ids = useAgent.getState().messages.map((message) => message.id)
  assert.ok(!ids.includes('seg-a'), 'scope-b never renders scope-a live segments')
})

// ---------- Codex gap 1: REAL send-path chain ----------

test('real chain: send creates empty reply → first chunk seeds the cache → switch away/back keeps text and tool trace', async () => {
  const { upsertStreamedSegmentCache } = await import('../renderer/modules/agent/runtimeDriver')

  // the real send path: an EMPTY assistant reply exists in messages and the
  // run state carries its id — the live cache has NO twin yet
  const replyId = 'reply-real-1'
  useAgent.setState((state: any) => ({
    messages: [...state.messages, { id: replyId, agent: 'butler', content: '', type: 'agent', timestamp: new Date('2026-06-12T11:00:00.000Z'), meta: { transient: true } }],
    sessions: {
      'sess-a': {
        ...(state.sessions['sess-a'] || {}),
        conversationId: 'scope-a',
        messages: [],
        scopeRunStates: {
          'scope-a': {
            scopeId: 'scope-a', agent: 'butler', requestId: 'run-1', phase: 'responding',
            toolTrace: [{ tool: 'web_search', status: 'done' }],
            startedAt: '2026-06-12T11:00:00.000Z', updatedAt: '2026-06-12T11:00:01.000Z',
            latestText: '', module: null, intent: null, executionKind: null,
            responseMessageId: replyId, responseBuffer: '',
          },
        },
      },
    },
    activeSessionId: 'sess-a',
  } as never))

  // first chunk arrives: previously a bare append would NO-OP (no cache twin)
  upsertStreamedSegmentCache(useAgent.getState() as never, 'scope-a', replyId, '第一段', '第一段', 'butler')
  // second chunk: twin exists now → append path
  upsertStreamedSegmentCache(useAgent.getState() as never, 'scope-a', replyId, '，第二段', '第一段，第二段', 'butler')
  const cached = (useAgent.getState().scopeLiveMessages['scope-a'] || []).find((m: { id: string }) => m.id === replyId) as { content: string } | undefined
  assert.equal(cached?.content, '第一段，第二段', 'first chunk seeded the cache; later chunks appended')

  // switch to B, then back to A — text must still be visible
  await useAgent.getState().loadScope('scope-b')
  await useAgent.getState().loadScope('scope-a')
  const visible = useAgent.getState().messages.find((m) => m.id === replyId)
  assert.equal(visible?.content, '第一段，第二段', 'in-flight reply text survives the round trip')

  // tool trace lives in the per-scope run state and is restored by loadScope
  const sessions = (useAgent.getState() as never as { sessions: Record<string, { scopeRunStates?: Record<string, { toolTrace?: unknown[] }> }> }).sessions
  const restored = Object.values(sessions)
    .map((slice) => slice?.scopeRunStates?.['scope-a'])
    .find(Boolean)
  assert.equal(restored?.toolTrace?.length, 1, 'tool trace preserved across the switch (task cards consume main projections)')
})
