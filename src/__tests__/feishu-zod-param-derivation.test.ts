/**
 * Feishu derivation equality test (Phase 2.5 PR 8).
 *
 * Locks that zodObjectToParamList matches the legacy hand-rolled
 * SkillParamDefinition[] for all 16 feishu tools byte-for-byte.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FEISHU_SCHEMAS } from '../main/modules/tools/schemas/feishu-schemas'
import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'
import type { SkillParamDefinition } from '../shared/skill-execution-types'

const CHANNEL_ID: SkillParamDefinition = {
  name: 'channel_id',
  type: 'string',
  description: '飞书频道 ID',
  required: true,
}

test('derives feishu_doc_read params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_read), [
    CHANNEL_ID,
    { name: 'doc_token', type: 'string', description: '文档 token，从文档 URL 中提取', required: true },
    {
      name: 'doc_type',
      type: 'string',
      description: '文档类型：doc(旧版文档), docx(新版文档), sheet(电子表格), bitable(多维表格)',
      required: true,
    },
  ])
})

test('derives feishu_doc_create params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_create), [
    CHANNEL_ID,
    { name: 'title', type: 'string', description: '文档标题', required: true },
    { name: 'doc_type', type: 'string', description: '文档类型', required: true },
    { name: 'content', type: 'object', description: '文档内容，格式根据文档类型而定', required: false },
    { name: 'folder_token', type: 'string', description: '可选：目标文件夹 token', required: false },
  ])
})

test('derives feishu_doc_update params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_update), [
    CHANNEL_ID,
    { name: 'doc_token', type: 'string', description: '文档 token', required: true },
    { name: 'doc_type', type: 'string', description: '文档类型', required: true },
    { name: 'updates', type: 'object', description: '更新内容，格式根据文档类型而定', required: true },
  ])
})

test('derives feishu_doc_list params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_doc_list), [
    CHANNEL_ID,
    {
      name: 'folder_token',
      type: 'string',
      description: '可选：文件夹 token，不提供则列出根目录',
      required: false,
    },
    { name: 'doc_type', type: 'string', description: '可选：筛选文档类型，默认 all', required: false },
    { name: 'limit', type: 'number', description: '可选：返回数量限制，默认 50', required: false },
  ])
})

test('derives feishu_message_send params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_send), [
    CHANNEL_ID,
    { name: 'chat_id', type: 'string', description: '群聊 ID 或用户 open_id', required: true },
    {
      name: 'content',
      type: 'object',
      description: '消息内容，支持文本、富文本、卡片等格式',
      required: true,
    },
    { name: 'msg_type', type: 'string', description: '消息类型', required: true },
  ])
})

test('derives feishu_message_get_context params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_get_context), [
    CHANNEL_ID,
    { name: 'chat_id', type: 'string', description: '群聊 ID', required: true },
    { name: 'limit', type: 'number', description: '可选：获取消息数量，默认 50', required: false },
    { name: 'start_time', type: 'string', description: '可选：起始时间戳（秒）', required: false },
    { name: 'end_time', type: 'string', description: '可选：结束时间戳（秒）', required: false },
  ])
})

test('derives feishu_message_reply params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_message_reply), [
    CHANNEL_ID,
    { name: 'message_id', type: 'string', description: '要回复的消息 ID', required: true },
    { name: 'content', type: 'object', description: '回复内容', required: true },
    { name: 'msg_type', type: 'string', description: '消息类型', required: true },
  ])
})

test('derives feishu_calendar_list_events params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_list_events), [
    CHANNEL_ID,
    { name: 'calendar_id', type: 'string', description: '日历 ID，不提供则使用主日历', required: false },
    { name: 'start_time', type: 'string', description: '起始时间（ISO 8601 格式）', required: true },
    { name: 'end_time', type: 'string', description: '结束时间（ISO 8601 格式）', required: true },
    { name: 'limit', type: 'number', description: '可选：返回数量限制，默认 50', required: false },
  ])
})

test('derives feishu_calendar_create_event params (with typed array attendees)', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_create_event), [
    CHANNEL_ID,
    {
      name: 'calendar_id',
      type: 'string',
      description: '可选：日历 ID，不提供则使用主日历',
      required: false,
    },
    { name: 'summary', type: 'string', description: '事件标题', required: true },
    { name: 'description', type: 'string', description: '可选：事件描述', required: false },
    { name: 'start_time', type: 'string', description: '开始时间（ISO 8601 格式）', required: true },
    { name: 'end_time', type: 'string', description: '结束时间（ISO 8601 格式）', required: true },
    { name: 'location', type: 'string', description: '可选：地点', required: false },
    {
      name: 'attendees',
      type: 'array',
      description: '可选：参与者 open_id 列表',
      required: false,
      items: { type: 'string' },
    },
  ])
})

test('derives feishu_calendar_update_event params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_update_event), [
    CHANNEL_ID,
    { name: 'event_id', type: 'string', description: '事件 ID', required: true },
    { name: 'calendar_id', type: 'string', description: '可选：日历 ID', required: false },
    {
      name: 'updates',
      type: 'object',
      description: '更新内容（summary, description, start_time, end_time, location, attendees）',
      required: true,
    },
  ])
})

test('derives feishu_calendar_delete_event params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_calendar_delete_event), [
    CHANNEL_ID,
    { name: 'event_id', type: 'string', description: '事件 ID', required: true },
    { name: 'calendar_id', type: 'string', description: '可选：日历 ID', required: false },
  ])
})

test('derives feishu_chat_list params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_list), [
    CHANNEL_ID,
    { name: 'limit', type: 'number', description: '可选：返回数量限制，默认 50', required: false },
  ])
})

test('derives feishu_chat_get_members params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_get_members), [
    CHANNEL_ID,
    { name: 'chat_id', type: 'string', description: '群聊 ID', required: true },
  ])
})

test('derives feishu_chat_get_info params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_chat_get_info), [
    CHANNEL_ID,
    { name: 'chat_id', type: 'string', description: '群聊 ID', required: true },
  ])
})

test('derives feishu_file_upload params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_file_upload), [
    CHANNEL_ID,
    { name: 'file_path', type: 'string', description: '本地文件路径', required: true },
    { name: 'file_type', type: 'string', description: '文件类型', required: true },
    { name: 'parent_token', type: 'string', description: '可选：父文件夹 token', required: false },
  ])
})

test('derives feishu_file_download params', () => {
  assert.deepEqual(zodObjectToParamList(FEISHU_SCHEMAS.feishu_file_download), [
    CHANNEL_ID,
    { name: 'file_token', type: 'string', description: '文件 token', required: true },
    { name: 'save_path', type: 'string', description: '保存路径', required: true },
  ])
})
