/**
 * R-CTX (P2) — provider_request_bill section attribution. Instrumentation-only:
 * these assert the pure classifier partitions a provider request's tokens into
 * disjoint sections so the 565–633K bloat can be diagnosed (e.g. is the same
 * image re-sent every turn?). No behavior change is under test here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { billProviderRequestSections } from '../shared/context-budget-types'

// REAL @openai/agents InputImage shape emitted by toSdkInput: the key is `image`
// (a data-URL string), NOT `url`/`image_url`. Fixtures must match what the app sends.
const bigBase64 = 'A'.repeat(80_000)
const imageItem = () => ({ role: 'user', content: [{ type: 'input_image', image: `data:image/webp;base64,${bigBase64}`, detail: 'auto' }] })
const screenshotResult = () => ({ type: 'computer_call_result', callId: 'c9', output: { type: 'computer_screenshot', data: `data:image/png;base64,${bigBase64}` } })

test('vision: the REAL {type:input_image, image:data-url} shape is attributed to vision and dominates tokens', () => {
  const bill = billProviderRequestSections([imageItem(), { role: 'user', content: '一段历史文本' }] as never)
  assert.ok(bill.sections.vision > 50_000, 'a data-URL image should dominate the bill')
  assert.equal(bill.visionItems, 1)
  assert.ok(bill.sections.history > 0)
  assert.equal(bill.sections.tool_results, 0)
})

test('vision: a computer_screenshot result is attributed to vision (image cost), not tool_results', () => {
  const bill = billProviderRequestSections([screenshotResult()] as never)
  assert.ok(bill.sections.vision > 50_000)
  assert.equal(bill.visionItems, 1)
  assert.equal(bill.sections.tool_results, 0)
})

test('tool_results: tool call + result items are attributed to tool_results, not vision', () => {
  const bill = billProviderRequestSections([
    { type: 'function_call', callId: 'c1', name: 'x', arguments: '{}' },
    { type: 'function_call_result', callId: 'c1', output: 'some tool output text' },
  ] as never)
  assert.ok(bill.sections.tool_results > 0)
  assert.equal(bill.sections.vision, 0)
})

test('reminders: system role and <system-reminder> content are attributed to reminders', () => {
  const bill = billProviderRequestSections([
    { role: 'system', content: 'you are ready' },
    { role: 'user', content: '<system-reminder>budget low</system-reminder>' },
  ] as never)
  assert.ok(bill.sections.reminders > 0)
  assert.equal(bill.sections.history, 0)
})

test('partition: sections sum EXACTLY to totalTokens (disjoint, no double-count / no gap)', () => {
  const bill = billProviderRequestSections([
    imageItem(),
    { type: 'function_call_result', callId: 'c1', output: 'r' },
    { role: 'user', content: 'hello' },
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'SKILL.md 内联方法论' },
  ] as never)
  const sum = Object.values(bill.sections).reduce((a, b) => a + b, 0)
  assert.equal(sum, bill.totalTokens)
  assert.equal(bill.itemCount, 5)
})

test('diagnosis question: a re-sent image reads as the SAME vision cost each turn (re-send, not one-time)', () => {
  const image = imageItem()
  const turn1 = billProviderRequestSections([image] as never)
  const turn2 = billProviderRequestSections([image, { role: 'assistant', content: 'ok' }] as never)
  assert.equal(turn1.sections.vision, turn2.sections.vision, 'vision cost persists across turns → image re-sent')
})

test('empty request bills to zero everywhere', () => {
  const bill = billProviderRequestSections([] as never)
  assert.equal(bill.totalTokens, 0)
  assert.equal(bill.itemCount, 0)
  assert.equal(bill.visionItems, 0)
})

test('total-safe: a null/garbage item never throws (the emit hot path has no try/catch)', () => {
  // A throw here would reject callModelInputFilter and break the provider call.
  assert.doesNotThrow(() => billProviderRequestSections([null, undefined, 42, 'x', { role: 'user', content: 'ok' }] as never))
  const bill = billProviderRequestSections([null, undefined, { role: 'user', content: 'ok' }] as never)
  assert.equal(bill.itemCount, 3)
})

test('partition still holds with the real image shape (sections sum to total)', () => {
  const bill = billProviderRequestSections([imageItem(), screenshotResult(), { role: 'user', content: 'hi' }] as never)
  const sum = Object.values(bill.sections).reduce((a, b) => a + b, 0)
  assert.equal(sum, bill.totalTokens)
})
