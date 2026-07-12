/**
 * W10b — document_insert_widget 位置语义合同（2026-07-11 dogfood 第四例）。
 *
 * 实锚：用户要求"在开头做一张信息卡"，widget 被写到 226 行文件的第 224 行（文末），
 * 完成宣告却称"已在文档开头标题后插入"。两个根因：
 *   1. 位置词汇缺失——只有 append_end / after_section，"开头"不可表达；
 *   2. execute.ts 把任何未知 position 静默强转为 append_end（静默降级）。
 * 合同：prepend_start 真实存在且落点正确；未知 position 响亮报错不落盘。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { insertWidgetIntoDocument } from '../renderer/modules/agent/document-actions/execute'

const FENCE_MARK = '```show-widget'

test('prepend_start 在 H1 大标题之后、正文之前插入', () => {
  const source = '# 视听剖析报告\n\n## 导读\n\n正文第一段。\n'
  const result = insertWidgetIntoDocument(source, 'info_card_summary', '<div>card</div>', 'prepend_start')
  assert.equal(result.inserted, true)
  const lines = result.content.split('\n')
  assert.equal(lines[0], '# 视听剖析报告')
  assert.equal(lines[1], '')
  assert.ok(lines[2].startsWith(FENCE_MARK), `围栏必须紧随大标题，实际：${lines[2]}`)
  assert.ok(
    result.content.indexOf(FENCE_MARK) < result.content.indexOf('## 导读'),
    '围栏必须出现在首个章节之前'
  )
})

test('prepend_start 对无 H1 的文档插到最顶部', () => {
  const source = '普通首行内容。\n\n第二段。\n'
  const result = insertWidgetIntoDocument(source, 'info_card_summary', '<div>card</div>', 'prepend_start')
  assert.equal(result.inserted, true)
  assert.ok(result.content.startsWith(FENCE_MARK))
  assert.match(result.content, /普通首行内容。/)
})

test('prepend_start 对空文档只落围栏', () => {
  const result = insertWidgetIntoDocument('', 'info_card_summary', '<div>card</div>', 'prepend_start')
  assert.equal(result.inserted, true)
  assert.ok(result.content.startsWith(FENCE_MARK))
})

test('append_end 语义保持不变（回归护栏）', () => {
  const source = '# 标题\n\n正文。\n'
  const result = insertWidgetIntoDocument(source, 'info_card_summary', '<div>card</div>', 'append_end')
  assert.equal(result.inserted, true)
  assert.ok(result.content.trimEnd().endsWith('```'), '围栏应在文末')
  assert.ok(result.content.indexOf('正文。') < result.content.indexOf(FENCE_MARK))
})

test('after_section 未命中章节仍是响亮失败（回归护栏）', () => {
  const source = '# 标题\n\n## 导读\n\n正文。\n'
  const result = insertWidgetIntoDocument(source, 'info_card_summary', '<div>card</div>', 'after_section', '不存在的章节')
  assert.equal(result.inserted, false)
  assert.match(result.error || '', /未找到章节/)
})

test('同标题 widget 走 upsert 而非重复插入（回归护栏）', () => {
  const source = '# 标题\n\n正文。\n'
  const first = insertWidgetIntoDocument(source, 'info_card_summary', '<div>v1</div>', 'prepend_start')
  const second = insertWidgetIntoDocument(first.content, 'info_card_summary', '<div>v2</div>', 'prepend_start')
  assert.equal(second.updatedExisting, true)
  assert.equal((second.content.match(/```show-widget/g) || []).length, 1)
  assert.match(second.content, /v2/)
})
