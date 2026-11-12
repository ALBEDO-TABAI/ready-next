import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'
import type { MenuEntry } from '../renderer/components/ui/float/Menu'

const { FloatHost, openMenu, openContextMenu, isFloatOpen } = ui
const anchor = { left: 30, top: 30, right: 70, bottom: 60 }
const entries = (select: (id: string) => void): MenuEntry[] => [
  { kind: 'group', label: '页面' },
  { id: 'blocked-first', label: 'Blocked', disabled: true, onSelect: () => select('blocked') },
  { id: 'alpha', label: 'Alpha', onSelect: () => select('alpha') },
  { kind: 'separator' },
  { id: 'blocked-middle', label: 'Bravo', disabled: true, onSelect: () => select('blocked') },
  { kind: 'group', label: '其他' },
  { id: 'beta', label: 'Beta', checked: true, onSelect: () => select('beta') },
  { id: 'apple', label: 'Apple', checked: false, onSelect: () => select('apple') },
]

test('Menu focuses its named list and arrows/Home/End skip non-items and disabled items', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  const selected: string[] = []
  let id = ''
  await act(async () => { id = openMenu(anchor, entries(value => selected.push(value)), { label: '页面操作' }) })
  const menu = h.get('[role="menu"]')
  assert.equal(menu.getAttribute('aria-label'), '页面操作')
  assert.equal(h.dom.window.document.activeElement, menu)
  const highlighted = () => {
    const active = menu.querySelectorAll('[data-highlighted="true"]')
    assert.equal(active.length, 1)
    return active[0].textContent
  }
  assert.equal(highlighted(), 'Alpha')
  for (const [key, name] of [['ArrowDown', 'Beta'], ['ArrowDown', 'Apple'], ['ArrowDown', 'Alpha'], ['ArrowUp', 'Apple'], ['Home', 'Alpha'], ['End', 'Apple']]) {
    await h.key(menu, key); assert.equal(highlighted(), name)
  }
  const checks = [...menu.querySelectorAll('[role="menuitemcheckbox"]')]
  assert.deepEqual(checks.map(item => [item.textContent, item.getAttribute('aria-checked')]), [['Beta', 'true'], ['Apple', 'false']])
  await h.click(h.get('[aria-disabled="true"]', menu))
  assert.deepEqual(selected, []); assert.equal(isFloatOpen(id), true)
  await h.key(menu, 'Enter')
  assert.deepEqual(selected, ['apple']); assert.equal(isFloatOpen(id), false)
  assert.equal(h.body.querySelector('[role="menu"]'), null)
})

test('Menu typeahead is case-insensitive, wraps and ignores disabled matches; Space selects', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  const selected: string[] = []
  await act(async () => { openMenu(anchor, entries(value => selected.push(value))) })
  const menu = h.get('[role="menu"]')
  for (const [key, name] of [['a', 'Apple'], ['A', 'Alpha'], ['b', 'Beta'], ['z', 'Beta']]) {
    await h.key(menu, key)
    assert.equal(h.get('[data-highlighted="true"]', menu).textContent, name)
  }
  await h.key(menu, ' ')
  assert.deepEqual(selected, ['beta']); assert.equal(h.body.querySelector('[role="menu"]'), null)
})

test('openContextMenu prevents the native menu and positions its float at the pointer', async t => {
  const h = await mountPrimitives(t)
  await h.render(<><div onContextMenu={event => openContextMenu(event, entries(() => {}), '右键操作')}>目标</div><FloatHost /></>)
  const event = new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 123, clientY: 234 })
  await act(async () => { h.get('#root > div').dispatchEvent(event) })
  assert.equal(event.defaultPrevented, true)
  assert.equal(h.get('[role="menu"]').getAttribute('aria-label'), '右键操作')
  const frame = h.get('[data-float-id]')
  assert.equal(frame.style.left, '123px')
  assert.equal(frame.style.top, '240px') // pointer y + the shared 6px float gap
})

test('A checkable item with an icon keeps the icon in front and shows its state at the end', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  await act(async () => {
    openMenu(anchor, [
      { id: 'book', label: '书本阅读', icon: <svg data-icon="book" />, checked: true, onSelect: () => {} },
      { id: 'marks', label: '书签与笔记', icon: <svg data-icon="marks" />, checked: false, onSelect: () => {} },
    ], { label: '页面操作' })
  })
  const [on, off] = [...h.get('[role="menu"]').querySelectorAll('[role="menuitemcheckbox"]')]
  assert.equal(on.firstElementChild?.getAttribute('data-icon'), 'book', 'the icon leads the row')
  assert.ok(on.lastElementChild?.matches('.rn-menu__check') && on.lastElementChild.querySelector('svg'), 'a checked item ends with its check')
  assert.equal(off.firstElementChild?.getAttribute('data-icon'), 'marks')
  assert.ok(off.lastElementChild?.matches('.rn-menu__check') && !off.lastElementChild.querySelector('svg'), 'an unchecked item keeps the slot empty')
  assert.equal(on.getAttribute('aria-checked'), 'true')
  assert.equal(off.getAttribute('aria-checked'), 'false')
})
