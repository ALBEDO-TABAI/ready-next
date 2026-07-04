/**
 * EP1-I3 live-target enforcement (Codex review P1 follow-up).
 *
 * The dispatch gate classifies on ARGUMENTS only — the preferred browser
 * channels (page-map target_id, CSS selector, viewport coordinates) legally
 * carry no semantic text, so a payment/captcha/password control could be hit
 * with clean args and classify M4. These tests pin the second net at the
 * browser execution layer, where the REAL element label is known:
 *
 *   - target_id-only act_on_target on an destructive control → grant_required
 *   - act_on_target fill into a password field without an args cue →
 *     denied_pending_confirmation (reroute); with a cue → proceeds
 *   - CSS-selector click on an destructive control → grant_required (in-script
 *     check generated from the policy patterns — single source)
 *   - coordinate click: labeled destructive target refused; unresolvable label
 *     proceeds (the visual channel must keep working)
 *   - opaque-selector typing into a password field → reroute
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { __resetBrowserAgentPageMapForTests } from '../main/modules/tools/browser-observe-tools'
import { matchBrowserDestructiveTarget } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'

test('action-confirmation-live-target declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'action-confirmation-live-target transitive sqlite load')
})

interface MockCalls {
  scripts: string[]
  mouse: Array<Record<string, unknown>>
  typed: string[]
  keys: Array<Record<string, unknown>>
}

function makeController(
  executeJS: (source: string) => unknown,
): BrowserController & { calls: MockCalls } {
  const calls: MockCalls = { scripts: [], mouse: [], typed: [], keys: [] }
  const mock = {
    calls,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com', active: true }],
    normalizedToCss: async (_tabId: unknown, x: number, y: number) => ({ x, y, width: 1000, height: 800 }),
    dispatchMouse: async (_tabId: unknown, payload: Record<string, unknown>) => {
      calls.mouse.push(payload)
    },
    dispatchKey: async (_tabId: unknown, payload: Record<string, unknown>) => {
      calls.keys.push(payload)
    },
    typeTextDirectly: async (_tabId: unknown, text: unknown) => {
      calls.typed.push(String(text))
    },
    executeJS: async (_tabId: unknown, code: unknown) => {
      const source = String(code || '')
      calls.scripts.push(source)
      return executeJS(source)
    },
  }
  return mock as unknown as BrowserController & { calls: MockCalls }
}

function modelContext(controller: BrowserController, overrides: Partial<ToolContext> = {}): ToolContext {
  const leaseService = new BrowserWriteLeaseService()
  return {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'live-target-test',
    runId: 'live-target-run',
    browserController: controller,
    browserLease: new BrowserTurnLease({ taskId: 'live-target-task', runId: 'live-target-run' }, 'user-view', leaseService),
    ...overrides,
  } as ToolContext
}

test.beforeEach(() => {
  __resetBrowserAgentPageMapForTests()
})

// ---------------------------------------------------------------------------
// 1. target_id-only act_on_target
// ---------------------------------------------------------------------------

test('act_on_target: bare target_id click on a payment-confirm control → grant_required', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/checkout', title: 'Checkout' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'button', name: '确认支付', backendDOMNodeId: 1, frameId: '0' }, { role: 'button', name: 'Filler A', backendDOMNodeId: 91, frameId: '0' }, { role: 'button', name: 'Filler B', backendDOMNodeId: 92, frameId: '0' }, { role: 'button', name: 'Filler C', backendDOMNodeId: 93, frameId: '0' }, { role: 'button', name: 'Filler D', backendDOMNodeId: 94, frameId: '0' }] }],
        riskFlags: {},
      }
    }
    if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
      return { matchCount: 1, disabled: false, target: { role: 'button', name: '确认支付' } }
    }
    return null
  })
  const context = modelContext(controller)
  await executeToolCall('browser_read_page_map', {}, context)
  // Args carry NO semantic cue — the dispatch gate classified this M4.
  const output = await executeToolCall('browser_act_on_target', { target_id: '1:0:1', action: 'click' }, context)
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(output.envelope?.kind, 'denied_by_policy')
  assert.ok(!controller.calls.scripts.some((s) => s.includes('__READY_AGENT_ACT_ON_TARGET__')),
    'the act script must never run against a destructive-grant target')
})

test('act_on_target: fill into a live password field without an args cue → reroute to confirmation', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/login', title: 'Login' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: '口令', backendDOMNodeId: 1, frameId: '0' }, { role: 'button', name: 'Filler A', backendDOMNodeId: 91, frameId: '0' }, { role: 'button', name: 'Filler B', backendDOMNodeId: 92, frameId: '0' }, { role: 'button', name: 'Filler C', backendDOMNodeId: 93, frameId: '0' }, { role: 'button', name: 'Filler D', backendDOMNodeId: 94, frameId: '0' }] }],
        riskFlags: {},
      }
    }
    if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
      return { matchCount: 1, disabled: false, target: { role: 'textbox', name: '', states: { password: true } } }
    }
    if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
      return { ok: true, action: 'fill', target: { role: 'textbox' } }
    }
    return null
  })
  const context = modelContext(controller)
  await executeToolCall('browser_read_page_map', {}, context)
  const output = await executeToolCall('browser_act_on_target', {
    target_id: '1:0:1',
    action: 'fill',
    value: 'hunter2',
  }, context)
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.ok(!controller.calls.scripts.some((s) => s.includes('__READY_AGENT_ACT_ON_TARGET__')),
    'credentials must not be filled without confirmation')
})

test('act_on_target: password fill WITH an args cue proceeds (gate upstream owned the confirmation)', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/login', title: 'Login' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: '口令', backendDOMNodeId: 1, frameId: '0' }, { role: 'button', name: 'Filler A', backendDOMNodeId: 91, frameId: '0' }, { role: 'button', name: 'Filler B', backendDOMNodeId: 92, frameId: '0' }, { role: 'button', name: 'Filler C', backendDOMNodeId: 93, frameId: '0' }, { role: 'button', name: 'Filler D', backendDOMNodeId: 94, frameId: '0' }] }],
        riskFlags: {},
      }
    }
    if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
      return { matchCount: 1, disabled: false, target: { role: 'textbox', name: '', states: { password: true } } }
    }
    if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
      return { ok: true, action: 'fill', target: { role: 'textbox' } }
    }
    return null
  })
  // host invoker: the model path would have frozen+confirmed at the gate
  // (args carry the password cue → m3-login); host calls carry the user's
  // own action and skip the gate — the browser net must respect the cue.
  const context = modelContext(controller, { invoker: 'host' })
  await executeToolCall('browser_read_page_map', {}, context)
  const output = await executeToolCall('browser_act_on_target', {
    target_id: '1:0:1',
    action: 'fill',
    value: 'hunter2',
    disambiguation: '登录密码输入框',
  }, context)
  assert.notEqual(output.data?.errorKind, 'denied_pending_confirmation')
  assert.ok(controller.calls.scripts.some((s) => s.includes('__READY_AGENT_ACT_ON_TARGET__')),
    'cue-carrying fill must execute')
})

test('act_on_target: fill into an editable field whose VALUE contains a trigger word is NOT blocked (P2 parity)', async () => {
  // The probe reports the field's current value (提交订单草稿); for a fill the
  // value is content, not a control caption — it must not trip destructive-grant.
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/form', title: 'Form' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: '订单备注', backendDOMNodeId: 1, frameId: '0' }, { role: 'button', name: 'Filler A', backendDOMNodeId: 91, frameId: '0' }, { role: 'button', name: 'Filler B', backendDOMNodeId: 92, frameId: '0' }, { role: 'button', name: 'Filler C', backendDOMNodeId: 93, frameId: '0' }, { role: 'button', name: 'Filler D', backendDOMNodeId: 94, frameId: '0' }] }],
        riskFlags: {},
      }
    }
    if (source.includes('__READY_AGENT_TARGET_PROBE__')) {
      return { matchCount: 1, disabled: false, target: { role: 'textbox', name: '订单备注', value: '提交订单草稿' } }
    }
    if (source.includes('__READY_AGENT_ACT_ON_TARGET__')) {
      return { ok: true, action: 'fill', target: { role: 'textbox' } }
    }
    return null
  })
  const context = modelContext(controller)
  await executeToolCall('browser_read_page_map', {}, context)
  const output = await executeToolCall('browser_act_on_target', {
    target_id: '1:0:1',
    action: 'fill',
    value: '加急处理',
  }, context)
  assert.notEqual(output.data?.errorKind, 'grant_required', 'field value must not enter the destructive-grant decision for fill')
  assert.ok(controller.calls.scripts.some((s) => s.includes('__READY_AGENT_ACT_ON_TARGET__')),
    'a benign editable fill must execute')
})

// ---------------------------------------------------------------------------
// 2. CSS-selector click
// ---------------------------------------------------------------------------

test('browser_click: in-script destructive check refuses without clicking; patterns are policy-generated', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_DESTRUCTIVE_TARGET_CHECK__')) {
      return { __readyDestructiveTargetBlocked: true, label: '确认支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_click', { selector: '#btn-3' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(output.envelope?.kind, 'denied_by_policy')
  const clickScript = controller.calls.scripts.find((s) => s.includes('__READY_DESTRUCTIVE_TARGET_CHECK__'))
  assert.ok(clickScript, 'click script must embed the destructive-grant check')
  assert.ok(clickScript!.includes('确认支付'), 'embedded patterns must come from the policy source')
  // selector 命中按钮里的 icon/span 时 label 在父级——脚本必须爬 owner。
  assert.ok(clickScript!.includes('readyClickableOwner'), 'selector click must judge the clickable owner, not the bare child')
  assert.ok(clickScript!.includes('readyIsEditableField(owner)'), 'selector click must not judge editable field current values')
  assert.ok(clickScript!.includes('aria-labelledby'), 'click label must resolve aria-labelledby')
})

test('browser_click_text: generic text resolving to a payment button → grant_required before mouse event', async () => {
  const controller = makeController((source) => {
    if (source.includes('const target = "确认"')) {
      return { ok: true, text: '确认支付', clickedDirect: false, cssX: 500, cssY: 500, width: 1000, height: 800 }
    }
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '确认支付', inputLabel: '', password: false, editable: false }
    }
    return null
  })
  const output = await executeToolCall('browser_click_text', { text: '确认' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(controller.calls.mouse.length, 0, 'the resolved payment button must not receive a mouse event')
})

// ---------------------------------------------------------------------------
// 3. Coordinate click
// ---------------------------------------------------------------------------

test('browser_click_at: labeled destructive target under the point is refused before any mouse event', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '立即支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_click_at', { x: 500, y: 500 }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(controller.calls.mouse.length, 0, 'no mouse event may fire on a refused target')
  // Parent-bubble proof: clicks bubble, so hitting an icon/span inside a
  // 「确认支付」 button still presses the button — the probe must climb to
  // the nearest clickable owner instead of reading the bare child.
  const probeScript = controller.calls.scripts.find((s) => s.includes('__READY_CLICK_POINT_LABEL_PROBE__'))
  assert.ok(probeScript!.includes('closest'), 'probe must climb to the nearest clickable ancestor')
  assert.ok(probeScript!.includes('[role="button"]'), 'clickable owner selector must cover role=button')
  assert.ok(probeScript!.includes('aria-labelledby'), 'probe must resolve aria-labelledby references')
})

test('browser_click_at: unresolvable label proceeds (visual channel stays usable)', async () => {
  const controller = makeController(() => null)
  const output = await executeToolCall('browser_click_at', { x: 500, y: 500 }, modelContext(controller))
  assert.match(output.text, /"ok": true/)
  assert.ok(controller.calls.mouse.length >= 3, 'click must dispatch when no label is resolvable')
})

// ---------------------------------------------------------------------------
// 4. Opaque-selector typing into a password field
// ---------------------------------------------------------------------------

test('browser_type: opaque selector resolving to a password field → reroute to confirmation', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_LIVE_TARGET_GUARD__')) {
      return { __readyPasswordFillBlocked: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type', { selector: '#input-3', text: 'hunter2' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  const typeScript = controller.calls.scripts.find((s) => s.includes('__READY_LIVE_TARGET_GUARD__'))
  assert.ok(typeScript!.includes('!false'), 'no args cue → in-page allow flag must be false')
})

test('browser_type: opaque selector resolving to a captcha field → grant_required (代填验证码被拦)', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_LIVE_TARGET_GUARD__')) {
      return { __readyDestructiveTargetBlocked: true, label: '验证码' }
    }
    return null
  })
  const output = await executeToolCall('browser_type', { selector: '#input-3', text: '8244' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(output.envelope?.kind, 'denied_by_policy')
  const typeScript = controller.calls.scripts.find((s) => s.includes('__READY_LIVE_TARGET_GUARD__'))
  assert.ok(typeScript!.includes('验证码'), 'in-page guard must embed the policy captcha pattern')
  assert.ok(typeScript!.includes('placeholder'), 'guard must read field semantics (placeholder/aria/name/label)')
  assert.ok(typeScript!.includes('aria-labelledby'), 'guard must resolve aria-labelledby references (标准标签来源)')
})

// ---------------------------------------------------------------------------
// 4b. Coordinate typing (browser_type_at)
// ---------------------------------------------------------------------------

test('browser_type_at: password field under the point without an args cue → reroute, nothing typed', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '', inputLabel: '', password: true, editable: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type_at', { x: 500, y: 500, text: 'hunter2' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.deepEqual(controller.calls.typed, [], 'no text may be typed into an unconfirmed password field')
  assert.equal(controller.calls.mouse.length, 0, 'the focusing click must not fire either')
})

test('browser_type_at: captcha INPUT field under the point → grant_required (editable branch, field semantics)', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '', inputLabel: '请输入验证码', password: false, editable: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type_at', { x: 500, y: 500, text: '8244' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.deepEqual(controller.calls.typed, [])
})

test('browser_type_at: editable field whose CURRENT VALUE contains a trigger word is NOT blocked (P2 false-positive fix)', async () => {
  // A normal text field already holding "提交订单草稿" must stay typable —
  // the value must never enter the destructive-grant decision (only field
  // semantics do, and those exclude value).
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '订单备注 提交订单草稿', inputLabel: '订单备注', password: false, editable: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type_at', { x: 500, y: 500, text: '加急' }, modelContext(controller))
  assert.match(output.text, /"ok": true/)
  assert.deepEqual(controller.calls.typed, ['加急'], 'a benign editable field must remain typable')
})

test('browser_type_at: unresolvable probe proceeds (visual channel stays usable)', async () => {
  const controller = makeController(() => null)
  const output = await executeToolCall('browser_type_at', { x: 500, y: 500, text: '你好' }, modelContext(controller))
  assert.match(output.text, /"ok": true/)
  assert.deepEqual(controller.calls.typed, ['你好'])
})

// ---------------------------------------------------------------------------
// 4c. Smart typing (browser_type_smart) — scorer-resolved element
// ---------------------------------------------------------------------------

test('browser_type_smart: scorer resolving a password field without an args cue → reroute', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_LIVE_TARGET_GUARD__') && source.includes('Smart target not found')) {
      return { __readyPasswordFillBlocked: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type_smart', { target: '输入框', text: 'hunter2' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
})

// ---------------------------------------------------------------------------
// 4d. Coordinate typing must judge the CLICK target too (focusing click
//     fires before any typing — pressing a payment button is already the act)
// ---------------------------------------------------------------------------

test('browser_type_at: payment button under the point → grant_required BEFORE the focusing click', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '确认支付', inputLabel: '', password: false }
    }
    return null
  })
  const output = await executeToolCall('browser_type_at', { x: 500, y: 500, text: '随便' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(controller.calls.mouse.length, 0, 'the focusing click must never fire')
  assert.deepEqual(controller.calls.typed, [])
})

// ---------------------------------------------------------------------------
// 4e. send_keys — the keyboard bypass (tool + workflow substep share
//     sendKeyStroke, the single enforcement entry)
// ---------------------------------------------------------------------------

test('browser_send_keys: printable key while a captcha field is focused → grant_required', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_FOCUSED_FIELD_PROBE__')) {
      return { inputLabel: '请输入验证码', password: false }
    }
    return null
  })
  const output = await executeToolCall('browser_send_keys', { key: 'a' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.deepEqual(controller.calls.keys, [], 'no key event may reach a captcha field')
})

test('browser_send_keys: printable key while a password field is focused → reroute, nothing sent', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_FOCUSED_FIELD_PROBE__')) {
      return { inputLabel: '', password: true }
    }
    return null
  })
  const output = await executeToolCall('browser_send_keys', { key: '8' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.deepEqual(controller.calls.keys, [])
})

test('browser_send_keys: navigation keys (Enter) skip the probe and pass — user-driven submits stay usable', async () => {
  const controller = makeController(() => null)
  const output = await executeToolCall('browser_send_keys', { key: 'Enter' }, modelContext(controller))
  assert.match(output.text, /Sent key/)
  assert.ok(controller.calls.keys.length > 0, 'Enter must dispatch')
  assert.ok(
    !controller.calls.scripts.some((s) => s.includes('__READY_FOCUSED_FIELD_PROBE__')),
    'non-printable keys must not pay the probe roundtrip',
  )
})

test('workflow send_keys substep funnels through the same guard', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_FOCUSED_FIELD_PROBE__')) {
      return { inputLabel: '', password: true }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'send_keys', key: 'a' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation',
    'the workflow substep must hit the same sendKeyStroke guard')
  assert.deepEqual(controller.calls.keys, [])
})

// ---------------------------------------------------------------------------
// 4f. send_keys — Shift-modified printable chars must still be guarded
// ---------------------------------------------------------------------------

test('browser_send_keys: Shift+letter into a focused password field → reroute (Shift is a text modifier)', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_FOCUSED_FIELD_PROBE__')) {
      return { inputLabel: '', password: true }
    }
    return null
  })
  // Shift mask bit = 8; the guard must still probe (Shift+a → 'A').
  const output = await executeToolCall('browser_send_keys', { key: 'a', modifiers: ['shift'] }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  assert.deepEqual(controller.calls.keys, [], 'no Shift+char may reach a password field')
})

test('browser_send_keys: Ctrl+a (select-all shortcut) skips the probe and passes', async () => {
  const controller = makeController(() => null)
  const output = await executeToolCall('browser_send_keys', { key: 'a', modifiers: ['ctrl'] }, modelContext(controller))
  assert.match(output.text, /Sent key/)
  assert.ok(
    !controller.calls.scripts.some((s) => s.includes('__READY_FOCUSED_FIELD_PROBE__')),
    'command-modifier combos are shortcuts, not character entry — no probe',
  )
})

// ---------------------------------------------------------------------------
// 4g. browser_run_workflow — inner write substeps share the SAME guards
//     (the workflow tool is NOT in the dispatch confirmation policy)
// ---------------------------------------------------------------------------

test('workflow click: selector hitting a payment button → grant_required, not clicked', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_DESTRUCTIVE_TARGET_CHECK__')) {
      return { __readyDestructiveTargetBlocked: true, label: '确认支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'click', selector: '#pay' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
})

test('workflow click_at: payment button under the point → grant_required, no mouse event', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '立即支付', inputLabel: '', password: false, editable: false }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'click_at', x: 500, y: 500 }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.equal(controller.calls.mouse.length, 0)
})

test('workflow type: selector resolving to a password field → reroute (workflow never confirms, so no cue path)', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_LIVE_TARGET_GUARD__')) {
      return { __readyPasswordFillBlocked: true }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'type', selector: '#pw', text: 'hunter2' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
})

test('workflow type_at: captcha input under the point → grant_required', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '', inputLabel: '验证码', password: false, editable: true }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'type_at', x: 400, y: 400, text: '1234' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.deepEqual(controller.calls.typed, [])
})

test('workflow click_text: generic text resolving to a payment button → grant_required', async () => {
  const controller = makeController((source) => {
    if (source.includes('readyClickSemanticsLabel') || source.includes('Element by text')) {
      return { __readyDestructiveTargetBlocked: true, label: '确认支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'click_text', text: '确认' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
})

test('workflow click_text: text arg itself naming a destructive-grant action → denied before locating', async () => {
  const controller = makeController(() => null)
  const output = await executeToolCall('browser_run_workflow', {
    steps: [{ action: 'click_text', text: '确认支付' }],
  }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'grant_required')
  assert.ok(
    !controller.calls.scripts.some((s) => s.includes('Element by text')),
    'a destructive-grant text arg must be refused before the locate script runs',
  )
})

// ---------------------------------------------------------------------------
// 5. Matcher unit — the single pattern source behind all the nets
// ---------------------------------------------------------------------------

test('matchBrowserDestructiveTarget: payment / password-change / captcha labels hit; neutral labels do not', () => {
  assert.equal(matchBrowserDestructiveTarget('确认支付')?.ruleId, 'browser-power-payment-final')
  assert.equal(matchBrowserDestructiveTarget('保存新密码')?.ruleId, 'browser-power-password-change-final')
  assert.equal(matchBrowserDestructiveTarget('请输入验证码')?.ruleId, 'browser-power-access-control-interaction')
  assert.equal(matchBrowserDestructiveTarget('下一页'), null)
  assert.equal(matchBrowserDestructiveTarget(''), null)
})
