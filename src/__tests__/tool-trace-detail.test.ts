/**
 * 2026-07-10 activity-capsule L3 — 工具事件详情构建器纯合同：
 * 秘密键过滤、逐值/数组/深度/总量截断、result 详情的「比预览多出信息才生成」
 * 规则。构建侧是唯一的上限强制点（renderer 只做展示回退）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOOL_TRACE_SECRET_KEY_PATTERN,
  buildToolCallDetail,
  buildToolResultDetail,
} from '../main/modules/agent-control/runtime-core/tool-trace-detail'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

test('buildToolCallDetail: drops secret-looking keys at any depth and keeps the rest', () => {
  const detail = buildToolCallDetail({
    relativePath: '参考/mapping.md',
    apiKey: 'sk-live-123',
    nested: { authorization: 'Bearer x', mode: 'strict' },
  })
  assert.ok(detail, 'non-secret args produce a detail block')
  assert.match(detail, /relativePath/)
  assert.match(detail, /参考\/mapping\.md/)
  assert.match(detail, /"mode": "strict"/)
  assert.doesNotMatch(detail, /sk-live-123/)
  assert.doesNotMatch(detail, /apiKey/)
  assert.doesNotMatch(detail, /Bearer x/)
})

test('buildToolCallDetail: returns null when args are empty or all-secret', () => {
  assert.equal(buildToolCallDetail({}), null)
  assert.equal(buildToolCallDetail({ token: 'a', password: 'b' }), null)
})

test('buildToolCallDetail: truncates long string values and caps arrays and total size', () => {
  const longValue = 'x'.repeat(5_000)
  const detail = buildToolCallDetail({ content: longValue })
  assert.ok(detail)
  assert.ok(detail.length <= 2_001, `total cap holds: ${detail.length}`)
  assert.match(detail, /…/)

  const arrayDetail = buildToolCallDetail({ urls: Array.from({ length: 30 }, (_, i) => `https://e.com/${i}`) })
  assert.ok(arrayDetail)
  assert.match(arrayDetail, /\(\+10 more\)/)
  assert.doesNotMatch(arrayDetail, /e\.com\/25/)
})

test('buildToolResultDetail: null when the text does not exceed the single-line preview', () => {
  assert.equal(buildToolResultDetail(createToolExecutionOutput('已读取')), null)
  assert.equal(buildToolResultDetail(createToolExecutionOutput('')), null)
})

test('buildToolResultDetail: carries multiline or long output up to the cap', () => {
  const multiline = buildToolResultDetail(createToolExecutionOutput('第一行\n第二行'))
  assert.equal(multiline, '第一行\n第二行')

  const long = buildToolResultDetail(createToolExecutionOutput('y'.repeat(6_000)))
  assert.ok(long)
  assert.equal(long.length, 4_001, 'capped at 4000 chars plus ellipsis')
  assert.ok(long.endsWith('…'))
})

test('secret pattern is the shared single source used by the call trace formatter', async () => {
  assert.match('apiKey', TOOL_TRACE_SECRET_KEY_PATTERN)
  assert.match('Authorization', TOOL_TRACE_SECRET_KEY_PATTERN)
  assert.doesNotMatch('relativePath', TOOL_TRACE_SECRET_KEY_PATTERN)
  const { formatToolCallTrace } = await import(
    '../main/modules/agent-control/runtime-core/agent-sdk-model-message-utils'
  )
  assert.equal(formatToolCallTrace('t', { apiKey: '1', path: '2' }), 't(path)')
})
