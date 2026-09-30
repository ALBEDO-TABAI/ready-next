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
  {
    name: 'rss_query_items',
    description: '查询已保存的 RSS 资讯；支持收件箱/历史底稿、筛选和连续分页，不打开界面、不抓取、不改已读。',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'inbox 当前收件箱；library 含历史底稿', enum: ['inbox', 'library'] },
        filter: { type: 'string', description: 'all、unread 或 starred', enum: ['all', 'unread', 'starred'] },
        sourceId: { type: 'string', description: '可选订阅源 ID' },
        search: { type: 'string', description: '按字面关键词搜索，不触发网络获取' },
        searchIn: { type: 'string', description: 'title_summary 标题摘要；body 已保存正文', enum: ['title_summary', 'body'] },
        from: { type: 'number', description: '时间范围起点，Unix 毫秒，包含' },
        until: { type: 'number', description: '时间范围终点，Unix 毫秒，不包含' },
        sort: { type: 'string', description: 'newest 或 oldest', enum: ['newest', 'oldest'] },
        limit: { type: 'number', description: '每页 1–100 条，默认 50' },
        cursor: { type: 'string', description: '上一页返回的 nextCursor；其他查询条件保持相同' },
        expectedRevision: { type: 'number', description: '可选，固定当前界面或导出所引用的资料版本' },
      },
      required: [],
    },
  },
  {
    name: 'rss_read_article',
    description: '按文章 ID 分段读取已保存正文和来源，以及最近分析任务、报告路径与原文变化警告；不重新启动分析。沿 nextOffset 与 revision 续读；缺失正文明确返回来源摘要。',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '文章 ID' },
        expectedRevision: { type: 'string', description: '文章版本；连续读取时沿用首次返回版本' },
        offset: { type: 'number', description: '读取位置，使用上次返回的 nextOffset' },
        length: { type: 'number', description: '本次最多读取字符数，默认 12000、上限 24000' },
      },
      required: ['itemId'],
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
