/**
 * Shape tests for the browser_interaction Zod schemas (Phase 2.5 PR 9).
 * Spot-checks required fields, enum coverage, and object/array typing across
 * the 25 tools without exhaustively probing every field.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BrowserNavigateSchema,
  BrowserSearchSchema,
  BrowserGetTabsSchema,
  BrowserClickSchema,
  BrowserClickTextSchema,
  BrowserTypeSchema,
  BrowserCaptureViewportSchema,
  BrowserProbeReadonlySchema,
  BrowserLocateActionTargetsSchema,
  BrowserAnalyzeViewportSchema,
  BrowserUploadScopeAttachmentSchema,
  BrowserClickAtSchema,
  BrowserScrollAtSchema,
  BrowserSendKeysSchema,
  BrowserWaitForConditionSchema,
} from '../main/modules/tools/schemas/browser-interaction-schemas'

test('BrowserNavigateSchema requires url', () => {
  assert.equal(BrowserNavigateSchema.safeParse({ url: 'https://x' }).success, true)
  assert.equal(BrowserNavigateSchema.safeParse({}).success, false)
})

test('BrowserSearchSchema requires query; engine must be one of the enum values', () => {
  assert.equal(BrowserSearchSchema.safeParse({ query: 'cats' }).success, true)
  assert.equal(BrowserSearchSchema.safeParse({ query: 'x', engine: 'google' }).success, true)
  assert.equal(BrowserSearchSchema.safeParse({ query: 'x', engine: 'yandex' }).success, false)
  assert.equal(BrowserSearchSchema.safeParse({}).success, false)
})

test('BrowserGetTabsSchema accepts empty object', () => {
  assert.equal(BrowserGetTabsSchema.safeParse({}).success, true)
})

test('BrowserClickSchema requires selector; click_text requires text', () => {
  assert.equal(BrowserClickSchema.safeParse({ selector: '#btn' }).success, true)
  assert.equal(BrowserClickSchema.safeParse({}).success, false)
  assert.equal(BrowserClickTextSchema.safeParse({ text: 'Submit' }).success, true)
  assert.equal(BrowserClickTextSchema.safeParse({ text: 'Submit', exact: true }).success, true)
  assert.equal(BrowserClickTextSchema.safeParse({}).success, false)
})

test('BrowserTypeSchema requires selector + text', () => {
  assert.equal(BrowserTypeSchema.safeParse({ selector: '#in', text: 'hi' }).success, true)
  assert.equal(BrowserTypeSchema.safeParse({ selector: '#in' }).success, false)
})

test('BrowserCaptureViewportSchema accepts optional mode + clip object', () => {
  assert.equal(BrowserCaptureViewportSchema.safeParse({}).success, true)
  assert.equal(BrowserCaptureViewportSchema.safeParse({ mode: 'full_page' }).success, true)
  assert.equal(BrowserCaptureViewportSchema.safeParse({ mode: 'weird' }).success, false)
  assert.equal(
    BrowserCaptureViewportSchema.safeParse({ clip: { x: 0, y: 0, width: 100, height: 100 } })
      .success,
    true,
  )
  assert.equal(BrowserCaptureViewportSchema.safeParse({ clip: 'not-object' }).success, false)
})

test('BrowserProbeReadonlySchema requires generation and fixed scope enum', () => {
  assert.equal(
    BrowserProbeReadonlySchema.safeParse({ generation: 1, scope: 'forms', query: 'upload' }).success,
    true,
  )
  assert.equal(BrowserProbeReadonlySchema.safeParse({ scope: 'forms' }).success, false)
  assert.equal(BrowserProbeReadonlySchema.safeParse({ generation: 1, scope: 'eval' }).success, false)
})

test('BrowserLocateActionTargetsSchema enforces action enum', () => {
  assert.equal(
    BrowserLocateActionTargetsSchema.safeParse({ action: 'upload' }).success,
    true,
  )
  assert.equal(
    BrowserLocateActionTargetsSchema.safeParse({ action: 'submit' }).success,
    false,
  )
})

test('BrowserAnalyzeViewportSchema enforces extended action enum (includes input)', () => {
  assert.equal(BrowserAnalyzeViewportSchema.safeParse({ action: 'input' }).success, true)
  assert.equal(BrowserAnalyzeViewportSchema.safeParse({ action: 'weird' }).success, false)
})

test('BrowserUploadScopeAttachmentSchema coordinates are numbers', () => {
  assert.equal(
    BrowserUploadScopeAttachmentSchema.safeParse({ x: 120, y: 300 }).success,
    true,
  )
  assert.equal(
    BrowserUploadScopeAttachmentSchema.safeParse({ x: '120', y: '300' }).success,
    false,
  )
})

test('BrowserClickAtSchema requires numeric x + y', () => {
  assert.equal(BrowserClickAtSchema.safeParse({ x: 100, y: 200 }).success, true)
  assert.equal(BrowserClickAtSchema.safeParse({ x: 100 }).success, false)
  assert.equal(BrowserClickAtSchema.safeParse({ x: '100', y: '200' }).success, false)
})

test('BrowserScrollAtSchema direction enum required; coordinates optional', () => {
  assert.equal(BrowserScrollAtSchema.safeParse({ direction: 'down' }).success, true)
  assert.equal(BrowserScrollAtSchema.safeParse({}).success, false)
  assert.equal(
    BrowserScrollAtSchema.safeParse({ direction: 'down', magnitude: 1000, x: 500, y: 500 })
      .success,
    true,
  )
})

test('BrowserSendKeysSchema modifiers must be string[]', () => {
  assert.equal(BrowserSendKeysSchema.safeParse({ key: 'Enter' }).success, true)
  assert.equal(
    BrowserSendKeysSchema.safeParse({ key: 'a', modifiers: ['ctrl', 'shift'] }).success,
    true,
  )
  assert.equal(
    BrowserSendKeysSchema.safeParse({ key: 'a', modifiers: [1, 2] }).success,
    false,
  )
})

test('BrowserWaitForConditionSchema enforces condition enum', () => {
  assert.equal(
    BrowserWaitForConditionSchema.safeParse({ condition: 'page_readable' }).success,
    true,
  )
  assert.equal(
    BrowserWaitForConditionSchema.safeParse({ condition: 'network_idle' }).success,
    true,
  )
  assert.equal(
    BrowserWaitForConditionSchema.safeParse({ condition: 'bogus' }).success,
    false,
  )
})
