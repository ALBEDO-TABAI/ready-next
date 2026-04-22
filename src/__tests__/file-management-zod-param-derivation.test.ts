/**
 * File-management derivation equality test (Phase 2.5 PR 6).
 *
 * Expected arrays include items:{type:'string'} because Zod derivation now
 * emits it for z.array(z.string()). Downstream `toSchemaParam` hardcodes the
 * same items value for array-typed params regardless, so the LLM-facing
 * output stays byte-identical — locked by the golden snapshot.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FILE_MANAGEMENT_SCHEMAS } from '../main/modules/tools/schemas/file-management-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives file_search params correctly', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'query',
      type: 'string',
      description: '搜索表达式；例如 "#project src:document keyword"',
      required: true,
    },
    {
      name: 'sources',
      type: 'array',
      description:
        '可选，过滤到指定 sourceType 列表（document / bookmark / rss / calendar / agent）',
      required: false,
      items: { type: 'string' },
    },
    { name: 'limit', type: 'number', description: '返回上限（默认 20）', required: false },
    {
      name: 'workspaceRoot',
      type: 'string',
      description: '可选，限定 workspace 根',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_search), expected)
})

test('derives file_locate params correctly', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '文件绝对路径或索引内 path', required: true },
    {
      name: 'anchor',
      type: 'string',
      description: '可选：目标章节标题或关键词；不传则返回首行',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_locate), expected)
})

test('derives file_get_backlinks params correctly', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '目标文件路径', required: true },
    { name: 'limit', type: 'number', description: '返回上限（默认 50）', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_get_backlinks), expected)
})

test('derives file_get_graph params correctly', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'centerPath',
      type: 'string',
      description: '可选，作为 BFS 起点的路径',
      required: false,
    },
    { name: 'depth', type: 'number', description: 'BFS 深度（默认 2）', required: false },
    {
      name: 'workspaceRoot',
      type: 'string',
      description: '可选，限定 workspace 根',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_get_graph), expected)
})

test('derives file_classify params correctly', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '.md 文件绝对路径', required: true },
    {
      name: 'addTags',
      type: 'array',
      description: '要新增的标签数组',
      required: false,
      items: { type: 'string' },
    },
    {
      name: 'removeTags',
      type: 'array',
      description: '要移除的标签数组',
      required: false,
      items: { type: 'string' },
    },
    {
      name: 'setFrontmatter',
      type: 'object',
      description: '要覆盖的 frontmatter 键值对',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_classify), expected)
})

test('derives file_rename params correctly', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '原文件绝对路径', required: true },
    {
      name: 'newName',
      type: 'string',
      description: '新文件名（含扩展名，不含目录）',
      required: true,
    },
    {
      name: 'overwrite',
      type: 'boolean',
      description: '可选：目标已存在时是否覆盖（默认 false）',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_rename), expected)
})

test('derives file_move params correctly', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '原文件绝对路径', required: true },
    { name: 'destDir', type: 'string', description: '目标目录绝对路径', required: true },
    { name: 'newName', type: 'string', description: '可选：新文件名', required: false },
    {
      name: 'overwrite',
      type: 'boolean',
      description: '可选：目标存在时是否覆盖（默认 false）',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(FILE_MANAGEMENT_SCHEMAS.file_move), expected)
})
