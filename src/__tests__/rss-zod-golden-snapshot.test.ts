/**
 * Golden snapshot for RSS domain LLM-facing tool schemas (Phase 2.5 PR 3).
 *
 * Commit BEFORE swapping rss-tools.ts params from hand-rolled to Zod-derived;
 * the snapshot then locks the derivation swap to byte equivalence.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getRSSAnthropicTools,
  getRSSOpenAITools,
} from '../main/modules/tools/rss-tools'

const EXPECTED_ANTHROPIC = [
  {
    name: 'rss_add_source',
    description: '添加一个 RSS 订阅源。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '订阅源名称' },
        url: { type: 'string', description: '订阅源 URL' },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'rss_fetch_updates',
    description: '刷新当前 RSS 订阅，拉取最新内容。',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'rss_select_item',
    description: '在 RSS 列表中按 itemId 或标题定位一个条目。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '可选，条目 ID' },
        title: { type: 'string', description: '可选，条目标题关键词' },
      },
      required: [],
    },
  },
  {
    name: 'rss_analyze_item',
    description: '对指定 RSS 条目运行 copy 或 visual 分析流程。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '可选，条目 ID' },
        title: { type: 'string', description: '可选，条目标题关键词' },
        analysisType: { type: 'string', description: 'copy 或 visual' },
      },
      required: ['analysisType'],
    },
  },
  {
    name: 'rss_capture_session',
    description: '读取当前 RSS 会话快照、选中条目和最近分析状态。',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]

test('getRSSAnthropicTools matches the locked LLM-facing payload byte-for-byte', () => {
  assert.deepEqual(getRSSAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getRSSOpenAITools matches the locked LLM-facing payload byte-for-byte', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getRSSOpenAITools(), expected)
})
