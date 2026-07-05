/**
 * EP1-I3-2 — frozen-call freeze/release + confirmation card tests.
 *
 * Contract: docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md (EP1-I3-2)
 * Design:   docs/agent-evolution/05-意图理解与行动确认设计明细.md §3.2
 *
 * Pins (合同红线逐条):
 *   1. Release executes the FROZEN params byte-identical — no model
 *      re-generation between confirmation and execution.
 *   2. The release token skips ONLY the re-confirmation step — admission
 *      (allowlist / tool policy) reruns on the same dispatch path
 *      (确认 ≠ 提权).
 *   3. A frozen call releases exactly once — second release is rejected.
 *   4. Timeout / abort → expired; NO late execution after context loss.
 *   5. User denial feeds a structured rejection back to the model.
 *   6. Single pending per session — a second M2 hit is denied immediately.
 *   7. §7 closed loop — the dedicated frozenCall:respond IPC drives the
 *      same confirmation flow end to end.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import {
  FrozenCallStore,
  type FrozenCallDb,
} from '../main/modules/agent-control/safety/frozen-call-store'
import {
  registerFrozenCallStore,
  _resetFrozenCallBridgeForTests,
} from '../main/modules/agent-control/safety/frozen-call-bridge'
import {
  FROZEN_CALL_CONFIRM_OPTION,
  FROZEN_CALL_DENY_OPTION,
  FROZEN_CALL_QUESTION_ID,
  runFrozenCallConfirmation,
} from '../main/modules/agent-control/safety/frozen-call-confirmation'
import { resolveConfirmationGate } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { getAskUserQuestionsStore } from '../main/modules/tools/builtins/ask-user-questions-store'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { askUserGroup, type AskUserGroupDeps } from '../main/modules/claude-bridge/ipc/ask-user-group'

test('frozen-call-release declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'frozen-call-release transitive sqlite load')
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeDb extends FrozenCallDb {
  rows: Map<string, Record<string, unknown>>
}

function createFakeDb(): FakeDb {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    prepare(sql: string) {
      return {
        run: (...params: unknown[]) => {
          if (/INSERT INTO pending_confirmations/i.test(sql)) {
            const [id, runId, taskId, scopeId, toolName, paramsJson, createdAt, expiresAt, status] = params
            rows.set(String(id), {
              id, run_id: runId, task_id: taskId, scope_id: scopeId,
              tool_name: toolName, params_json: paramsJson,
              created_at: createdAt, expires_at: expiresAt, status,
              released_at: null,
            })
          } else if (/UPDATE pending_confirmations SET status = \?, released_at = \? WHERE id = \?/i.test(sql)) {
            const [status, releasedAt, id] = params
            const row = rows.get(String(id))
            if (row) {
              row.status = status
              row.released_at = releasedAt
            }
          } else if (/SET status = 'expired' WHERE status = 'pending'/i.test(sql)) {
            // constructor restart sweep — expire every leftover pending row
            for (const row of rows.values()) {
              if (row.status === 'pending') row.status = 'expired'
            }
          }
          return undefined
        },
      }
    },
  }
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `frozen-call-test-${sessionCounter}`
}

function modelContext(sessionId: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId,
    ...overrides,
  } as ToolContext
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value as T
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function answerPendingCard(sessionId: string, answer: string): void {
  const card = getAskUserQuestionsStore().findPendingForSession(sessionId)
  if (!card) throw new Error('no pending confirmation card to answer')
  getAskUserQuestionsStore().resolve(card.cardId, {
    answers: [{ id: FROZEN_CALL_QUESTION_ID, answer }],
    answeredAt: Date.now(),
  })
}

// ---------------------------------------------------------------------------
// 1. Byte-identical release through the REAL dispatch path
// ---------------------------------------------------------------------------

test('freeze → confirm → release executes the frozen params byte-identical, exactly once', async (t) => {
  const db = createFakeDb()
  const store = new FrozenCallStore(db)
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  const executed: Array<Record<string, unknown>> = []
  const originalArgs = { id: 'evt-42' }
  const pending = executeToolCall('calendar_delete_event', originalArgs, modelContext(sessionId, {
    requestModuleToolAction: async (_action, args) => {
      executed.push(args)
      return { summary: '事件已删除' }
    },
  }))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  const frozenRow = [...db.rows.values()][0]
  assert.ok(frozenRow, 'freeze must persist a pending_confirmations row')
  assert.equal(frozenRow.status, 'pending')
  assert.equal(frozenRow.tool_name, 'calendar_delete_event')
  // Durable row is ONLY a value-free structural shape + sha256 fingerprint —
  // no parameter value, sensitive or not (Codex review P1#4 strict form).
  const audit = JSON.parse(String(frozenRow.params_json)) as {
    __audit: string
    sha256: string
    shape: Record<string, unknown>
  }
  assert.equal(audit.__audit, 'redacted')
  assert.equal(audit.sha256, createHash('sha256').update(JSON.stringify(originalArgs)).digest('hex'))
  assert.deepEqual(audit.shape, { id: '<string>' }, 'shape carries key names + types only')
  assert.ok(!String(frozenRow.params_json).includes('evt-42'), 'no parameter value may persist')

  answerPendingCard(sessionId, FROZEN_CALL_CONFIRM_OPTION)
  const output = await pending

  assert.equal(executed.length, 1, 'released call must execute exactly once')
  assert.equal(
    JSON.stringify(executed[0]),
    JSON.stringify(originalArgs),
    'executed params must be byte-identical to the frozen serialization',
  )
  assert.deepEqual(executed[0], originalArgs)
  assert.match(output.text, /事件已删除/)
  assert.equal(frozenRow.status, 'released', 'row must be marked released')
  assert.ok(frozenRow.released_at, 'released_at must be stamped')
})

// ---------------------------------------------------------------------------
// 2. Release token skips ONLY re-confirmation — admission reruns (确认 ≠ 提权)
// ---------------------------------------------------------------------------

test('release re-enters the same dispatch path and is stopped by admission when authorization was lost', async (t) => {
  const store = new FrozenCallStore(createFakeDb())
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  const executed: string[] = []
  // Mutable allowlist: tool is allowed at freeze time, revoked before release.
  const allowedToolNames = new Set(['calendar_delete_event'])
  const pending = executeToolCall('calendar_delete_event', { id: 'evt-7' }, modelContext(sessionId, {
    allowedToolNames,
    requestModuleToolAction: async (action) => {
      executed.push(action)
      return { summary: 'deleted' }
    },
  }))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  allowedToolNames.delete('calendar_delete_event') // 确认后恰好失去授权
  answerPendingCard(sessionId, FROZEN_CALL_CONFIRM_OPTION)
  const output = await pending

  assert.equal(output.data?.errorKind, 'tool_restricted_this_turn',
    'release must be stopped by the allowlist admission gate, not waved through by the token')
  assert.equal(output.data?.reason, undefined)
  assert.deepEqual(executed, [], 'tool must NOT execute after losing authorization')
})

// ---------------------------------------------------------------------------
// 3. Exactly-once release — second release rejected (store contract)
// ---------------------------------------------------------------------------

test('store: a frozen call releases exactly once; the second release is rejected', () => {
  const store = new FrozenCallStore(createFakeDb())
  const frozen = store.freeze({ toolName: 'calendar_delete_event', params: { id: 'evt-1' }, sessionId: 's-once' })
  assert.ok(frozen.ok)
  if (!frozen.ok) return

  const first = store.release(frozen.id, frozen.token)
  assert.ok(first.ok, 'first release must succeed')
  const second = store.release(frozen.id, frozen.token)
  assert.deepEqual(second, { ok: false, reason: 'not_pending' })
})

test('store: a wrong token never releases', () => {
  const store = new FrozenCallStore(createFakeDb())
  const frozen = store.freeze({ toolName: 'calendar_delete_event', params: { id: 'evt-1' }, sessionId: 's-token' })
  assert.ok(frozen.ok)
  if (!frozen.ok) return
  const released = store.release(frozen.id, 'forged-token')
  assert.deepEqual(released, { ok: false, reason: 'invalid_token' })
})

// ---------------------------------------------------------------------------
// 4. Expiry — timeout voids the frozen call; NO late execution
// ---------------------------------------------------------------------------

test('store: an expired frozen call cannot be released (no execution after context loss)', () => {
  let nowMs = 1_000_000
  const store = new FrozenCallStore(createFakeDb(), { now: () => nowMs })
  const frozen = store.freeze({
    toolName: 'calendar_delete_event',
    params: { id: 'evt-late' },
    sessionId: 's-exp',
    ttlMs: 50,
  })
  assert.ok(frozen.ok)
  if (!frozen.ok) return

  nowMs += 51
  const released = store.release(frozen.id, frozen.token)
  assert.deepEqual(released, { ok: false, reason: 'expired' })
  assert.equal(store.get(frozen.id)?.status, 'expired')
})

test('restart sweep: leftover pending rows expire at construction even INSIDE their TTL (token was memory-only)', () => {
  const db = createFakeDb()
  // Simulate a row left behind by a crashed/restarted process whose TTL has
  // NOT elapsed yet — without the unconditional sweep it would stay pending
  // forever (no memory token can ever release it again).
  db.rows.set('fc-orphan', {
    id: 'fc-orphan',
    status: 'pending',
    tool_name: 'calendar_delete_event',
    params_json: '{"__audit":"redacted"}',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(), // in-TTL
    released_at: null,
  })
  void new FrozenCallStore(db)
  assert.equal(db.rows.get('fc-orphan')?.status, 'expired',
    'in-TTL orphan must be expired at construction — it can never be released')
})

test('abort while waiting → frozen call expired, structured timeout-cancel result, no late execution', async (t) => {
  const db = createFakeDb()
  const store = new FrozenCallStore(db)
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  const executed: string[] = []
  const controller = new AbortController()
  const pending = executeToolCall('calendar_delete_event', { id: 'evt-abort' }, modelContext(sessionId, {
    abortSignal: controller.signal,
    requestModuleToolAction: async (action) => {
      executed.push(action)
      return { summary: 'deleted' }
    },
  }))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  controller.abort()
  const output = await pending

  assert.equal(output.data?.errorKind, 'confirmation_expired')
  assert.match(output.text, /取消/)
  const frozenRow = [...db.rows.values()][0]
  assert.equal(frozenRow.status, 'expired')

  // Context is gone — a late confirmation must be a no-op, never a late run.
  const lateCard = getAskUserQuestionsStore().findPendingForSession(sessionId)
  assert.equal(lateCard, null, 'confirmation card must be gone after abort')
  assert.deepEqual(executed, [], 'tool must never execute after expiry')
})

// ---------------------------------------------------------------------------
// 5. User denial → structured rejection back to the model
// ---------------------------------------------------------------------------

test('user denial feeds a structured confirmation_denied_by_user back to the model', async (t) => {
  const db = createFakeDb()
  registerFrozenCallStore(new FrozenCallStore(db))
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  const executed: string[] = []
  const pending = executeToolCall('calendar_delete_event', { id: 'evt-deny' }, modelContext(sessionId, {
    requestModuleToolAction: async (action) => {
      executed.push(action)
      return { summary: 'deleted' }
    },
  }))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  answerPendingCard(sessionId, FROZEN_CALL_DENY_OPTION)
  const output = await pending

  assert.equal(output.data?.errorKind, 'confirmation_denied_by_user')
  assert.deepEqual(executed, [])
  assert.equal([...db.rows.values()][0].status, 'denied')
})

// ---------------------------------------------------------------------------
// 5b. Sensitive params — full bytes only in memory; DB/card/metrics redacted
// ---------------------------------------------------------------------------

test('sensitive outbound send: secret never reaches the DB row or the confirmation card; frozen bytes stay intact', async (t) => {
  const db = createFakeDb()
  const store = new FrozenCallStore(db)
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  // 696bd508 (authorized Power Browser tools) removed the browser-side
  // m3-login-existing-account rule from the static table — password fills are
  // now adjudicated by the browser execution layer's live-target net /
  // Power-grant contract, not by the freeze gate. The remaining
  // sensitive-params freeze rule is m2-send-sensitive: outbound content that
  // looks like credentials (SENSITIVE_CONTENT_PATTERN → mask ALL free-text
  // values in the audit copy).
  // NOTE: keys are declared in FeishuMessageSendSchema order — dispatch
  // replaces args with the Zod-parsed object (args = outcome.data), so the
  // frozen serialization (and its sha256 fingerprint) follows schema key
  // order, not the caller's literal order.
  const originalArgs = {
    channel_id: 'feishu-main',
    chat_id: 'oc-demo-chat',
    content: { text: '这是登录密码：hunter2-secret' },
    msg_type: 'text',
  }
  // feishu_message_send with credential-looking text → m2-send-sensitive.
  // No sidecar is needed: we deny at the card, so dispatch never reaches the
  // feishu domain.
  const pending = executeToolCall('feishu_message_send', originalArgs, modelContext(sessionId))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  const card = getAskUserQuestionsStore().findPendingForSession(sessionId)
  assert.ok(card)
  assert.ok(
    !card!.questions[0].question.includes('hunter2-secret'),
    'confirmation card must not leak the credential',
  )
  const expectedFingerprint = createHash('sha256')
    .update(JSON.stringify(originalArgs))
    .digest('hex')
    .slice(0, 12)
  assert.ok(
    card!.questions[0].question.includes(expectedFingerprint),
    'card must carry the params fingerprint so audit can join card ↔ row ↔ release',
  )
  const frozenRow = [...db.rows.values()][0]
  assert.ok(
    !String(frozenRow.params_json).includes('hunter2-secret'),
    'pending_confirmations row must not contain the credential',
  )
  const audit = JSON.parse(String(frozenRow.params_json)) as { sha256: string }
  assert.equal(
    audit.sha256,
    createHash('sha256').update(JSON.stringify(originalArgs)).digest('hex'),
    'audit hash must still identify the frozen bytes',
  )
  // The in-memory release source keeps the FULL original bytes.
  const frozen = store.findPendingForSession(sessionId)
  assert.equal(frozen!.paramsJson, JSON.stringify(originalArgs))

  answerPendingCard(sessionId, FROZEN_CALL_DENY_OPTION)
  const output = await pending
  assert.equal(output.data?.errorKind, 'confirmation_denied_by_user')
})

test('store: sensitively-named keys are masked in the audit copy even without the sensitive-rule flag', () => {
  const db = createFakeDb()
  const store = new FrozenCallStore(db)
  const frozen = store.freeze({
    toolName: 'feishu_file_upload',
    params: { channel_id: 'ch-1', file_path: '/tmp/x.pdf', file_type: 'pdf', api_key: 'sk-leak-me' },
    sessionId: 's-keys',
  })
  assert.ok(frozen.ok)
  const row = [...db.rows.values()][0]
  assert.ok(!String(row.params_json).includes('sk-leak-me'), 'sensitive key value must be masked')
  if (!frozen.ok) return
  const released = store.release(frozen.id, frozen.token)
  assert.ok(released.ok)
  if (!released.ok) return
  assert.equal((released.params as { api_key: string }).api_key, 'sk-leak-me', 'release keeps the full original value')
})

// ---------------------------------------------------------------------------
// 5c. One TTL for frozen call AND confirmation card
// ---------------------------------------------------------------------------

test('card timeout follows the frozen-call TTL — no 24h ask-user default', async () => {
  const store = new FrozenCallStore(createFakeDb())
  const outcome = await runFrozenCallConfirmation(
    'calendar_delete_event',
    { id: 'evt-ttl' },
    resolveConfirmationGate('calendar_delete_event', { id: 'evt-ttl' }),
    {
      store,
      sessionId: 'ttl-session',
      conversationId: 'ttl-session',
      timeoutMs: 60,
    },
  )
  assert.equal(outcome.kind, 'expired', 'card must time out on the frozen-call TTL, not the 24h default')
  if (outcome.kind !== 'expired') return
  assert.equal(store.get(outcome.frozenCallId)?.status, 'expired')
  assert.equal(
    getAskUserQuestionsStore().findPendingForSession('ttl-session'),
    null,
    'card slot must be freed when the TTL fires',
  )
})

// ---------------------------------------------------------------------------
// 6. Single pending — second M2 hit denied immediately
// ---------------------------------------------------------------------------

test('second M2 call while one confirmation is pending → immediate denied_pending_confirmation', async (t) => {
  registerFrozenCallStore(new FrozenCallStore(createFakeDb()))
  t.after(() => _resetFrozenCallBridgeForTests())

  const sessionId = nextSessionId()
  const executed: string[] = []
  const context = modelContext(sessionId, {
    requestModuleToolAction: async (action) => {
      executed.push(action)
      return { summary: 'ok' }
    },
  })
  const first = executeToolCall('calendar_delete_event', { id: 'evt-A' }, context)
  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))

  const second = await executeToolCall('feishu_calendar_delete_event', {
    channel_id: 'ch-1',
    calendar_id: 'cal-1',
    event_id: 'evt-B',
  }, context)
  assert.equal(second.data?.errorKind, 'denied_pending_confirmation',
    'second M2 must be denied immediately so the model reroutes')

  answerPendingCard(sessionId, FROZEN_CALL_CONFIRM_OPTION)
  const firstOutput = await first
  assert.match(firstOutput.text, /ok/)
  assert.deepEqual(executed, ['calendar.deleteEvent'])
})

// ---------------------------------------------------------------------------
// 7. §7 closed loop — dedicated frozenCall:respond IPC drives the same flow
// ---------------------------------------------------------------------------

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

test('dedicated agent:frozenCall:respond IPC confirms a pending frozen call end to end', async (t) => {
  const db = createFakeDb()
  const store = new FrozenCallStore(db)
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  // Register the IPC group against a mock ipcMain and grab the handler.
  const handlers = new Map<string, HandlerFn>()
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler() { /* noop */ },
  } as unknown as IpcMain
  const deps: AskUserGroupDeps = {
    getDatabase: (() => ({
      getChatMessageById: () => null,
      updateChatMessageMeta: () => true,
      listPendingAskUserQuestionsCards: () => [],
    })) as unknown as AskUserGroupDeps['getDatabase'],
    getEphemeralExecutionStore: (() => {
      throw new Error('not used')
    }) as unknown as AskUserGroupDeps['getEphemeralExecutionStore'],
    getAskUserQuestionsStore: () => getAskUserQuestionsStore(),
    logAgentMetric: () => { /* noop */ },
  }
  const handle = askUserGroup.register(ipc, deps)
  t.after(() => handle.dispose())

  const respond = handlers.get('agent:frozenCall:respond')
  assert.ok(respond, 'agent:frozenCall:respond must be registered by the askUser group')

  const sessionId = nextSessionId()
  const executed: Array<Record<string, unknown>> = []
  const pending = executeToolCall('calendar_delete_event', { id: 'evt-ipc' }, modelContext(sessionId, {
    requestModuleToolAction: async (_action, args) => {
      executed.push(args)
      return { summary: 'IPC 确认后已删除' }
    },
  }))

  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  const frozen = store.findPendingForSession(sessionId)
  assert.ok(frozen, 'frozen record must be pending')

  const ipcResult = await respond!({} as IpcMainInvokeEvent, {
    frozenCallId: frozen!.id,
    decision: 'confirm',
  }) as { success: boolean }
  assert.equal(ipcResult.success, true)

  const output = await pending
  assert.match(output.text, /IPC 确认后已删除/)
  assert.equal(executed.length, 1)
  assert.deepEqual(executed[0], { id: 'evt-ipc' })
})

test('dedicated IPC deny path rejects without execution', async (t) => {
  const store = new FrozenCallStore(createFakeDb())
  registerFrozenCallStore(store)
  t.after(() => _resetFrozenCallBridgeForTests())

  const handlers = new Map<string, HandlerFn>()
  const ipc = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    removeHandler() { /* noop */ },
  } as unknown as IpcMain
  const deps: AskUserGroupDeps = {
    getDatabase: (() => ({
      getChatMessageById: () => null,
      updateChatMessageMeta: () => true,
      listPendingAskUserQuestionsCards: () => [],
    })) as unknown as AskUserGroupDeps['getDatabase'],
    getEphemeralExecutionStore: (() => {
      throw new Error('not used')
    }) as unknown as AskUserGroupDeps['getEphemeralExecutionStore'],
    getAskUserQuestionsStore: () => getAskUserQuestionsStore(),
    logAgentMetric: () => { /* noop */ },
  }
  const handle = askUserGroup.register(ipc, deps)
  t.after(() => handle.dispose())

  const sessionId = nextSessionId()
  const executed: string[] = []
  const pending = executeToolCall('calendar_delete_event', { id: 'evt-ipc-deny' }, modelContext(sessionId, {
    requestModuleToolAction: async (action) => {
      executed.push(action)
      return { summary: 'deleted' }
    },
  }))
  await waitFor(() => getAskUserQuestionsStore().findPendingForSession(sessionId))
  const frozen = store.findPendingForSession(sessionId)

  const respond = handlers.get('agent:frozenCall:respond')
  const ipcResult = await respond!({} as IpcMainInvokeEvent, {
    frozenCallId: frozen!.id,
    decision: 'deny',
  }) as { success: boolean }
  assert.equal(ipcResult.success, true)

  const output = await pending
  assert.equal(output.data?.errorKind, 'confirmation_denied_by_user')
  assert.deepEqual(executed, [])
})
