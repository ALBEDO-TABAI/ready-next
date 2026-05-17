/**
 * Stage U (PR 2) — pure behavior tests for `message-capability-filter`.
 *
 * Covers:
 *   - sanitizeHistoricalMessagesByCapability:
 *     * fast path (both capabilities on) returns input unchanged
 *     * vision-off + image block → block removed, count incremented
 *     * vision-off + image-only message → entire content replaced with
 *       a placeholder text block (model still sees "there was an image here")
 *     * mixed content (text + image) → image removed, text kept verbatim
 *     * video-off + video block → block removed
 *     * supports multiple block-type names (image / image_url / input_image)
 *     * string-content messages pass through unchanged
 *     * non-content top-level fields (tool_calls, reasoning_content,
 *       providerData) are tunneled untouched
 *     * conservative semantics: undefined capability acts like false
 *
 *   - assertCurrentMessageCapability:
 *     * vision-off + image → throws ToolDomainError('provider_request_failed')
 *     * vision-on + image → no throw
 *     * video-off + video → throws
 *     * text-only / empty → never throws
 *     * mixed image+video → throws with both kinds noted
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCurrentMessageCapability,
  sanitizeHistoricalMessagesByCapability,
  type CapabilityMessage,
  type MessageCapabilitySnapshot,
} from '../main/modules/agent-control/message-capability-filter'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

const VISION_ON: MessageCapabilitySnapshot = { supportsVision: true, supportsVideo: true }
const VISION_OFF: MessageCapabilitySnapshot = { supportsVision: false, supportsVideo: false }
const VISION_OFF_VIDEO_ON: MessageCapabilitySnapshot = { supportsVision: false, supportsVideo: true }
const VISION_ON_VIDEO_OFF: MessageCapabilitySnapshot = { supportsVision: true, supportsVideo: false }
// Conservative semantics test target: undefined acts as false.
const UNDEFINED_CAP = { supportsVision: undefined as unknown as boolean, supportsVideo: undefined as unknown as boolean }

// ============================================================================
// sanitizeHistoricalMessagesByCapability
// ============================================================================

test('fast path: vision+video on → input passed through, zero counts', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: 'data:...' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_ON)
  assert.equal(out.removedImageBlocks, 0)
  assert.equal(out.removedVideoBlocks, 0)
  assert.equal(out.replacedWithPlaceholders, 0)
  assert.equal(out.filtered.length, 1)
  assert.deepEqual(out.filtered[0].content, messages[0].content)
})

test('vision-off + image block → image removed, count = 1', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'caption' }, { type: 'image', source: 's' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF_VIDEO_ON)
  assert.equal(out.removedImageBlocks, 1)
  assert.equal(out.replacedWithPlaceholders, 0)
  const content = out.filtered[0].content as Array<{ type: string; text?: string }>
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'caption')
})

test('vision-off + image-only content → entire content replaced with placeholder text block', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'image', source: 's' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF)
  assert.equal(out.removedImageBlocks, 1)
  assert.equal(out.replacedWithPlaceholders, 1)
  const content = out.filtered[0].content as Array<{ type: string; text?: string }>
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(String(content[0].text), /图片.*当前模型不支持/)
})

test('video-off + video block → video removed, count = 1', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'check this' }, { type: 'video', source: 'v' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_ON_VIDEO_OFF)
  assert.equal(out.removedVideoBlocks, 1)
  assert.equal(out.removedImageBlocks, 0)
  const content = out.filtered[0].content as Array<{ type: string }>
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
})

test('multiple block-type names recognized: image / image_url / input_image', () => {
  const messages: CapabilityMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image', source: 'a' },
        { type: 'image_url', image_url: 'b' },
        { type: 'input_image', image: 'c' },
        { type: 'text', text: 'caption' },
      ],
    },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF_VIDEO_ON)
  assert.equal(out.removedImageBlocks, 3)
  const content = out.filtered[0].content as Array<{ type: string }>
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
})

test('string-content messages pass through unchanged even when capability off', () => {
  const messages: CapabilityMessage[] = [
    { role: 'assistant', content: 'plain text reply' },
    { role: 'user', content: 'another text' },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF)
  assert.equal(out.removedImageBlocks, 0)
  assert.equal(out.filtered[0].content, 'plain text reply')
  assert.equal(out.filtered[1].content, 'another text')
})

test('non-content top-level fields are tunneled untouched (tool_calls, reasoning_content, providerData)', () => {
  const messages: CapabilityMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'image', source: 's' }, { type: 'text', text: 'meta' }],
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } }],
      reasoning_content: 'thinking',
      providerData: { anthropicThinkingBlocks: [{ type: 'thinking', thinking: 't' }] },
    },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF_VIDEO_ON)
  const first = out.filtered[0]
  assert.deepEqual((first as any).tool_calls, messages[0].tool_calls)
  assert.equal((first as any).reasoning_content, 'thinking')
  assert.deepEqual((first as any).providerData, messages[0].providerData)
})

test('conservative: undefined capability acts as off (image blocks removed)', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'image', source: 's' }, { type: 'text', text: 't' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, UNDEFINED_CAP)
  assert.equal(out.removedImageBlocks, 1)
  const content = out.filtered[0].content as Array<{ type: string }>
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
})

test('multi-message: counts aggregate across messages, untouched messages unchanged', () => {
  const messages: CapabilityMessage[] = [
    { role: 'user', content: [{ type: 'image', source: 's1' }] },
    { role: 'assistant', content: 'no media here' },
    { role: 'user', content: [{ type: 'image', source: 's2' }, { type: 'image', source: 's3' }] },
  ]
  const out = sanitizeHistoricalMessagesByCapability(messages, VISION_OFF)
  assert.equal(out.removedImageBlocks, 3)
  assert.equal(out.replacedWithPlaceholders, 2)
  assert.equal(out.filtered[1].content, 'no media here')
})

// ============================================================================
// assertCurrentMessageCapability
// ============================================================================

test('current turn: vision-off + image block → throws provider_request_failed', () => {
  assert.throws(
    () => assertCurrentMessageCapability(
      [{ type: 'text', text: 'caption' }, { type: 'image', source: 's' }],
      VISION_OFF,
    ),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'provider_request_failed'
      && /图片/.test(err.message),
  )
})

test('current turn: vision-on + image block → no throw', () => {
  assert.doesNotThrow(() => assertCurrentMessageCapability(
    [{ type: 'image', source: 's' }, { type: 'text', text: 't' }],
    VISION_ON,
  ))
})

test('current turn: video-off + video block → throws with 视频 in the message', () => {
  assert.throws(
    () => assertCurrentMessageCapability(
      [{ type: 'video', source: 'v' }],
      VISION_ON_VIDEO_OFF,
    ),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'provider_request_failed'
      && /视频/.test(err.message),
  )
})

test('current turn: text-only → never throws', () => {
  assert.doesNotThrow(() => assertCurrentMessageCapability(
    [{ type: 'text', text: 'just words' }],
    VISION_OFF,
  ))
})

test('current turn: empty blocks → never throws', () => {
  assert.doesNotThrow(() => assertCurrentMessageCapability([], VISION_OFF))
  assert.doesNotThrow(() => assertCurrentMessageCapability(undefined, VISION_OFF))
})

test('current turn: image + video both present, both off → throws with both kinds noted', () => {
  let thrown: unknown = null
  try {
    assertCurrentMessageCapability(
      [{ type: 'image', source: 'i' }, { type: 'video', source: 'v' }],
      VISION_OFF,
    )
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof ToolDomainError)
  const msg = (thrown as ToolDomainError).message
  assert.match(msg, /图片/)
  assert.match(msg, /视频/)
})

test('current turn: conservative undefined cap → throws on image', () => {
  assert.throws(
    () => assertCurrentMessageCapability(
      [{ type: 'image', source: 's' }],
      UNDEFINED_CAP,
    ),
    (err: unknown) => err instanceof ToolDomainError && err.errorKind === 'provider_request_failed',
  )
})
