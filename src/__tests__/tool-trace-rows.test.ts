/**
 * P0-2 (2026-07-02 P0 visibility batch) — pure contract for ToolTraceCard
 * row derivation: serial call→result pairing, duration formatting, and
 * tolerance for orphan results.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveToolTraceRows,
  formatToolTraceDuration,
} from '../renderer/modules/agent/toolTraceRows'

function at(ms: number): Date {
  return new Date(1_780_000_000_000 + ms)
}

test('toolTraceRows: pairs each result with the most recent unpaired call and labels duration', () => {
  const rows = deriveToolTraceRows([
    { id: 'c1', kind: 'call', text: '调用 browser_read_page', timestamp: at(0) },
    { id: 'r1', kind: 'result', text: '读取完成', timestamp: at(1_240) },
    { id: 'c2', kind: 'call', text: '调用 browser_click', timestamp: at(2_000) },
    { id: 'r2', kind: 'result', text: '点击完成', timestamp: at(2_060) },
  ])
  assert.equal(rows.length, 4)
  assert.equal(rows[0].durationLabel, undefined)
  assert.equal(rows[1].durationLabel, '1.2s')
  // <100ms 视为噪声不显示
  assert.equal(rows[3].durationLabel, undefined)
})

test('toolTraceRows: orphan result (no unpaired call) carries no duration and does not throw', () => {
  const rows = deriveToolTraceRows([
    { id: 'r0', kind: 'result', text: '迟到的结果', timestamp: at(500) },
    { id: 'c1', kind: 'call', text: '调用 web_search', timestamp: at(1_000) },
  ])
  assert.equal(rows[0].durationLabel, undefined)
  assert.equal(rows[1].kind, 'call')
})

test('toolTraceRows: duration formatting tiers', () => {
  assert.equal(formatToolTraceDuration(42), null)
  assert.equal(formatToolTraceDuration(-500), null)
  assert.equal(formatToolTraceDuration(Number.NaN), null)
  assert.equal(formatToolTraceDuration(860), '860ms')
  assert.equal(formatToolTraceDuration(1_000), '1s')
  assert.equal(formatToolTraceDuration(1_240), '1.2s')
  assert.equal(formatToolTraceDuration(59_940), '59.9s')
  assert.equal(formatToolTraceDuration(61_000), '1m1s')
})
