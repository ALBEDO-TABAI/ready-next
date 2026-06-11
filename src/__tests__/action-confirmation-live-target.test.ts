/**
 * EP1-I3 live-target enforcement (Codex review P1 follow-up).
 *
 * The dispatch gate classifies on ARGUMENTS only — the preferred browser
 * channels (page-map target_id, CSS selector, viewport coordinates) legally
 * carry no semantic text, so a payment/captcha/password control could be hit
 * with clean args and classify M4. These tests pin the second net at the
 * browser execution layer, where the REAL element label is known:
 *
 *   - target_id-only act_on_target on an M1 control → denied_manual_only
 *   - act_on_target fill into a password field without an args cue →
 *     denied_pending_confirmation (reroute); with a cue → proceeds
 *   - CSS-selector click on an M1 control → denied_manual_only (in-script
 *     check generated from the policy patterns — single source)
 *   - coordinate click: labeled M1 target refused; unresolvable label
 *     proceeds (the visual channel must keep working)
 *   - opaque-selector typing into a password field → reroute
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import { __resetBrowserAgentPageMapForTests } from '../main/modules/tools/browser-tools'
import { matchManualOnlyBrowserTarget } from '../main/modules/agent-control/safety/action-confirmation-policy'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'

interface MockCalls {
  scripts: string[]
  mouse: Array<Record<string, unknown>>
}

function makeController(
  executeJS: (source: string) => unknown,
): BrowserController & { calls: MockCalls } {
  const calls: MockCalls = { scripts: [], mouse: [] }
  const mock = {
    calls,
    getTabList: () => [{ id: 'tab-1', title: 'Example', url: 'https://example.com', active: true }],
    normalizedToCss: async (_tabId: unknown, x: number, y: number) => ({ x, y, width: 1000, height: 800 }),
    dispatchMouse: async (_tabId: unknown, payload: Record<string, unknown>) => {
      calls.mouse.push(payload)
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
  return {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    sessionId: 'live-target-test',
    browserController: controller,
    ...overrides,
  } as ToolContext
}

test.beforeEach(() => {
  __resetBrowserAgentPageMapForTests()
})

// ---------------------------------------------------------------------------
// 1. target_id-only act_on_target
// ---------------------------------------------------------------------------

test('act_on_target: bare target_id click on a payment-confirm control → denied_manual_only', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/checkout', title: 'Checkout' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'button', name: '确认支付', backendDOMNodeId: 1, frameId: '0' }] }],
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
  assert.equal(output.data?.errorKind, 'denied_manual_only')
  assert.equal(output.envelope?.kind, 'denied_by_policy')
  assert.ok(!controller.calls.scripts.some((s) => s.includes('__READY_AGENT_ACT_ON_TARGET__')),
    'the act script must never run against a manual-only target')
})

test('act_on_target: fill into a live password field without an args cue → reroute to confirmation', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_AGENT_PAGE_MAP__')) {
      return {
        identity: { url: 'https://example.com/login', title: 'Login' },
        viewport: { width: 1000, height: 800 },
        rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: '口令', backendDOMNodeId: 1, frameId: '0' }] }],
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
        rawRoots: [{ role: 'generic', children: [{ role: 'textbox', name: '口令', backendDOMNodeId: 1, frameId: '0' }] }],
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

// ---------------------------------------------------------------------------
// 2. CSS-selector click
// ---------------------------------------------------------------------------

test('browser_click: in-script M1 check refuses without clicking; patterns are policy-generated', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_MANUAL_ONLY_CHECK__')) {
      return { __readyManualOnlyBlocked: true, label: '确认支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_click', { selector: '#btn-3' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_manual_only')
  assert.equal(output.envelope?.kind, 'denied_by_policy')
  const clickScript = controller.calls.scripts.find((s) => s.includes('__READY_MANUAL_ONLY_CHECK__'))
  assert.ok(clickScript, 'click script must embed the manual-only check')
  assert.ok(clickScript!.includes('确认支付'), 'embedded patterns must come from the policy source')
})

// ---------------------------------------------------------------------------
// 3. Coordinate click
// ---------------------------------------------------------------------------

test('browser_click_at: labeled M1 target under the point is refused before any mouse event', async () => {
  const controller = makeController((source) => {
    if (source.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
      return { label: '立即支付' }
    }
    return null
  })
  const output = await executeToolCall('browser_click_at', { x: 500, y: 500 }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_manual_only')
  assert.equal(controller.calls.mouse.length, 0, 'no mouse event may fire on a refused target')
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
    if (source.includes('__READY_PASSWORD_FILL_CHECK__')) {
      return { __readyPasswordFillBlocked: true }
    }
    return null
  })
  const output = await executeToolCall('browser_type', { selector: '#input-3', text: 'hunter2' }, modelContext(controller))
  assert.equal(output.data?.errorKind, 'denied_pending_confirmation')
  const typeScript = controller.calls.scripts.find((s) => s.includes('__READY_PASSWORD_FILL_CHECK__'))
  assert.ok(typeScript!.includes('!false'), 'no args cue → in-page allow flag must be false')
})

// ---------------------------------------------------------------------------
// 5. Matcher unit — the single pattern source behind all the nets
// ---------------------------------------------------------------------------

test('matchManualOnlyBrowserTarget: payment / password-change / captcha labels hit; neutral labels do not', () => {
  assert.equal(matchManualOnlyBrowserTarget('确认支付')?.ruleId, 'm1-payment-final')
  assert.equal(matchManualOnlyBrowserTarget('保存新密码')?.ruleId, 'm1-password-change-final')
  assert.equal(matchManualOnlyBrowserTarget('请输入验证码')?.ruleId, 'm1-captcha-bypass')
  assert.equal(matchManualOnlyBrowserTarget('下一页'), null)
  assert.equal(matchManualOnlyBrowserTarget(''), null)
})
