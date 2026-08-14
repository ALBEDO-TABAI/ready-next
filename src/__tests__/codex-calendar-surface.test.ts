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

test('calendar workbench without keywords adds capture and list, not writes', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(
      ['file_search', 'calendar_capture_session', 'calendar_list_window', 'calendar_create_event'],
      ['file_search'],
    ),
    authorizationId: 'cal-auth',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    workbenchMode: 'calendar',
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('calendar_capture_session'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('calendar_list_window'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('calendar_create_event'), false)
})

test('invalid or oversized calendar windows are rejected', () => {
  assert.throws(() => validateCodexCalendarWindow({ start: 'nope', end: '2026-01-02' }), /codex_calendar_window_invalid/)
  assert.throws(() => validateCodexCalendarWindow({ start: '2026-02-01', end: '2026-01-01' }), /codex_calendar_window_order_invalid/)
  assert.throws(() => validateCodexCalendarWindow({ start: '2026-01-01', end: '2028-01-02' }), /codex_calendar_window_span_invalid/)
  const ok = validateCodexCalendarWindow({ start: '2026-01-01', end: '2026-01-08' })
  assert.equal(ok.start, '2026-01-01')
})

test('calendar window becomes a structured resource without event bodies', async () => {
  const resolved = await resolveCodexExplicitResources({
    selections: [{
      kind: 'calendar_window',
      id: 'w1',
      name: '本周',
      start: '2026-01-01',
      end: '2026-01-08',
    }],
    resolveSkill: () => null,
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
