import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'

const { FloatHost, openFloat, closeFloat, isFloatOpen, openMenu } = ui
const anchor = { left: 40, top: 40, right: 80, bottom: 60 }
const content = { anchor, render: () => <span>浮层内容</span> }

test('Float marks the native overlay, focuses itself and dismisses outside exactly once', async t => {
  const h = await mountPrimitives(t)
  await h.render(<><button>外部</button><FloatHost /></>)
  let closed = 0, id = ''
  await act(async () => { id = openFloat({ ...content, onClose: () => closed++ }) })
  const frame = h.get('[data-float-id]')
  assert.equal(frame.getAttribute('data-float-id'), id)
  assert.equal(frame.getAttribute('data-ready-native-overlay'), 'float')
  assert.equal(h.dom.window.document.activeElement, frame)
  await h.pointer(frame); assert.equal(isFloatOpen(id), true)
  await h.pointer(h.get('button'))
  assert.equal(isFloatOpen(id), false); assert.equal(h.body.querySelector('[data-float-id]'), null)
  assert.equal(closed, 1)
  await act(async () => closeFloat(id)); assert.equal(closed, 1)
})

test('A second unrelated Float replaces the first and calls its close handler', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  let first = '', second = '', closed = 0
  await act(async () => { first = openFloat({ ...content, onClose: () => closed++ }) })
  await act(async () => { second = openFloat(content) })
  assert.equal(isFloatOpen(first), false); assert.equal(isFloatOpen(second), true)
  assert.equal(closed, 1); assert.equal(h.body.querySelectorAll('[data-float-id]').length, 1)
})

test('Child floats coexist; Escape dismisses only the top child, then the parent', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  const closed: string[] = []
  let parent = '', child = ''
  await act(async () => { parent = openFloat({ ...content, onClose: () => closed.push('parent') }) })
  await act(async () => { child = openFloat({ ...content, parent, onClose: () => closed.push('child') }) })
  assert.equal(h.body.querySelectorAll('[data-float-id]').length, 2)
  await h.pointer(h.get(`[data-float-id="${child}"]`))
  assert.equal(isFloatOpen(parent), true); assert.equal(isFloatOpen(child), true)
  await h.key(h.get(`[data-float-id="${child}"]`), 'Escape')
  assert.equal(isFloatOpen(parent), true); assert.equal(isFloatOpen(child), false)
  assert.deepEqual(closed, ['child'])
  await h.key(h.get(`[data-float-id="${parent}"]`), 'Escape')
  assert.equal(isFloatOpen(), false); assert.deepEqual(closed, ['child', 'parent'])
})

test('Closing a parent closes its child and reports both once', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  const closed: string[] = []
  let parent = ''
  await act(async () => { parent = openFloat({ ...content, onClose: () => closed.push('parent') }) })
  await act(async () => { openFloat({ ...content, parent, onClose: () => closed.push('child') }) })
  await act(async () => closeFloat(parent))
  assert.deepEqual(closed, ['child', 'parent']); assert.equal(isFloatOpen(), false)
  assert.equal(h.body.querySelector('[data-float-id]'), null)
})

test('A tooltip does not close an existing menu or steal its focus', async t => {
  const h = await mountPrimitives(t)
  await h.render(<FloatHost />)
  let menuId = '', tooltipId = ''
  await act(async () => { menuId = openMenu(anchor, [{ id: 'open', label: '打开', onSelect: () => {} }], { label: '操作' }) })
  const menu = h.get('[role="menu"]')
  assert.equal(h.dom.window.document.activeElement, menu)
  await act(async () => { tooltipId = openFloat({ ...content, role: 'tooltip', noFocus: true }) })
  assert.equal(isFloatOpen(menuId), true); assert.equal(isFloatOpen(tooltipId), true)
  assert.ok(h.get('[role="tooltip"]')); assert.equal(h.dom.window.document.activeElement, menu)
})

test('Float chooses data-autofocus; noFocus leaves the external control focused', async t => {
  const h = await mountPrimitives(t)
  await h.render(<><button id="trigger">打开</button><FloatHost /></>)
  const trigger = h.get('#trigger'); trigger.focus()
  await act(async () => { openFloat({ ...content, noFocus: true, render: () => <input data-autofocus aria-label="姓名" /> }) })
  assert.equal(h.dom.window.document.activeElement, trigger)
  await act(async () => { openFloat({ ...content, render: () => <input data-autofocus aria-label="姓名" /> }) })
  assert.equal(h.dom.window.document.activeElement, h.get('input[aria-label="姓名"]'))
})
