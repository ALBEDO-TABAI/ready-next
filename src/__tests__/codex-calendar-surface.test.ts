import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveCodexExplicitResources,
  validateCodexCalendarWindow,
} from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  createProductionProductActionHandlers,
} from '../main/modules/agent-control/codex-runtime/codex-product-action-handlers'
import { CodexProductActionError } from '../main/modules/agent-control/codex-runtime/codex-product-action-requester'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('calendar host available exposes read floor and write tools in the degraded catalog path', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(
      [
        'file_search',
        'calendar_capture_session',
        'calendar_list_window',
        'calendar_create_event',
        'calendar_update_event',
        'calendar_delete_event',
      ],
      ['file_search'],
    ),
    authorizationId: 'cal-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'calendar',
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('calendar_capture_session'))
  assert.ok(names.includes('calendar_list_window'))
  assert.ok(names.includes('calendar_create_event'))
  assert.ok(names.includes('calendar_update_event'))
  assert.ok(names.includes('calendar_delete_event'))
})

test('invalid or oversized calendar windows are rejected', () => {
  assert.throws(() => validateCodexCalendarWindow({ start: 'nope', end: '2026-01-02' }), /codex_calendar_window_invalid/)
  assert.throws(() => validateCodexCalendarWindow({ start: '2026-02-01', end: '2026-01-01' }), /codex_calendar_window_order_invalid/)
  assert.throws(() => validateCodexCalendarWindow({ start: '2026-01-01', end: '2028-01-02' }), /codex_calendar_window_span_invalid/)
  const ok = validateCodexCalendarWindow({ start: '2026-01-01', end: '2026-01-08' })
  assert.equal(ok.start, '2026-01-01')
})

test('calendar window becomes a Main-versioned structured resource without event bodies', async () => {
  const resolved = await resolveCodexExplicitResources({
    selections: [{
      kind: 'calendar_window',
      id: 'w1',
      name: '本周',
      start: '2026-01-01',
      end: '2026-01-08',
    }],
    resolveSkill: () => null,
    resolveLibrary: async () => ({ selection: { kind: 'calendar_window', id: 'w1', name: '本周', libraryId: 'a'.repeat(64), start: '2026-01-01', end: '2026-01-08' }, version: 'b'.repeat(64) }),
  })
  assert.equal(resolved.requestResources[0]?.kind, 'calendar_window')
  assert.equal(JSON.stringify(resolved.input).includes('会议纪要正文'), false)
})

test('conflicting calendar event target refuses update', async () => {
  const { dispatch } = createProductionProductActionHandlers({
    database: {
      getCalendarSources: () => [],
    } as never,
    rss: {
      async fetchUpdates() { return { success: false } },
      async addSource() { return { ok: false } },
      async analyzeItem() { return { ok: false } },
    },
    requestRendererToolAction: async () => ({ ok: false }),
    targets: { calendarEventId: 'typed-event' },
    sessionId: 's',
    runId: 'r',
    codexThreadId: 't',
    codexTurnId: 'u',
    codexCallId: 'c',
    readyActionId: 'a',
    actionIdentityDigest: 'd',
    abortSignal: new AbortController().signal,
  })
  await assert.rejects(
    () => dispatch('calendar.updateEvent', { id: 'other-event' }),
    (error: unknown) => error instanceof CodexProductActionError && error.code === 'product_action_calendar_event_conflict',
  )
})

for (const reason of ['vault_missing', 'vault_directory_missing', 'remote_scope']) test(`M7 calendar window sends without library: ${reason}`, async () => {
  let libraryCalls = 0
  const resolved = await resolveCodexExplicitResources({
    selections: [{ kind: 'calendar_window', id: 'window', name: '本周', start: '2026-10-31', end: '2026-11-07' }],
    resolveSkill: () => null,
    resolveLibrary: async () => { libraryCalls++; throw new Error(reason) },
  })
  assert.equal(libraryCalls, 0)
  assert.equal(resolved.requestResources[0].kind, 'calendar_window')
  assert.equal(resolved.libraryResources.length, 0)
  assert.match(JSON.stringify(resolved.input), /2026-10-31/)
})

test('M7 unavailable library item is marked without losing calendar context or authorizing reads', async () => {
  const result = await resolveCodexExplicitResources({
    selections: [
      { kind: 'calendar_day', id: 'day', name: '这一天', libraryId: 'a'.repeat(64), date: '2026-10-31', timeZone: 'UTC', categories: [], items: [] },
      { kind: 'calendar_window', id: 'window', name: '窗口', start: '2026-10-31', end: '2026-11-01' },
    ], resolveSkill: () => null, resolveLibrary: async () => { throw new Error('library_resource_unavailable') },
  })
  assert.equal(result.libraryResources.length, 0)
  assert.equal(result.requestResources.find(r => r.id === 'day')?.canRead, false)
  assert.equal(result.requestResources.some(r => r.kind === 'calendar_window'), true)
  assert.match(JSON.stringify(result.input), /重新选择/)
})
