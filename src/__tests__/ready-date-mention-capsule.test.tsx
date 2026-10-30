import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'

test('C9 date capsule applies time/reminder in one buffer undo and preserves surrounding source', async t => {
  const original = '交稿 [日期](ready://calendar/day/2026-11-03) 之后'
  const f = await editorFixture(t, original)
  const capsule = document.querySelector<HTMLAnchorElement>('[data-ready-date-mention]')!
  assert.ok(capsule)
  await act(() => capsule.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
  assert.ok(document.querySelector('[aria-label="日期与提醒"]'))
  for (const [label, value] of [['时间', '15:00'], ['提前分钟', '10']]) {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    await act(() => {
      Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
      input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }))
    })
  }
  await act(() => document.querySelector('form[aria-label="日期与提醒"]')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(f.buffer.history.entries.length, 1)
  f.bytes('交稿 [2026-11-03 15:00](ready://calendar/day/2026-11-03?at=15:00\\&remind=10) 之后')
  await f.key(f.rich('交稿 2026-11-03 15:00 之后'), 'z', { ctrlKey: true })
  f.bytes(original)
})
