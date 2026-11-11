import assert from 'node:assert/strict'
import test from 'node:test'
import {
  READY_SHORTCUT_GUIDE,
  resolveReadyAppShortcut,
} from '../shared/app-shortcuts'

test('global shortcut resolver matches the shortcuts shown in Settings', () => {
  assert.equal(resolveReadyAppShortcut({ key: 's', metaKey: true, shiftKey: true }), 'capture-window')
  assert.equal(resolveReadyAppShortcut({ key: 'k', metaKey: true }), 'open-search')
  assert.equal(resolveReadyAppShortcut({ key: ',', metaKey: true }), 'open-settings')
  assert.equal(resolveReadyAppShortcut({ key: 'b', metaKey: true }), 'toggle-sidebar')
  assert.equal(resolveReadyAppShortcut({ key: 't', metaKey: true }), 'new-document')
  assert.equal(resolveReadyAppShortcut({ key: 's', metaKey: true }), 'save-document')
  assert.equal(resolveReadyAppShortcut({ key: 's', ctrlKey: true }), 'save-document')
  assert.equal(resolveReadyAppShortcut({ key: 'w', metaKey: true }), 'close-document')
  assert.equal(resolveReadyAppShortcut({ key: '\\', metaKey: true }), 'toggle-theme')
  assert.equal(resolveReadyAppShortcut({ key: 'Home' }), 'open-ready')
  assert.equal(resolveReadyAppShortcut({ key: 'F1' }), 'switch-browser')
  assert.equal(resolveReadyAppShortcut({ key: 'F4' }), 'switch-calendar')
  assert.equal(resolveReadyAppShortcut({ key: '1', metaKey: true }), 'switch-browser')
  assert.equal(resolveReadyAppShortcut({ key: '4', ctrlKey: true }), 'switch-calendar')

  assert.ok(READY_SHORTCUT_GUIDE.some((item) => item.id === 'capture-window' && item.value.includes('S')))
  assert.ok(READY_SHORTCUT_GUIDE.some((item) => item.id === 'switch-calendar' && item.value.includes('4')))
  assert.equal(READY_SHORTCUT_GUIDE.some((item) => item.id === 'newTask'), false)
  assert.equal(READY_SHORTCUT_GUIDE.some((item) => item.id === 'globalSearch'), false)
})

test('global shortcuts reject extra modifiers and unsupported mode numbers', () => {
  assert.equal(resolveReadyAppShortcut({ key: 'b', metaKey: true, altKey: true }), null)
  assert.equal(resolveReadyAppShortcut({ key: 's', metaKey: true, shiftKey: true, altKey: true }), null)
  assert.equal(resolveReadyAppShortcut({ key: '5', metaKey: true }), null)
  assert.equal(resolveReadyAppShortcut({ key: 'F6' }), null)
  assert.equal(resolveReadyAppShortcut({ key: 'Enter', metaKey: true }), null)
})
