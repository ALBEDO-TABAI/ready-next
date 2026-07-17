import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arePdfPageSlotRenderInputsEqual,
  countPdfPagesInRange,
  getPdfPageRenderRange,
} from '../renderer/modules/document/pdfPageWindow'

test('500-page PDF render window never mounts more than seven pages', () => {
  for (const current of [1, 2, 250, 499, 500]) {
    const range = getPdfPageRenderRange(500, current)
    assert.ok(range.start >= 1)
    assert.ok(range.end <= 500)
    assert.ok(current >= range.start && current <= range.end)
    assert.ok(countPdfPagesInRange(range) <= 7)
  }
})

test('PDF page window clamps invalid and edge current pages', () => {
  assert.deepEqual(getPdfPageRenderRange(0, 1), { start: 0, end: -1 })
  assert.deepEqual(getPdfPageRenderRange(10, -3), { start: 1, end: 4 })
  assert.deepEqual(getPdfPageRenderRange(10, 99), { start: 7, end: 10 })
})

test('PDF zoom rerenders mounted pages but not hundreds of offscreen slots', () => {
  const registerPageRef = () => undefined
  const recordPageHeight = () => undefined
  const offscreen = {
    pageNumber: 200,
    shouldRender: false,
    pageHeight: 792,
    scale: 1,
    registerPageRef,
    recordPageHeight,
  }
  const mounted = { ...offscreen, pageNumber: 3, shouldRender: true }

  assert.equal(arePdfPageSlotRenderInputsEqual(offscreen, { ...offscreen, scale: 3 }), true)
  assert.equal(arePdfPageSlotRenderInputsEqual(mounted, { ...mounted, scale: 3 }), false)
  assert.equal(arePdfPageSlotRenderInputsEqual(offscreen, { ...offscreen, shouldRender: true }), false)
})
