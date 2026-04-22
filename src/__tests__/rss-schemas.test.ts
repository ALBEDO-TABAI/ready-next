/**
 * Shape tests for the RSS domain Zod schemas (Phase 2.5 PR 3).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RssAddSourceSchema,
  RssFetchUpdatesSchema,
  RssSelectItemSchema,
  RssAnalyzeItemSchema,
  RssCaptureSessionSchema,
} from '../main/modules/tools/schemas/rss-schemas'

test('RssAddSourceSchema requires name + url', () => {
  assert.equal(RssAddSourceSchema.safeParse({ name: 'f', url: 'https://x' }).success, true)
  assert.equal(RssAddSourceSchema.safeParse({ name: 'f' }).success, false)
  assert.equal(RssAddSourceSchema.safeParse({ url: 'https://x' }).success, false)
  assert.equal(RssAddSourceSchema.safeParse({}).success, false)
})

test('RssFetchUpdatesSchema accepts empty object (no params)', () => {
  assert.equal(RssFetchUpdatesSchema.safeParse({}).success, true)
})

test('RssSelectItemSchema accepts empty object and string itemId/title', () => {
  assert.equal(RssSelectItemSchema.safeParse({}).success, true)
  assert.equal(RssSelectItemSchema.safeParse({ itemId: 'i-1' }).success, true)
  assert.equal(RssSelectItemSchema.safeParse({ title: 'headline' }).success, true)
  assert.equal(RssSelectItemSchema.safeParse({ itemId: 42 }).success, false)
})

test('RssAnalyzeItemSchema requires analysisType string', () => {
  assert.equal(RssAnalyzeItemSchema.safeParse({ analysisType: 'copy' }).success, true)
  assert.equal(RssAnalyzeItemSchema.safeParse({ analysisType: 'visual' }).success, true)
  // Any string passes — we preserve byte-equivalence with legacy (no enum).
  assert.equal(RssAnalyzeItemSchema.safeParse({ analysisType: 'anything' }).success, true)
  assert.equal(RssAnalyzeItemSchema.safeParse({}).success, false)
})

test('RssCaptureSessionSchema accepts empty object', () => {
  assert.equal(RssCaptureSessionSchema.safeParse({}).success, true)
})
