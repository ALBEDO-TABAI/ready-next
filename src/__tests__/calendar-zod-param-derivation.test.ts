/**
 * Calendar derivation equality test (Phase 2.5 PR 4).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CALENDAR_SCHEMAS } from '../main/modules/tools/schemas/calendar-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

test('derives calendar_list_window params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'start', type: 'string', description: '开始时间 ISO 字符串', required: true },
    { name: 'end', type: 'string', description: '结束时间 ISO 字符串', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(CALENDAR_SCHEMAS.calendar_list_window), expected)
})

test('derives calendar_create_event params identical to legacy hand-rolled list', () => {
  // L0-Schema-Lock: this expected list mirrors `CalendarCreateEventSchema` —
  // any addition there (reminders, recurrenceRule …) must be reflected here.
  const expected: SkillParamDefinition[] = [
    { name: 'title', type: 'string', description: '事件标题', required: true },
    { name: 'startTime', type: 'string', description: '开始时间 ISO 字符串', required: true },
    { name: 'endTime', type: 'string', description: '结束时间 ISO 字符串', required: true },
    { name: 'calendarId', type: 'string', description: '目标日历 ID', required: false },
    { name: 'description', type: 'string', description: '事件描述', required: false },
    { name: 'location', type: 'string', description: '事件地点', required: false },
    { name: 'allDay', type: 'boolean', description: '是否全天事件', required: false },
    {
      name: 'reminders',
      type: 'array',
      description: '提醒列表',
      required: false,
      items: { type: 'object' },
    },
    { name: 'recurrenceRule', type: 'string', description: 'RFC 5545 RRULE 字符串，描述循环规则', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(CALENDAR_SCHEMAS.calendar_create_event), expected)
})

test('derives calendar_update_event params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'id', type: 'string', description: '事件 ID', required: true },
    { name: 'title', type: 'string', description: '可选，更新后的标题', required: false },
    { name: 'startTime', type: 'string', description: '可选，新的开始时间 ISO 字符串', required: false },
    { name: 'endTime', type: 'string', description: '可选，新的结束时间 ISO 字符串', required: false },
    { name: 'description', type: 'string', description: '可选，新的事件描述', required: false },
    { name: 'location', type: 'string', description: '可选，新的事件地点', required: false },
    { name: 'allDay', type: 'boolean', description: '可选，是否全天事件', required: false },
    {
      name: 'reminders',
      type: 'array',
      description: '可选，新的提醒列表（整组替换）',
      required: false,
      items: { type: 'object' },
    },
    { name: 'recurrenceRule', type: 'string', description: '可选，新的 RFC 5545 RRULE 字符串', required: false },
  ]
  assert.deepEqual(zodObjectToParamList(CALENDAR_SCHEMAS.calendar_update_event), expected)
})

test('derives calendar_delete_event params identical to legacy hand-rolled list', () => {
  const expected: SkillParamDefinition[] = [
    { name: 'id', type: 'string', description: '事件 ID', required: true },
  ]
  assert.deepEqual(zodObjectToParamList(CALENDAR_SCHEMAS.calendar_delete_event), expected)
})

test('derives calendar_capture_session as empty params', () => {
  assert.deepEqual(zodObjectToParamList(CALENDAR_SCHEMAS.calendar_capture_session), [])
})
