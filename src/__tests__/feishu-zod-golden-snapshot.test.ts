/**
 * Golden snapshot for feishu domain LLM-facing schemas (Phase 2.5 PR 8).
 * Commit BEFORE swapping feishu-tools.ts params to Zod-derived.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getFeishuAnthropicTools,
  getFeishuOpenAITools,
} from '../main/modules/tools/feishu-tools'

const CHANNEL = { type: 'string', description: '飞书频道 ID' }

const EXPECTED_ANTHROPIC = [
  {
    name: 'feishu_doc_read',
    description: '读取飞书文档内容。支持飞书文档、电子表格、多维表格等。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        doc_token: { type: 'string', description: '文档 token，从文档 URL 中提取' },
        doc_type: {
          type: 'string',
          description: '文档类型：doc(旧版文档), docx(新版文档), sheet(电子表格), bitable(多维表格)',
        },
      },
      required: ['channel_id', 'doc_token', 'doc_type'],
    },
  },
  {
    name: 'feishu_doc_create',
    description: '创建新的飞书文档。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        title: { type: 'string', description: '文档标题' },
        doc_type: { type: 'string', description: '文档类型' },
        content: { type: 'object', description: '文档内容，格式根据文档类型而定' },
        folder_token: { type: 'string', description: '可选：目标文件夹 token' },
      },
      required: ['channel_id', 'title', 'doc_type'],
    },
  },
  {
    name: 'feishu_doc_update',
    description: '更新飞书文档内容。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        doc_token: { type: 'string', description: '文档 token' },
        doc_type: { type: 'string', description: '文档类型' },
        updates: { type: 'object', description: '更新内容，格式根据文档类型而定' },
      },
      required: ['channel_id', 'doc_token', 'doc_type', 'updates'],
    },
  },
  {
    name: 'feishu_doc_list',
    description: '列出可访问的飞书文档。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        folder_token: { type: 'string', description: '可选：文件夹 token，不提供则列出根目录' },
        doc_type: { type: 'string', description: '可选：筛选文档类型，默认 all' },
        limit: { type: 'number', description: '可选：返回数量限制，默认 50' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'feishu_message_send',
    description: '发送消息到飞书群聊或用户。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        chat_id: { type: 'string', description: '群聊 ID 或用户 open_id' },
        content: { type: 'object', description: '消息内容，支持文本、富文本、卡片等格式' },
        msg_type: { type: 'string', description: '消息类型' },
      },
      required: ['channel_id', 'chat_id', 'content', 'msg_type'],
    },
  },
  {
    name: 'feishu_message_get_context',
    description: '获取飞书群聊的历史消息上下文。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        chat_id: { type: 'string', description: '群聊 ID' },
        limit: { type: 'number', description: '可选：获取消息数量，默认 50' },
        start_time: { type: 'string', description: '可选：起始时间戳（秒）' },
        end_time: { type: 'string', description: '可选：结束时间戳（秒）' },
      },
      required: ['channel_id', 'chat_id'],
    },
  },
  {
    name: 'feishu_message_reply',
    description: '回复飞书消息。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        message_id: { type: 'string', description: '要回复的消息 ID' },
        content: { type: 'object', description: '回复内容' },
        msg_type: { type: 'string', description: '消息类型' },
      },
      required: ['channel_id', 'message_id', 'content', 'msg_type'],
    },
  },
  {
    name: 'feishu_calendar_list_events',
    description: '列出飞书日历事件。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        calendar_id: { type: 'string', description: '日历 ID，不提供则使用主日历' },
        start_time: { type: 'string', description: '起始时间（ISO 8601 格式）' },
        end_time: { type: 'string', description: '结束时间（ISO 8601 格式）' },
        limit: { type: 'number', description: '可选：返回数量限制，默认 50' },
      },
      required: ['channel_id', 'start_time', 'end_time'],
    },
  },
  {
    name: 'feishu_calendar_create_event',
    description: '创建飞书日历事件。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        calendar_id: { type: 'string', description: '可选：日历 ID，不提供则使用主日历' },
        summary: { type: 'string', description: '事件标题' },
        description: { type: 'string', description: '可选：事件描述' },
        start_time: { type: 'string', description: '开始时间（ISO 8601 格式）' },
        end_time: { type: 'string', description: '结束时间（ISO 8601 格式）' },
        location: { type: 'string', description: '可选：地点' },
        attendees: {
          type: 'array',
          description: '可选：参与者 open_id 列表',
          items: { type: 'string' },
        },
      },
      required: ['channel_id', 'summary', 'start_time', 'end_time'],
    },
  },
  {
    name: 'feishu_calendar_update_event',
    description: '更新飞书日历事件。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        event_id: { type: 'string', description: '事件 ID' },
        calendar_id: { type: 'string', description: '可选：日历 ID' },
        updates: {
          type: 'object',
          description:
            '更新内容（summary, description, start_time, end_time, location, attendees）',
        },
      },
      required: ['channel_id', 'event_id', 'updates'],
    },
  },
  {
    name: 'feishu_calendar_delete_event',
    description: '删除飞书日历事件。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        event_id: { type: 'string', description: '事件 ID' },
        calendar_id: { type: 'string', description: '可选：日历 ID' },
      },
      required: ['channel_id', 'event_id'],
    },
  },
  {
    name: 'feishu_chat_list',
    description: '列出可访问的飞书群聊。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        limit: { type: 'number', description: '可选：返回数量限制，默认 50' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'feishu_chat_get_members',
    description: '获取飞书群聊成员列表。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        chat_id: { type: 'string', description: '群聊 ID' },
      },
      required: ['channel_id', 'chat_id'],
    },
  },
  {
    name: 'feishu_chat_get_info',
    description: '获取飞书群聊信息。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        chat_id: { type: 'string', description: '群聊 ID' },
      },
      required: ['channel_id', 'chat_id'],
    },
  },
  {
    name: 'feishu_file_upload',
    description: '上传文件到飞书。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        file_path: { type: 'string', description: '本地文件路径' },
        file_type: { type: 'string', description: '文件类型' },
        parent_token: { type: 'string', description: '可选：父文件夹 token' },
      },
      required: ['channel_id', 'file_path', 'file_type'],
    },
  },
  {
    name: 'feishu_file_download',
    description: '从飞书下载文件。',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: CHANNEL,
        file_token: { type: 'string', description: '文件 token' },
        save_path: { type: 'string', description: '保存路径' },
      },
      required: ['channel_id', 'file_token', 'save_path'],
    },
  },
]

test('getFeishuAnthropicTools matches the locked LLM-facing payload', () => {
  assert.deepEqual(getFeishuAnthropicTools(), EXPECTED_ANTHROPIC)
})

test('getFeishuOpenAITools matches the locked LLM-facing payload', () => {
  const expected = EXPECTED_ANTHROPIC.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
  assert.deepEqual(getFeishuOpenAITools(), expected)
})
