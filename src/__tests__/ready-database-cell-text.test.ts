import assert from 'node:assert/strict'
import test from 'node:test'
import { cellText, dateText } from '../renderer/modules/document/database/cell-text'

test('date cells read as dates, not JSON', () => {
  const now = new Date('2026-10-31T12:00:00')
  assert.equal(dateText('2026-11-03', now), '11月3日')
  assert.equal(dateText('2025-02-01T09:30', now), '2025年2月1日 09:30')
  assert.equal(cellText({ status: 'ok', value: { start: `${new Date().getFullYear()}-11-03`, end: `${new Date().getFullYear()}-11-05` } } as never), '11月3日 → 11月5日')
  assert.equal(cellText({ status: 'ok', value: { start: `${new Date().getFullYear()}-11-03`, end: `${new Date().getFullYear()}-11-03` } } as never), '11月3日')
  assert.equal(cellText({ status: 'ok', value: { title: '相关页' } } as never), '相关页')
})
