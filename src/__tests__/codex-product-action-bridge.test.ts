import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexProductActionRequester,
  CodexProductActionError,
} from '../main/modules/agent-control/codex-runtime/codex-product-action-requester'
import { isAllowedProductAction } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import type {
  ReadyToolActionReceiptPort,
  ReadyToolActionReceiptRead,
} from '../main/modules/agent-control/codex-runtime/codex-tool-action-journal'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { executeRSSTool } from '../main/modules/tools/rss-tools'

class MemoryJournal implements ReadyToolActionReceiptPort {
  readonly records = new Map<string, Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>>()
  readonly pending = new Set<string>()
  readonly absent = new Map<string, Extract<ReadyToolActionReceiptRead, { state: 'proven_absent' }>>()
  readonly unknown = new Set<string>()

  async begin(input: { readyActionId: string; actionIdentityDigest: string; at: string }) {
    if (this.records.has(input.readyActionId) || this.pending.has(input.readyActionId) || this.unknown.has(input.readyActionId) || this.absent.has(input.readyActionId)) {
      return { fresh: false }
    }
    this.pending.add(input.readyActionId)
    return { fresh: true }
  }

  async read(readyActionId: string): Promise<ReadyToolActionReceiptRead> {
    const confirmed = this.records.get(readyActionId)
    if (confirmed) return confirmed
    const absent = this.absent.get(readyActionId)
    if (absent) return absent
    if (this.unknown.has(readyActionId) || this.pending.has(readyActionId)) {
      return { state: 'indeterminate', reason: 'pending', evidenceDigest: 'evidence' }
    }
    return { state: 'absent' }
  }

  async commit(input: {
    readyActionId: string
    actionIdentityDigest: string
    resultDigest: string
    output: ToolExecutionOutput
    at: string
  }) {
    this.pending.delete(input.readyActionId)
    const receipt = {
      state: 'confirmed' as const,
      receiptId: `r-${this.records.size + 1}`,
      resultDigest: input.resultDigest,
      output: input.output,
    }
    this.records.set(input.readyActionId, receipt)
    return receipt
  }

  markProvenAbsent(input: { readyActionId: string; actionIdentityDigest: string; reason: string; evidenceDigest: string; at: string }) {
    this.pending.delete(input.readyActionId)
    this.absent.set(input.readyActionId, {
      state: 'proven_absent',
      reason: input.reason,
      evidenceDigest: input.evidenceDigest,
    })
  }

  markIndeterminate(input: { readyActionId: string; actionIdentityDigest: string; reason: string; evidenceDigest: string; at: string }) {
    this.pending.delete(input.readyActionId)
    this.unknown.add(input.readyActionId)
  }
}

function makeRequester(overrides?: {
  tool?: string
  allowed?: string[]
  journal?: MemoryJournal
  dispatch?: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abort?: AbortController
  epoch?: number
}) {
  const journal = overrides?.journal || new MemoryJournal()
  const calls: string[] = []
  const abort = overrides?.abort || new AbortController()
  let epoch = overrides?.epoch ?? 1
  const requester = createCodexProductActionRequester({
    executingToolName: overrides?.tool || 'rss_fetch_updates',
    allowedToolNames: overrides?.allowed || ['rss_fetch_updates'],
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    messageVisibilityEpoch: epoch,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'digest-1',
    abortSignal: abort.signal,
    journal,
    assertEffectAuthority: () => {
      if (abort.signal.aborted) throw new CodexProductActionError('product_action_aborted')
      if (epoch !== 1) throw new CodexProductActionError('product_action_authority_drift')
    },
    handlers: {
      async dispatch(action, args) {
        calls.push(action)
        if (overrides?.dispatch) return overrides.dispatch(action, args)
        return { ok: true, summary: `${action} 完成`, fetched: 1 }
      },
    },
  })
  return { requester, calls, journal, abort, shiftEpoch: () => { epoch = 2 } }
}

test('product action map only allows the registered action for each tool', () => {
  assert.equal(isAllowedProductAction('rss_fetch_updates', 'rss.fetchUpdates'), true)
  assert.equal(isAllowedProductAction('rss_fetch_updates', 'rss.addSource'), false)
  assert.equal(isAllowedProductAction('tag_forge_apply_batch', 'tagForge.checkRevision'), true)
  assert.equal(isAllowedProductAction('file_move', 'tagForge.applyContent'), false)
})

test('rss_fetch_updates without current document executes the product action once', async () => {
  const { requester, calls } = makeRequester()
  const first = await requester('rss.fetchUpdates', {})
  assert.equal(first.ok, true)
  assert.equal(String(first.summary || '').includes('已排队'), false)
  assert.deepEqual(calls, ['rss.fetchUpdates'])
})

test('mismatched action, missing allow-set and drifted epoch do not dispatch', async () => {
  const matched = makeRequester()
  await assert.rejects(
    () => matched.requester('rss.addSource', {}),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_tool_mismatch',
  )
  assert.deepEqual(matched.calls, [])

  const denied = makeRequester({ allowed: ['calendar_list_window'] })
  await assert.rejects(
    () => denied.requester('rss.fetchUpdates', {}),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_tool_not_in_allow_set',
  )

  const drifted = makeRequester()
  drifted.shiftEpoch()
  await assert.rejects(
    () => drifted.requester('rss.fetchUpdates', {}),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_authority_drift',
  )
  assert.deepEqual(drifted.calls, [])
})

test('same product action identity replays and timeout-unknown does not retry', async () => {
  const journal = new MemoryJournal()
  const first = makeRequester({ journal })
  const second = makeRequester({ journal })
  const created = await first.requester('rss.fetchUpdates', {})
  const replayed = await second.requester('rss.fetchUpdates', {})
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.summary, created.summary)
  assert.deepEqual(first.calls, ['rss.fetchUpdates'])
  assert.deepEqual(second.calls, [])

  const unknownJournal = new MemoryJournal()
  let attempts = 0
  const failingDispatch = async () => {
    attempts += 1
    throw new Error('timeout after start')
  }
  const unknown = makeRequester({ journal: unknownJournal, dispatch: failingDispatch })
  const result = await unknown.requester('rss.fetchUpdates', {})
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'product_action_unknown')
  const retry = makeRequester({ journal: unknownJournal, dispatch: failingDispatch })
  const retried = await retry.requester('rss.fetchUpdates', {})
  assert.equal(retried.ok, false)
  assert.equal(retried.errorKind, 'product_action_unknown')
  assert.equal(attempts, 1)
})

test('stop before dispatch leaves product state unchanged', async () => {
  const abort = new AbortController()
  abort.abort()
  const { requester, calls } = makeRequester({ abort })
  await assert.rejects(
    () => requester('rss.fetchUpdates', {}),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_aborted',
  )
  assert.deepEqual(calls, [])
})

test('tag_forge_apply_batch can call both sync actions and other file tools cannot', async () => {
  const apply = makeRequester({
    tool: 'tag_forge_apply_batch',
    allowed: ['tag_forge_apply_batch'],
  })
  await apply.requester('tagForge.checkRevision', { path: '/tmp/a.md' })
  await apply.requester('tagForge.applyContent', { path: '/tmp/a.md' })
  assert.deepEqual(apply.calls, ['tagForge.checkRevision', 'tagForge.applyContent'])

  const move = makeRequester({ tool: 'file_move', allowed: ['file_move'] })
  await assert.rejects(
    () => move.requester('tagForge.applyContent', { path: '/tmp/a.md' }),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_tool_mismatch',
  )
})

test('handler validation errors stay proven-absent and keep their error code', async () => {
  const journal = new MemoryJournal()
  const requester = createCodexProductActionRequester({
    executingToolName: 'calendar_update_event',
    allowedToolNames: ['calendar_update_event'],
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    messageVisibilityEpoch: 1,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'digest-1',
    abortSignal: new AbortController().signal,
    journal,
    assertEffectAuthority: () => {},
    handlers: {
      async dispatch() {
        throw new CodexProductActionError('product_action_calendar_event_not_in_receipt')
      },
    },
  })
  await assert.rejects(
    () => requester('calendar.updateEvent', { id: 'guessed' }),
    (error: unknown) => error instanceof CodexProductActionError
      && error.code === 'product_action_calendar_event_not_in_receipt',
  )
})

test('authority drift after dispatch is unknown, not proven absent', async () => {
  const { CodexToolBridgeError } = await import('../main/modules/agent-control/codex-runtime/codex-tool-bridge')
  const journal = new MemoryJournal()
  let created = 0
  let afterDispatch = false
  const requester = createCodexProductActionRequester({
    executingToolName: 'calendar_create_event',
    allowedToolNames: ['calendar_create_event'],
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    messageVisibilityEpoch: 1,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'digest-1',
    abortSignal: new AbortController().signal,
    journal,
    assertEffectAuthority: () => {
      if (afterDispatch) throw new CodexToolBridgeError('tool_execution_aborted')
    },
    handlers: {
      async dispatch() {
        created += 1
        afterDispatch = true
        return { ok: true, summary: 'created', eventId: 'event-1' }
      },
    },
  })
  const result = await requester('calendar.createEvent', { title: '会', startTime: '2026-08-14T13:00:00Z', endTime: '2026-08-14T14:00:00Z' })
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'product_action_unknown')
  assert.equal(created, 1)
  const retry = createCodexProductActionRequester({
    executingToolName: 'calendar_create_event',
    allowedToolNames: ['calendar_create_event'],
    readyRunId: 'run-1',
    scopeId: 'scope-1',
    messageVisibilityEpoch: 1,
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    codexCallId: 'call-1',
    readyActionId: 'action-1',
    actionIdentityDigest: 'digest-1',
    abortSignal: new AbortController().signal,
    journal,
    assertEffectAuthority: () => {},
    handlers: {
      async dispatch() {
        created += 1
        return { ok: true, summary: 'created', eventId: 'event-1' }
      },
    },
  })
  const retried = await retry('calendar.createEvent', { title: '会', startTime: '2026-08-14T13:00:00Z', endTime: '2026-08-14T14:00:00Z' })
  assert.equal(retried.ok, false)
  assert.equal(retried.errorKind, 'product_action_unknown')
  assert.equal(created, 1)
})

test('RSS tools without a requester fail closed instead of queueing', async () => {
  const result = JSON.parse(await executeRSSTool('rss_fetch_updates', {}))
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'product_action_bridge_missing')
  assert.equal(String(result.message || '').includes('已排队'), false)
})
