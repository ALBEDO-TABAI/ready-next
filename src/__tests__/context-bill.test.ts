import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContextBill,
  emitContextBill,
} from '../main/modules/agent-control/context-bill'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

test('bill byte counts equal UTF-8 byte length of each injected section', () => {
  const l0 = 'You are Ready 助手。' // mixed ASCII + CJK
  const l1 = '最近会话摘要：采集 3/6 篇笔记。'
  const bill = buildContextBill('scope-1', [
    { section: 'L0', text: l0 },
    { section: 'L1_summary', text: l1 },
  ])
  assert.equal(bill.sections.L0, Buffer.byteLength(l0, 'utf8'))
  assert.equal(bill.sections.L1_summary, Buffer.byteLength(l1, 'utf8'))
  assert.equal(bill.total, Buffer.byteLength(l0, 'utf8') + Buffer.byteLength(l1, 'utf8'))
  assert.deepEqual(bill.truncations, [])
  assert.deepEqual(bill.truncationReasons, {})
})

test('empty sections are omitted from the bill', () => {
  const bill = buildContextBill('scope-2', [
    { section: 'L0', text: 'present' },
    { section: 'L1_taskIndex', text: '' },
    { section: 'reminders', text: '' },
  ])
  assert.deepEqual(Object.keys(bill.sections), ['L0'])
  assert.equal(bill.total, Buffer.byteLength('present', 'utf8'))
})

test('same-key sections accumulate bytes', () => {
  const bill = buildContextBill('scope-3', [
    { section: 'L2_triggers', text: 'aa' },
    { section: 'L2_triggers', text: 'bbb' },
  ])
  assert.equal(bill.sections.L2_triggers, 5)
  assert.equal(bill.total, 5)
})

test('truncation marker flags the section', () => {
  const clipped = `${'x'.repeat(20)}\n...[truncated]`
  const bill = buildContextBill('scope-4', [
    { section: 'L1_summary', text: clipped },
    { section: 'L0', text: 'whole' },
  ])
  assert.deepEqual(bill.truncations, ['L1_summary'])
  assert.deepEqual(bill.truncationReasons, { L1_summary: 'section_budget' })
})

test('emitContextBill writes exactly one context_bill metric row', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((e) => events.push(e))
  try {
    const payload = buildContextBill('scope-5', [{ section: 'L0', text: '常驻' }])
    emitContextBill(payload)
  } finally {
    __setMetricSinkForTests(null)
  }
  assert.equal(events.length, 1)
  assert.equal(events[0].metric, 'context_bill')
  assert.equal(events[0].scopeId, 'scope-5')
  assert.equal((events[0].sections as Record<string, number>).L0, Buffer.byteLength('常驻', 'utf8'))
  assert.equal(events[0].total, Buffer.byteLength('常驻', 'utf8'))
  assert.deepEqual(events[0].truncationReasons, {})
})
