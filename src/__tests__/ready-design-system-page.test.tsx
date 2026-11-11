import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { DesignSystem, mountPrimitives } from './utils/primitives-ui-harness'

test('DesignSystem renders both themes and toggles the reduced-transparency preview', async t => {
  const h = await mountPrimitives(t)
  await h.render(<DesignSystem />)
  const page = h.get('[data-design-system-page]')
  for (const theme of ['light', 'dark']) {
    const column = h.get(`[data-theme="${theme}"]`, page)
    assert.ok(column.querySelector('button'))
    assert.ok(column.querySelector('input'))
    assert.ok(column.querySelector('[role="tablist"]'))
  }
  const toggle = h.get<HTMLButtonElement>('[role="switch"][aria-label="预览减少透明"]')
  assert.equal(toggle.getAttribute('aria-checked'), 'false')
  assert.notEqual(page.getAttribute('data-transparency'), 'reduced')
  await h.click(toggle)
  assert.equal(toggle.getAttribute('aria-checked'), 'true')
  assert.equal(page.getAttribute('data-transparency'), 'reduced')
  await h.click(toggle)
  assert.equal(toggle.getAttribute('aria-checked'), 'false')
  assert.notEqual(page.getAttribute('data-transparency'), 'reduced')
})
