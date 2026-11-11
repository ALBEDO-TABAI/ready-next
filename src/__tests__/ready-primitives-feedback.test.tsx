import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'

const { FloatHost, tooltip, openDialog, confirmDialog, ToastHost, showToast, dismissToast } = ui

test('Tooltip delays opening, cancels on leave, and closes immediately on pointerdown', async t => {
  const h = await mountPrimitives(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await h.render(<><button {...tooltip('查看详情', '⌘I')}>详情</button><FloatHost /></>)
  const trigger = h.get('button')
  const hover = async () => { await act(async () => { trigger.dispatchEvent(new h.dom.window.MouseEvent('mouseover', { bubbles: true })) }) }
  const leave = async () => { await act(async () => { trigger.dispatchEvent(new h.dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: h.body })) }) }
  const tick = async (ms: number) => { await act(async () => t.mock.timers.tick(ms)) }
  await hover(); await tick(449); assert.equal(h.body.querySelector('[role="tooltip"]'), null)
  await tick(1); assert.equal(h.get('[role="tooltip"]').textContent, '查看详情⌘I')
  await leave(); assert.equal(h.body.querySelector('[role="tooltip"]'), null)
  await hover(); await tick(200); await leave(); await tick(450)
  assert.equal(h.body.querySelector('[role="tooltip"]'), null)
  await hover(); await tick(450); await h.pointer(trigger)
  assert.equal(h.body.querySelector('[role="tooltip"]'), null)
  await hover(); await tick(200); await h.pointer(trigger); await tick(450)
  assert.equal(h.body.querySelector('[role="tooltip"]'), null)
})

test('Tooltip opens on keyboard focus without stealing it and closes on blur', async t => {
  const h = await mountPrimitives(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await h.render(<><button {...tooltip('键盘提示')}>提示</button><button id="other">其他</button><FloatHost /></>)
  const trigger = h.get('button')
  await act(async () => trigger.focus())
  assert.equal(trigger.matches(':focus-visible'), true)
  await act(async () => t.mock.timers.tick(450))
  assert.equal(h.get('[role="tooltip"]').textContent, '键盘提示')
  assert.equal(h.dom.window.document.activeElement, trigger)
  await act(async () => h.get('#other').focus())
  assert.equal(h.body.querySelector('[role="tooltip"]'), null)
})

for (const dismiss of ['escape', 'backdrop'] as const) {
  test(`Dialog is named and modal, focuses its action and closes via ${dismiss}`, async t => {
    const h = await mountPrimitives(t)
    await h.render(<FloatHost />)
    let closed = 0
    await act(async () => { openDialog({ title: '删除页面？', body: '页面将移到回收站', actions: [{ label: '确定', autoFocus: true }], onClose: () => closed++ }) })
    const dialog = h.get('[role="dialog"]')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-label'), '删除页面？')
    assert.match(dialog.textContent!, /页面将移到回收站/)
    const backdrop = h.get('[data-ready-native-overlay="float-backdrop"]')
    assert.equal(h.dom.window.document.activeElement, h.get('button', dialog))
    if (dismiss === 'escape') await h.key(dialog, 'Escape')
    else await h.pointer(backdrop)
    assert.equal(h.body.querySelector('[role="dialog"]'), null)
    assert.equal(h.body.querySelector('[data-ready-native-overlay="float-backdrop"]'), null)
    assert.equal(closed, 1)
  })
}

for (const choice of ['confirm', 'cancel', 'escape', 'backdrop'] as const) {
  test(`confirmDialog resolves ${choice === 'confirm'} for ${choice}`, async t => {
    const h = await mountPrimitives(t)
    await h.render(<FloatHost />)
    let result: Promise<boolean> | undefined
    await act(async () => { result = confirmDialog({ title: '继续？' }) })
    const dialog = h.get('[role="dialog"]')
    if (choice === 'escape') await h.key(dialog, 'Escape')
    else if (choice === 'backdrop') await h.pointer(h.get('[data-ready-native-overlay="float-backdrop"]'))
    else {
      const button = [...dialog.querySelectorAll('button')].find(item => item.textContent === (choice === 'confirm' ? '确定' : '取消'))
      assert.ok(button); await h.click(button)
    }
    assert.equal(await result, choice === 'confirm')
    assert.equal(h.body.querySelector('[role="dialog"]'), null)
  })
}

test('Toast announces in a status region and expires at the configured time', async t => {
  const h = await mountPrimitives(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await h.render(<ToastHost />)
  let id = 0
  t.after(() => dismissToast(id))
  await act(async () => { id = showToast('已保存', { durationMs: 1000 }) })
  const status = h.get('[role="status"]')
  assert.equal(status.getAttribute('aria-live'), 'polite'); assert.equal(status.textContent, '已保存')
  await act(async () => t.mock.timers.tick(999)); assert.equal(status.textContent, '已保存')
  await act(async () => t.mock.timers.tick(1)); assert.equal(status.textContent, '')
})

test('Toast action executes once and dismisses the notification', async t => {
  const h = await mountPrimitives(t)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await h.render(<ToastHost />)
  let calls = 0, id = 0
  t.after(() => dismissToast(id))
  await act(async () => { id = showToast('已删除', { action: { label: '撤销', onClick: () => calls++ } }) })
  const action = h.get<HTMLButtonElement>('[role="status"] button')
  assert.equal(action.textContent, '撤销')
  await h.activateButton(action, 'Enter')
  assert.equal(calls, 1); assert.equal(h.get('[role="status"]').textContent, '')
  await act(async () => t.mock.timers.tick(4000)); assert.equal(calls, 1)
})
