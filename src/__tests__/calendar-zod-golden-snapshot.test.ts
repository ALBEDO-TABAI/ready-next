/**
 * Golden snapshot for calendar domain LLM-facing tool schemas (Phase 2.5 PR 4).
 * Commit BEFORE swapping calendar-tools.ts params from hand-rolled to Zod-derived.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getCalendarAnthropicTools,
  getCalendarOpenAITools,
} from '../main/modules/tools/calendar-tools'

const EXPECTED_ANTHROPIC = [
  {
    name: 'calendar_list_window',
    description: '读取某个时间窗口内的日程事件。',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始时间 ISO 字符串；省略时使用本轮日历窗口' },
        end: { type: 'string', description: '结束时间 ISO 字符串；省略时使用本轮日历窗口' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_create_event',
    description: '创建一个新的日程事件。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '事件标题' },
        startTime: { type: 'string', description: '开始时间 ISO 字符串' },
        endTime: { type: 'string', description: '结束时间 ISO 字符串' },
        calendarId: { type: 'string', description: '目标日历 ID' },
        description: { type: 'string', description: '事件描述' },
        location: { type: 'string', description: '事件地点' },
        allDay: { type: 'boolean', description: '是否全天事件' },
        reminders: { type: 'array', description: '提醒列表' },
        recurrenceRule: { type: 'string', description: 'RFC 5545 RRULE 字符串，描述循环规则' },
      },
      required: ['title', 'startTime', 'endTime'],
    },
  },
  {
    name: 'calendar_update_event',
    description: '更新一个现有日程事件。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事件 ID；省略时使用本轮唯一日程目标或列表回执' },
        title: { type: 'string', description: '可选，更新后的标题' },
        startTime: { type: 'string', description: '可选，新的开始时间 ISO 字符串' },
        endTime: { type: 'string', description: '可选，新的结束时间 ISO 字符串' },
        description: { type: 'string', description: '可选，新的事件描述' },
        location: { type: 'string', description: '可选，新的事件地点' },
        allDay: { type: 'boolean', description: '可选，是否全天事件' },
        reminders: { type: 'array', description: '可选，新的提醒列表（整组替换）' },
        recurrenceRule: { type: 'string', description: '可选，新的 RFC 5545 RRULE 字符串' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_delete_event',
    description: '删除一个日程事件。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事件 ID；省略时使用本轮唯一日程目标或列表回执' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_capture_session',
    description: '读取当前日程模块会话快照、时间窗口和选中事件。',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]

test('getCalendarAnthropicTools matches the locked LLM-facing payload byte-for-byte', () => {
  assert.deepEqual(getCalendarAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getCalendarOpenAITools matches the locked LLM-facing payload byte-for-byte', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getCalendarOpenAITools(), expected)
})
