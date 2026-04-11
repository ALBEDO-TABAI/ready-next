import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldIgnoreGlobalKeyboardShortcut } from '../renderer/modules/keyboard/shortcut-guard'

test('global keyboard shortcuts stay silent for text input targets and IME composition', () => {
  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    target: { tagName: 'TEXTAREA' } as unknown as EventTarget,
  }), true)

  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget,
  }), true)

  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    isComposing: true,
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), true)

  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    keyCode: 229,
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), true)

  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    activeElement: { tagName: 'INPUT' } as unknown as Element,
  }), true)

  assert.equal(shouldIgnoreGlobalKeyboardShortcut({
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), false)
})
