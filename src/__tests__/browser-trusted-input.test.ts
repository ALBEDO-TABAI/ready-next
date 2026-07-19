import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  clearFocusedInput,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  runGuardedTargetType,
  sendKeyStroke,
} from '../main/modules/tools/browser-input-actions'
import { throwIfLiveTargetGuardBlocked } from '../main/modules/tools/browser-probe'

function trustedInputFixture() {
  const scripts: string[] = []
  const mouse: Array<Record<string, unknown>> = []
  const keys: Array<Record<string, unknown>> = []
  const typed: string[] = []
  let documentFocused = true
  let focusCalls = 0
  const controller = {
    getBrowserInputEnvironment: () => ({
      mainWindowForeground: true,
      hostPresentation: 'visible',
      tabActive: true,
    }),
    getPhysicalTargetToken: () => 'physical-tab-a',
    normalizedToCss: async (_tabId: string | null, x: number, y: number) => ({
      x: x / 2,
      y: y / 2,
      width: 500,
      height: 500,
    }),
    dispatchMouse: async (_tabId: string | null, event: Record<string, unknown>) => { mouse.push(event) },
    dispatchKey: async (_tabId: string | null, event: Record<string, unknown>) => { keys.push(event) },
    typeTextDirectly: async (_tabId: string | null, text: string) => { typed.push(text) },
    focusTrustedKeyboardTarget: () => {
      focusCalls += 1
      documentFocused = true
      return true
    },
    executeJS: async (_tabId: string | null, script: string) => {
      scripts.push(script)
      if (script.includes('activeElementEditable')) {
        return { ready: true, focused: documentFocused, activeElementEditable: true }
      }
      if (script.includes('__READY_CLICK_POINT_LABEL_PROBE__')) {
        return { label: 'Open', inputLabel: 'Search', editable: true, password: false }
      }
      if (script.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
        return { kind: 'editable', tag: 'input', label: 'Search', maxLength: 200, singleLine: true }
      }
      if (script.includes('__READY_AGENT_TARGET_SELECT_ALL__')) {
        return { ok: true, kind: 'text_control' }
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
  return {
    controller,
    scripts,
    mouse,
    keys,
    typed,
    setDocumentFocused: (focused: boolean) => { documentFocused = focused },
    focusCallCount: () => focusCalls,
  }
}

test('selector click only observes in page and dispatches trusted mouse input', async () => {
  const fixture = trustedInputFixture()
  const result = await runGuardedSelectorClick(fixture.controller, 'tab-a', '#open')

  assert.match(result, /"trustedInput":true/)
  assert.deepEqual(fixture.mouse.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.equal(fixture.scripts.some((script) => /\.click\s*\(|dispatchEvent\s*\(/.test(script)), false)
})

test('an unavailable point probe does not block visual clicks but still blocks unverifiable typing', async () => {
  const clickFixture = trustedInputFixture()
  const clickExecuteJS = clickFixture.controller.executeJS.bind(clickFixture.controller)
  clickFixture.controller.executeJS = async (tabId, script) => {
    if (String(script).includes('__READY_CLICK_POINT_LABEL_PROBE__')) throw new Error('probe unavailable')
    return clickExecuteJS(tabId, script)
  }
  await runGuardedCoordinateClick(clickFixture.controller, 'tab-a', 500, 500)
  assert.deepEqual(clickFixture.mouse.map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])

  const typeFixture = trustedInputFixture()
  const typeExecuteJS = typeFixture.controller.executeJS.bind(typeFixture.controller)
  typeFixture.controller.executeJS = async (tabId, script) => {
    if (String(script).includes('__READY_CLICK_POINT_LABEL_PROBE__')) throw new Error('probe unavailable')
    return typeExecuteJS(tabId, script)
  }
  await assert.rejects(
    runGuardedCoordinateType(typeFixture.controller, 'tab-a', 500, 500, 'hello', {
      clearBefore: false,
      pressEnter: false,
      useShiftEnter: false,
      allowPasswordFill: false,
    }),
    (error: unknown) => (error as { errorKind?: string }).errorKind === 'denied_pending_confirmation',
  )
  assert.equal(typeFixture.mouse.length, 0)
  assert.equal(typeFixture.typed.length, 0)
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
  assert.equal(fixture.keys.length, 0)
  assert.equal(fixture.scripts.some((script) => /\.click\s*\(|dispatchEvent\s*\(/.test(script)), false)
})

test('clear focused input sends a complete platform select-all shortcut before backspace', async () => {
  const fixture = trustedInputFixture()
  await clearFocusedInput(fixture.controller, 'tab-a')

  if (process.platform === 'darwin') {
    assert.deepEqual(fixture.keys, [
      { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4, isKeypad: false, commands: ['selectAll'] },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4, isKeypad: false },
      { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0, isKeypad: false, commands: ['deleteBackward'] },
      { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0, isKeypad: false },
    ])
    return
  }
  assert.deepEqual(fixture.keys.map((event) => [event.type, event.key]), [
    ['rawKeyDown', 'a'],
    ['keyUp', 'a'],
    ['rawKeyDown', 'Backspace'],
    ['keyUp', 'Backspace'],
  ])
})

test('target type focuses and verifies inside the target frame without pointer input', async () => {
  const fixture = trustedInputFixture()
  const frameScripts: string[] = []
  const runInTargetFrame = async (script: string): Promise<unknown> => {
    frameScripts.push(script)
    if (script.includes('__READY_AGENT_TARGET_FOCUS__')) {
      return { ok: true, kind: 'editable', tag: 'input', label: 'Field note' }
    }
    if (script.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
      return { kind: 'editable', tag: 'input', label: 'Field note', maxLength: 120, singleLine: true }
    }
    if (script.includes('__READY_AGENT_TARGET_SELECT_ALL__')) {
      return { ok: true, kind: 'text_control' }
    }
    if (script.includes('__READY_TYPED_INTO_PROBE__')) {
      return { tag: 'input', label: 'Field note', textHead: 'hello', textLength: 5 }
    }
    return null
  }

  const result = await runGuardedTargetType(
    fixture.controller,
    'tab-a',
    '3',
    'document-frame-3',
    { x: 250, y: 300, cssX: 125, cssY: 150, width: 500, height: 500 },
    'hello',
    { clearBefore: true, pressEnter: false, useShiftEnter: false, allowPasswordFill: false },
    runInTargetFrame,
  )

  assert.equal(result.typed, true)
  assert.deepEqual(fixture.mouse, [])
  assert.deepEqual(fixture.typed, ['hello'])
  assert.equal(frameScripts.filter((script) => script.includes('__READY_AGENT_TARGET_FOCUS__')).length, 1)
  assert.equal(frameScripts.filter((script) => script.includes('__READY_FOCUSED_EDITABLE_PROBE__')).length, 1)
  assert.equal(frameScripts.filter((script) => script.includes('__READY_TYPED_INTO_PROBE__')).length, 1)
  assert.equal(fixture.scripts.some((script) => script.includes('__READY_AGENT_TARGET_FOCUS__')), false)
})

test('target submit rechecks focus after text delivery instead of reusing the stale pre-type document state', async () => {
  const fixture = trustedInputFixture()
  fixture.setDocumentFocused(false)
  const runInTargetFrame = async (script: string): Promise<unknown> => {
    if (script.includes('__READY_AGENT_TARGET_FOCUS__')) {
      return { ok: true, kind: 'editable', tag: 'input', label: 'Search' }
    }
    if (script.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
      return {
        kind: 'editable',
        tag: 'input',
        label: 'Search',
        maxLength: 120,
        singleLine: true,
        documentFocused: false,
        documentReady: true,
      }
    }
    if (script.includes('__READY_AGENT_TARGET_SELECT_ALL__')) {
      return { ok: true, kind: 'text_control' }
    }
    if (script.includes("const token = 'text-'")) return 'text-token'
    if (script.includes("const token = 'submit-'")) return 'submit-token'
    if (script.includes('return { count: Number(state.count')) return { count: 1, changed: true }
    if (script.includes('return { keydown: Number(state.keydown')) return { keydown: 1, submit: 0 }
    if (script.includes('__READY_TYPED_INTO_PROBE__')) {
      return { tag: 'input', label: 'Search', textHead: 'hello', textLength: 5, textMatchesExpected: true }
    }
    return null
  }

  const result = await runGuardedTargetType(
    fixture.controller,
    'tab-a',
    '3',
    'document-frame-3',
    { x: 250, y: 300, cssX: 125, cssY: 150, width: 500, height: 500 },
    'hello',
    { clearBefore: true, pressEnter: true, useShiftEnter: false, allowPasswordFill: false },
    runInTargetFrame,
  )

  assert.equal(result.typed, true)
  assert.equal(result.textDelivery, 'delivered')
  assert.equal(result.submitDelivery, 'delivered')
  assert.deepEqual(fixture.typed, ['hello'])
  assert.equal(fixture.focusCallCount(), 0)
  assert.equal(fixture.keys.at(-2)?.key, 'Enter')
})

test('target submit returns a partial result when text landed but the keyboard transport fails', async () => {
  const fixture = trustedInputFixture()
  const originalExecuteJS = fixture.controller.executeJS.bind(fixture.controller)
  fixture.controller.executeJS = async (tabId, script) => {
    if (String(script).includes('activeElementEditable')) {
      return { ready: true, focused: false, activeElementEditable: true }
    }
    return originalExecuteJS(tabId, script)
  }
  fixture.controller.dispatchKey = async () => {
    throw Object.assign(new Error('Input.dispatchKeyEvent failed'), { code: 'CDP_COMMAND_FAILED' })
  }
  const runInTargetFrame = async (script: string): Promise<unknown> => {
    if (script.includes('__READY_AGENT_TARGET_FOCUS__')) {
      return { ok: true, kind: 'editable', tag: 'input', label: 'Search' }
    }
    if (script.includes('__READY_FOCUSED_EDITABLE_PROBE__')) {
      return {
        kind: 'editable',
        tag: 'input',
        label: 'Search',
        maxLength: 120,
        singleLine: true,
        documentFocused: false,
        documentReady: true,
      }
    }
    if (script.includes('__READY_AGENT_TARGET_SELECT_ALL__')) return { ok: true, kind: 'text_control' }
    if (script.includes("const token = 'text-'")) return 'text-token'
    if (script.includes("const token = 'submit-'")) return 'submit-token'
    if (script.includes('return { count: Number(state.count')) return { count: 1, changed: true }
    if (script.includes('return { keydown: Number(state.keydown')) return { keydown: 0, submit: 0 }
    if (script.includes('__READY_TYPED_INTO_PROBE__')) {
      return { tag: 'input', label: 'Search', textHead: 'hello', textLength: 5, textMatchesExpected: true }
    }
    return null
  }

  const result = await runGuardedTargetType(
    fixture.controller,
    'tab-a',
    '3',
    'document-frame-3',
    { x: 250, y: 300, cssX: 125, cssY: 150, width: 500, height: 500 },
    'hello',
    { clearBefore: true, pressEnter: true, useShiftEnter: false, allowPasswordFill: false },
    runInTargetFrame,
  )

  assert.equal(result.typed, true)
  assert.equal(result.textDelivery, 'delivered')
  assert.equal(result.submitDelivery, 'not_delivered')
  assert.equal(result.submitError, 'CDP_COMMAND_FAILED')
  assert.deepEqual(fixture.typed, ['hello'])
  assert.equal(fixture.keys.length, 0)
})

test('keyboard aliases dispatch case-insensitively to the exact hidden target without stealing focus', async () => {
  const fixture = trustedInputFixture()
  fixture.setDocumentFocused(false)
  fixture.controller.getBrowserInputEnvironment = () => ({
    mainWindowForeground: false,
    hostPresentation: 'hidden',
    tabActive: false,
  })
  await sendKeyStroke(fixture.controller, 'tab-a', 'ENTER')
  await sendKeyStroke(fixture.controller, 'tab-a', 'SPACE')

  assert.equal(fixture.focusCallCount(), 0)
  assert.equal(fixture.keys.at(-4)?.key, 'Enter')
  assert.equal(fixture.keys.at(-4)?.code, 'Enter')
  assert.equal(fixture.keys.at(-4)?.emulateFocus, true)
  assert.equal(fixture.keys.at(-3)?.key, 'Enter')
  assert.equal(fixture.keys.at(-2)?.key, ' ')
  assert.equal(fixture.keys.at(-2)?.code, 'Space')
})

test('live target guard is structural and ignores page labels', () => {
  assert.doesNotThrow(() => throwIfLiveTargetGuardBlocked({
    ok: true,
    label: '确认支付 captcha save password',
  }, { targetId: 'button-1' }))
  assert.throws(
    () => throwIfLiveTargetGuardBlocked({
      ok: false,
      errorKind: 'credential_confirmation_required',
      liveTargetKind: 'password',
    }, { targetId: 'input-1' }),
    (error: unknown) => (error as { errorKind?: string }).errorKind === 'credential_confirmation_required',
  )
  assert.throws(
    () => throwIfLiveTargetGuardBlocked({
      ok: false,
      errorKind: 'file_input_requires_upload',
      liveTargetKind: 'file',
    }, { targetId: 'input-2' }),
    (error: unknown) => (error as { errorKind?: string }).errorKind === 'file_input_requires_upload',
  )
})
