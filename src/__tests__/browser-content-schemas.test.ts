/**
 * Shape tests for browser_content_task domain schemas (Phase 2.5 PR 10).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserDownloadUrlsSchema,
  BrowserExtractStructuredSchema,
  BrowserScrollCollectSchema,
  BrowserStartTaskSchema,
  BrowserGetTaskSchema,
  BrowserAggregateResultsSchema,
  BrowserResearchTopicSchema,
  BrowserRunWorkflowSchema,
  BrowserExecuteJsSchema,
} from '../main/modules/tools/schemas/browser-content-schemas'

test('BrowserDownloadUrlsSchema requires urls array and an explicit directory', () => {
  // fc641d31 (Pinterest 采集主链收口) made `directory` required —
  // downloads without a user-designated target directory are rejected.
  assert.equal(
    BrowserDownloadUrlsSchema.safeParse({ urls: ['https://a', 'https://b'], directory: '/tmp/dl' }).success,
    true,
  )
  assert.equal(
    BrowserDownloadUrlsSchema.safeParse({ urls: ['https://a'] }).success,
    false,
    'directory is required since fc641d31',
  )
  assert.equal(BrowserDownloadUrlsSchema.safeParse({}).success, false)
  assert.equal(
    BrowserDownloadUrlsSchema.safeParse({ urls: 'not-array', directory: '/tmp/dl' }).success,
    false,
  )
})

test('BrowserExtractStructuredSchema requires template enum', () => {
  assert.equal(
    BrowserExtractStructuredSchema.safeParse({ template: 'article_list' }).success,
    true,
  )
  assert.equal(
    BrowserExtractStructuredSchema.safeParse({ template: 'card_list', fields: [{ a: 1 }] })
      .success,
    true,
  )
  assert.equal(
    BrowserExtractStructuredSchema.safeParse({ template: 'bogus' }).success,
    false,
  )
})

test('BrowserScrollCollectSchema shares the same template enum', () => {
  assert.equal(BrowserScrollCollectSchema.safeParse({ template: 'custom' }).success, true)
  assert.equal(BrowserScrollCollectSchema.safeParse({ template: 'unknown' }).success, false)
})

test('BrowserStartTaskSchema requires kind + payload', () => {
  assert.equal(
    BrowserStartTaskSchema.safeParse({ kind: 'download_urls', payload: { urls: [] } }).success,
    true,
  )
  assert.equal(
    BrowserStartTaskSchema.safeParse({ kind: 'download_urls' }).success,
    false,
  )
  assert.equal(
    BrowserStartTaskSchema.safeParse({ kind: 'unknown', payload: {} }).success,
    false,
  )
})

test('BrowserGetTaskSchema requires task_id', () => {
  assert.equal(BrowserGetTaskSchema.safeParse({ task_id: 't-1' }).success, true)
  assert.equal(BrowserGetTaskSchema.safeParse({}).success, false)
})

test('BrowserAggregateResultsSchema items is array of objects', () => {
  assert.equal(
    BrowserAggregateResultsSchema.safeParse({ items: [{ a: 1 }, { b: 2 }] }).success,
    true,
  )
  assert.equal(BrowserAggregateResultsSchema.safeParse({ items: 'nope' }).success, false)
  assert.equal(
    BrowserAggregateResultsSchema.safeParse({ items: [], merge_strategy: 'weird' }).success,
    false,
  )
})

test('BrowserResearchTopicSchema requires query; urls is optional string[]', () => {
  assert.equal(BrowserResearchTopicSchema.safeParse({ query: 'topic' }).success, true)
  assert.equal(
    BrowserResearchTopicSchema.safeParse({ query: 't', urls: ['a', 'b'] }).success,
    true,
  )
  assert.equal(
    BrowserResearchTopicSchema.safeParse({ query: 't', urls: [1, 2] }).success,
    false,
  )
})

test('BrowserRunWorkflowSchema requires steps array', () => {
  assert.equal(
    BrowserRunWorkflowSchema.safeParse({ steps: [{ action: 'click' }] }).success,
    true,
  )
  assert.equal(BrowserRunWorkflowSchema.safeParse({}).success, false)
})

test('BrowserExecuteJsSchema accepts optional code OR a named readonly template (Safe/Power mode contract)', () => {
  // 73ba5299 (audit roadmap closures / Safe Mode + Power Mode 浏览器脚本合同):
  // `code` became optional — Safe Mode runs named readonly templates, and the
  // dispatch layer (not the schema) rejects freeform code with
  // freeform_script_denied / routes granted code to browser_power_eval.
  assert.equal(BrowserExecuteJsSchema.safeParse({ code: 'return 1' }).success, true)
  assert.equal(BrowserExecuteJsSchema.safeParse({ template: 'read_text', selector: 'h1' }).success, true)
  assert.equal(BrowserExecuteJsSchema.safeParse({ template: 'not-a-template' }).success, false)
  // Empty args parse at the schema level; Safe/Power adjudication happens in dispatch.
  assert.equal(BrowserExecuteJsSchema.safeParse({}).success, true)
})
