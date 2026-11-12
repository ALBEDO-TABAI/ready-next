import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { importWithoutStyles } from './utils/import-without-styles'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'
import type { ContextMenuItem } from '../renderer/components/layout/ContextMenu'

// B13 (W1 §5, DS4): the shell's declarative ContextMenu is drawn by the shared float — one menu implementation,
// the float's keyboard and native-layer hand-off — while its props API stays for every caller.
const { default: ContextMenu } = await importWithoutStyles(() => import('../renderer/components/layout/ContextMenu'))
const { FloatHost, isFloatOpen } = ui

function Harness({ log, initial = true }: { log: string[]; initial?: boolean }) {
  const [open, setOpen] = useState(initial)
  const [tick, setTick] = useState(0)
  const items: ContextMenuItem[] = [
    { id: 'copy', label: '复制', shortcut: '⌘C', onClick: () => log.push(`copy:${tick}`) },
    { id: 'sep', label: '', separator: true },
    { id: 'blocked', label: '不可用', disabled: true, onClick: () => log.push('blocked') },
    { id: 'delete', label: '删除', danger: true, onClick: () => log.push('delete') },
  ]
  return (
    <>
      <button type="button" data-outside="true" onClick={() => setTick(value => value + 1)}>外部</button>
      {open && <ContextMenu x={40} y={50} items={items} onClose={() => { log.push('close'); setOpen(false) }} portal />}
      <FloatHost />
    </>
  )
}

test('ContextMenu opens the shared float menu with its items, hint and danger row; a choice runs once and closes', async t => {
  const h = await mountPrimitives(t)
  const log: string[] = []
  await h.render(<Harness log={log} />)
  const frame = h.get('[data-float-id]')
  assert.equal(frame.getAttribute('data-ready-native-overlay'), 'float', 'the native web layer steps aside for it')
  const menu = h.get('[role="menu"]', frame)
  assert.deepEqual([...menu.querySelectorAll('[role="menuitem"] .rn-menu__label')].map(node => node.textContent), ['复制', '不可用', '删除'])
  assert.equal(h.get('.rn-menu__hint', menu).textContent, '⌘C')
  assert.ok(menu.querySelector('[role="separator"]'))
  assert.equal(h.get('[data-danger="true"]', menu).textContent, '删除')
  await h.click(h.get('[aria-disabled="true"]', menu))
  assert.deepEqual(log, [])
  await h.key(menu, 'Enter')
  assert.deepEqual(log, ['close', 'copy:0'])
  assert.equal(h.body.querySelector('[role="menu"]'), null)
  assert.equal(isFloatOpen(), false)
})

for (const dismiss of ['escape', 'outside'] as const) {
  test(`ContextMenu closes on ${dismiss === 'escape' ? 'Escape' : 'a click outside'}, calling onClose once`, async t => {
    const h = await mountPrimitives(t)
    const log: string[] = []
    await h.render(<Harness log={log} />)
    if (dismiss === 'escape') await h.key(h.get('[role="menu"]'), 'Escape')
    else await h.pointer(h.get('[data-outside="true"]'))
    assert.deepEqual(log, ['close'])
    assert.equal(h.body.querySelector('[role="menu"]'), null)
  })
}

test('a caller that re-renders while the menu is open keeps one menu, and a choice runs the latest handler', async t => {
  const h = await mountPrimitives(t)
  const log: string[] = []
  await h.render(<Harness log={log} />)
  const before = h.get('[data-float-id]').getAttribute('data-float-id')
  // Re-render the caller (new items array, new handlers) without moving the menu.
  await act(async () => { h.get<HTMLButtonElement>('[data-outside="true"]').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true })) })
  assert.equal(h.body.querySelectorAll('[data-float-id]').length, 1)
  assert.equal(h.get('[data-float-id]').getAttribute('data-float-id'), before)
  await h.key(h.get('[role="menu"]'), 'Enter')
  assert.deepEqual(log, ['close', 'copy:1'])
})
