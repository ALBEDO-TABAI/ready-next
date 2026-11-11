const assert = require('node:assert/strict')
const test = require('node:test')
const { checkTable, inspectSource } = require('../check-shortcut-conflicts.cjs')
const entry = (id, keys, scope = 'global') => ({ id, keys, scope, description: id })
test('duplicate chords fail in the same scope, including modifier aliases and order', () => {
  assert.equal(checkTable([entry('a', 'Alt+Cmd+K'), entry('b', 'Command+Option+K')]).length, 1)
  assert.equal(checkTable([entry('a', 'CommandOrControl+K'), entry('b', 'Ctrl+K')]).length, 1)
  assert.deepEqual(checkTable([entry('a', 'Command+K'), entry('b', 'Command+K', 'calendar')]), [])
})
test('direct, aliased, guarded and switch-based unregistered command chords fail', () => {
  for (const source of [
    `function key(e) { if (e.metaKey && e.key === ',') open() }`,
    `function key({metaKey, key}) { if (metaKey && key === ',') open() }`,
    `function key(e) { const mod = e.metaKey || e.ctrlKey; const key = e.key.toLowerCase(); if (mod && key === ',') open() }`,
    `function key(e) { if (!(e.metaKey || e.ctrlKey)) return; if (e.key === ',') open() }`,
    `function key(e) { if(e.metaKey) { switch(e.key) { case ',': open(); break } } }`,
  ]) {
    assert.ok(inspectSource('module.ts', source, []).length, source)
    assert.deepEqual(inspectSource('module.ts', source, [entry('settings', 'CommandOrControl+,')]), [])
  }
})
test('module scope, bare keys, reasoned internal handler and native accelerators', () => {
  const source = `function key(e) { if (e.metaKey && e.key === 'j') join() }`
  const table = [entry('join', 'CommandOrControl+J', 'calendar')]
  assert.ok(inspectSource('module.ts', source, table).length)
  assert.deepEqual(inspectSource('module.ts', '// shortcut-scope: calendar -- selected event commands\n' + source, table), [])
  assert.deepEqual(inspectSource('module.ts', '// shortcut-internal: editing only inside this field\n' + source, []), [])
  assert.ok(inspectSource('module.ts', '// shortcut-internal:\n' + source, []).length)
  assert.deepEqual(inspectSource('module.ts', `function key(e) { if(e.metaKey || e.ctrlKey) return; if(e.key === 'j') next() }`, []), [])
  assert.ok(inspectSource('main.ts', `globalShortcut.register('CommandOrControl+U', open)`, []).length)
  assert.ok(inspectSource('menu.ts', `const menu = {accelerator: 'Cmd+U'}`, []).length)
})
