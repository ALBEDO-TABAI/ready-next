/**
 * Document derivation equality test (Phase 2.5 PR 7).
 *
 * Asserts zodObjectToParamList reproduces the legacy hand-rolled
 * SkillParamDefinition[] for each of the 15 document tools byte-for-byte.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DOCUMENT_SCHEMAS } from '../main/modules/tools/schemas/document-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

const TAB_ID_OPTIONAL: SkillParamDefinition = {
  name: 'tabId',
  type: 'string',
  description: '可选，目标标签 ID',
  required: false,
}

test('derives document_new_tab params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'title', type: 'string', description: '新标签标题（可选）', required: false },
    {
      name: 'path',
      type: 'string',
      description: '可选，目标保存路径；提供后创建或复用该路径的后台标签',
      required: false,
    },
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_new_tab), expected)
})

test('derives document_open_tab params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'path', type: 'string', description: '文档绝对路径', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_open_tab), expected)
})

test('derives document_switch_tab params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'target', type: 'string', description: 'tabId、标题关键词或序号', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_switch_tab), expected)
})

test('derives document_rename_tab params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'title', type: 'string', description: '新标题', required: true },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_rename_tab), expected)
})

test('derives document_set_content params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'content', type: 'string', description: '完整文档内容', required: true },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_set_content), expected)
})

test('derives document_append_content params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'content', type: 'string', description: '要追加的内容', required: true },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_append_content), expected)
})

test('derives document_insert_widget params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'title',
      type: 'string',
      description: 'widget 标题（建议 snake_case 或简短标题）',
      required: true,
    },
    {
      name: 'widgetCode',
      type: 'string',
      description:
        '可选：直接提供 widget 的 HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）',
      required: false,
    },
    {
      name: 'componentSpec',
      type: 'object',
      description:
        '可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。',
      required: false,
    },
    {
      name: 'position',
      type: 'string',
      description: '插入位置：append_end 或 after_section',
      required: true,
    },
    {
      name: 'sectionTitle',
      type: 'string',
      description: '当 position=after_section 时，目标章节标题',
      required: false,
    },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_insert_widget), expected)
})

test('derives document_list_widgets params', () => {
  const expected: SkillParamDefinition[] = [TAB_ID_OPTIONAL]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_list_widgets), expected)
})

test('derives document_update_widget params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'target',
      type: 'string',
      description: '目标 widget 标题关键词或 1-based 序号',
      required: true,
    },
    {
      name: 'widgetCode',
      type: 'string',
      description:
        '可选：新的 widget HTML/SVG/本地交互脚本内容（允许 oninput/onclick 等本地内联事件）',
      required: false,
    },
    {
      name: 'componentSpec',
      type: 'object',
      description:
        '可选：结构化 OpenUI 组件规格，例如 { component, props?, dataSource? }。优先使用它而不是自由 HTML。',
      required: false,
    },
    {
      name: 'componentSpecPatch',
      type: 'object',
      description: '可选：仅包含变更字段的 componentSpec patch。适合在已有结构化 widget 上做小改。',
      required: false,
    },
    { name: 'title', type: 'string', description: '可选，更新后的新标题', required: false },
    {
      name: 'occurrence',
      type: 'number',
      description: '当标题命中多个 widget 时，指定第几处（从 1 开始）',
      required: false,
    },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_update_widget), expected)
})

test('derives document_remove_widget params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'target',
      type: 'string',
      description: '目标 widget 标题关键词或 1-based 序号',
      required: true,
    },
    {
      name: 'occurrence',
      type: 'number',
      description: '当标题命中多个 widget 时，指定第几处（从 1 开始）',
      required: false,
    },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_remove_widget), expected)
})

test('derives document_replace_text params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'from', type: 'string', description: '要替换的原文', required: true },
    { name: 'to', type: 'string', description: '替换后的文本', required: true },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_replace_text), expected)
})

test('derives document_replace_exact params', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'target', type: 'string', description: '要精准替换的原文片段', required: true },
    { name: 'replacement', type: 'string', description: '替换后的新内容', required: true },
    {
      name: 'occurrence',
      type: 'number',
      description: '可选，第几处匹配（从 1 开始）',
      required: false,
    },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_replace_exact), expected)
})

test('derives document_format_section params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'sectionTitle',
      type: 'string',
      description: '章节标题（例如：引言、第二部分）',
      required: true,
    },
    {
      name: 'style',
      type: 'string',
      description: '可选，格式化风格（默认 readable）',
      required: false,
    },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_format_section), expected)
})

test('derives document_rewrite_section params', () => {
  const expected: SkillParamDefinition[] = [
    {
      name: 'sectionTitle',
      type: 'string',
      description: '章节标题（例如：引言、第二部分）',
      required: true,
    },
    { name: 'content', type: 'string', description: '章节完整新内容（不含标题行）', required: true },
    TAB_ID_OPTIONAL,
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_rewrite_section), expected)
})

test('derives document_save_tab params', () => {
  const expected: SkillParamDefinition[] = [
    TAB_ID_OPTIONAL,
    { name: 'path', type: 'string', description: '可选，直接保存到该绝对路径', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(DOCUMENT_SCHEMAS.document_save_tab), expected)
})
