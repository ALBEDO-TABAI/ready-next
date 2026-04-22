/**
 * RSS derivation equality test (Phase 2.5 PR 3).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RSS_SCHEMAS } from '../main/modules/tools/schemas/rss-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives rss_add_source params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'name', type: 'string', description: '订阅源名称', required: true },
    { name: 'url', type: 'string', description: '订阅源 URL', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(RSS_SCHEMAS.rss_add_source), expected)
})

test('derives rss_fetch_updates as empty params', () => {
  assert.deepEqual(zodObjectToParamList(RSS_SCHEMAS.rss_fetch_updates), [])
})

test('derives rss_select_item params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'itemId', type: 'string', description: '可选，条目 ID', required: false },
    { name: 'title', type: 'string', description: '可选，条目标题关键词', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(RSS_SCHEMAS.rss_select_item), expected)
})

test('derives rss_analyze_item params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'itemId', type: 'string', description: '可选，条目 ID', required: false },
    { name: 'title', type: 'string', description: '可选，条目标题关键词', required: false },
    { name: 'analysisType', type: 'string', description: 'copy 或 visual', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(RSS_SCHEMAS.rss_analyze_item), expected)
})

test('derives rss_capture_session as empty params', () => {
  assert.deepEqual(zodObjectToParamList(RSS_SCHEMAS.rss_capture_session), [])
})
