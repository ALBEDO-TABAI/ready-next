/**
 * Derivation equality test (Phase 2.5 PR 2).
 *
 * Asserts that zodObjectToParamList(MEMORY_SCHEMAS[x]) reproduces the exact
 * legacy hand-rolled SkillParamDefinition[] from memory-tools.ts, so the swap
 * to Zod-derived params is byte-identical for the LLM.
 *
 * Expected arrays are inlined so drift is impossible to hide.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MEMORY_SCHEMAS } from '../main/modules/tools/schemas/memory-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives memory_create params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'category',
      type: 'string',
      description:
        '记忆类别：summary(当前任务/当前 scope 摘要，30天后过期) 或 learning(常驻 agent 记忆，长期保留)',
      required: true,
      enum: ['summary', 'learning'],
    },
    { name: 'title', type: 'string', description: '记忆标题，简短描述', required: true },
    { name: 'content', type: 'string', description: '记忆内容，详细信息', required: true },
    {
      name: 'tags',
      type: 'array',
      description: '标签列表，用于分类和检索',
      required: false,
      items: { type: 'string' },
    },
    {
      name: 'priority',
      type: 'number',
      description: '优先级，0-10，数字越大优先级越高',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(MEMORY_SCHEMAS.memory_create), expected)
})

test('derives memory_search params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'query',
      type: 'string',
      description: '搜索关键词，在标题和摘要中搜索',
      required: false,
    },
    {
      name: 'layer',
      type: 'string',
      description: '存储层级：l0(常驻), l1(当前 scope), l2(触发规则)',
      required: false,
      enum: ['l0', 'l1', 'l2'],
    },
    {
      name: 'source_type',
      type: 'string',
      description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
      required: false,
      enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
    },
    {
      name: 'category',
      type: 'string',
      description: '记忆类别：summary, learning, trigger, rule',
      required: false,
      enum: ['summary', 'learning', 'trigger', 'rule'],
    },
    { name: 'limit', type: 'number', description: '返回结果数量限制，默认10', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(MEMORY_SCHEMAS.memory_search), expected)
})

test('derives memory_update params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'memory_id', type: 'string', description: '记忆ID', required: true },
    { name: 'title', type: 'string', description: '新标题', required: false },
    { name: 'summary', type: 'string', description: '新摘要', required: false },
    {
      name: 'tags',
      type: 'array',
      description: '新标签列表',
      required: false,
      items: { type: 'string' },
    },
    { name: 'priority', type: 'number', description: '新优先级', required: false },
    {
      name: 'source_type',
      type: 'string',
      description:
        '新的来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
      required: false,
      enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
    },
  ]
  assert.deepEqual(zodObjectToParamList(MEMORY_SCHEMAS.memory_update), expected)
})

test('derives memory_list_recent params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'limit', type: 'number', description: '返回数量，默认5', required: false },
    {
      name: 'source_type',
      type: 'string',
      description: '来源分类：resident_agent, resident_user, scope_memory, trigger_rule',
      required: false,
      enum: ['resident_agent', 'resident_user', 'scope_memory', 'trigger_rule'],
    },
  ]
  assert.deepEqual(zodObjectToParamList(MEMORY_SCHEMAS.memory_list_recent), expected)
})
