/**
 * Golden snapshot for the memory domain LLM-facing tool schemas (Phase 2.5 PR 2).
 *
 * Locks the exact Anthropic + OpenAI tool payloads emitted by
 * getMemoryAnthropicTools / getMemoryOpenAITools before we swap
 * memory-tools.ts from hand-rolled params to zod-derived params.
 *
 * Commit this test BEFORE the derivation swap so a mismatch surfaces in CI
 * if Zod derivation doesn't reproduce the exact same output. After swap, the
 * test must still pass byte-for-byte.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import {
  getMemoryAnthropicTools,
  getMemoryOpenAITools,
} from '../main/modules/tools/memory-tools'

test('memory-zod-golden-snapshot declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'memory-zod-golden-snapshot transitive sqlite load')
})

const EXPECTED_ANTHROPIC = [
  {
    name: 'memory_create',
    description:
      '创建新的记忆。summary 只记录当前任务/当前 scope 的上下文摘要；learning 只记录以后仍会反复用到的稳定事实。历史聊天回看请改用 session_search，不要把 memory 当旧会话检索。',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            '记忆类别：summary(当前任务/当前 scope 摘要，30天后过期) 或 learning(常驻 agent 记忆，长期保留)',
          enum: ['summary', 'learning'],
        },
        title: { type: 'string', description: '记忆标题，简短描述' },
        content: { type: 'string', description: '记忆内容，详细信息' },
        tags: {
          type: 'array',
          description: '标签列表，用于分类和检索',
          items: { type: 'string' },
        },
        priority: { type: 'number', description: '优先级，0-10，数字越大优先级越高' },
      },
      required: ['category', 'title', 'content'],
    },
  },
  {
    name: 'memory_search',
    description:
      '搜索持久记忆与触发规则。不要把它当历史聊天检索；涉及“上次那轮对话”之类的问题请使用 session_search。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，在标题和摘要中搜索' },
        layer: {
          type: 'string',
          description: '存储层级：l0(常驻), l1(当前 scope), l2(触发规则)',
          enum: ['l0', 'l1', 'l2'],
        },
        source_type: {
          type: 'string',
          description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
          enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
        },
        category: {
          type: 'string',
          description: '记忆类别：summary, learning, trigger, rule',
          enum: ['summary', 'learning', 'trigger', 'rule'],
        },
        limit: { type: 'number', description: '返回结果数量限制，默认10' },
      },
      required: [],
    },
  },
  {
    name: 'memory_update',
    description: '更新已存在的持久记忆。用于整理常驻记忆或当前摘要，不用于回看旧聊天。',
    input_schema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆ID' },
        title: { type: 'string', description: '新标题' },
        summary: { type: 'string', description: '新摘要' },
        tags: {
          type: 'array',
          description: '新标签列表',
          items: { type: 'string' },
        },
        priority: { type: 'number', description: '新优先级' },
        source_type: {
          type: 'string',
          description:
            '新的来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
          enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
        },
      },
      required: ['memory_id'],
    },
  },
  {
    name: 'memory_list_recent',
    description:
      '列出最近的记忆。默认用于查看最近写入的 resident/scope/trigger 记录，不包含历史会话回看。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，默认5' },
        source_type: {
          type: 'string',
          description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
          enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
        },
      },
      required: [],
    },
  },
]

// The lock's purpose is byte-for-byte stability of the LEGACY 4 memory tools
// across the zod-derivation swap. The memory domain may grow (EP1-K1 added
// memory_write_card / memory_read_card), so we lock the legacy 4 by name
// rather than asserting the whole array length.
function byName(tools: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(tools.map((tool) => [tool.name as string, tool]))
}

test('getMemoryAnthropicTools keeps the legacy 4 payloads byte-for-byte', () => {
  const actual = byName(getMemoryAnthropicTools())
  for (const expected of EXPECTED_ANTHROPIC) {
    assert.deepEqual(actual.get(expected.name), expected)
  }
})

test('getMemoryOpenAITools keeps the legacy 4 payloads byte-for-byte', () => {
  const actual = new Map(
    getMemoryOpenAITools().map((tool) => [
      (tool.function as { name: string }).name,
      tool,
    ]),
  )
  for (const tool of EXPECTED_ANTHROPIC) {
    assert.deepEqual(actual.get(tool.name), {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    })
  }
})
