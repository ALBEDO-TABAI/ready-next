/**
 * 2026-07-10 activity-capsule L3 — 可见性去重的富字段合并合同。
 *
 * 同一工具事件有两个生产者：SDK executor 的富事件（toolName/detail）与
 * orchestrator 输出流的瘦事件（仅 text）。`filterUserVisibleToolTraceEvents`
 * 按 kind:text 去重时，必须把后到重复事件的富字段回填到已保留条目上——
 * 否则「先到的瘦事件」会吃掉 L3 详情。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { filterUserVisibleToolTraceEvents } from '../renderer/modules/agent/toolTraceVisibility'

function at(ms: number): Date {
  return new Date(1_780_000_000_000 + ms)
}

test('duplicate rich event backfills toolName/detail onto the kept thin event', () => {
  const visible = filterUserVisibleToolTraceEvents([
    { id: 'thin', kind: 'call' as const, text: 'browser_read(url)', timestamp: at(0) },
    {
      id: 'rich',
      kind: 'call' as const,
      text: 'browser_read(url)',
      timestamp: at(1),
      toolName: 'browser_read',
      detail: '{\n  "url": "https://example.com"\n}',
    },
  ])
  assert.equal(visible.length, 1, 'still deduped to one entry')
  assert.equal(visible[0].id, 'thin', 'first occurrence stays the kept entry')
  assert.equal(visible[0].toolName, 'browser_read')
  assert.match(visible[0].detail || '', /example\.com/)
})

test('kept rich fields are not overwritten by a later thin duplicate', () => {
  const visible = filterUserVisibleToolTraceEvents([
    {
      id: 'rich',
      kind: 'result' as const,
      text: 'web_search: 找到 3 条结果',
      timestamp: at(0),
      toolName: 'web_search',
      detail: '完整结果列表…',
    },
    { id: 'thin', kind: 'result' as const, text: 'web_search: 找到 3 条结果', timestamp: at(1) },
  ])
  assert.equal(visible.length, 1)
  assert.equal(visible[0].toolName, 'web_search')
  assert.equal(visible[0].detail, '完整结果列表…')
})

test('skill-formatted duplicates merge on the normalized public text', () => {
  // 两条原文不同（长尾细节被 formatSkillToolTraceText 归一）但公开文本相同。
  const visible = filterUserVisibleToolTraceEvents([
    { id: 'thin', kind: 'result' as const, text: 'skill_read_artifact: Artifact read.', timestamp: at(0) },
    {
      id: 'rich',
      kind: 'result' as const,
      text: 'skill_read_artifact: Artifact read.',
      timestamp: at(1),
      toolName: 'skill_read_artifact',
      detail: '正文全文……',
    },
  ])
  assert.equal(visible.length, 1)
  assert.equal(visible[0].text, 'skill_read_artifact: 已读取')
  assert.equal(visible[0].detail, '正文全文……')
})

test('distinct events keep their own fields untouched', () => {
  const visible = filterUserVisibleToolTraceEvents([
    { id: 'a', kind: 'call' as const, text: 'a(x)', timestamp: at(0), toolName: 'a' },
    { id: 'b', kind: 'call' as const, text: 'b(y)', timestamp: at(1) },
  ])
  assert.equal(visible.length, 2)
  assert.equal(visible[0].toolName, 'a')
  assert.equal(visible[1].toolName, undefined)
})
