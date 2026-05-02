import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionRecallService } from '../main/modules/agent-control/session-recall-service'

// skill-resume E1 — when user fires bare retry/continue intent on a scope with
// no manually attached recall context, auto-attach top-N predecessors in same
// lineage_root. Without this, prompt assembler has nothing to build "继续 …"
// context on, and the LLM has to guess what was happening.

interface FakeMetaRow {
  conversation_id: string
  lineage_root_id: string
  resume_title: string
  title: string
  source_kind: 'channel'
  source_id: string
  thread_key: string
  user_id: string | null
  channel_key: string
  preview_text: string | null
  latest_task_title: string | null
  latest_task_summary: string | null
  attachment_names_json: string
  updated_at: string
}

interface ScopeRow {
  id: string
  agent: string
  user_id?: string | null
  title: string
  parent_conversation_id?: string | null
  lineage_root_id?: string | null
  resume_title?: string | null
  source_kind: 'channel'
  source_id: string
  thread_key: string
  meta_json: string | null
  created_at: string
  updated_at: string
}

class FakeAdapter {
  private metaRows = new Map<string, FakeMetaRow>()
  private scopes = new Map<string, ScopeRow>()

  addScope(row: ScopeRow): void { this.scopes.set(row.id, row) }
  addMetaRow(row: FakeMetaRow): void { this.metaRows.set(row.conversation_id, row) }

  getRawDb() {
    const all = Array.from(this.metaRows.values())
    return {
      prepare: (sql: string) => ({
        all: <T = unknown>(...params: unknown[]): T[] => {
          if (sql.includes('FROM session_recall_metadata') && sql.includes('lineage_root_id = ?')) {
            const lineageRootId = String(params[0])
            const excludeId = String(params[1])
            const limit = Number(params[2])
            const matches = all
              .filter((row) => row.lineage_root_id === lineageRootId && row.conversation_id !== excludeId)
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
              .slice(0, limit)
            return matches as unknown as T[]
          }
          if (sql.includes('FROM session_recall_metadata') && sql.includes('conversation_id = ?')) {
            const id = String(params[0])
            const row = this.metaRows.get(id)
            return row ? [row] as unknown as T[] : []
          }
          return [] as T[]
        },
        get: <T = unknown>(...params: unknown[]): T | undefined => {
          if (sql.includes('FROM session_recall_metadata') && sql.includes('conversation_id = ?')) {
            return this.metaRows.get(String(params[0])) as unknown as T | undefined
          }
          return undefined
        },
        run: () => undefined,
      }),
    }
  }

  getConversationScope(id: string) { return this.scopes.get(id) || null }

  updateConversationScopeMeta(id: string, meta: Record<string, unknown>) {
    const scope = this.scopes.get(id)
    if (!scope) return null
    const updated = { ...scope, meta_json: JSON.stringify(meta) }
    this.scopes.set(id, updated)
    return updated
  }
}

function buildMetaRow(opts: {
  id: string
  lineageRootId: string
  title?: string
  updatedAt: string
}): FakeMetaRow {
  return {
    conversation_id: opts.id,
    lineage_root_id: opts.lineageRootId,
    resume_title: opts.title || `resume-${opts.id}`,
    title: opts.title || `Conv ${opts.id}`,
    source_kind: 'channel',
    source_id: 'src-1',
    thread_key: 'thread-A',
    user_id: null,
    channel_key: 'channel:src-1:thread-A',
    preview_text: 'prev',
    latest_task_title: 'last task',
    latest_task_summary: 'summary of work',
    attachment_names_json: '[]',
    updated_at: opts.updatedAt,
  }
}

function buildScope(id: string, lineageRootId: string, metaJson: string | null = null): ScopeRow {
  return {
    id,
    agent: 'a',
    title: id,
    lineage_root_id: lineageRootId,
    source_kind: 'channel',
    source_id: 'src-1',
    thread_key: 'thread-A',
    meta_json: metaJson,
    created_at: '2026-04-25T00:00:00.000Z',
    updated_at: '2026-04-25T00:00:00.000Z',
  }
}

test('autoAttachOnResume: attaches top-N predecessors in same lineage when no refs exist', () => {
  const adapter = new FakeAdapter()
  // current scope (lineage L1, no attached refs)
  adapter.addScope(buildScope('curr', 'L1'))
  // predecessors in same lineage
  adapter.addMetaRow(buildMetaRow({ id: 'p1', lineageRootId: 'L1', updatedAt: '2026-04-24T10:00:00.000Z' }))
  adapter.addMetaRow(buildMetaRow({ id: 'p2', lineageRootId: 'L1', updatedAt: '2026-04-24T11:00:00.000Z' }))
  adapter.addMetaRow(buildMetaRow({ id: 'p3', lineageRootId: 'L1', updatedAt: '2026-04-24T12:00:00.000Z' }))
  adapter.addMetaRow(buildMetaRow({ id: 'p4', lineageRootId: 'L1', updatedAt: '2026-04-24T13:00:00.000Z' }))
  // an unrelated lineage that should NOT be picked
  adapter.addMetaRow(buildMetaRow({ id: 'other', lineageRootId: 'L_other', updatedAt: '2026-04-24T14:00:00.000Z' }))

  const service = new SessionRecallService(adapter as never)
  const result = service.autoAttachOnResume({ currentScopeId: 'curr', intent: 'continue', limit: 3 })

  assert.equal(result.attached.length, 3, 'attached top 3')
  // newest first
  assert.deepEqual(
    result.attached.map((c) => c.conversationId),
    ['p4', 'p3', 'p2'],
    'sorted newest first by updated_at',
  )
  // self-exclusion
  assert.ok(!result.attached.some((c) => c.conversationId === 'curr'), 'never attaches self')
  // lineage isolation
  assert.ok(!result.attached.some((c) => c.conversationId === 'other'), 'never attaches different lineage')
})

test('autoAttachOnResume: no-op when scope already has manually-attached refs', () => {
  const adapter = new FakeAdapter()
  const existingRefs = JSON.stringify({
    sessionRecallContext: [{ conversationId: 'manual-1', attachedAt: '2026-04-24T00:00:00.000Z' }],
  })
  adapter.addScope(buildScope('curr', 'L1', existingRefs))
  adapter.addMetaRow(buildMetaRow({ id: 'p1', lineageRootId: 'L1', updatedAt: '2026-04-24T10:00:00.000Z' }))

  const service = new SessionRecallService(adapter as never)
  const result = service.autoAttachOnResume({ currentScopeId: 'curr', intent: 'continue' })

  assert.equal(result.attached.length, 0, 'skipped because manual refs exist')
})

test('autoAttachOnResume: no-op when scope is the only conv in its lineage', () => {
  const adapter = new FakeAdapter()
  adapter.addScope(buildScope('curr', 'L_solo'))
  // self present in metadata but no peers
  adapter.addMetaRow(buildMetaRow({ id: 'curr', lineageRootId: 'L_solo', updatedAt: '2026-04-25T00:00:00.000Z' }))

  const service = new SessionRecallService(adapter as never)
  const result = service.autoAttachOnResume({ currentScopeId: 'curr', intent: 'continue' })

  assert.equal(result.attached.length, 0, 'no peers → no attach')
})

test('autoAttachOnResume: no-op when scope not found', () => {
  const adapter = new FakeAdapter()
  const service = new SessionRecallService(adapter as never)
  const result = service.autoAttachOnResume({ currentScopeId: 'missing', intent: 'continue' })
  assert.equal(result.attached.length, 0)
})

test('autoAttachOnResume: respects custom limit', () => {
  const adapter = new FakeAdapter()
  adapter.addScope(buildScope('curr', 'L1'))
  for (let i = 1; i <= 5; i += 1) {
    adapter.addMetaRow(buildMetaRow({
      id: `p${i}`,
      lineageRootId: 'L1',
      updatedAt: `2026-04-24T0${i}:00:00.000Z`,
    }))
  }

  const service = new SessionRecallService(adapter as never)
  const result = service.autoAttachOnResume({ currentScopeId: 'curr', intent: 'continue', limit: 2 })

  assert.equal(result.attached.length, 2, 'capped at limit=2')
})

test('autoAttachOnResume: persists refs into scope.meta_json', () => {
  const adapter = new FakeAdapter()
  adapter.addScope(buildScope('curr', 'L1'))
  adapter.addMetaRow(buildMetaRow({ id: 'p1', lineageRootId: 'L1', updatedAt: '2026-04-24T10:00:00.000Z' }))

  const service = new SessionRecallService(adapter as never)
  service.autoAttachOnResume({ currentScopeId: 'curr', intent: 'continue' })

  const scope = adapter.getConversationScope('curr')
  assert.ok(scope?.meta_json, 'meta_json populated')
  const meta = JSON.parse(scope!.meta_json!) as { sessionRecallContext: Array<{ conversationId: string }> }
  assert.equal(meta.sessionRecallContext.length, 1)
  assert.equal(meta.sessionRecallContext[0].conversationId, 'p1')
})
