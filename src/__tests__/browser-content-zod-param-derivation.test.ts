/**
 * Browser-content derivation equality test (Phase 2.5 PR 10).
 *
 * Locks 13 content_task tool params derived from Zod against the legacy
 * hand-rolled SkillParamDefinition[]. Covers the .meta opt-in for
 * additionalProperties on open records/record-arrays.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_CONTENT_SCHEMAS } from '../main/modules/tools/schemas/browser-content-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

const TAB_ID_OPTIONAL: SkillParamDefinition = {
  name: 'tab_id',
  type: 'string',
  description: '标签页 ID，留空则使用当前活跃标签页',
  required: false,
}
const TEMPLATE_ENUM = ['article_list', 'image_gallery', 'link_list', 'card_list', 'custom']

test('browser_collect_images', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_collect_images), [
    { name: 'keyword', type: 'string', description: '可选关键词，按图片 URL/alt/title 过滤', required: false },
    { name: 'limit', type: 'number', description: '最多返回条数，默认 20，最大 60', required: false },
    { name: 'min_width', type: 'number', description: '最小宽度像素过滤，默认 120', required: false },
    { name: 'include_hidden', type: 'boolean', description: '是否包含页面中已加载但当前不可见的候选大图，默认 false', required: false },
    TAB_ID_OPTIONAL,
  ])
})

test('browser_download_urls', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_urls), [
    {
      name: 'urls',
      type: 'array',
      description: '要下载的 URL 数组（http/https）',
      required: true,
      items: { type: 'string' },
    },
    { name: 'directory', type: 'string', description: '目标目录，默认 ~/Documents', required: false },
    { name: 'filename_prefix', type: 'string', description: '文件名前缀（可选）', required: false },
    { name: 'overwrite', type: 'boolean', description: '同名是否覆盖，默认 false', required: false },
    { name: 'tab_id', type: 'string', description: '可选标签页 ID（用于带 Referer 下载）', required: false },
  ])
})

test('browser_download_collected_media', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_collected_media), [
    { name: 'source_task_id', type: 'string', description: 'browser_visible_collect(image_gallery) 返回的任务 ID', required: true },
    { name: 'directory', type: 'string', description: '目标目录', required: true },
    { name: 'filename_prefix', type: 'string', description: '文件名前缀（可选，默认 image）', required: false },
    { name: 'overwrite', type: 'boolean', description: '同名是否覆盖，默认 false', required: false },
  ])
})

test('browser_resolve_video', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_resolve_video), [
    { name: 'page_url', type: 'string', description: '视频所在页面 URL；留空时尝试使用当前标签页 URL', required: false },
    { name: 'video_url', type: 'string', description: '页面已暴露的直接视频 URL（可选）', required: false },
    { name: 'poster_url', type: 'string', description: '视频封面 URL（可选）', required: false },
    { name: 'title', type: 'string', description: '视频或笔记标题（可选）', required: false },
    {
      name: 'sources',
      type: 'array',
      description: '候选 source URL 数组（可选）',
      required: false,
      items: { type: 'string' },
    },
    { name: 'tab_id', type: 'string', description: '可选标签页 ID，用于补充当前页面 URL/标题', required: false },
  ])
})

test('browser_extract_structured (fields has additionalProperties:true items)', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_extract_structured), [
    {
      name: 'template',
      type: 'string',
      description: '提取模板：article_list/image_gallery/link_list/card_list/custom',
      required: true,
      enum: TEMPLATE_ENUM,
    },
    { name: 'url', type: 'string', description: '可选：先打开或复用该 URL 再提取', required: false },
    { name: 'tab_id', type: 'string', description: '当前标签页 ID，留空则使用当前活跃页', required: false },
    { name: 'item_selector', type: 'string', description: '可选：限定提取项选择器', required: false },
    {
      name: 'fields',
      type: 'array',
      description: 'template=custom 时的字段映射',
      required: false,
      items: { type: 'object', additionalProperties: true },
    },
    { name: 'limit', type: 'number', description: '最多提取条数', required: false },
    { name: 'min_width', type: 'number', description: '图片提取最小宽度', required: false },
    { name: 'custom_script', type: 'string', description: '可选：直接执行自定义提取脚本', required: false },
  ])
})

test('browser_scroll_collect', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_scroll_collect), [
    {
      name: 'template',
      type: 'string',
      description: '提取模板：article_list/image_gallery/link_list/card_list/custom',
      required: true,
      enum: TEMPLATE_ENUM,
    },
    { name: 'url', type: 'string', description: '可选：先打开或复用该 URL 再滚动采集', required: false },
    { name: 'tab_id', type: 'string', description: '标签页 ID，留空则使用当前活跃页', required: false },
    { name: 'item_selector', type: 'string', description: '可选：限定采集项选择器', required: false },
    { name: 'limit', type: 'number', description: '最多采集条数', required: false },
    { name: 'max_scrolls', type: 'number', description: '最大滚动次数', required: false },
    { name: 'scroll_delay_ms', type: 'number', description: '每次滚动后的等待时间', required: false },
    { name: 'custom_script', type: 'string', description: '可选：直接执行自定义提取脚本', required: false },
  ])
})

test('browser_start_task (payload has additionalProperties:true at field level)', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_start_task), [
    {
      name: 'kind',
      type: 'string',
      description: '任务类型：download_urls/scroll_collect/research/visible_collect',
      required: true,
      enum: ['download_urls', 'scroll_collect', 'research', 'visible_collect'],
    },
    {
      name: 'payload',
      type: 'object',
      description: '任务参数对象',
      required: true,
      additionalProperties: true,
    },
  ])
})

test('browser_get_task / resume_task / cancel_task (same shape)', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'task_id', type: 'string', description: '任务 ID', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_get_task), expected)
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_resume_task), expected)
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_cancel_task), expected)
})

test('browser_aggregate_results (items has additionalProperties:true objects)', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_aggregate_results), [
    {
      name: 'items',
      type: 'array',
      description: '结构化结果数组',
      required: true,
      items: { type: 'object', additionalProperties: true },
    },
    {
      name: 'merge_strategy',
      type: 'string',
      description: 'concat 或 dedupe，默认 dedupe',
      required: false,
      enum: ['concat', 'dedupe'],
    },
    {
      name: 'sort_by',
      type: 'string',
      description: 'title/link/source',
      required: false,
      enum: ['title', 'link', 'source'],
    },
  ])
})

test('browser_download_gallery', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_download_gallery), [
    { name: 'url', type: 'string', description: '图集或画板链接', required: true },
    { name: 'directory', type: 'string', description: '下载目录', required: false },
    { name: 'limit', type: 'number', description: '最多采集图片数量', required: false },
    { name: 'max_scrolls', type: 'number', description: '最大滚动次数', required: false },
    { name: 'retry_failed', type: 'boolean', description: '下载失败是否重试', required: false },
  ])
})

test('browser_research_topic', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_research_topic), [
    { name: 'query', type: 'string', description: '研究主题或问题', required: true },
    {
      name: 'urls',
      type: 'array',
      description: '可选：直接指定来源页列表',
      required: false,
      items: { type: 'string' },
    },
    { name: 'max_pages', type: 'number', description: '最多访问页面数', required: false },
    { name: 'limit_per_page', type: 'number', description: '每页最多提取条数', required: false },
    {
      name: 'template',
      type: 'string',
      description: '提取模板，默认 article_list',
      required: false,
      enum: ['article_list', 'link_list', 'card_list', 'custom'],
    },
  ])
})

test('browser_run_workflow (steps has additionalProperties:true objects)', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_run_workflow), [
    {
      name: 'steps',
      type: 'array',
      description: '步骤数组，每项形如 { action, ... }',
      required: true,
      items: { type: 'object', additionalProperties: true },
    },
    TAB_ID_OPTIONAL,
    {
      name: 'continue_on_error',
      type: 'boolean',
      description: '遇错是否继续执行后续步骤，默认 false',
      required: false,
    },
  ])
})

test('browser_execute_js', () => {
  assert.deepEqual(zodObjectToParamList(BROWSER_CONTENT_SCHEMAS.browser_execute_js), [
    { name: 'code', type: 'string', description: '要执行的 JavaScript 代码', required: true },
    TAB_ID_OPTIONAL,
  ])
})
