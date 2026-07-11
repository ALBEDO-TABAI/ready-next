/**
 * P0-2 (2026-07-02 P0 visibility batch) — pure contract for ToolTraceCard
 * row derivation: serial call→result pairing, duration formatting, and
 * tolerance for orphan results.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveToolTraceRows,
  deriveToolTimelineItems,
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

// 2026-07-10 activity-capsule — timeline 条目派生：call+result 配成一条，
// 未回的 call 保持 running，孤儿 result 独立成条，失败字样判 error。

test('toolTimelineItems: pairs call+result into one item with status and duration', () => {
  const items = deriveToolTimelineItems([
    { id: 'c1', kind: 'call', text: 'browser_read_page(url)', timestamp: at(0) },
    { id: 'r1', kind: 'result', text: 'browser_read_page: 读取完成', timestamp: at(1_240) },
    { id: 'c2', kind: 'call', text: 'browser_click(selector)', timestamp: at(2_000) },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'c1')
  assert.equal(items[0].status, 'done')
  assert.equal(items[0].callText, 'browser_read_page(url)')
  assert.equal(items[0].resultText, 'browser_read_page: 读取完成')
  assert.equal(items[0].durationLabel, '1.2s')
  assert.equal(items[1].status, 'running')
  assert.equal(items[1].resultText, null)
})

test('toolTimelineItems: error-looking result text marks the item as error', () => {
  const items = deriveToolTimelineItems([
    { id: 'c1', kind: 'call', text: 'skill_write_artifact(relativePath)', timestamp: at(0) },
    { id: 'r1', kind: 'result', text: 'skill_write_artifact: 失败', timestamp: at(400) },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'error')
})

test('toolTimelineItems: rich events carry toolName/callDetail/resultDetail onto the paired item', () => {
  const items = deriveToolTimelineItems([
    {
      id: 'c1',
      kind: 'call',
      text: 'skill_read_artifact(relativePath)',
      timestamp: at(0),
      toolName: 'skill_read_artifact',
      detail: '{\n  "relativePath": "参考/mapping.md"\n}',
    },
    {
      id: 'r1',
      kind: 'result',
      text: 'skill_read_artifact: 已读取',
      timestamp: at(900),
      detail: '第一行\n第二行完整输出',
    },
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].toolName, 'skill_read_artifact')
  assert.match(items[0].callDetail || '', /mapping\.md/)
  assert.equal(items[0].resultDetail, '第一行\n第二行完整输出')
})

test('toolTimelineItems: orphan result becomes its own terminal item', () => {
  const items = deriveToolTimelineItems([
    { id: 'r0', kind: 'result', text: '迟到的结果', timestamp: at(100) },
    { id: 'c1', kind: 'call', text: 'web_search(query)', timestamp: at(1_000) },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].id, 'r0')
  assert.equal(items[0].callText, null)
  assert.equal(items[0].status, 'done')
  assert.equal(items[1].status, 'running')
})
