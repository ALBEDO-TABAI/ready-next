/**
 * Golden snapshot for session recall domain (Phase 2.5 PR 5).
 * Commit BEFORE swapping session-recall-tools.ts to derive from Zod.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSessionRecallAnthropicTools,
  getSessionRecallOpenAITools,
} from '../main/modules/tools/session-recall-tools'

const EXPECTED_ANTHROPIC = [
  {
    name: 'session_search',
    description:
      '搜索历史会话或列出最近会话。无 query 时返回最近历史；有 query 时按会话消息、标题、任务摘要、附件名搜索。默认排除当前会话谱系。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选，搜索关键词' },
        channelKey: { type: 'string', description: '可选，限定频道来源，例如 local:app' },
        sourceKind: {
          type: 'string',
          description: '可选，限定会话来源 local 或 channel',
          enum: ['local', 'channel'],
        },
        hasAttachments: { type: 'boolean', description: '可选，只返回带附件的历史会话' },
        limit: { type: 'number', description: '可选，返回数量限制，默认 5' },
      },
      required: [],
    },
  },
]

test('getSessionRecallAnthropicTools matches the locked LLM-facing payload', () => {
  assert.deepEqual(getSessionRecallAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getSessionRecallOpenAITools matches the locked LLM-facing payload', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getSessionRecallOpenAITools(), expected)
})
