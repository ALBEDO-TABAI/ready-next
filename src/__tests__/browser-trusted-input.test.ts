import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  runGuardedSelectorClick,
  runGuardedSelectorType,
} from '../main/modules/tools/browser-input-actions'

function trustedInputFixture() {
  const scripts: string[] = []
  const mouse: Array<Record<string, unknown>> = []
  const keys: Array<Record<string, unknown>> = []
  const typed: string[] = []
  const controller = {
    normalizedToCss: async (_tabId: string | null, x: number, y: number) => ({
      x: x / 2,
      y: y / 2,
      width: 500,
      height: 500,
    }),
    dispatchMouse: async (_tabId: string | null, event: Record<string, unknown>) => { mouse.push(event) },
    dispatchKey: async (_tabId: string | null, event: Record<string, unknown>) => { keys.push(event) },
    typeTextDirectly: async (_tabId: string | null, text: string) => { typed.push(text) },
    executeJS: async (_tabId: string | null, script: string) => {
      scripts.push(script)
      if (script.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
        return { label: 'Open', inputLabel: 'Search', editable: true, password: false }
      }
      if (script.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
        return { kind: 'editable', tag: 'input', label: 'Search', maxLength: 200, singleLine: true }
      }
      if (script.includes('__READY_TYPED_INTO_PROBE__')) {
        return { tag: 'input', label: 'Search', textHead: 'hello', textLength: 5 }
      }
      if (script.includes('document.readyState')) {
        return { readyState: 'complete', bodyTextLen: 20, matched: false }
      }
      if (script.includes('document.querySelector')) {
        return { ok: true, x: 250, y: 250, width: 500, height: 500, label: 'Open', tag: 'button' }
      }
      return null
    },
  } as unknown as BrowserController
  return { controller, scripts, mouse, keys, typed }
}

test('selector click only observes in page and dispatches trusted mouse input', async () => {
  const fixture = trustedInputFixture()
  const result = await runGuardedSelectorClick(fixture.controller, 'tab-a', '#open')

  assert.match(result, /"trustedInput":true/)
  assert.deepEqual(fixture.mouse.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.equal(fixture.scripts.some((script) => /\.click\s*\(|dispatchEvent\s*\(/.test(script)), false)
})

test('selector type focuses with trusted mouse input and writes through the browser input channel', async () => {
  const fixture = trustedInputFixture()
  const result = await runGuardedSelectorType(fixture.controller, 'tab-a', '#search', 'hello', {
    clearFirst: true,
    allowPasswordFill: false,
  })

  assert.match(result, /"trustedInput":true/)
  assert.deepEqual(fixture.mouse.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.deepEqual(fixture.typed, ['hello'])
  assert.ok(fixture.keys.length >= 3)
  assert.equal(fixture.scripts.some((script) => /\.click\s*\(|dispatchEvent\s*\(/.test(script)), false)
})
