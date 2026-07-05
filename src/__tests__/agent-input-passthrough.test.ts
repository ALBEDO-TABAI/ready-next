/**
 * D18-d（真机第十六轮实锚）—— agent 自注入输入直通登记的行为合同。
 *
 * 事实链：CDP Input.dispatchKey/MouseEvent 注入的事件**会**触发
 * before-input-event / before-mouse-event（attachAgentTabSupervision 的旧
 * 假设不成立）。后果三连：agent 的 send_keys 触发自家接管闸（凭空
 * pending_confirm）；键击被 preventDefault 吞掉（模型的 Cmd+A/Backspace
 * 修复静默失效 → 标题区死循环）；被吞 Meta 组合键落穿应用菜单（两次
 * Cmd+A 与两次窗口缩放动画毫秒级对齐）。本合同钉：登记窗内命中放行、
 * 窗外/未登记键不放行（真实用户接管语义不受损）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentInputPassthroughRegistry } from '../main/modules/browser-engine/agent-input-passthrough'

test('registered keys pass through within the window, unknown keys do not', () => {
  let now = 1_000
  const registry = new AgentInputPassthroughRegistry({ now: () => now })
  registry.beginKeys(['Meta', 'a'])
  assert.equal(registry.matchKey('Meta'), true)
  assert.equal(registry.matchKey('a'), true)
  assert.equal(registry.matchKey('A'), true, 'match is case-insensitive (Electron reports shifted labels)')
  assert.equal(registry.matchKey('Backspace'), false, 'unregistered key = real user input, must not pass')
  now += 500
  assert.equal(registry.matchKey('a'), true, 'still inside the window')
})

test('key passthrough expires after the window (user typing later is takeover again)', () => {
  let now = 1_000
  const registry = new AgentInputPassthroughRegistry({ now: () => now })
  registry.beginKeys(['Backspace'], 1200)
  assert.equal(registry.matchKey('Backspace'), true)
  now += 1_201
  assert.equal(registry.matchKey('Backspace'), false, 'expired window must not shield user input')
})

test('a new dispatch refreshes the window and merges labels', () => {
  let now = 1_000
  const registry = new AgentInputPassthroughRegistry({ now: () => now })
  registry.beginKeys(['a'])
  now += 1_100
  registry.beginKeys(['Backspace'])
  assert.equal(registry.matchKey('Backspace'), true)
  assert.equal(registry.matchKey('a'), true, 'labels within the refreshed window stay valid')
  now += 1_300
  assert.equal(registry.matchKey('a'), false)
  assert.equal(registry.matchKey('Backspace'), false)
})

test('stale label set is cleared once expired (no unbounded growth)', () => {
  let now = 1_000
  const registry = new AgentInputPassthroughRegistry({ now: () => now })
  registry.beginKeys(['a', 'b', 'c'])
  now += 2_000
  assert.equal(registry.matchKey('a'), false)
  registry.beginKeys(['d'])
  assert.equal(registry.matchKey('a'), false, 'expired labels must not resurrect on the next dispatch')
  assert.equal(registry.matchKey('d'), true)
})

test('mouse passthrough is a plain window without identity', () => {
  let now = 1_000
  const registry = new AgentInputPassthroughRegistry({ now: () => now })
  assert.equal(registry.matchMouse(), false, 'no dispatch yet = user mouse is takeover')
  registry.beginMouse()
  assert.equal(registry.matchMouse(), true)
  now += 1_300
  assert.equal(registry.matchMouse(), false)
})
