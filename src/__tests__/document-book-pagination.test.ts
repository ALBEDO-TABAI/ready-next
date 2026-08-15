/**
 * 阅读模式分页引擎合同（纯模型部分）：
 * 块→页映射（含跨页块真实栏序号）、页模型锚点、对开映射、翻页叶片正反面。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOK_TITLE_PAGE,
  buildBookPageModel,
  locatePageForAnchor,
  resolveFlipSheet,
  spreadAt,
  spreadCountForPages,
  spreadForPage,
} from '../renderer/modules/document/book/bookPagination'

const CONTENT_HEIGHT = 500

test('buildBookPageModel：跨页块保留真实分栏列，锚点取首个非延续块', () => {
  const model = buildBookPageModel([
    { blockIdx: 0, startCol: 0, endCol: 0, offsetY: 20, height: 200 },
    { blockIdx: 1, startCol: 0, endCol: 1, offsetY: 240, height: 600 },
    { blockIdx: 2, startCol: 1, endCol: 1, offsetY: 100, height: 300 },
  ], 380, CONTENT_HEIGHT)

  assert.equal(model.pageCount, 2)
  assert.deepEqual(
    model.pages[0].entries.map((entry) => [
      entry.blockIdx,
      entry.offsetY,
      entry.continued,
      entry.columnIndex,
      entry.spansPages,
      entry.startOffsetY,
    ]),
    [[0, 20, false, 0, false, 20], [1, 240, false, 0, true, 240]],
  )
  assert.deepEqual(
    model.pages[1].entries.map((entry) => [
      entry.blockIdx,
      entry.offsetY,
      entry.continued,
      entry.columnIndex,
      entry.spansPages,
      entry.startOffsetY,
    ]),
    [[1, 240, true, 1, true, 240], [2, 100, false, 0, false, 100]],
  )
  assert.equal(model.pages[0].anchorBlock, 0)
  assert.ok(Math.abs(model.pages[0].anchorRatio - 0.04) < 1e-9)
  assert.equal(model.pages[1].anchorBlock, 2)
  assert.ok(Math.abs(model.pages[1].anchorRatio - 0.2) < 1e-9)
})

test('buildBookPageModel：空文档保底一页；跨三页块逐页记录栏序号', () => {
  const empty = buildBookPageModel([], 380, CONTENT_HEIGHT)
  assert.equal(empty.pageCount, 1)
  assert.equal(empty.pages[0].entries.length, 0)

  const model = buildBookPageModel([
    { blockIdx: 0, startCol: 0, endCol: 2, offsetY: 40, height: 1400 },
  ], 380, CONTENT_HEIGHT)
  assert.equal(model.pageCount, 3)
  assert.deepEqual(
    model.pages.map((page) => page.entries[0].columnIndex),
    [0, 1, 2],
  )
  // 全部为延续片段的页：锚点回退到该块、比例为 0
  assert.equal(model.pages[1].anchorBlock, 0)
  assert.equal(model.pages[1].anchorRatio, 0)
})

test('locatePageForAnchor：命中起始页、前溯回退、兜底第 0 页', () => {
  const model = buildBookPageModel([
    { blockIdx: 0, startCol: 0, endCol: 0, offsetY: 20, height: 200 },
    { blockIdx: 2, startCol: 1, endCol: 1, offsetY: 100, height: 300 },
  ], 380, CONTENT_HEIGHT)
  assert.equal(locatePageForAnchor(model, 2), 1)
  assert.equal(locatePageForAnchor(model, 0), 0)
  assert.equal(locatePageForAnchor(model, 99), 1, '锚块消失时前溯到最近含较小块的页')
  assert.equal(locatePageForAnchor(model, -5), 0)
})

test('对开映射：spread0 = [扉页, 第0页]，其后 [2k−1, 2k]', () => {
  assert.equal(spreadCountForPages(0), 0)
  assert.equal(spreadCountForPages(1), 1)
  assert.equal(spreadCountForPages(2), 2)
  assert.equal(spreadCountForPages(3), 2)
  assert.equal(spreadCountForPages(4), 3)

  assert.deepEqual(spreadAt(0, 5), { index: 0, left: BOOK_TITLE_PAGE, right: 0 })
  assert.deepEqual(spreadAt(1, 5), { index: 1, left: 1, right: 2 })
  assert.deepEqual(spreadAt(2, 5), { index: 2, left: 3, right: 4 })
  assert.deepEqual(spreadAt(2, 4), { index: 2, left: 3, right: null })

  assert.equal(spreadForPage(0), 0)
  assert.equal(spreadForPage(1), 1)
  assert.equal(spreadForPage(2), 1)
  assert.equal(spreadForPage(3), 2)
  assert.equal(spreadForPage(4), 2)
})

test('resolveFlipSheet：前翻取当前右页/下一左页，后翻取当前左页/前一右页', () => {
  assert.deepEqual(resolveFlipSheet(0, 3, 'forward'), { front: 0, back: 1 })
  assert.deepEqual(resolveFlipSheet(1, 3, 'forward'), { front: 2, back: null })
  assert.equal(resolveFlipSheet(1, 2, 'forward'), null, '右页缺失则无前翻')
  assert.deepEqual(resolveFlipSheet(1, 3, 'backward'), { front: 1, back: 0 })
  assert.equal(resolveFlipSheet(0, 3, 'backward'), null, '首个对开后翻 = 合封面（由视图特判）')
})
