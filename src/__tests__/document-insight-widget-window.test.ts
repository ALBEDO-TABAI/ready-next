import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildDocumentChunks,
  selectWidgetCenteredChunks,
} from '../shared/document-sectioning'

function buildWidgetFence(title: string, body = '<div>x</div>'): string {
  return ['```show-widget', JSON.stringify({ title, widget_code: body }), '```'].join('\n')
}

const CONTENT = [
  '# Section A',
  '',
  '第一段关于 A 的长文本 1 '.repeat(8),
  '',
  '第一段关于 A 的长文本 2 '.repeat(8),
  '',
  '# Section B',
  '',
  '第一段关于 B 的长文本 '.repeat(8),
  '',
  buildWidgetFence('target_card'),
  '',
  '尾随段落关于 B '.repeat(6),
  '',
  '# Section C',
  '',
  '第一段关于 C 的长文本 '.repeat(8),
  '',
  '# Section D',
  '',
  '第一段关于 D 的长文本 '.repeat(8),
  '',
  '# Section E',
  '',
  '第一段关于 E 的长文本 '.repeat(8),
].join('\n')

test('selectWidgetCenteredChunks 以 target 为中心返回窗口', () => {
  const { chunks } = buildDocumentChunks(CONTENT)
  assert.ok(chunks.length >= 3, '测试前置：chunk 数需充分')
  const windowed = selectWidgetCenteredChunks(CONTENT, chunks, 'target_card', 1, {
    windowChunks: 1,
  })
  assert.ok(windowed, '窗口不应为 null')
  assert.ok(windowed!.length > 0 && windowed!.length <= 3, '窗口大小应受 windowChunks 约束')

  const centerChunk = windowed!.find((chunk) =>
    chunk.content.includes('show-widget') || chunk.content.includes('target_card'),
  )
  assert.ok(centerChunk, '窗口内必须包含 target widget 所在 chunk')
})

test('target 不存在时返回 null，让上层回退老逻辑', () => {
  const { chunks } = buildDocumentChunks(CONTENT)
  const windowed = selectWidgetCenteredChunks(CONTENT, chunks, 'ghost_card', 1)
  assert.equal(windowed, null)
})

test('空 widgetTitle / 空 chunks 时返回 null', () => {
  const { chunks } = buildDocumentChunks(CONTENT)
  assert.equal(selectWidgetCenteredChunks(CONTENT, chunks, '', 1), null)
  assert.equal(selectWidgetCenteredChunks(CONTENT, [], 'target_card', 1), null)
})

test('同名 widget 多次出现时，按 occurrence 选中指定那一次', () => {
  const content = [
    '# Section A',
    '',
    '前置文本 AAAAA '.repeat(6),
    '',
    buildWidgetFence('dup_card', '<div>first</div>'),
    '',
    '# Section B',
    '',
    '中间大段文本 BBBBB '.repeat(8),
    '',
    buildWidgetFence('dup_card', '<div>second</div>'),
    '',
    '# Section C',
    '',
    '尾部 CCCCC '.repeat(6),
  ].join('\n')
  const { chunks } = buildDocumentChunks(content)
  const first = selectWidgetCenteredChunks(content, chunks, 'dup_card', 1, { windowChunks: 0 })
  const second = selectWidgetCenteredChunks(content, chunks, 'dup_card', 2, { windowChunks: 0 })
  assert.ok(first && first.length === 1)
  assert.ok(second && second.length === 1)
  assert.notEqual(first![0].index, second![0].index, '不同 occurrence 应命中不同 chunk')
})

test('buildDocumentChunks 为每个 chunk 注入 startOffset/endOffset', () => {
  const { chunks } = buildDocumentChunks(CONTENT)
  for (const chunk of chunks) {
    assert.equal(typeof chunk.startOffset, 'number', `chunk#${chunk.index} 缺少 startOffset`)
    assert.equal(typeof chunk.endOffset, 'number', `chunk#${chunk.index} 缺少 endOffset`)
    assert.ok(chunk.endOffset! >= chunk.startOffset!)
  }
})

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)

test('buildDocumentPipelineInsight 接收 targetWidgetTitle 并做窗口化', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  assert.match(source, /targetWidgetTitle\?: string/)
  assert.match(source, /targetWidgetOccurrence\?: number/)
  assert.match(source, /selectWidgetCenteredChunks\(/)
  assert.match(source, /目标卡片窗口片段/)
})

test('两个 insight 调用点都把 envelope widget_target 透传到 insight', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')
  const matches = source.match(/targetWidgetTitle: envelopeWidgetTarget/g) || []
  assert.ok(matches.length >= 1, 'runDocumentWidgetPipeline 必须透传 envelopeWidgetTarget')
  assert.match(source, /targetWidgetTitle: envelopeWidgetTargetForInsight/)
})
