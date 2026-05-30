import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWorkbenchPanelShortcutAction } from '../renderer/modules/workbench/panel-shortcuts'

test('plain Tab toggles the chat panel when focus is not in an editable area', () => {
  const action = resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    selectionText: '',
    target: { tagName: 'BUTTON' } as unknown as EventTarget,
  })

  assert.strictEqual(action, 'toggle-chat')
})

test('plain ` and plain · both toggle the sidebar when no selection is active', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: '`',
    code: 'Backquote',
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), 'toggle-sidebar')

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: '·',
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), 'toggle-sidebar')
})

test('shortcuts stay disabled while typing, renaming, creating, or when text is selected', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    selectionText: '',
    target: { tagName: 'TEXTAREA' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    selectionText: 'selected text',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    selectionText: '',
    renamingPath: '/tmp/name',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: '`',
    selectionText: '',
    creatingType: 'file',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)
})

test('modifier keys and Shift+Tab do not trigger panel shortcuts', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    shiftKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    metaKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: '`',
    ctrlKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)
})

test('Ctrl+Tab cycles the side panel, even from an editable target', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    ctrlKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), 'cycle-side-panel')

  // Carries a modifier and isn't a typing key, so it still fires inside inputs.
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    ctrlKey: true,
    selectionText: '',
    target: { tagName: 'TEXTAREA' } as unknown as EventTarget,
  }), 'cycle-side-panel')
})

test('Ctrl+Tab with extra modifiers does not cycle, and plain Tab still toggles chat', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    ctrlKey: true,
    shiftKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    ctrlKey: true,
    altKey: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    selectionText: '',
    target: { tagName: 'BUTTON' } as unknown as EventTarget,
  }), 'toggle-chat')
})

test('shortcuts stay disabled during input method composition', () => {
  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: 'Tab',
    isComposing: true,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)

  assert.strictEqual(resolveWorkbenchPanelShortcutAction({
    key: '`',
    code: 'Backquote',
    keyCode: 229,
    selectionText: '',
    target: { tagName: 'DIV' } as unknown as EventTarget,
  }), null)
})
