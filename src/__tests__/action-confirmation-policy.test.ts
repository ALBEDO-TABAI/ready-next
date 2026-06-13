/**
 * EP1-I3-1 — action-confirmation policy table + dispatch gate tests.
 *
 * Contract: docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md
 * Design:   docs/agent-evolution/05-意图理解与行动确认设计明细.md §3.1/§3.2
 *
 * Pins:
 *   1. M1-M4 matrix — every mode has at least one first-batch tool sample.
 *   2. Same tool + different argument features → different modes.
 *   3. M3 has NO pre-approval in phase 1 (no I-auth) — it takes the SAME
 *      confirm path as M2 (guards against reading intent fields to pre-approve).
 *   4. NO confirmation caching — the same object/action hit twice must be
 *      gated twice.
 *   5. Gate ordering — admission (authorization / allowlist / input
 *      validation) wins over the confirmation gate.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { resolveConfirmationGate } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'

test('action-confirmation-policy declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'action-confirmation-policy transitive sqlite load')
})

function modelContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'confirmation-gate-test',
    ...overrides,
  } as ToolContext
}

// ---------------------------------------------------------------------------
// 1. Policy table matrix — M1
// ---------------------------------------------------------------------------

test('M1 matrix: payment final-confirm click → manual_only', () => {
  const decision = resolveConfirmationGate('browser_click_text', { text: '确认支付' })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('M1 matrix: password-change final submit → manual_only', () => {
  const decision = resolveConfirmationGate('browser_click_text', { text: '保存新密码' })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('M1 matrix: typing into a captcha field → manual_only', () => {
  const decision = resolveConfirmationGate('browser_type', { selector: '#captcha-input', text: '8244' })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('M1 matrix: act-on-target click on a payment-confirm target → manual_only (no page-map bypass)', () => {
  const decision = resolveConfirmationGate('browser_act_on_target', {
    target_id: 'pm-3:button-17',
    action: 'click',
    disambiguation: '订单页底部的「确认支付」主按钮',
  })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('M1 matrix: act-on-target fill into a captcha field → manual_only', () => {
  const decision = resolveConfirmationGate('browser_act_on_target', {
    target_id: 'pm-3:input-4',
    action: 'fill',
    value: '8244',
    disambiguation: '验证码输入框',
  })
  assert.equal(decision.mode, 'M1')
  assert.equal(decision.action, 'manual_only')
})

test('M3 matrix: act-on-target fill into a password field → confirm (登录已存账号)', () => {
  const decision = resolveConfirmationGate('browser_act_on_target', {
    target_id: 'pm-2:input-9',
    action: 'fill',
    value: 'hunter2',
    disambiguation: '登录表单的 password 输入框',
  })
  assert.equal(decision.mode, 'M3')
  assert.equal(decision.action, 'confirm')
})

test('M4 matrix: a neutral act-on-target click stays allowed', () => {
  const decision = resolveConfirmationGate('browser_act_on_target', {
    target_id: 'pm-1:link-2',
    action: 'click',
    disambiguation: '文章列表第一条链接',
  })
  assert.equal(decision.mode, 'M4')
  assert.equal(decision.action, 'allow')
})

// ---------------------------------------------------------------------------
// 1. Policy table matrix — M2
// ---------------------------------------------------------------------------

test('M2 matrix: calendar_delete_event → confirm every time', () => {
  const decision = resolveConfirmationGate('calendar_delete_event', { id: 'evt-1' })
  assert.equal(decision.mode, 'M2')
  assert.equal(decision.action, 'confirm')
})

test('M2 matrix: feishu_calendar_delete_event → confirm', () => {
  const decision = resolveConfirmationGate('feishu_calendar_delete_event', {
    channel_id: 'ch-1',
    calendar_id: 'cal-1',
    event_id: 'evt-1',
  })
  assert.equal(decision.mode, 'M2')
  assert.equal(decision.action, 'confirm')
})

test('M2 matrix: batch irreversible apply stays M2 even with model-asserted confirmed=true (确认卫生：模型断言不解锁)', () => {
  const decision = resolveConfirmationGate('file_organize_apply', {
    planId: 'plan-1',
    confirmed: true,
    confirmedVia: 'ask_user_questions',
  })
  assert.equal(decision.mode, 'M2')
  assert.equal(decision.action, 'confirm')
})

// ---------------------------------------------------------------------------
// 1. Policy table matrix — M3 (phase 1: degraded to the M2 confirm path)
// ---------------------------------------------------------------------------

test('M3 matrix: file upload → mode M3 but action is confirm (same path as M2, no pre-approval)', () => {
  const decision = resolveConfirmationGate('feishu_file_upload', {
    channel_id: 'ch-1',
    file_path: '/tmp/report.pdf',
    file_type: 'pdf',
  })
  assert.equal(decision.mode, 'M3')
  assert.equal(decision.action, 'confirm')
})

test('M3 matrix: browser_upload_scope_attachment → confirm', () => {
  const decision = resolveConfirmationGate('browser_upload_scope_attachment', { attachmentId: 'att-1' })
  assert.equal(decision.mode, 'M3')
  assert.equal(decision.action, 'confirm')
})

test('M3 matrix: typing into a login password field → confirm (登录已存账号)', () => {
  const decision = resolveConfirmationGate('browser_type', { selector: '#login-password', text: 'hunter2' })
  assert.equal(decision.mode, 'M3')
  assert.equal(decision.action, 'confirm')
})

test('M3 matrix: collection task on a high-control platform → confirm; neutral site → allow', () => {
  const risky = resolveConfirmationGate('browser_start_task', {
    kind: 'scroll_collect',
    payload: { url: 'https://www.xiaohongshu.com/explore' },
  })
  assert.equal(risky.mode, 'M3')
  assert.equal(risky.action, 'confirm')

  const neutral = resolveConfirmationGate('browser_start_task', {
    kind: 'scroll_collect',
    payload: { url: 'https://example.org/blog' },
  })
  assert.equal(neutral.mode, 'M4')
  assert.equal(neutral.action, 'allow')
})

// ---------------------------------------------------------------------------
// 1. Policy table matrix — M4
// ---------------------------------------------------------------------------

test('M4 matrix: read-only tool not in the first batch → allow by default', () => {
  const decision = resolveConfirmationGate('file_search', { query: 'foo' })
  assert.equal(decision.mode, 'M4')
  assert.equal(decision.action, 'allow')
})

test('M4 matrix: downloads are explicitly allowed', () => {
  const decision = resolveConfirmationGate('browser_download_urls', { urls: ['https://example.org/a.png'] })
  assert.equal(decision.mode, 'M4')
  assert.equal(decision.action, 'allow')
})

test('M4 matrix: cookie-consent click is carved out before the M1 click rules', () => {
  const decision = resolveConfirmationGate('browser_click_text', { text: '接受所有 Cookie' })
  assert.equal(decision.mode, 'M4')
  assert.equal(decision.action, 'allow')
})

// ---------------------------------------------------------------------------
// 2. Same tool, different argument features → different modes
// ---------------------------------------------------------------------------

test('file_move without overwrite → allow; with overwrite=true → M2 confirm', () => {
  const plain = resolveConfirmationGate('file_move', { path: '/ws/a.md', destDir: '/ws/sub' })
  assert.equal(plain.action, 'allow')

  const overwrite = resolveConfirmationGate('file_move', {
    path: '/ws/a.md',
    destDir: '/ws/sub',
    overwrite: true,
  })
  assert.equal(overwrite.mode, 'M2')
  assert.equal(overwrite.action, 'confirm')
})

test('feishu_message_send: sensitive content → M2; ordinary content → M3 (both confirm in phase 1)', () => {
  const sensitive = resolveConfirmationGate('feishu_message_send', {
    channel_id: 'ch-1',
    chat_id: 'oc-1',
    msg_type: 'text',
    content: { text: '服务器 root 密码是 hunter2' },
  })
  assert.equal(sensitive.mode, 'M2')
  assert.equal(sensitive.action, 'confirm')

  const ordinary = resolveConfirmationGate('feishu_message_send', {
    channel_id: 'ch-1',
    chat_id: 'oc-1',
    msg_type: 'text',
    content: { text: '会议改到明天上午十点' },
  })
  assert.equal(ordinary.mode, 'M3')
  assert.equal(ordinary.action, 'confirm')
})

// ---------------------------------------------------------------------------
// 3. M3 takes the SAME flow as M2 — and the resolver is a pure function of
//    (toolName, args): no intent/TurnFrame input exists to pre-approve with.
// ---------------------------------------------------------------------------

test('M3 and M2 produce the same gate action (no pre-approval branch in phase 1)', () => {
  const m2 = resolveConfirmationGate('calendar_delete_event', { id: 'evt-1' })
  const m3 = resolveConfirmationGate('feishu_file_upload', {
    channel_id: 'ch-1',
    file_path: '/tmp/x.pdf',
    file_type: 'pdf',
  })
  assert.equal(m2.action, 'confirm')
  assert.equal(m3.action, m2.action, 'M3 must flow through the identical confirm action as M2')
})

// ---------------------------------------------------------------------------
// 4. No confirmation caching — same object, same action, hit twice → gated twice
// ---------------------------------------------------------------------------

test('no-cache: identical M2 call resolved twice → confirm both times', () => {
  const first = resolveConfirmationGate('calendar_delete_event', { id: 'evt-same' })
  const second = resolveConfirmationGate('calendar_delete_event', { id: 'evt-same' })
  assert.equal(first.action, 'confirm')
  assert.equal(second.action, 'confirm')
})

test('no-cache (dispatch level): two consecutive identical M2 dispatches are BOTH denied pending confirmation', async () => {
  const calls: string[] = []
  const context = modelContext({
    requestModuleToolAction: async (action) => {
      calls.push(action)
      return { summary: 'deleted' }
    },
  })
  const first = await executeToolCall('calendar_delete_event', { id: 'evt-same' }, context)
  const second = await executeToolCall('calendar_delete_event', { id: 'evt-same' }, context)
  assert.equal(first.data?.errorKind, 'denied_pending_confirmation')
  assert.equal(second.data?.errorKind, 'denied_pending_confirmation', 'second hit must confirm again — no cache')
  assert.deepEqual(calls, [], 'underlying module action must never run without confirmation')
})

// ---------------------------------------------------------------------------
// 5. Dispatch gate behavior through the REAL executeToolCall entry
// ---------------------------------------------------------------------------

test('dispatch: M1 click is refused with denied_manual_only and never reaches the browser domain', async () => {
  const output = await executeToolCall('browser_click_text', { text: '确认支付' }, modelContext())
  assert.equal(output.data?.errorKind, 'denied_manual_only')
  assert.equal(output.data?.mode, 'M1')
  assert.match(output.text, /亲手|手动|亲自/, 'M1 denial must instruct the user to act manually')
})

test('dispatch: M2 delete is denied pending confirmation (I3-1 placeholder) and tool does not execute', async () => {
  const calls: string[] = []
  const output = await executeToolCall('calendar_delete_event', { id: 'evt-9' }, modelContext({
    requestModuleToolAction: async (action) => {
      calls.push(action)
      return { summary: 'deleted' }
    },
  }))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.equal(output.data?.mode, 'M2')
  assert.deepEqual(calls, [])
})

test('dispatch: M3 upload takes the same denied_pending_confirmation path as M2', async () => {
  const output = await executeToolCall('feishu_file_upload', {
    channel_id: 'ch-1',
    file_path: '/tmp/x.pdf',
    file_type: 'pdf',
  }, modelContext())
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.equal(output.data?.mode, 'M3')
})

test('dispatch: M4 read-only call passes the gate and executes normally', async () => {
  const calls: string[] = []
  const output = await executeToolCall('calendar_list_window', {
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-02T00:00:00Z',
  }, modelContext({
    requestModuleToolAction: async (action) => {
      calls.push(action)
      return { summary: 'ok' }
    },
  }))
  assert.deepEqual(calls, ['calendar.listWindow'], 'M4 call must reach the calendar module action')
  assert.notEqual(output.data?.errorKind, 'denied_pending_confirmation')
})

test('dispatch: host invoker bypasses the confirmation gate (host calls carry their own admission)', async () => {
  const calls: string[] = []
  const output = await executeToolCall('calendar_delete_event', { id: 'evt-host' }, modelContext({
    invoker: 'host',
    requestModuleToolAction: async (action) => {
      calls.push(action)
      return { summary: 'deleted' }
    },
  }))
  assert.deepEqual(calls, ['calendar.deleteEvent'])
  assert.notEqual(output.data?.errorKind, 'denied_pending_confirmation')
})

// ---------------------------------------------------------------------------
// 6. Ordering — admission signals win over the confirmation gate
// ---------------------------------------------------------------------------

test('ordering: M2 tool missing from allowedToolNames → tool_restricted_this_turn, NOT pending confirmation', async () => {
  const output = await executeToolCall('calendar_delete_event', { id: 'evt-1' }, modelContext({
    allowedToolNames: new Set<string>(),
  }))
  assert.equal(output.data?.reason, 'tool_restricted_this_turn')
  assert.notEqual(output.data?.errorKind, 'denied_pending_confirmation')
})

test('ordering: M2 tool with invalid input → input validation error, NOT pending confirmation', async () => {
  const output = await executeToolCall('calendar_delete_event', {}, modelContext())
  assert.equal(output.data?.errorKind, 'input_validation')
})

test('source pin: confirmation gate sits AFTER authorization and consumes only (toolName, args)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract (合同 I3-1): the first-batch table holds no skill_* tool, so no behavior test can produce an input where authorization and the confirmation gate both fire — yet the contract requires the gate to sit after authorization, and to take no intent/TurnFrame input (pre-approval ban). Source-level pin is the only proof available.
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/tools/tool-executor.ts'),
    'utf8',
  )
  const authIdx = source.indexOf('checkSkillToolAuthorization(toolName, authorization, isPrimitive)')
  // EP2-I-auth: the gate gains a scopeId opt (lineage key for the M3 fact
  // lookup) — still no intent/TurnFrame input; the pre-approval ban is
  // superseded ONLY by provable object-level facts (05 §3.4).
  const gateIdx = source.indexOf('resolveConfirmationGate(toolName, args, { scopeId:')
  assert.ok(authIdx > 0, 'authorization check must exist')
  assert.ok(gateIdx > 0, 'confirmation gate must exist and take exactly (toolName, args) — no frame/intent inputs')
  assert.ok(authIdx < gateIdx, 'confirmation gate must run AFTER skill tool authorization')
})
