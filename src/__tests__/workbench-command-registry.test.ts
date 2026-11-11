import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { appShortcut } from '../shared/app-shortcuts'
import { registerCommands, listCommands } from '../renderer/modules/workbench/commands/registry'
import { requestShellAction, SHELL_ACTION_EVENT } from '../renderer/modules/workbench/commands/shell-actions'

test('registry owns ids atomically, filters modes, and releases only its registration', () => {
  let ran = false
  const shortcut = appShortcut('toggle-theme')
  const off = registerCommands('fixture', [
    { id: 'test.global', title: '切换主题', shortcut, run: () => { ran = true } },
    { id: 'test.calendar', title: '日历命令', when: { mode: 'calendar' }, run() {} },
  ])
  try {
    assert.equal(listCommands({ mode: 'browser' }).some(c => c.id === 'test.calendar'), false)
    const command = listCommands({ mode: 'calendar' }).find(c => c.id === 'test.global')!
    assert.equal(command.shortcut, shortcut)
    command.run(); assert.equal(ran, true)
    assert.throws(() => registerCommands('other', [{ id: 'test.new', title: '新命令', run() {} }, command]), /duplicate/i)
    assert.equal(listCommands({ mode: 'browser' }).some(c => c.id === 'test.new'), false)
    assert.throws(() => registerCommands('same-batch', [{ ...command, id: 'test.batch' }, { ...command, id: 'test.batch' }]), /duplicate/i)
    assert.throws(() => registerCommands('forged-shortcut', [{ ...command, id: 'test.forged', shortcut: { ...shortcut } }]), /app-shortcuts/)
  } finally { off() }
  const release = registerCommands('fixture', [{ id: 'test.global', title: '再次注册', run() {} }])
  off()
  assert.ok(listCommands({ mode: 'browser' }).some(c => c.id === 'test.global'))
  release()
  assert.equal(listCommands({ mode: 'calendar' }).some(c => c.id.startsWith('test.')), false)
})

test('shell request dispatches exactly one typed action on the shared event', () => {
  const dom = new JSDOM('')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  try {
    const actions: unknown[] = []
    dom.window.addEventListener(SHELL_ACTION_EVENT, event => actions.push((event as CustomEvent).detail))
    requestShellAction('toggle-theme'); requestShellAction('new-page')
    assert.deepEqual(actions, [{ action: 'toggle-theme' }, { action: 'new-page' }])
  } finally { dom.window.close(); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') }
})
