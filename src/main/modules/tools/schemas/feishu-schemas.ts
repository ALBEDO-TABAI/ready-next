/**
 * Zod schemas for the 16 feishu domain tools (Phase 2.5 PR 8).
 *
 * Organized into the same four operation families as feishu-tools.ts:
 * Document / Message / Calendar / Group chat / File. A shared ChannelId
 * schema collapses the `channel_id` boilerplate (16 copies) and uses the
 * same description byte-for-byte.
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

const ChannelId = z.string().describe('飞书频道 ID')

// --- Document ---------------------------------------------------------------

export const FeishuDocReadSchema = z.object({
  channel_id: ChannelId,
  doc_token: z.string().describe('文档 token，从文档 URL 中提取'),
  doc_type: z
    .string()
    .describe('文档类型：doc(旧版文档), docx(新版文档), sheet(电子表格), bitable(多维表格)'),
})

export const FeishuDocCreateSchema = z.object({
  channel_id: ChannelId,
  title: z.string().describe('文档标题'),
  doc_type: z.string().describe('文档类型'),
  content: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('文档内容，格式根据文档类型而定'),
  folder_token: z.string().optional().describe('可选：目标文件夹 token'),
})

export const FeishuDocUpdateSchema = z.object({
  channel_id: ChannelId,
  doc_token: z.string().describe('文档 token'),
  doc_type: z.string().describe('文档类型'),
  updates: z.record(z.string(), z.unknown()).describe('更新内容，格式根据文档类型而定'),
})

export const FeishuDocListSchema = z.object({
  channel_id: ChannelId,
  folder_token: z.string().optional().describe('可选：文件夹 token，不提供则列出根目录'),
  doc_type: z.string().optional().describe('可选：筛选文档类型，默认 all'),
  limit: z.number().optional().describe('可选：返回数量限制，默认 50'),
})

// --- Message ----------------------------------------------------------------

export const FeishuMessageSendSchema = z.object({
  channel_id: ChannelId,
  chat_id: z.string().describe('群聊 ID 或用户 open_id'),
  content: z.record(z.string(), z.unknown()).describe('消息内容，支持文本、富文本、卡片等格式'),
  msg_type: z.string().describe('消息类型'),
})

export const FeishuMessageGetContextSchema = z.object({
  channel_id: ChannelId,
  chat_id: z.string().describe('群聊 ID'),
  limit: z.number().optional().describe('可选：获取消息数量，默认 50'),
  start_time: z.string().optional().describe('可选：起始时间戳（秒）'),
  end_time: z.string().optional().describe('可选：结束时间戳（秒）'),
})

export const FeishuMessageReplySchema = z.object({
  channel_id: ChannelId,
  message_id: z.string().describe('要回复的消息 ID'),
  content: z.record(z.string(), z.unknown()).describe('回复内容'),
  msg_type: z.string().describe('消息类型'),
})

// --- Calendar ---------------------------------------------------------------

export const FeishuCalendarListEventsSchema = z.object({
  channel_id: ChannelId,
  calendar_id: z.string().optional().describe('日历 ID，不提供则使用主日历'),
  start_time: z.string().describe('起始时间（ISO 8601 格式）'),
  end_time: z.string().describe('结束时间（ISO 8601 格式）'),
  limit: z.number().optional().describe('可选：返回数量限制，默认 50'),
})

export const FeishuCalendarCreateEventSchema = z.object({
  channel_id: ChannelId,
  calendar_id: z.string().optional().describe('可选：日历 ID，不提供则使用主日历'),
  summary: z.string().describe('事件标题'),
  description: z.string().optional().describe('可选：事件描述'),
  start_time: z.string().describe('开始时间（ISO 8601 格式）'),
  end_time: z.string().describe('结束时间（ISO 8601 格式）'),
  location: z.string().optional().describe('可选：地点'),
  attendees: z.array(z.string()).optional().describe('可选：参与者 open_id 列表'),
})

export const FeishuCalendarUpdateEventSchema = z.object({
  channel_id: ChannelId,
  event_id: z.string().describe('事件 ID'),
  calendar_id: z.string().optional().describe('可选：日历 ID'),
  updates: z
    .record(z.string(), z.unknown())
    .describe('更新内容（summary, description, start_time, end_time, location, attendees）'),
})

export const FeishuCalendarDeleteEventSchema = z.object({
  channel_id: ChannelId,
  event_id: z.string().describe('事件 ID'),
  calendar_id: z.string().optional().describe('可选：日历 ID'),
})

// --- Group chat -------------------------------------------------------------

export const FeishuChatListSchema = z.object({
  channel_id: ChannelId,
  limit: z.number().optional().describe('可选：返回数量限制，默认 50'),
})

export const FeishuChatGetMembersSchema = z.object({
  channel_id: ChannelId,
  chat_id: z.string().describe('群聊 ID'),
})

export const FeishuChatGetInfoSchema = z.object({
  channel_id: ChannelId,
  chat_id: z.string().describe('群聊 ID'),
})

// --- File -------------------------------------------------------------------

export const FeishuFileUploadSchema = z.object({
  channel_id: ChannelId,
  file_path: z.string().describe('本地文件路径'),
  file_type: z.string().describe('文件类型'),
  parent_token: z.string().optional().describe('可选：父文件夹 token'),
})

export const FeishuFileDownloadSchema = z.object({
  channel_id: ChannelId,
  file_token: z.string().describe('文件 token'),
  save_path: z.string().describe('保存路径'),
})

export type FeishuToolName =
  | 'feishu_doc_read'
  | 'feishu_doc_create'
  | 'feishu_doc_update'
  | 'feishu_doc_list'
  | 'feishu_message_send'
  | 'feishu_message_get_context'
  | 'feishu_message_reply'
  | 'feishu_calendar_list_events'
  | 'feishu_calendar_create_event'
  | 'feishu_calendar_update_event'
  | 'feishu_calendar_delete_event'
  | 'feishu_chat_list'
  | 'feishu_chat_get_members'
  | 'feishu_chat_get_info'
  | 'feishu_file_upload'
  | 'feishu_file_download'

export const FEISHU_SCHEMAS: Record<FeishuToolName, z.ZodObject<z.ZodRawShape>> = {
  feishu_doc_read: FeishuDocReadSchema,
  feishu_doc_create: FeishuDocCreateSchema,
  feishu_doc_update: FeishuDocUpdateSchema,
  feishu_doc_list: FeishuDocListSchema,
  feishu_message_send: FeishuMessageSendSchema,
  feishu_message_get_context: FeishuMessageGetContextSchema,
  feishu_message_reply: FeishuMessageReplySchema,
  feishu_calendar_list_events: FeishuCalendarListEventsSchema,
  feishu_calendar_create_event: FeishuCalendarCreateEventSchema,
  feishu_calendar_update_event: FeishuCalendarUpdateEventSchema,
  feishu_calendar_delete_event: FeishuCalendarDeleteEventSchema,
  feishu_chat_list: FeishuChatListSchema,
  feishu_chat_get_members: FeishuChatGetMembersSchema,
  feishu_chat_get_info: FeishuChatGetInfoSchema,
  feishu_file_upload: FeishuFileUploadSchema,
  feishu_file_download: FeishuFileDownloadSchema,
}
